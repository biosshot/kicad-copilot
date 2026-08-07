import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

export type PcbNetClassRule = {
    name: string;
    clearance: number;
    trackWidth: number;
    viaDiameter: number;
    viaDrill: number;
    diffPairWidth: number;
    diffPairGap: number;
};

export type PcbRoutingRules = {
    minimumClearance: number;
    minimumTrackWidth: number;
    minimumViaDiameter: number;
    minimumViaDrill: number;
    minimumViaAnnularWidth: number;
    copperEdgeClearance: number;
    classes: PcbNetClassRule[];
    assignments: Record<string, string>;
    patterns: Array<{ netclass: string; pattern: string }>;
};

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as JsonObject
        : {};
}

function finite(value: unknown, fallback: number) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function classRule(value: unknown): PcbNetClassRule | undefined {
    const item = object(value);
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    if (!name) return undefined;
    return {
        name,
        clearance: finite(item.clearance, 0.2),
        trackWidth: finite(item.track_width, 0.25),
        viaDiameter: finite(item.via_diameter, 0.6),
        viaDrill: finite(item.via_drill, 0.3),
        diffPairWidth: finite(item.diff_pair_width, finite(item.track_width, 0.25)),
        diffPairGap: finite(item.diff_pair_gap, finite(item.clearance, 0.2)),
    };
}

function assignments(value: unknown) {
    const output: Record<string, string> = {};
    for (const [net, assigned] of Object.entries(object(value))) {
        if (typeof assigned === 'string') output[net] = assigned;
        else if (Array.isArray(assigned)) {
            const first = assigned.find((item): item is string => typeof item === 'string');
            if (first) output[net] = first;
        }
    }
    return output;
}

function patterns(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const item = object(entry);
        return typeof item.netclass === 'string' && typeof item.pattern === 'string'
            ? [{ netclass: item.netclass, pattern: item.pattern }]
            : [];
    });
}

function parseRoutingRules(source: string): PcbRoutingRules {
    const root = object(JSON.parse(source));
    const netSettings = object(root.net_settings);
    const designSettings = object(object(root.board).design_settings);
    const globalRules = object(designSettings.rules);
    const classes = (Array.isArray(netSettings.classes) ? netSettings.classes : [])
        .map(classRule)
        .filter((value): value is PcbNetClassRule => Boolean(value));
    if (!classes.some((item) => item.name === 'Default')) {
        classes.push(classRule({ name: 'Default' })!);
    }
    return {
        minimumClearance: finite(globalRules.min_clearance, 0),
        minimumTrackWidth: finite(globalRules.min_track_width, 0),
        minimumViaDiameter: finite(globalRules.min_via_diameter, 0),
        minimumViaDrill: finite(globalRules.min_through_hole_diameter, 0),
        minimumViaAnnularWidth: finite(globalRules.min_via_annular_width, 0),
        copperEdgeClearance: finite(globalRules.min_copper_edge_clearance, 0),
        classes,
        assignments: assignments(netSettings.netclass_assignments),
        patterns: patterns(netSettings.netclass_patterns),
    };
}

export async function findPcbProjectPath(pcbPath: string) {
    const absolute = resolve(pcbPath);
    const directory = dirname(absolute);
    const matching = join(directory, `${basename(absolute, extname(absolute))}.kicad_pro`);
    if (await readFile(matching, 'utf8').then(() => true, () => false)) return matching;
    const candidates = (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.kicad_pro'));
    return candidates.length === 1 ? join(directory, candidates[0].name) : undefined;
}

export async function readPcbRoutingRules(pcbPath: string) {
    const path = await findPcbProjectPath(pcbPath);
    if (!path) return parseRoutingRules('{}');
    return parseRoutingRules(await readFile(path, 'utf8'));
}

function patternRegex(pattern: string) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`, 'i');
}

export function netClassFor(rules: PcbRoutingRules, net: string) {
    const names = new Set(rules.classes.map((item) => item.name));
    const direct = rules.assignments[net];
    if (direct && names.has(direct)) return direct;
    const matched = rules.patterns.find((item) => names.has(item.netclass)
        && patternRegex(item.pattern).test(net));
    return matched?.netclass || 'Default';
}
