import { saveCheckpoint } from '../checkpoints/store';
import { applyCircuitAssembly } from '../kicad/assembly';
import { getSchematic } from '../kicad/schematic-reader';
import { CircuitAssembly, CircuitMod, ExplainCircuit } from '../types/circuit';
import { postJson } from '../utils/server';

export type SchematicBlocks = Record<string, string[]>;

function baseDesignator(value: string) {
    return value.trim().replace(/\.\d+$/, '');
}

function selectedBlocks(blocks: SchematicBlocks) {
    const selected = new Map<string, string>();
    for (const [rawBlockName, designators] of Object.entries(blocks)) {
        const blockName = rawBlockName.trim();
        if (!blockName) throw new Error('block name must not be empty');
        if (!designators.length) throw new Error(`block has no components: ${blockName}`);
        for (const rawDesignator of designators) {
            const designator = baseDesignator(rawDesignator);
            if (!designator) throw new Error(`empty component designator in block: ${blockName}`);
            const previous = selected.get(designator);
            if (previous) throw new Error(`component appears in multiple blocks: ${designator}`);
            selected.set(designator, blockName);
        }
    }
    if (!selected.size) throw new Error('blocks must contain at least one component');
    return selected;
}

function serverAssembly(response: unknown) {
    const record = typeof response === 'object' && response !== null
        ? response as Record<string, unknown>
        : undefined;
    return (record?.circuit || response) as CircuitAssembly;
}

function withoutSelectedComponents(input: ExplainCircuit, selected: Set<string>): ExplainCircuit {
    return {
        components: input.components.filter((component) => !selected.has(component.designator)),
    };
}

export async function beautifySchematic(path: string, blocks: SchematicBlocks) {
    const requested = selectedBlocks(blocks);
    const inputCircuit = await getSchematic(path);
    const components = new Map(inputCircuit.components.map((component) => [component.designator, component]));
    const missing = [...requested.keys()].filter((designator) => !components.has(designator));
    if (missing.length) throw new Error(`components not found: ${missing.join(', ')}`);

    const missingPartUuid = [...requested.keys()]
        .filter((designator) => !components.get(designator)?.part_uuid);
    if (missingPartUuid.length) {
        throw new Error(`components have no part_uuid: ${missingPartUuid.join(', ')}`);
    }

    const selected = new Set(requested.keys());
    const circuit: CircuitMod = {
        add_components: [...requested].map(([designator, blockName]) => {
            const component = components.get(designator)!;
            return {
                designator,
                value: component.value,
                pins: component.pins,
                block_name: blockName,
                search_query: component.value,
                part_uuid: component.part_uuid!,
            };
        }),
        add_reused_blocks: [],
        rm_components: null,
        external_rm_connect: null,
        external_connect: null,
    };
    const serverInputCircuit = withoutSelectedComponents(inputCircuit, selected);
    const checkpointId = await saveCheckpoint(path, 'Before beautify_schematic');
    const response = await postJson('/v1/mcp-tools/extract-circuit', {
        circuit,
        inputCircuit: serverInputCircuit,
    });
    const assembly = serverAssembly(response);
    assembly.rm_components = [...new Set([
        ...(assembly.rm_components || []).map(baseDesignator),
        ...selected,
    ])];
    if (assembly.replace_components) {
        assembly.replace_components = assembly.replace_components
            .filter((designator) => !selected.has(baseDesignator(designator)));
    }

    await applyCircuitAssembly(path, assembly, inputCircuit);
    const result = await getSchematic(path);
    return { checkpointId, result, assembly };
}
