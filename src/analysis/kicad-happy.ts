import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { prepareManagedRouterAsset } from 'eda-copilot-router/backends/assets';
import { TEMP_DIR } from '../utils/dirs';
import { runProcessChecked } from '../utils/process';
import { getPython } from '../utils/python';
import {
    asRecord,
    projectPcb,
    projectSchematic,
    type JsonRecord,
    type PcbAnalysisOptions,
    type PcbRelatedReports,
    type SchematicAnalysisOptions,
} from './projections';

const KICAD_HAPPY_VERSION = 'v2.2.0';
const MAX_FINDING_GROUPS = 20;
const MAX_REFS = 12;
const KICAD_HAPPY_ARCHIVE = 'kicad-happy-v2.2.0.zip';

const EXTRACT_KICAD_HAPPY = String.raw`
import pathlib
import stat
import sys
import zipfile

archive = pathlib.Path(sys.argv[1])
output = pathlib.Path(sys.argv[2]).resolve()
archive_root = "kicad-happy-2.2.0/"
skill_prefixes = {
    archive_root + "skills/kicad/": pathlib.PurePosixPath("skills/kicad"),
    archive_root + "skills/emc/": pathlib.PurePosixPath("skills/emc"),
}

with zipfile.ZipFile(archive) as source:
    for entry in source.infolist():
        name = entry.filename.replace("\\", "/")
        if name == archive_root + "LICENSE":
            relative = pathlib.PurePosixPath("LICENSE")
        else:
            relative = None
            for skill_prefix, target_prefix in skill_prefixes.items():
                if name.startswith(skill_prefix):
                    relative = target_prefix / name[len(skill_prefix):]
                    break
            if relative is None:
                continue

        if not relative.parts:
            continue

        if any(part in ("", ".", "..") for part in relative.parts):
            raise RuntimeError(f"Unsafe archive path: {name}")
        mode = entry.external_attr >> 16
        if stat.S_ISLNK(mode):
            continue

        target = output.joinpath(*relative.parts).resolve()
        if output != target and output not in target.parents:
            raise RuntimeError(f"Archive path escapes output directory: {name}")
        if entry.is_dir():
            target.mkdir(parents=True, exist_ok=True)
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(source.read(entry))
`;

async function extractKicadHappy(directory: string) {
    const python = await getPython();
    await runProcessChecked(
        python.command,
        [
            ...python.prefixArgs,
            '-X',
            'utf8',
            '-c',
            EXTRACT_KICAD_HAPPY,
            join(directory, KICAD_HAPPY_ARCHIVE),
            directory,
        ],
        { cwd: directory, timeoutMs: 120_000 },
    );
}

const KICAD_HAPPY_RELEASE = {
    backend: 'kicad-happy',
    version: KICAD_HAPPY_VERSION,
    url: 'https://github.com/aklofas/kicad-happy/archive/refs/tags/v2.2.0.zip',
    sha256: 'f486249e739779c513b636090d101dd8b213d10d54f1d4440cc332536778dbba',
    sizeBytes: 1_465_127,
    archive: 'file' as const,
    fileName: KICAD_HAPPY_ARCHIVE,
    markers: [
        'skills/kicad/scripts/analyze_schematic.py',
        'skills/kicad/scripts/analyze_pcb.py',
        'skills/kicad/scripts/cross_analysis.py',
        'skills/kicad/scripts/analyze_thermal.py',
        'skills/kicad/scripts/lifecycle_audit.py',
        'skills/emc/scripts/analyze_emc.py',
    ],
    prepareDirectory: extractKicadHappy,
};

export type AnalysisSeverity = 'error' | 'warning' | 'info';

export type AnalysisFinding = {
    severity: AnalysisSeverity;
    message: string;
    refs?: string[];
    fix?: string;
};

export type AnalysisResult = {
    status: 'pass' | 'warn' | 'fail';
    summary: string;
    skipped: string[];
    findings?: AnalysisFinding[];
} & JsonRecord;

type AnalysisDomain = 'schematic' | 'pcb' | 'lifecycle';

type FindingCandidate = {
    severity: AnalysisSeverity;
    message: string;
    refs: string[];
    fix?: string;
    detector: string;
    ruleId: string;
    category: string;
    raw: JsonRecord;
};

