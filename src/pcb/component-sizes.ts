import { getSchematic } from '../kicad/schematic-reader';
import { postJson } from '../utils/server';
import { associatedSchematicPath } from './paths';

type SizeResponse = { content?: string; error?: string };

export async function getPcbComponentSizes(
    pcbPath: string,
    designators?: string[] | null,
    includeAll?: boolean | null,
) {
    const schematicPath = await associatedSchematicPath(pcbPath);
    const circuit = await getSchematic(schematicPath);
    const response = await postJson('/v1/mcp-tools/get-pcb-component-sizes', {
        circuit,
        designators,
        includeAll,
    }) as SizeResponse;
    if (response.error) throw new Error(response.error);
    return response.content || 'component_sizes\nselected: 0';
}
