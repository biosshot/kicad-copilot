import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { assemblePcbLayout } from '../../pcb/assemble';
import { getPcbComponentSizes } from '../../pcb/component-sizes';
import { importPcbChanges } from '../../pcb/import';
import { makePcbLayout } from '../../pcb/layout-operation';
import { runPcbDsl } from '../../routing/routing-operation';
import { DOCS_DIR } from '../../utils/dirs';
import { enqueueMutation } from '../../utils/mutation-queue';
import { runTool } from '../../utils/tool-result';
import { join } from 'node:path';

const PCB_DOC_PATH = join(DOCS_DIR, 'pcb-layout', 'instructions.md');

export function registerPcbTools(server: McpServer) {
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
            description: `Create placement without changing the PCB and return PNG/SVG preview paths. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript PCB layout DSL file path.'),
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000),
            }),
        },
        async ({ path, file, wait_ms }) => runTool(() => makePcbLayout(path, file, wait_ms)),
    );

    server.registerTool(
        'assemble_pcb_layout',
        {
            title: 'Assemble PCB Layout',
            description: `Apply a stored placement to one KiCad PCB. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                layout_id: z.string().min(1),
            }),
        },
        async ({ path, layout_id }) => runTool(
            () => enqueueMutation(() => assemblePcbLayout(path, layout_id)),
        ),
    );

    server.registerTool(
        'run_pcb_dsl',
        {
            title: 'Run PCB DSL',
            description: `Apply stackup, DRC, copper-only, or routing intent through eda-copilot-router, verify natively, and commit atomically. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript PCB routing DSL file path.'),
                timeout_sec: z.number().int().min(10).max(1800).default(1800)
                    .describe('KRT routing timeout; non-routing terminals do not start KRT.'),
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000)
                    .describe('Initial synchronous wait before returning a pcb-dsl operation_id.'),
            }),
        },
        async (input) => runTool(() => runPcbDsl(
            input.path,
            input.file,
            { timeoutSec: input.timeout_sec },
            input.wait_ms,
        )),
    );
}
