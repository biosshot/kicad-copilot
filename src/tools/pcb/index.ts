import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { assemblePcbLayout } from '../../pcb/assemble';
import { getPcbComponentSizes } from '../../pcb/component-sizes';
import { importPcbChanges } from '../../pcb/import';
import { cancelPcbLayout, makePcbLayout, waitPcbLayout } from '../../pcb/layout-operation';
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
            description: `Create placement without changing the PCB. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript PCB layout DSL file path.'),
                wait_ms: z.number().min(30_000).max(180_000).default(60_000),
            }),
        },
        async ({ path, file, wait_ms }) => runTool(() => makePcbLayout(path, file, wait_ms)),
    );

    server.registerTool(
        'wait_pcb_layout',
        {
            title: 'Wait PCB Layout',
            description: 'Wait for an active make_pcb_layout operation.',
            inputSchema: z.object({
                operation_id: z.string().min(1),
                wait_ms: z.number().min(30_000).max(180_000).default(60_000),
            }),
        },
        async ({ operation_id, wait_ms }) => runTool(() => waitPcbLayout(operation_id, wait_ms)),
    );

    server.registerTool(
        'cancel_pcb_layout',
        {
            title: 'Cancel PCB Layout',
            description: 'Request cancellation of an active make_pcb_layout operation.',
            inputSchema: z.object({ operation_id: z.string().min(1) }),
        },
        async ({ operation_id }) => runTool(() => cancelPcbLayout(operation_id)),
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
}
