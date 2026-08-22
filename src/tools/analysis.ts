import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { join } from 'node:path';
import { analyzePcb, analyzeSchematic } from '../analysis/kicad-happy';
import { auditLifecycle, waitAnalysis } from '../analysis/lifecycle-operation';
import { DOCS_DIR } from '../utils/dirs';
import { runTool } from '../utils/tool-result';

const ANALYSIS_DOC_PATH = join(DOCS_DIR, 'analysis.md');
const optionalReport = (description: string) => z.boolean().default(false).describe(description);

export function registerAnalysisTools(server: McpServer) {
    server.registerTool(
        'analyze_schematic',
        {
            title: 'Analyze KiCad Schematic',
            description: `Run pinned kicad-happy schematic checks offline. Findings are compact and enabled by default; optional booleans add focused top-level report fields. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_sch, .kicad_pro, or KiCad project directory.'),
                findings: z.boolean().default(true)
                    .describe('Return compact actionable findings. Disable when only focused report fields are needed.'),
                overview: optionalReport('Return structured project size and schematic statistics.'),
                hierarchy: optionalReport('Return sheets, hierarchical ports/labels, and hierarchy discovery warnings.'),
                blocks: optionalReport('Return detected functional blocks such as regulators, crystals, filters, and interfaces.'),
                connectivity: optionalReport('Return unconnected pins, single-pin nets, multi-driver nets, labels, and no-connect data.'),
                power: optionalReport('Return rails, voltage estimates, power tree, budget, sequencing, sleep current, and PDN observations.'),
                buses: optionalReport('Return detected buses, interfaces, differential pairs, and cross-domain signals.'),
                bom: optionalReport('Return compact BOM, sourcing coverage, missing properties, and optimization observations.'),
                assembly: optionalReport('Return package mix and estimated hand/professional assembly complexity.'),
                verification: optionalReport('Return test coverage, simulation readiness, protocol checks, and analysis trust coverage.'),
                all: optionalReport('Return every optional schematic report field. Does not override findings=false.'),
            }),
        },
        async (input) => runTool(() => analyzeSchematic(input.path, input)),
    );

    server.registerTool(
        'analyze_pcb',
        {
            title: 'Analyze KiCad PCB',
            description: `Run pinned kicad-happy PCB checks. The associated schematic is discovered automatically and used for PCB enrichment and cross-domain checks. Thermal and EMC are opt-in. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_pcb, .kicad_pro, or KiCad project directory.'),
                schematic: z.string().min(1).optional()
                    .describe('Optional root .kicad_sch override. Normally discovered from the PCB/project automatically.'),
                findings: z.boolean().default(true)
                    .describe('Return merged PCB, cross, thermal, and EMC findings. Disable for focused report-only queries.'),
                overview: optionalReport('Return board dimensions, layers, footprints, copper counts, zones, and routing completion.'),
                placement: optionalReport('Return placement density, component groups, courtyard/edge issues, and decoupling distances.'),
                routing: optionalReport('Return compact track/via distributions, net lengths, layer transitions, and proximity results.'),
                connectivity: optionalReport('Return copper connectivity, disconnected islands, plane splits, and zone continuity.'),
                power: optionalReport('Return power routing, current capacity, ground domains, decoupling proximity, and switching loops.'),
                buses: optionalReport('Return bus and differential-pair routing information enriched from the schematic.'),
                assembly: optionalReport('Return fiducials, orientation, test points, silkscreen, tombstoning, via-in-pad, and assembly complexity.'),
                dfm: optionalReport('Return fabrication process tier, rule compliance, manufacturing metrics, and DFM issues.'),
                cross: optionalReport('Return detailed schematic/PCB cross-domain analysis. Cross checks run automatically when a schematic exists.'),
                thermal: optionalReport('Run thermal analysis and return junction-temperature, margin, proximity, and thermal-via results.'),
                emc: optionalReport('Run analytical EMC pre-compliance checks and return risk score, categories, and test plan. SPICE is not used.'),
                proximity: optionalReport('Enable slower trace proximity and crosstalk analysis after routing exists.'),
                all: optionalReport('Return all optional PCB fields and run thermal and EMC. Does not override findings=false or enable proximity.'),
            }),
        },
        async (input) => runTool(() => analyzePcb(input.path, input)),
    );

    server.registerTool(
        'audit_lifecycle',
        {
            title: 'Audit Component Lifecycle',
            description: `Run network-backed component lifecycle and optional temperature-range checks. Long audits return an operation_id for wait_analysis. Analysis instructions: ${ANALYSIS_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1)
                    .describe('Path to a .kicad_sch, .kicad_pro, or KiCad project directory.'),
                sources: z.array(z.enum(['lcsc', 'digikey', 'mouser', 'element14'])).optional()
                    .describe('Optional distributor sources. Omit to use every source with available credentials.'),
                temperature: z.enum([
                    'commercial', 'industrial', 'extended', 'automotive', 'military',
                ]).optional().describe('Optional required operating-temperature grade.'),
                suggest_alternatives: z.boolean().default(false)
                    .describe('Search for replacement parts when obsolete, EOL, or NRND parts are found. Adds network requests.'),
                findings: z.boolean().default(true)
                    .describe('Return compact per-part lifecycle and temperature findings.'),
                wait_ms: z.number().int().min(1_000).max(30_000).default(5_000)
                    .describe('Initial synchronous wait. A still-running audit returns operation_id.'),
            }),
        },
        async (input) => runTool(() => auditLifecycle(input.path, {
            sources: input.sources,
            temperature: input.temperature,
            suggestAlternatives: input.suggest_alternatives,
            findings: input.findings,
        }, input.wait_ms)),
    );

    server.registerTool(
        'wait_analysis',
        {
            title: 'Wait Analysis',
            description: 'Wait for a running long analysis operation such as audit_lifecycle.',
            inputSchema: z.object({
                operation_id: z.string().uuid(),
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000)
                    .describe('Wait below the common 60-second MCP request timeout.'),
            }),
        },
        async ({ operation_id, wait_ms }) => runTool(() => waitAnalysis(operation_id, wait_ms)),
    );
}
