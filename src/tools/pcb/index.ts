import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { runPcbAnalysis } from '../../analysis/pcb-operation';
import { exportBoardV2 } from '../../pcb/board-v2';
import { getPcbComponentSizes } from '../../pcb/component-sizes';
import { importPcbChanges } from '../../pcb/import';
import { makePcbLayout } from '../../pcb/layout-operation';
import { runPcbRouterDsl } from '../../routing/routing-operation';
import { DOCS_DIR } from '../../utils/dirs';
import { enqueueMutation } from '../../utils/mutation-queue';
import { runTool } from '../../utils/tool-result';
import { join } from 'node:path';

const PCB_DOC_PATH = join(DOCS_DIR, 'pcb-layout', 'instructions.md');
const ANALYSIS_DOC_PATH = join(DOCS_DIR, 'pcb-analysis', 'SKILL.md');

export function registerPcbTools(server: McpServer) {
    server.registerTool('export_pcb_routing_board', {
        title: 'Export PCB Routing Board V2',
        description: 'Export a read-only .kicad_pcb snapshot as JSON with RoutingBoardV2 and capture diagnostics.',
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: z.object({ path: z.string().min(1).describe('Source .kicad_pcb path.') }),
    }, async ({ path }) => runTool(() => exportBoardV2(path)));

    server.registerTool('run_pcb_analysis', {
        title: 'Run PCB Analysis',
        description: `Run a trusted local analysis DSL against a read-only KiCad Board V2 snapshot. Returns a report or an operation ID for wait_operation. Instructions: ${ANALYSIS_DOC_PATH}`,
        annotations: { readOnlyHint: true, openWorldHint: false },
        inputSchema: z.object({
            path: z.string().min(1).describe('Source .kicad_pcb path.'),
            file: z.string().min(1).describe('Trusted JavaScript analysis DSL file.'),
            wait_ms: z.number().int().min(1_000).max(55_000).default(30_000),
        }),
    }, async ({ path, file, wait_ms }) => runTool(() => runPcbAnalysis(path, file, wait_ms)));

    server.registerTool(
        'import_pcb_changes',
        {
            title: 'Import PCB Changes',
            description: `Synchronize one KiCad PCB from its associated schematic. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                schematic_path: z.string().min(1).nullable().optional()
                    .describe('Optional root .kicad_sch override.'),
            }),
        },
        async ({ path, schematic_path }) => runTool(
            () => enqueueMutation(() => importPcbChanges(path, schematic_path)),
        ),
    );

    server.registerTool(
        'get_pcb_component_sizes',
        {
            title: 'Get PCB Component Sizes',
            description: `Return server placement footprint sizes and compact board estimate. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                designators: z.array(z.string()).nullable().optional(),
                include_all: z.boolean().nullable().optional(),
            }),
        },
        async ({ path, designators, include_all }) => runTool(
            () => getPcbComponentSizes(path, designators, include_all),
        ),
    );

    server.registerTool(
        'make_pcb_layout',
        {
            title: 'Make PCB Layout',
            description: `Create and atomically apply placement, save a checkpoint, and return PNG/SVG preview paths. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript PCB layout DSL file path.'),
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000),
            }),
        },
        async ({ path, file, wait_ms }) => runTool(() => makePcbLayout(path, file, wait_ms)),
    );

    // assemble_pcb_layout is intentionally hidden. make_pcb_layout applies every
    // returned PCB immediately while the stored layout remains available internally.

    server.registerTool(
        'run_pcb_router_dsl',
        {
            title: 'Run PCB DSL',
            description: `Apply stackup, DRC, copper-only, or routing intent through eda-copilot-router, verify natively, and commit atomically. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript PCB routing DSL file path.'),
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000)
                    .describe('Initial synchronous wait before returning a pcb-dsl operation_id.'),
            }),
        },
        async (input) => runTool(() => runPcbRouterDsl(
            input.path,
            input.file,
            input.wait_ms,
        )),
    );
}
