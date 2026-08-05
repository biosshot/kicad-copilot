import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { saveCheckpoint } from '../checkpoints/store';
import { applyCircuitAssembly } from '../kicad/assembly';
import { getSchematic } from '../kicad/schematic-reader';
import { CircuitAssembly, circuitModSchema } from '../types/circuit';
import { SKILL_DOC_PATH } from '../utils/dirs';
import { enqueueMutation } from '../utils/mutation-queue';
import { postJson } from '../utils/server';
import { runTool, textResult } from '../utils/tool-result';

export function registerCircuitTools(server: McpServer) {
    server.registerTool(
        'component_search',
        {
            title: 'Search EasyEDA Component',
            description: `Search a component by exact part_uuid or MPN. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                part_uuid: z.string().nullable().optional(),
                MPN: z.string().nullable().optional(),
            }),
        },
        async ({ part_uuid, MPN }) => {
            if (!part_uuid && !MPN) {
                return textResult('Fill one: part_uuid or MPN');
            }

            return runTool(() => postJson('/v1/mcp-tools/component-search', { part_uuid, MPN }));
        },
    );

    server.registerTool(
        'search_reused_block',
        {
            title: 'Search Reused Circuit Block',
            description: `Search reusable circuit blocks that can be recalculated and inserted into a schematic. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                query: z.string().min(1).describe('Query example: "3.3V power regulator"'),
                page: z.number().int().min(1).default(1).describe('Current results page.'),
                limit: z.number().int().min(1).max(25).default(10).describe('Number of results per page.'),
            }),
        },
        async ({ query, page, limit }) => runTool(
            () => postJson('/v1/mcp-tools/search-reused-block', { query, page, limit }),
        ),
    );

    server.registerTool(
        'extract_circuit',
        {
            title: 'Extract Circuit into KiCad',
            description: `Post-process circuit changes on the Circuit Copilot server and assemble them into one existing .kicad_sch file. Every added component must include part_uuid. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: circuitModSchema.extend({
                path: z.string().min(1).describe('Existing target .kicad_sch path.'),
            }),
        },
        async ({ path, ...circuit }) => runTool(() => enqueueMutation(async () => {
            const inputCircuit = await getSchematic(path);
            await saveCheckpoint(path, 'Before extract_circuit');
            const response = await postJson('/v1/mcp-tools/extract-circuit', {
                circuit,
                inputCircuit,
            });
            const record = typeof response === 'object' && response !== null
                ? response as Record<string, unknown>
                : undefined;
            const assembly = (record?.circuit || response) as CircuitAssembly;
            await applyCircuitAssembly(path, assembly, inputCircuit);
            await getSchematic(path);
            return 'ok';
        })),
    );
}
