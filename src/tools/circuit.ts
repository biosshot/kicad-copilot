import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { beautifySchematic } from '../circuit/beautify';
import { extractCircuit } from '../circuit/extract';
import { CircuitModStruct } from '../types/circuit';
import { SKILL_DOC_PATH } from '../utils/dirs';
import { diagnosticToolResult } from '../utils/diagnostics';
import { enqueueMutation } from '../utils/mutation-queue';
import { componentSearch, searchReusedBlock } from 'eda-copilot-backend/components';
import { runTool } from '../utils/tool-result';
import { registeredAsset, nativeProperty } from '../kicad/schematic-assets';
import { basename } from 'node:path';

export function registerCircuitTools(server: McpServer) {
    server.registerTool(
        'component_search',
        {
            title: 'Search Component',
            description: 'Search a component by exact part_uuid or MPN.',
            inputSchema: z.object({
                part_uuid: z.string().nullable().optional(),
                MPN: z.string().nullable().optional(),
            }).refine(({ part_uuid, MPN }) => Boolean(part_uuid || MPN), 'Fill one: part_uuid or MPN'),
        },
        async ({ part_uuid, MPN }) => {
            return runTool(async () => {
                const asset = part_uuid ? await registeredAsset(part_uuid) : undefined;
                if (!asset) return componentSearch({ part_uuid, MPN });
                return { bestComponent: {
                    part_uuid: asset.partUuid,
                    name: asset.kind === 'sheet' ? basename(asset.path, '.kicad_sch') : nativeProperty(asset.instance, 'Value'),
                    description: asset.kind === 'sheet' ? asset.path : nativeProperty(asset.instance, 'Description'),
                    manufacturer: '', price: 0, datasheet: '',
                    designatorPattern: asset.kind === 'sheet' ? 'SH' : nativeProperty(asset.library, 'Reference'),
                    footprintName: asset.kind === 'sheet' ? null : nativeProperty(asset.instance, 'Footprint') || null,
                    pins: asset.symbol.pins.map(p => ({ pin_number: p.num, name: p.name })),
                } };
            });
        },
    );

    server.registerTool(
        'search_reused_block',
        {
            title: 'Search Reused Block',
            description: 'The backend reusable-block catalog is currently disabled. Use get_project_info to find reusable sheets in the current project.',
            inputSchema: z.object({
                query: z.string().min(1).describe('Query example: "3.3V power regulator"'),
                page: z.number().int().min(1).default(1).describe('Current results page.'),
                limit: z.number().int().min(1).max(25).default(10).describe('Number of results per page.'),
            }),
        },
        async ({ query, page, limit }) => runTool(
            () => searchReusedBlock({ query, page, limit }),
        ),
    );

    server.registerTool(
        'beautify_schematic',
        {
            title: 'Beautify Schematic',
            description: `Reassemble selected KiCad components into named functional blocks while preserving their electrical connections. Recoverable item errors are returned (max 36). For circuit workflow docs, read: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Existing target .kicad_sch path.'),
                blocks: z.record(
                    z.string().min(1).describe('Block name.'),
                    z.array(z.string().min(1)).min(1).describe('Component designators in the block.'),
                ).describe('Component groups keyed by block name.'),
            }),
        },
        async ({ path, blocks }) => runTool(() => enqueueMutation(async () => {
            const { diagnostics } = await beautifySchematic(path, blocks);
            return diagnosticToolResult(diagnostics);
        })),
    );

    server.registerTool(
        'extract_circuit',
        {
            title: 'Extract Circuit',
            description: `Apply circuit changes to a KiCad .kicad_sch file. Every added component must include part_uuid. Recoverable item errors are returned (max 36). For circuit modification docs, read: ${SKILL_DOC_PATH}`,
            inputSchema: CircuitModStruct().extend({
                path: z.string().min(1).describe('Existing target .kicad_sch path.'),
            }),
        },
        async ({ path, ...circuit }) => runTool(() => enqueueMutation(async () => {
            const { diagnostics } = await extractCircuit(path, circuit);
            return diagnosticToolResult(diagnostics);
        })),
    );
}
