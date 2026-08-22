import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareManagedRouterAsset } from 'eda-copilot-router/backends/assets';
import { TEMP_DIR } from '../utils/dirs';
import { runProcessChecked } from '../utils/process';
import { getPython } from '../utils/python';

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
skill_prefix = archive_root + "skills/kicad/"

with zipfile.ZipFile(archive) as source:
    for entry in source.infolist():
        name = entry.filename.replace("\\", "/")
        if name == archive_root + "LICENSE":
            relative = pathlib.PurePosixPath("LICENSE")
        else:
            if not name.startswith(skill_prefix):
                continue
            relative = pathlib.PurePosixPath("skills/kicad") / name[len(skill_prefix):]

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
    findings: AnalysisFinding[];
    report?: string;
};

type AnalysisDomain = 'schematic' | 'pcb';
type JsonRecord = Record<string, unknown>;

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

function asRecord(value: unknown): JsonRecord | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonRecord
        : undefined;
}

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
    return { finding, refsTruncated: refs.length > MAX_REFS };
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
    return `${domain === 'pcb' ? 'PCB' : 'Schematic'}: ${counts.join(', ')}.`;
}

export function compactAnalysis(
    rawValue: unknown,
    domain: AnalysisDomain,
    options: { includeActionableInfo: boolean; reportPath: string },
): AnalysisResult {
    const raw = asRecord(rawValue);
    if (!raw) throw new Error(`kicad-happy returned an invalid ${domain} report`);

    const rawFindings = Array.isArray(raw.findings)
        ? raw.findings.map(asRecord).filter((finding): finding is JsonRecord => finding !== undefined)
        : [];
    const candidates = rawFindings
        .map((finding) => findingCandidate(finding, raw, options.includeActionableInfo))
        .filter((finding): finding is FindingCandidate => finding !== undefined);
    const groups = groupCandidates(candidates).sort((a, b) => {
        const severity = severityRank(a.items[0].severity) - severityRank(b.items[0].severity);
        return severity || b.items.length - a.items.length || a.key.localeCompare(b.key);
    });
    const selectedGroups = groups.slice(0, MAX_FINDING_GROUPS);
    const compacted = selectedGroups.map(compactGroup);
    const findings = compacted.map((item) => item.finding);

    const hasErrors = candidates.some((item) => item.severity === 'error');
    const result: AnalysisResult = {
        status: hasErrors ? 'fail' : candidates.length ? 'warn' : 'pass',
        summary: resultSummary(domain, candidates),
        findings,
    };
    const detailsHidden = groups.length > selectedGroups.length
        || groups.some((group) => group.items.length > 1)
        || compacted.some((item) => item.refsTruncated);
    if (detailsHidden) result.report = options.reportPath;
    return result;
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

async function runAnalyzer(
    domain: AnalysisDomain,
    inputPath: string,
    flags: string[],
    includeActionableInfo: boolean,
) {
    const [asset, python, path] = await Promise.all([
        prepareKicadHappy(),
        getPython(),
        checkedInputPath(inputPath),
    ]);
    const runDirectory = join(TEMP_DIR, 'analysis', randomUUID());
    await mkdir(runDirectory, { recursive: true });
    const reportPath = join(runDirectory, `${domain}.json`);
    const resultPath = join(runDirectory, 'result.json');
    const script = join(
        asset.directory,
        'skills',
        'kicad',
        'scripts',
        domain === 'schematic' ? 'analyze_schematic.py' : 'analyze_pcb.py',
    );

    await runProcessChecked(
        python.command,
        [
            ...python.prefixArgs,
            '-X',
            'utf8',
            script,
            path,
            '--output',
            reportPath,
            '--compact',
            ...flags,
        ],
        { cwd: runDirectory, timeoutMs: 300_000 },
    );

    const readReport = async () => {
        const source = await readFile(reportPath, 'utf8');
        try {
            const raw = asRecord(JSON.parse(source));
            if (!raw) throw new Error('not an object');
            return raw;
        } catch {
            throw new Error(`kicad-happy returned invalid JSON: ${reportPath}`);
        }
    };
    const raw = await readReport();
    const result = compactAnalysis(raw, domain, { includeActionableInfo, reportPath });
    await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    return result;
}

export function analyzeSchematic(path: string, mode: 'quick' | 'full') {
    const flags = mode === 'quick' ? ['--only-deterministic'] : [];
    return runAnalyzer('schematic', path, flags, mode === 'full');
}

export function analyzePcb(path: string, full: boolean, proximity: boolean) {
    const flags = [
        ...(full ? ['--full'] : []),
        ...(proximity ? ['--proximity'] : []),
    ];
    return runAnalyzer('pcb', path, flags, full);
}
