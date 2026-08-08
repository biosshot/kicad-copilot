import { restoreCheckpoint, saveCheckpoint } from '../checkpoints/store';
import { applyCircuitAssembly } from '../kicad/assembly';
import { getSchematic, getSchematicContext } from '../kicad/schematic-reader';
import { CircuitAssembly, CircuitMod, ExplainCircuit } from '../types/circuit';
import { createDiagnosticCollector, errorWithDiagnostics } from '../utils/diagnostics';
import { postJson } from '../utils/server';
import { targetCircuitAssembly } from './target-assembly';

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
    ));
    if (!component) throw new Error(`component not found after assembly: ${designator}`);
    const pin = component.pins.find((item) => String(item.pin_number) === String(pinNumber));
    if (!pin) throw new Error(`pin not found after assembly: ${designator}.${pinNumber}`);
    return pin.signal_name;
}

function validateRequestedNets(circuit: CircuitMod, result: ExplainCircuit) {
    const expected = new Map<string, {
        designator: string;
        pinNumber: string | number;
        signal: string;
    }>();
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
    for (const item of expected.values()) {
        const actual = pinSignal(result, item.designator, item.pinNumber);
        if (actual !== item.signal) {
            throw new Error(
                `${item.designator}.${item.pinNumber}: expected `
                + `${item.signal || 'disconnected'}, got ${actual || 'disconnected'}`,
            );
        }
    }
}

export async function extractCircuit(
    path: string,
    circuit: CircuitMod,
    options: ExtractCircuitOptions = {},
) {
    const { target: inputCircuit, project: projectCircuit } = await getSchematicContext(path);
    if (!hasRequestedChanges(circuit)) throw new Error('no circuit changes requested');
    const checkpointId = await saveCheckpoint(path, 'Before extract_circuit');
    const response = await postJson('/v1/mcp-tools/extract-circuit', {
        circuit,
        inputCircuit: projectCircuit,
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
    let applyResult: Awaited<ReturnType<typeof applyCircuitAssembly>>;
    try {
        applyResult = await applyCircuitAssembly(path, assembly, inputCircuit, diagnostics.report);
    } catch (error) {
        throw errorWithDiagnostics(error, diagnostics.summary());
    }
    if (applyResult === 'unchanged') {
        throw errorWithDiagnostics(
            new Error('circuit assembly did not change the schematic'),
            diagnostics.summary(),
        );
    }
    const result = await getSchematic(path);
    try {
        validateRequestedNets(circuit, result);
    } catch (error) {
        await restoreCheckpoint(path, checkpointId);
        throw errorWithDiagnostics(error, diagnostics.summary());
    }

    return { checkpointId, result, assembly, diagnostics: diagnostics.summary() };
}
