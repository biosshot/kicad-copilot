import { getSchematic } from '../kicad/schematic-reader';
import { extractCircuit } from './extract';

export type SchematicBlocks = Record<string, string[]>;

export async function beautifySchematic(path: string, blocks: SchematicBlocks) {
    const circuit = await getSchematic(path);
    const selected = new Map<string, string>();
    for (const [block, designators] of Object.entries(blocks)) {
        if (!block.trim() || !designators.length) throw new Error('blocks and component selections must not be empty');
        for (const designator of designators) {
            const components = circuit.components.filter(c => c.designator === designator || c.designator.replace(/\.\d+$/, '') === designator);
            if (!components.length) throw new Error(`component not found: ${designator}`);
            for (const component of components) {
                if (selected.has(component.designator)) throw new Error(`component appears in multiple blocks: ${component.designator}`);
                selected.set(component.designator, block);
            }
        }
    }
    if (!selected.size) throw new Error('blocks must contain at least one component');
    return extractCircuit(path, {
        add_components: circuit.components.filter(c => selected.has(c.designator)).map(c => ({
            designator: c.designator, value: c.value, pins: c.pins, part_uuid: c.part_uuid!,
            search_query: c.value, block_name: selected.get(c.designator)!,
        })),
        rm_components: [...selected.keys()], add_reused_blocks: [], external_connect: null, external_rm_connect: null,
    });
}
