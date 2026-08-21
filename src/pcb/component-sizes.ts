import { postJson } from '../utils/server';
import { associatedSchematicPath } from './paths';
import { createPcbLayoutInput } from './layout-input';

type SizeResponse = { content?: string; error?: string };

export async function getPcbComponentSizes(
    pcbPath: string,
    designators?: string[] | null,
    includeAll?: boolean | null,
) {
    const schematicPath = await associatedSchematicPath(pcbPath);
    const input = await createPcbLayoutInput(pcbPath, schematicPath);
    const response = await postJson('/v1/mcp-tools/get-pcb-component-sizes', {
        ...input,
        designators,
        includeAll,
    }) as SizeResponse;
    if (response.error) throw new Error(response.error);
    return response.content || 'component_sizes\nselected: 0';
}
