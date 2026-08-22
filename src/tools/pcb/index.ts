import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { assemblePcbLayout } from '../../pcb/assemble';
import { getPcbComponentSizes } from '../../pcb/component-sizes';
import { importPcbChanges } from '../../pcb/import';
import { cancelPcbLayout, makePcbLayout, waitPcbLayout } from '../../pcb/layout-operation';
import { pourPcbLayers } from '../../pcb/pour';
import { clearPcbRouting } from '../../pcb/clear-routing';
import { autoRoutePcb, cancelAutoRoute, waitAutoRoute } from '../../routing/routing-operation';
import { setPcbStackLayers } from '../../kicad/pcb-stack';
import { DOCS_DIR } from '../../utils/dirs';
import { enqueueMutation } from '../../utils/mutation-queue';
import { runTool } from '../../utils/tool-result';
import { join } from 'node:path';

const PCB_DOC_PATH = join(DOCS_DIR, 'pcb-layout', 'instructions.md');

export function registerPcbTools(server: McpServer) {
    server.registerTool(
        'set_pcb_stack_layers',
        {
            title: 'Set PCB Stack Layers',
            description: `Set the PCB copper layer count while preserving F.Cu and B.Cu. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                copper_layer_count: z.union([
                    z.literal(2), z.literal(4), z.literal(6), z.literal(8),
                    z.literal(10), z.literal(12), z.literal(14), z.literal(16),
                    z.literal(18), z.literal(20), z.literal(22), z.literal(24),
                    z.literal(26), z.literal(28), z.literal(30), z.literal(32),
                ]),
            }),
        },
        async ({ path, copper_layer_count }) => runTool(
            () => enqueueMutation(() => setPcbStackLayers(path, copper_layer_count)),
        ),
    );

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
                wait_ms: z.number().min(30_000).max(180_000).default(60_000),
            }),
        },
        async ({ path, file, wait_ms }) => runTool(() => makePcbLayout(path, file, wait_ms)),
    );

    server.registerTool(
        'wait_pcb_layout',
        {
            title: 'Wait PCB Layout',
            description: 'Wait for an active make_pcb_layout operation and return its PNG/SVG preview paths.',
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

    server.registerTool(
        'auto_route_pcb',
        {
            title: 'Auto Route PCB',
            description: `Run the routing DSL through eda-copilot-router (KRT by default), verify natively, and apply atomically. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                file: z.string().min(1).describe('JavaScript routing DSL file path.'),
                timeout_sec: z.number().int().min(10).max(1800).default(1800),
                wait_ms: z.number().int().min(1_000).max(180_000).default(60_000),
            }),
        },
        async (input) => runTool(() => autoRoutePcb(
            input.path,
            input.file,
            { timeoutSec: input.timeout_sec },
            input.wait_ms,
        )),
    );

    server.registerTool(
        'wait_auto_route',
        {
            title: 'Wait Auto Route',
            description: 'Wait for a running local PCB auto-route operation.',
            inputSchema: z.object({
                operation_id: z.string().uuid(),
                wait_ms: z.number().int().min(1_000).max(180_000).default(60_000),
            }),
        },
        async ({ operation_id, wait_ms }) => runTool(() => waitAutoRoute(operation_id, wait_ms)),
    );

    server.registerTool(
        'cancel_auto_route',
        {
            title: 'Cancel Auto Route',
            description: 'Cancel a running local PCB auto-route operation.',
            inputSchema: z.object({ operation_id: z.string().uuid() }),
        },
        async ({ operation_id }) => runTool(async () => cancelAutoRoute(operation_id)),
    );

    server.registerTool(
        'clear_pcb_routing',
        {
            title: 'Clear PCB Routing',
            description: `Delete PCB tracks, track arcs, and vias while preserving placement, zones, and outline. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                only_nets: z.array(z.string().min(1)).nullable().optional(),
                ignore_nets: z.array(z.string().min(1)).nullable().optional(),
            }),
        },
        async ({ path, only_nets, ignore_nets }) => runTool(
            () => enqueueMutation(() => clearPcbRouting(path, {
                onlyNets: only_nets ?? undefined,
                ignoreNets: ignore_nets ?? undefined,
            })),
        ),
    );

    server.registerTool(
        'pour_pcb_layers',
        {
            title: 'Pour PCB Layers',
            description: `Create managed full-board copper zones and optional stitching vias. PCB instructions: ${PCB_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_pcb path.'),
                net: z.string().min(1),
                layers: z.array(z.string().min(1)).min(1),
                stitch_vias: z.boolean().default(true),
                stitch_grid_mm: z.number().min(0.5).max(50).default(4),
                via_diameter_mm: z.number().min(0.05).max(5).default(0.61),
                via_drill_mm: z.number().min(0.05).max(5).default(0.305),
                edge_margin_mm: z.number().min(0).max(20).default(1),
                max_vias: z.number().int().min(0).max(2000).default(500),
            }),
        },
        async (input) => runTool(
            () => enqueueMutation(() => pourPcbLayers(input.path, {
                net: input.net,
                layers: input.layers,
                stitchVias: input.stitch_vias,
                stitchGridMm: input.stitch_grid_mm,
                viaDiameterMm: input.via_diameter_mm,
                viaDrillMm: input.via_drill_mm,
                edgeMarginMm: input.edge_margin_mm,
                maxVias: input.max_vias,
            })),
        ),
    );
}
