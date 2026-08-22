import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { join } from 'node:path';
import { analyzePcb, analyzeSchematic } from '../analysis/kicad-happy';
import { DOCS_DIR } from '../utils/dirs';
import { runTool } from '../utils/tool-result';

const ANALYSIS_DOC_PATH = join(DOCS_DIR, 'analysis.md');

export function registerAnalysisTools(server: McpServer) {
    server.registerTool(
        'analyze_schematic',
        {
            title: 'Analyze KiCad Schematic',
            description: `Run pinned kicad-happy schematic checks and return compact, actionable findings. full mode incrementally downloads missing datasheets via LCSC before the final analysis; quick mode is offline. A full report path is returned only when details were grouped. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_sch, .kicad_pro, or KiCad project directory.'),
                mode: z.enum(['quick', 'full']).default('full')
                    .describe('quick is offline; full syncs missing datasheets and also includes actionable suggestions.'),
            }),
        },
        async ({ path, mode }) => runTool(() => analyzeSchematic(path, mode)),
    );

    server.registerTool(
        'analyze_pcb',
        {
            title: 'Analyze KiCad PCB',
            description: `Run pinned kicad-happy PCB connectivity, placement, DFM, thermal-pad, and optional proximity checks. Returns compact grouped findings. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_pcb, .kicad_pro, or KiCad project directory.'),
                full: z.boolean().default(true)
                    .describe('Include the full copper connectivity graph and actionable suggestions.'),
                proximity: z.boolean().default(false)
                    .describe('Enable slower trace-proximity/crosstalk analysis after routing exists.'),
            }),
        },
        async ({ path, full, proximity }) => runTool(() => analyzePcb(path, full, proximity)),
    );
}