type FindingGroup = {
    key: string;
    items: FindingCandidate[];
};

let assetPreparation: ReturnType<typeof prepareManagedRouterAsset> | undefined;

function stringValue(value: unknown) {
    return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function normalizeSeverity(value: unknown): AnalysisSeverity {
    const severity = stringValue(value).toLowerCase();
    if (severity === 'critical' || severity === 'high' || severity === 'error' || severity === 'fail') {
        return 'error';
    }
    if (severity === 'medium' || severity === 'warning' || severity === 'warn') return 'warning';
    return 'info';
}

function meaningfulRefs(finding: JsonRecord, detector: string, ruleId: string) {
    if (detector === 'audit_datasheet_coverage' && ruleId !== 'DS-003') return [];
    const candidates = detector === 'analyze_connectivity' && ruleId === 'RT-001'
        ? stringArray(finding.nets)
        : [...stringArray(finding.components), ...stringArray(finding.nets)];
    return [...new Set(candidates.filter((value) => (
        !value.startsWith('#') && !value.startsWith('__unnamed_')
    )))];
}

function powerPinsForNet(raw: JsonRecord, netName: string) {
    const nets = asRecord(raw.nets);
    const net = nets ? asRecord(nets[netName]) : undefined;
    if (!net || !Array.isArray(net.pins)) return [];
    return net.pins
        .map(asRecord)
        .filter((pin): pin is JsonRecord => pin !== undefined && pin.pin_type === 'power_in');
}

function isSyntheticPortRailFinding(finding: JsonRecord, raw: JsonRecord) {
    if (stringValue(finding.detector) !== 'audit_rail_sources'
        || stringValue(finding.rule_id) !== 'RS-001') return false;

    const netNames = stringArray(finding.nets);
    if (netNames.length > 0) {
        const powerPins = netNames.flatMap((netName) => powerPinsForNet(raw, netName));
        if (powerPins.length > 0 && powerPins.every((pin) => (
            stringValue(pin.component).startsWith('#PORT')
        ))) return true;
    }

    const findingPins = stringArray(finding.pins);
    return findingPins.length > 0 && findingPins.every((pin) => pin.startsWith('#PORT'));
}

function findingCandidate(
    finding: JsonRecord,
    raw: JsonRecord,
    includeActionableInfo: boolean,
): FindingCandidate | undefined {
    if (isSyntheticPortRailFinding(finding, raw)) return undefined;

    const severity = normalizeSeverity(finding.severity);
    const recommendation = stringValue(finding.recommendation);
    const detector = stringValue(finding.detector);
    const ruleId = stringValue(finding.rule_id);
    if (detector === 'audit_datasheet_coverage' && ruleId === 'DS-002') return undefined;
    if (severity === 'info') {
        if (!includeActionableInfo || !recommendation) return undefined;
        if (detector === 'audit_lifecycle_skipped') return undefined;
    }

    const message = stringValue(finding.summary) || stringValue(finding.description);
    if (!message) return undefined;

    return {
        severity,
        message,
        refs: meaningfulRefs(finding, detector, ruleId),
        fix: recommendation || undefined,
        detector,
        ruleId,
        category: stringValue(finding.category),
        raw: finding,
    };
}

function groupCandidates(candidates: FindingCandidate[]) {
    const groups = new Map<string, FindingGroup>();
    for (const candidate of candidates) {
        const key = [candidate.severity, candidate.detector, candidate.ruleId, candidate.category].join('|');
        const existing = groups.get(key);
        if (existing) existing.items.push(candidate);
        else groups.set(key, { key, items: [candidate] });
    }
    return [...groups.values()];
}

function groupMessage(group: FindingGroup) {
    const first = group.items[0];
    if (group.items.length === 1) return first.message;

    if (first.detector === 'analyze_connectivity' && first.ruleId === 'RT-001') {
        const largest = [...group.items]
            .sort((a, b) => Number(b.raw.pad_count ?? 0) - Number(a.raw.pad_count ?? 0))
            .slice(0, 3)
            .map((item) => item.message);
        return `${group.items.length} unrouted nets. Largest: ${largest.join('; ')}`;
    }
    if (first.detector === 'audit_rail_sources' && first.ruleId === 'RS-001') {
        return `${group.items.length} power rails have no declared source.`;
    }
    if (first.detector === 'analyze_placement' && first.ruleId === 'PM-002') {
        return `${group.items.length} board-edge placement findings. Example: ${first.message}`;
    }

    return `${first.message} (+${group.items.length - 1} similar findings)`;
}

function compactGroup(group: FindingGroup) {
    const refs = [...new Set(group.items.flatMap((item) => item.refs))];
    const first = group.items[0];
    let firstFix = group.items.find((item) => item.fix)?.fix;
    if (first.detector === 'analyze_connectivity' && first.ruleId === 'RT-001') {
        firstFix = 'Route the listed nets before detailed PCB review.';
    } else if (first.detector === 'audit_rail_sources' && first.ruleId === 'RS-001') {
        firstFix = 'Declare the actual source for each rail with a power output or PWR_FLAG.';
    } else if (first.detector === 'audit_datasheet_coverage') {
        firstFix = first.ruleId === 'DS-001'
            ? 'Populate manufacturer part numbers before making part-specific claims.'
            : 'Populate the missing manufacturer part numbers.';
    } else if (first.detector === 'analyze_thermal_pad_vias' && group.items.length > 1) {
        firstFix = 'Add or verify thermal vias for the listed components.';
    }
    const finding: AnalysisFinding = {
        severity: group.items[0].severity,
        message: groupMessage(group),
    };
    if (refs.length) finding.refs = refs.slice(0, MAX_REFS);
    if (firstFix) finding.fix = firstFix;
    return finding;
}

function severityRank(severity: AnalysisSeverity) {
    if (severity === 'error') return 0;
    if (severity === 'warning') return 1;
    return 2;
}

function resultSummary(domain: AnalysisDomain, candidates: FindingCandidate[]) {
    if (!candidates.length) return `No actionable ${domain} findings.`;
    const errors = candidates.filter((item) => item.severity === 'error').length;
    const warnings = candidates.filter((item) => item.severity === 'warning').length;
    const suggestions = candidates.filter((item) => item.severity === 'info').length;
    const counts = [
        errors ? `${errors} error${errors === 1 ? '' : 's'}` : '',
        warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '',
        suggestions ? `${suggestions} suggestion${suggestions === 1 ? '' : 's'}` : '',
    ].filter(Boolean);
    const label = domain === 'pcb' ? 'PCB' : domain === 'schematic' ? 'Schematic' : 'Lifecycle';
    return `${label}: ${counts.join(', ')}.`;
}

function compactReports(
    rawValues: unknown[],
    domain: AnalysisDomain,
    options: {
        includeActionableInfo: boolean;
        includeFindings: boolean;
        skipped: string[];
    },
): AnalysisResult {
    const raws = rawValues.map(asRecord).filter((raw): raw is JsonRecord => raw !== undefined);
    if (!raws.length) throw new Error(`kicad-happy returned an invalid ${domain} report`);

    const candidates = raws.flatMap((raw) => {
        const rawFindings = Array.isArray(raw.findings)
            ? raw.findings.map(asRecord).filter((finding): finding is JsonRecord => finding !== undefined)
            : [];
        return rawFindings
            .map((finding) => findingCandidate(finding, raw, options.includeActionableInfo))
            .filter((finding): finding is FindingCandidate => finding !== undefined);
    });
    const groups = groupCandidates(candidates).sort((a, b) => {
        const severity = severityRank(a.items[0].severity) - severityRank(b.items[0].severity);
        return severity || b.items.length - a.items.length || a.key.localeCompare(b.key);
    });
    const selectedGroups = groups.slice(0, MAX_FINDING_GROUPS);
    const findings = selectedGroups.map(compactGroup);

    const hasErrors = candidates.some((item) => item.severity === 'error');
    const result: AnalysisResult = {
        status: hasErrors ? 'fail' : candidates.length ? 'warn' : 'pass',
        summary: resultSummary(domain, candidates),
        skipped: options.skipped,
    };
    if (options.includeFindings) result.findings = findings;
    return result;
}

export function compactAnalysis(
    rawValue: unknown,
    domain: 'schematic' | 'pcb',
    options: { includeActionableInfo: boolean },
): AnalysisResult {
    return compactReports([rawValue], domain, {
        includeActionableInfo: options.includeActionableInfo,
        includeFindings: true,
        skipped: [],
    });
}

async function prepareKicadHappy() {
    assetPreparation ??= prepareManagedRouterAsset(
        KICAD_HAPPY_RELEASE,
        {},
        process.env.KICAD_HAPPY_DIR,
    ).catch((error) => {
        assetPreparation = undefined;
        throw error;
    });
    return assetPreparation;
}

async function checkedInputPath(inputPath: string) {
    const path = resolve(inputPath);
    await stat(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            throw new Error(`Analysis input does not exist: ${path}`);
        }
        throw error;
    });
    return path;
}

