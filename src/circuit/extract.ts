import { saveCheckpoint } from '../checkpoints/store';
import { applyCircuitAssembly } from '../kicad/assembly';
import { getProjectNetlist, getSchematicContext } from '../kicad/schematic-reader';
import { CircuitAssembly, CircuitMod, ExplainCircuit } from '../types/circuit';
import { createDiagnosticCollector, errorWithDiagnostics } from '../utils/diagnostics';
import { postJson } from '../utils/server';
import { targetCircuitAssembly } from './target-assembly';
import { prepareSchematicInput } from './schematic-input';
import { withSchematicChanges } from '../kicad/schematic-writer';
import { synchronizeHierarchy } from '../kicad/schematic-hierarchy';
import { projectConnections, SchematicPage, validateKiCadConnectivity, validateRetainedConnections } from '../kicad/schematic-connectivity';
import { readFile } from 'node:fs/promises';
import { parseSignal } from '../kicad/scoped-signals';

type ExtractCircuitOptions = {
    onAssembly?: (assembly: CircuitAssembly) => void | Promise<void>;
};

function baseDesignator(value: string) {
    return value.trim().replace(/\.\d+$/, '');
}

function hasRequestedChanges(circuit: CircuitMod) {
    return circuit.add_components.length > 0
        || circuit.add_reused_blocks.length > 0
        || Boolean(circuit.rm_components?.length)
        || Boolean(circuit.external_connect?.length)
        || Boolean(circuit.external_rm_connect?.length);
}

function pinSignal(circuit: ExplainCircuit, designator: string, pinNumber: string | number) {
    const component = circuit.components.find((item) => (
        baseDesignator(item.designator) === baseDesignator(designator)
        && item.pins.some(p => String(p.pin_number) === String(pinNumber))
    ));
    if (!component) throw new Error(`component not found after assembly: ${designator}`);
    const pin = component.pins.find((item) => String(item.pin_number) === String(pinNumber));
    if (!pin) throw new Error(`pin not found after assembly: ${designator}.${pinNumber}`);
    return pin.signal_name;
}

function validateRequestedNets(circuit: CircuitMod, result: ExplainCircuit, page: SchematicPage) {
    const expected = new Map<string, {
        designator: string;
        pinNumber: string | number;
        signal: string;
    }>();
    for (const component of circuit.add_components) for (const pin of component.pins) {
        expected.set(`${baseDesignator(component.designator)}\u0000${pin.pin_number}`, {
            designator: component.designator, pinNumber: pin.pin_number, signal: pin.signal_name,
        });
    }
    for (const item of circuit.external_rm_connect || []) {
        expected.set(`${baseDesignator(item.designator)}\u0000${item.pin_number}`, {
            designator: item.designator,
            pinNumber: item.pin_number,
            signal: '',
        });
    }
    for (const item of circuit.external_connect || []) {
        expected.set(`${baseDesignator(item.designator)}\u0000${item.pin_number}`, {
            designator: item.designator,
            pinNumber: item.pin_number,
            signal: item.signal_name,
        });
    }
    const requestedGroups = new Map<string, string>();
    for (const item of expected.values()) {
        const actual = pinSignal(result, item.designator, item.pinNumber);
        if (actual !== page.signalFor(item.signal)) {
            throw new Error(
                `${item.designator}.${item.pinNumber}: expected `
                + `${item.signal || 'disconnected'}, got ${actual || 'disconnected'}`,
            );
        }
        const ref = parseSignal(item.signal);
        if (ref.kind === 'empty' || ref.kind === 'nc') continue;
        const wanted = ref.kind === 'global' ? `global:${ref.name}`
            : ref.kind === 'local' || ref.sheet === page.scope ? `page:${ref.name}` : `port:${ref.sheet}:${ref.name}`;
        const group = page.pinGroup(item.designator, item.pinNumber)!;
        if (requestedGroups.has(group) && requestedGroups.get(group) !== wanted) {
            throw new Error(`unrequested short between ${requestedGroups.get(group)} and ${wanted} at ${item.designator}.${item.pinNumber}`);
        }
        requestedGroups.set(group, wanted);
    }
}

export async function extractCircuit(
    path: string,
    circuit: CircuitMod,
    options: ExtractCircuitOptions = {},
) {
    if (!hasRequestedChanges(circuit)) throw new Error('no circuit changes requested');
    const context = await prepareSchematicInput(path, circuit);
    circuit = context.circuit;
    const { target: inputCircuit, project: projectCircuit } = context;
    const checkpointId = await saveCheckpoint(path, 'Before extract_circuit');
    const response = await postJson('/v1/mcp-tools/extract-circuit', {
        circuit,
        inputCircuit: projectCircuit,
        symbols: context.symbols,
    });
    const record = typeof response === 'object' && response !== null
        ? response as Record<string, unknown>
        : undefined;
    const diagnostics = createDiagnosticCollector();
    const assembly = targetCircuitAssembly(
        (record?.circuit || response) as CircuitAssembly,
        inputCircuit,
        projectCircuit,
    );
    await options.onAssembly?.(assembly);
    try {
        return await withSchematicChanges(async () => {
            for (const [file, source] of context.files) {
                if (await readFile(file, 'utf8') !== source) throw new Error(`file changed while layout was running: ${file}`);
            }
            const applyResult = await applyCircuitAssembly(
                path,
                assembly,
                inputCircuit,
                diagnostics.report,
                diagnostics.warn,
                context,
            );
            const changesComponents = circuit.add_components.length > 0
                || circuit.add_reused_blocks.length > 0 || Boolean(circuit.rm_components?.length);
            if (applyResult === 'unchanged' && changesComponents) {
                throw new Error('circuit assembly did not change the schematic');
            }
            const changedInterfaces = await synchronizeHierarchy(context.rootPath);
            // Reuse component placement when a shared sheet gains or changes ports.
            // Merely appending pins leaves long names and new ports inside old wiring.
            for (const [parentPath, designators] of changedInterfaces) {
                const parent = await getSchematicContext(parentPath);
                await extractCircuit(parentPath, {
                    add_components: parent.target.components.filter(c => designators.includes(c.designator)).map(c => ({
                        ...c, part_uuid: c.part_uuid!, block_name: c.block_name || 'Circuit', search_query: c.value,
                    })),
                    rm_components: designators, add_reused_blocks: [], external_connect: null, external_rm_connect: null,
                });
            }
            const after = await getSchematicContext(path);
            const result = after.target;
            validateRequestedNets(circuit, result, after.page);
            validateRetainedConnections(context.page, after.page, circuit);
            validateKiCadConnectivity(projectConnections(after.rootPath, after.files, after.assets), (await getProjectNetlist(after.rootPath)).circuit);
            for (const designator of circuit.rm_components ?? []) {
                if (circuit.add_components.some(c => c.designator === designator)) continue;
                if (result.components.some(c => c.designator === designator)) throw new Error(`component was not removed: ${designator}`);
            }
            return { checkpointId, result, assembly, diagnostics: diagnostics.summary() };
        });
    } catch (error) {
        throw errorWithDiagnostics(error, diagnostics.summary());
    }
}
