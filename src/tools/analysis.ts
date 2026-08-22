import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { join } from 'node:path';
import { analyzePcb, analyzeSchematic } from '../analysis/kicad-happy';
import { startAnalysisOperation, waitAnalysis } from '../analysis/operation';
import { DOCS_DIR } from '../utils/dirs';
import { runTool } from '../utils/tool-result';

const ANALYSIS_DOC_PATH = join(DOCS_DIR, 'analysis.md');

export function registerAnalysisTools(server: McpServer) {
    server.registerTool(
        'analyze_schematic',
        {
            title: 'Analyze KiCad Schematic',
            description: `Start pinned kicad-happy schematic checks and return compact findings or a running operation. full mode incrementally downloads missing datasheets via LCSC; quick mode is offline. If status is running, call wait_analysis with the returned operation_id. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_sch, .kicad_pro, or KiCad project directory.'),
                mode: z.enum(['quick', 'full']).default('full')
                    .describe('quick is offline; full syncs missing datasheets and also includes actionable suggestions.'),
                wait_ms: z.number().int().min(0).max(50_000).default(5_000)
                    .describe('Initial synchronous wait before returning a running operation.'),
            }),
        },
        async ({ path, mode, wait_ms }) => runTool(() => startAnalysisOperation(
            'schematic',
            (onStage) => analyzeSchematic(path, mode, { onStage }),
            wait_ms,
        )),
    );

    server.registerTool(
        'analyze_pcb',
        {
            title: 'Analyze KiCad PCB',
            description: `Start pinned kicad-happy PCB connectivity, placement, DFM, thermal-pad, and optional proximity checks. Returns compact findings or a running operation; use wait_analysis when needed. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_pcb, .kicad_pro, or KiCad project directory.'),
                full: z.boolean().default(true)
                    .describe('Include the full copper connectivity graph and actionable suggestions.'),
                proximity: z.boolean().default(false)
                    .describe('Enable slower trace-proximity/crosstalk analysis after routing exists.'),
                wait_ms: z.number().int().min(0).max(50_000).default(5_000)
                    .describe('Initial synchronous wait before returning a running operation.'),
            }),
        },
        async ({ path, full, proximity, wait_ms }) => runTool(() => startAnalysisOperation(
            'pcb',
            (onStage) => analyzePcb(path, full, proximity, { onStage }),
            wait_ms,
        )),
    );

    server.registerTool(
        'wait_analysis',
        {
            title: 'Wait for KiCad Analysis',
            description: 'Wait for a running analyze_schematic or analyze_pcb operation and return its final compact result.',
            inputSchema: z.object({
                operation_id: z.string().uuid(),
                wait_ms: z.number().int().min(1_000).max(50_000).default(30_000),
            }),
        },
        async ({ operation_id, wait_ms }) => runTool(() => waitAnalysis(operation_id, wait_ms)),
    );
}