type PreparedRuntime = Awaited<ReturnType<typeof prepareKicadHappy>>;
type PythonRuntime = Awaited<ReturnType<typeof getPython>>;

async function readReport(reportPath: string) {
    const source = await readFile(reportPath, 'utf8');
    try {
        const raw = asRecord(JSON.parse(source));
        if (!raw) throw new Error('not an object');
        return raw;
    } catch {
        throw new Error(`kicad-happy returned invalid JSON: ${reportPath}`);
    }
}

async function runScript(
    asset: PreparedRuntime,
    python: PythonRuntime,
    runDirectory: string,
    skill: 'kicad' | 'emc',
    scriptName: string,
    args: string[],
    reportPath: string,
    timeoutMs = 300_000,
) {
    const script = join(asset.directory, 'skills', skill, 'scripts', scriptName);
    await runProcessChecked(
        python.command,
        [
            ...python.prefixArgs,
            '-X',
            'utf8',
            script,
            ...args,
            '--output',
            reportPath,
        ],
        { cwd: runDirectory, timeoutMs },
    );
    return readReport(reportPath);
}

async function createRun() {
    const runDirectory = join(TEMP_DIR, 'analysis', randomUUID());
    await mkdir(runDirectory, { recursive: true });
    return runDirectory;
}

async function writeResult(runDirectory: string, result: AnalysisResult) {
    await writeFile(join(runDirectory, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
}

async function automaticSchematicInput(inputPath: string, override?: string) {
    if (override) return checkedInputPath(override);
    const extension = extname(inputPath).toLowerCase();
    if (extension !== '.kicad_pcb') return inputPath;
    const sibling = join(dirname(inputPath), `${basename(inputPath, extension)}.kicad_sch`);
    return stat(sibling).then(() => sibling, () => undefined);
}

export async function analyzeSchematic(
    inputPath: string,
    options: SchematicAnalysisOptions = {},
) {
    const [asset, python, path, runDirectory] = await Promise.all([
        prepareKicadHappy(),
        getPython(),
        checkedInputPath(inputPath),
        createRun(),
    ]);
    const reportPath = join(runDirectory, 'schematic.json');
    const raw = await runScript(
        asset,
        python,
        runDirectory,
        'kicad',
        'analyze_schematic.py',
        [path, '--compact'],
        reportPath,
    );
    const result = compactReports([raw], 'schematic', {
        includeActionableInfo: true,
        includeFindings: options.findings !== false,
        skipped: ['Native KiCad ERC was not run by analyze_schematic.'],
    });
    Object.assign(result, projectSchematic(raw, options));
    return writeResult(runDirectory, result);
}

export async function analyzePcb(inputPath: string, options: PcbAnalysisOptions = {}) {
    const [asset, python, path, runDirectory] = await Promise.all([
        prepareKicadHappy(),
        getPython(),
        checkedInputPath(inputPath),
        createRun(),
    ]);
    const requestedThermal = options.thermal === true || options.all === true;
    const requestedEmc = options.emc === true || options.all === true;
    const schematicInput = await automaticSchematicInput(path, options.schematic);
    const schematicPath = join(runDirectory, 'schematic.json');
    const pcbPath = join(runDirectory, 'pcb.json');
    const crossPath = join(runDirectory, 'cross.json');
    const thermalPath = join(runDirectory, 'thermal.json');
    const emcPath = join(runDirectory, 'emc.json');

    let schematic: JsonRecord | undefined;
    if (schematicInput) {
        schematic = await runScript(
            asset, python, runDirectory, 'kicad', 'analyze_schematic.py',
            [schematicInput, '--compact'], schematicPath,
        );
    }

    const pcbFlags = [path, '--compact', '--full'];
    if (options.proximity) pcbFlags.push('--proximity');
    if (schematic) pcbFlags.push('--schematic', schematicPath);
    const pcb = await runScript(
        asset, python, runDirectory, 'kicad', 'analyze_pcb.py', pcbFlags, pcbPath,
    );

    let cross: JsonRecord | undefined;
    if (schematic) {
        cross = await runScript(
            asset, python, runDirectory, 'kicad', 'cross_analysis.py',
            ['--schematic', schematicPath, '--pcb', pcbPath], crossPath,
        );
    }

    const skipped = ['Native KiCad DRC was not run by analyze_pcb.'];
    if (!schematic) skipped.push('Cross-domain analysis was skipped because no schematic was found.');

    let thermal: JsonRecord | undefined;
    if (requestedThermal && schematic) {
        thermal = await runScript(
            asset, python, runDirectory, 'kicad', 'analyze_thermal.py',
            ['--schematic', schematicPath, '--pcb', pcbPath], thermalPath,
        );
        const reason = String(asRecord(thermal.summary)?.skipped_reason || '').trim();
        if (reason) skipped.push(`Thermal analysis: ${reason}`);
    } else if (requestedThermal) {
        skipped.push('Thermal analysis was skipped because no schematic was found.');
    }

    let emc: JsonRecord | undefined;
    if (requestedEmc && schematic) {
        emc = await runScript(
            asset, python, runDirectory, 'emc', 'analyze_emc.py',
            ['--schematic', schematicPath, '--pcb', pcbPath], emcPath,
        );
    } else if (requestedEmc) {
        skipped.push('EMC analysis was skipped because no schematic was found.');
    }

    const related: PcbRelatedReports = { schematic, cross, thermal, emc };
    const result = compactReports(
        [pcb, cross, thermal, emc].filter((raw): raw is JsonRecord => raw !== undefined),
        'pcb',
        {
            includeActionableInfo: true,
            includeFindings: options.findings !== false,
            skipped,
        },
    );
    Object.assign(result, projectPcb(pcb, related, options));
    return writeResult(runDirectory, result);
}

export type LifecycleAuditOptions = {
    sources?: Array<'lcsc' | 'digikey' | 'mouser' | 'element14'>;
    temperature?: 'commercial' | 'industrial' | 'extended' | 'automotive' | 'military' | string;
    suggestAlternatives?: boolean;
    findings?: boolean;
};

export async function runLifecycleAudit(inputPath: string, options: LifecycleAuditOptions = {}) {
    const [asset, python, path, runDirectory] = await Promise.all([
        prepareKicadHappy(),
        getPython(),
        checkedInputPath(inputPath),
        createRun(),
    ]);
    const schematicPath = join(runDirectory, 'schematic.json');
    const lifecyclePath = join(runDirectory, 'lifecycle.json');
    await runScript(
        asset, python, runDirectory, 'kicad', 'analyze_schematic.py',
        [path, '--compact'], schematicPath,
    );
    const flags = [schematicPath];
    if (options.sources?.length) flags.push('--only', options.sources.join(','));
    if (options.temperature) flags.push(`--temp-range=${options.temperature}`);
    if (options.suggestAlternatives) flags.push('--suggest-alternatives');
    const lifecycle = await runScript(
        asset, python, runDirectory, 'kicad', 'lifecycle_audit.py',
        flags, lifecyclePath, 1_800_000,
    );
    const skipped: string[] = [];
    const capabilityNote = String(lifecycle.capability_note || '').trim();
    if (capabilityNote) skipped.push(capabilityNote);
    const missingMpn = Number(lifecycle.components_without_mpn || 0);
    if (missingMpn > 0) skipped.push(`${missingMpn} component(s) were skipped because no MPN was available.`);
    const result = compactReports([lifecycle], 'lifecycle', {
        includeActionableInfo: true,
        includeFindings: options.findings !== false,
        skipped,
    });
    if (capabilityNote && result.status === 'pass') result.status = 'warn';
    result.lifecycle = {
        components_checked: lifecycle.components_checked,
        components_without_mpn: lifecycle.components_without_mpn,
        sources_available: lifecycle.sources_available,
        lifecycle_summary: lifecycle.lifecycle_summary,
        temperature_summary: lifecycle.temperature_summary,
        observations: lifecycle.observations,
        capability_note: lifecycle.capability_note,
    };
    return writeResult(runDirectory, result);
}
