import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import type {
    PointMm,
    RoutedTrack,
    RoutedVia,
    RoutedZone,
    RoutingBoard,
    RoutingCopper,
    RoutingDiagnostic,
    RoutingResult,
    RoutingRuleValues,
    RoutingRules,
} from '@easyeda-copilot/router';
import { validateRoutingBoard } from '@easyeda-copilot/router';
import {
    childText,
    footprintAt,
    footprintLayer,
    footprintReference,
    listChildren,
    padNet,
    padNumber,
    pcbFootprints,
    readPcb,
    type PcbDocument,
} from '../kicad/pcb-reader';
import { inspectPcbCandidate } from '../kicad/pcb-validation';
import { serializePcb, sourceHash } from '../kicad/pcb-writer';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    token,
    type SExpression,
} from '../kicad/sexpr/ast';
import { boardOutline } from '../pcb/board-geometry';
import {
    findPcbProjectPath,
    netClassFor,
    readPcbRoutingRules,
    type PcbRoutingRules,
} from '../pcb/router-rules';

const EMPTY_COPPER: RoutingCopper = { tracks: [], vias: [], zones: [] };
const ROUTER_ZONE_PREFIX = 'copilot-router:';

export type KiCadRouterImportOptions = Readonly<{
    /** Existing unlocked copper becomes router-owned only when requested. */
    existingCopper?: 'fixed' | 'editable';
}>;

export type KiCadRoutingContext = Readonly<{
    document: PcbDocument;
    existingCopper: 'fixed' | 'editable';
}>;

export type KiCadRoutingImport = Readonly<{
    board?: RoutingBoard;
    context?: KiCadRoutingContext;
    diagnostics: readonly RoutingDiagnostic[];
}>;

export type KiCadRoutingApplyResult = Readonly<{
    outputPath?: string;
    diagnostics: readonly RoutingDiagnostic[];
    nativeVerification: 'passed' | 'failed' | 'not-run';
    report?: unknown;
}>;

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
    const value = Number(atom(node?.[index]));
    return Number.isFinite(value) ? value : fallback;
}

function pointAt(node: SExpression[] | undefined): PointMm {
    return { x: numberAt(node, 1), y: numberAt(node, 2) };
}

function rotate(point: PointMm, degrees: number): PointMm {
    const radians = degrees * Math.PI / 180;
    return {
        x: point.x * Math.cos(radians) - point.y * Math.sin(radians),
        y: point.x * Math.sin(radians) + point.y * Math.cos(radians),
    };
}

function transformFootprintPoint(point: PointMm, at: ReturnType<typeof footprintAt>, bottom: boolean) {
    const mirrored = bottom ? { x: -point.x, y: point.y } : point;
    const placed = rotate(mirrored, bottom ? at.rotate : -at.rotate);
    return { x: at.x + placed.x, y: at.y + placed.y };
}

function copperLayers(root: SExpression[]) {
    const layers = findChild(root, 'layers');
    const names = layers?.slice(1).flatMap(item => {
        if (!isSExpressionList(item)) return [];
        const name = atom(item[1]);
        return name?.endsWith('.Cu') ? [name] : [];
    }) ?? [];
    return names.length ? names : ['F.Cu', 'B.Cu'];
}

function padLayers(pad: SExpression[], available: readonly string[], footprintSide: string) {
    const values = findChild(pad, 'layers')?.slice(1).map(atom).filter((item): item is string => Boolean(item)) ?? [];
    if (values.includes('*.Cu')) return [...available];
    const copper = values.filter(item => item.endsWith('.Cu'));
    return copper.length ? copper : [footprintSide];
}

function padShape(pad: SExpression[]): RoutingBoard['pads'][number]['shape'] {
    const kind = atom(pad[3]) ?? 'rect';
    const widthMm = Math.max(0.001, numberAt(findChild(pad, 'size'), 1, 0.001));
    const heightMm = Math.max(0.001, numberAt(findChild(pad, 'size'), 2, widthMm));
    if (kind === 'circle') return { kind: 'circle', diameterMm: widthMm };
    if (kind === 'oval') return { kind: 'oval', widthMm, heightMm };
    if (kind === 'roundrect') return {
        kind: 'round-rect', widthMm, heightMm,
        cornerRadiusMm: Math.min(widthMm, heightMm) * numberAt(findChild(pad, 'roundrect_rratio'), 1, 0.25),
    };
    // KiCad custom primitives need a full polygon boolean implementation.
    // Refuse them instead of inventing a lossy obstacle.
    if (kind !== 'rect') throw new TypeError(`unsupported KiCad pad shape: ${kind}`);
    return { kind: 'rect', widthMm, heightMm };
}

function padHole(pad: SExpression[]) {
    const drill = findChild(pad, 'drill');
    if (!drill) return undefined;
    const values = drill.slice(1).map(atom).map(Number).filter(value => Number.isFinite(value) && value > 0);
    if (!values.length) return undefined;
    const slot = values.length > 1;
    return {
        shape: slot ? 'slot' as const : 'round' as const,
        diameterMm: Math.min(...values),
        ...(slot ? { slotLengthMm: Math.max(...values) } : {}),
        plated: atom(pad[2]) !== 'np_thru_hole',
    };
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
    const net = findChild(node, 'net');
    if (!net) return '';
    if (net.length >= 3) return atom(net[2]) ?? '';
    const value = atom(net[1]) ?? '';
    if (!/^\d+$/.test(value)) return value;
    return atom(listChildren(root, 'net').find(item => atom(item[1]) === value)?.[2]) ?? '';
}

function locked(node: SExpression[]) {
    const item = findChild(node, 'locked');
    return Boolean(item && (item.length === 1 || atom(item[1]) === 'yes'));
}

function arcPoints(node: SExpression[]) {
    const start = pointAt(findChild(node, 'start'));
    const mid = pointAt(findChild(node, 'mid'));
    const end = pointAt(findChild(node, 'end'));
    const determinant = 2 * (start.x * (mid.y - end.y) + mid.x * (end.y - start.y) + end.x * (start.y - mid.y));
    if (Math.abs(determinant) < 1e-9) return [start, end];
    const start2 = start.x ** 2 + start.y ** 2;
    const mid2 = mid.x ** 2 + mid.y ** 2;
    const end2 = end.x ** 2 + end.y ** 2;
    const center = {
        x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
        y: (start2 * (end.x - mid.x) + mid2 * (end.y - start.y) + end2 * (mid.x - start.x)) / determinant,
    };
    const angle = (point: PointMm) => Math.atan2(point.y - center.y, point.x - center.x);
    const tau = Math.PI * 2;
    const normalized = (value: number) => ((value % tau) + tau) % tau;
    const from = angle(start);
    let to = angle(end);
    const ccwSpan = normalized(to - from);
    if (normalized(angle(mid) - from) > ccwSpan) while (to >= from) to -= tau;
    else while (to <= from) to += tau;
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const count = Math.max(2, Math.ceil(Math.abs(to - from) * radius / 0.25));
    return Array.from({ length: count + 1 }, (_, index) => {
        const current = from + (to - from) * index / count;
        return { x: center.x + Math.cos(current) * radius, y: center.y + Math.sin(current) * radius };
    });
}

function zoneOutline(root: SExpression[], zone: SExpression[]): RoutedZone | undefined {
    const rootPolygon = listChildren(zone, 'polygon')[0];
    const outer = listChildren(findChild(rootPolygon ?? [], 'pts') ?? [], 'xy').map(pointAt);
    const net = nodeNetName(root, zone) || childText(zone, 'net_name') || '';
    const layerValues = findChild(zone, 'layers')?.slice(1).map(atom).filter((item): item is string => Boolean(item));
    const layers = layerValues?.length ? layerValues : [childText(zone, 'layer') ?? 'F.Cu'];
    if (!net || outer.length < 3) return undefined;
    return {
        id: childText(zone, 'uuid') ?? childText(zone, 'tstamp'),
        net,
        layers,
        outline: { outer },
        priority: numberAt(findChild(zone, 'priority'), 1, 0),
        minThicknessMm: numberAt(findChild(zone, 'min_thickness'), 1, 0.1),
        connection: findChild(zone, 'connect_pads')?.some(item => atom(item) === 'yes') ? 'solid' : 'thermal',
    };
}

function importedKeepouts(root: SExpression[], knownLayers: readonly string[]) {
    return listChildren(root, 'zone').flatMap((zone, index): RoutingBoard['keepouts'][number][] => {
        const specification = findChild(zone, 'keepout');
        if (!specification) return [];
        const polygons = listChildren(zone, 'polygon').map(item => (
            listChildren(findChild(item, 'pts') ?? [], 'xy').map(pointAt)
        )).filter(points => points.length >= 3);
        if (!polygons.length) return [];
        const layerValues = findChild(zone, 'layers')?.slice(1).map(atom).filter((item): item is string => Boolean(item));
        const layers = (layerValues?.length ? layerValues : [childText(zone, 'layer') ?? 'F.Cu'])
            .filter(layer => knownLayers.includes(layer));
        if (!layers.length) return [];
        const forbidden = (head: string) => atom(findChild(specification, head)?.[1]) === 'not_allowed';
        return polygons.map((outer, polygonIndex) => ({
            id: childText(zone, 'uuid') ?? childText(zone, 'tstamp') ?? `keepout-${index}-${polygonIndex}`,
            layers,
            polygon: { outer },
            forbid: {
                tracks: forbidden('tracks'),
                vias: forbidden('vias'),
                zones: forbidden('copperpour'),
            },
        }));
    });
}

function importedCopper(root: SExpression[]) {
    const tracks: Array<RoutedTrack & { sourceLocked: boolean }> = [];
    for (const [index, segment] of listChildren(root, 'segment').entries()) tracks.push({
        id: childText(segment, 'uuid') ?? childText(segment, 'tstamp') ?? `segment-${index}`,
        net: nodeNetName(root, segment),
        layer: childText(segment, 'layer') ?? 'F.Cu',
        widthMm: numberAt(findChild(segment, 'width'), 1, 0.2),
        points: [pointAt(findChild(segment, 'start')), pointAt(findChild(segment, 'end'))],
        sourceLocked: locked(segment),
    });
    for (const [index, arc] of listChildren(root, 'arc').entries()) tracks.push({
        id: childText(arc, 'uuid') ?? childText(arc, 'tstamp') ?? `arc-${index}`,
        net: nodeNetName(root, arc),
        layer: childText(arc, 'layer') ?? 'F.Cu',
        widthMm: numberAt(findChild(arc, 'width'), 1, 0.2),
        points: arcPoints(arc),
        sourceLocked: locked(arc),
    });
    const vias: Array<RoutedVia & { sourceLocked: boolean }> = listChildren(root, 'via').map((via, index) => {
        const layerValues = findChild(via, 'layers')?.slice(1).map(atom).filter((item): item is string => Boolean(item)) ?? ['F.Cu', 'B.Cu'];
        return {
            id: childText(via, 'uuid') ?? childText(via, 'tstamp') ?? `via-${index}`,
            net: nodeNetName(root, via), at: pointAt(findChild(via, 'at')),
            diameterMm: numberAt(findChild(via, 'size'), 1, 0.6),
            drillMm: numberAt(findChild(via, 'drill'), 1, 0.3),
            fromLayer: layerValues[0] ?? 'F.Cu', toLayer: layerValues.at(-1) ?? 'B.Cu',
            type: findChild(via, 'micro') ? 'micro' as const : 'through' as const,
            sourceLocked: locked(via),
        };
    });
    const zones = listChildren(root, 'zone').map(zone => {
        const parsed = zoneOutline(root, zone);
        return parsed ? { ...parsed, sourceLocked: locked(zone) } : undefined;
    }).filter((item): item is RoutedZone & { sourceLocked: boolean } => Boolean(item));
    return { tracks, vias, zones };
}

function ruleValues(rule: PcbRoutingRules['classes'][number], source: PcbRoutingRules): RoutingRuleValues {
    const minTrack = Math.max(source.minimumTrackWidth, rule.trackWidth);
    const minDrill = Math.max(source.minimumViaDrill, rule.viaDrill);
    const minDiameter = Math.max(source.minimumViaDiameter, rule.viaDiameter, minDrill + source.minimumViaAnnularWidth * 2);
    return {
        clearanceMm: Math.max(source.minimumClearance, rule.clearance),
        edgeClearanceMm: Math.max(source.copperEdgeClearance, source.minimumClearance, rule.clearance),
        minTrackWidthMm: minTrack,
        preferredTrackWidthMm: minTrack,
        via: {
            minDiameterMm: minDiameter, preferredDiameterMm: minDiameter,
            minDrillMm: minDrill, preferredDrillMm: minDrill,
        },
        differential: {
            trackWidthMm: Math.max(source.minimumTrackWidth, rule.diffPairWidth),
            gapMm: Math.max(source.minimumClearance, rule.diffPairGap),
        },
    };
}

function routingRules(source: PcbRoutingRules, nets: readonly string[]): RoutingRules {
    const defaultClass = source.classes.find(item => item.name === 'Default') ?? source.classes[0];
    if (!defaultClass) throw new TypeError('KiCad project has no Default net class');
    const byName = new Map(source.classes.map(item => [item.name, item]));
    const fallback = ruleValues(defaultClass, source);
    return {
        default: fallback,
        nets: nets.map(net => ({
            net,
            values: ruleValues(byName.get(netClassFor(source, net)) ?? defaultClass, source),
        })),
    };
}

function splitCopper(copper: ReturnType<typeof importedCopper>, existingCopper: 'fixed' | 'editable') {
    const fixed: RoutingCopper = {
        tracks: copper.tracks.filter(item => item.sourceLocked || existingCopper === 'fixed').map(({ sourceLocked: _, ...item }) => item),
        vias: copper.vias.filter(item => item.sourceLocked || existingCopper === 'fixed').map(({ sourceLocked: _, ...item }) => item),
        zones: copper.zones.filter(item => item.sourceLocked || existingCopper === 'fixed').map(({ sourceLocked: _, ...item }) => item),
    };
    const editable: RoutingCopper = {
        tracks: copper.tracks.filter(item => !item.sourceLocked && existingCopper === 'editable').map(({ sourceLocked: _, ...item }) => item),
        vias: copper.vias.filter(item => !item.sourceLocked && existingCopper === 'editable').map(({ sourceLocked: _, ...item }) => item),
        zones: copper.zones.filter(item => !item.sourceLocked && existingCopper === 'editable').map(({ sourceLocked: _, ...item }) => item),
    };
    return { fixed, editable };
}

export async function importKiCadRoutingBoard(
    pcbPath: string,
    options: KiCadRouterImportOptions = {},
): Promise<KiCadRoutingImport> {
    const diagnostics: RoutingDiagnostic[] = [];
    try {
        const document = await readPcb(pcbPath);
        const layers = copperLayers(document.root).map((name, index, source) => ({
            name,
            index,
            side: index === 0 ? 'top' as const : index === source.length - 1 ? 'bottom' as const : 'inner' as const,
        }));
        const components: RoutingBoard['components'][number][] = [];
        const pads: RoutingBoard['pads'][number][] = [];
        const nets = new Set<string>();
        for (const [componentIndex, footprint] of pcbFootprints(document.root).entries()) {
            const at = footprintAt(footprint);
            const side = footprintLayer(footprint);
            const bottom = side === 'B.Cu';
            const designator = footprintReference(footprint) ?? `FP${componentIndex + 1}`;
            components.push({ designator, at: { x: at.x, y: at.y }, rotationDeg: at.rotate, side: bottom ? 'bottom' : 'top' });
            for (const [padIndex, pad] of listChildren(footprint, 'pad').entries()) {
                const local = findChild(pad, 'at');
                const net = padNet(pad);
                if (net) nets.add(net);
                const localRotation = numberAt(local, 3);
                const nativePadId = childText(pad, 'uuid') ?? childText(pad, 'tstamp');
                pads.push({
                    // KiCad legitimately reuses a pad UUID/tstamp for duplicated physical
                    // shapes of one logical contact. RoutingBoard ids identify physical
                    // shapes, while `number` retains the shared electrical identity.
                    id: nativePadId
                        ? `${nativePadId}:${componentIndex}:${padIndex}`
                        : `${designator}:${componentIndex}:${padIndex}`,
                    component: designator,
                    number: padNumber(pad) ?? String(padIndex + 1),
                    ...(net ? { net } : {}),
                    at: transformFootprintPoint(pointAt(local), at, bottom),
                    rotationDeg: bottom ? at.rotate - localRotation : at.rotate + localRotation,
                    layers: padLayers(pad, layers.map(item => item.name), side),
                    shape: padShape(pad),
                    ...(padHole(pad) ? { hole: padHole(pad) } : {}),
                });
            }
        }
        for (const net of listChildren(document.root, 'net')) {
            const name = atom(net[2]);
            if (name) nets.add(name);
        }
        const rulesSource = await readPcbRoutingRules(document.path);
        const outline = boardOutline(document.root);
        const ownership = options.existingCopper ?? 'fixed';
        const board: RoutingBoard = {
            outline: outline.points,
            cutouts: outline.holes,
            layers,
            nets: [...nets].sort().map(name => ({ name })),
            components,
            pads,
            keepouts: importedKeepouts(document.root, layers.map(item => item.name)),
            stackup: {
                fallbackCopperThicknessOz: 1,
                layers: layers.map(layer => ({ kind: 'copper' as const, layer: layer.name, thicknessMm: 0.03479 })),
            },
            rules: routingRules(rulesSource, [...nets].sort()),
            copper: splitCopper(importedCopper(document.root), ownership),
        };
        const validation = validateRoutingBoard(board);
        diagnostics.push(...validation.diagnostics);
        return validation.ok
            ? { board, context: { document, existingCopper: ownership }, diagnostics }
            : { diagnostics };
    } catch (error) {
        diagnostics.push({
            code: 'KICAD_ROUTING_IMPORT_FAILED', severity: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
        return { diagnostics };
    }
}

function netForm(root: SExpression[], version: number, name: string) {
    if (version >= 20250000) return [token('net'), token(name, true)] as SExpression[];
    const existing = listChildren(root, 'net').find(item => atom(item[2]) === name);
    if (!existing) throw new TypeError(`KiCad net not found: ${name}`);
    return [token('net'), token(atom(existing[1]) ?? '0')] as SExpression[];
}

function removeEditableCopper(
    root: SExpression[],
    existingCopper: 'fixed' | 'editable',
    replaceAll = false,
) {
    if (existingCopper !== 'editable' && !replaceAll) return 0;
    let removed = 0;
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const node = root[index];
        if (!isSExpressionList(node) || !['segment', 'arc', 'via', 'zone'].includes(listHead(node) ?? '')) continue;
        if (!replaceAll && locked(node)) continue;
        root.splice(index, 1);
        removed += 1;
    }
    return removed;
}

function appendTrack(root: SExpression[], version: number, track: RoutedTrack, lock = false) {
    for (let index = 0; index < track.points.length - 1; index += 1) {
        const start = track.points[index];
        const end = track.points[index + 1];
        if (Math.hypot(end.x - start.x, end.y - start.y) < 1e-9) continue;
        root.push([
            token('segment'),
            [token('start'), token(String(start.x)), token(String(start.y))],
            [token('end'), token(String(end.x)), token(String(end.y))],
            [token('width'), token(String(track.widthMm))],
            [token('layer'), token(track.layer, true)],
            ...(lock ? [[token('locked'), token('yes')] as SExpression[]] : []),
            netForm(root, version, track.net),
            [token('uuid'), token(randomUUID(), true)],
        ]);
    }
}

function appendVia(root: SExpression[], version: number, via: RoutedVia, lock = false) {
    root.push([
        token('via'),
        ...(via.type === 'micro' ? [[token('micro')]] : []),
        [token('at'), token(String(via.at.x)), token(String(via.at.y))],
        [token('size'), token(String(via.diameterMm))],
        [token('drill'), token(String(via.drillMm))],
        [token('layers'), token(via.fromLayer, true), token(via.toLayer, true)],
        ...(lock ? [[token('locked'), token('yes')] as SExpression[]] : []),
        netForm(root, version, via.net),
        [token('uuid'), token(randomUUID(), true)],
    ]);
}

function appendZone(root: SExpression[], version: number, zone: RoutedZone, layer: string, sequence: number) {
    const clearance = 0.2;
    root.push([
        token('zone'),
        ...(version >= 20250000
            ? [[token('net'), token(zone.net, true)] as SExpression[]]
            : [netForm(root, version, zone.net), [token('net_name'), token(zone.net, true)] as SExpression[]]),
        [token('layer'), token(layer, true)],
        [token('uuid'), token(randomUUID(), true)],
        [token('name'), token(`${ROUTER_ZONE_PREFIX}${zone.id ?? sequence}:${zone.net}:${layer}`, true)],
        [token('hatch'), token('edge'), token('0.5')],
        ...((zone.priority ?? 0) > 0 ? [[token('priority'), token(String(zone.priority))] as SExpression[]] : []),
        zone.connection === 'solid'
            ? [token('connect_pads'), token('yes'), [token('clearance'), token(String(clearance))]]
            : [token('connect_pads'), [token('clearance'), token(String(clearance))]],
        [token('min_thickness'), token(String(zone.minThicknessMm ?? 0.1))],
        [token('fill'), token('yes'),
            [token('thermal_gap'), token(String(Math.max(clearance, 0.2)))],
            [token('thermal_bridge_width'), token('0.3')],
            [token('island_removal_mode'), token('0')]],
        [token('polygon'), [token('pts'), ...zone.outline.outer.map(point => [
            token('xy'), token(String(point.x)), token(String(point.y)),
        ] as SExpression[])]],
        ...(zone.outline.holes ?? []).map(hole => [
            token('polygon'), [token('pts'), ...hole.map(point => [
                token('xy'), token(String(point.x)), token(String(point.y)),
            ] as SExpression[])],
        ] as SExpression[]),
    ]);
}

function applyCopper(root: SExpression[], version: number, copper: RoutingCopper, lock = false) {
    for (const track of copper.tracks) appendTrack(root, version, track, lock);
    for (const via of copper.vias) appendVia(root, version, via, lock);
    for (const [index, zone] of copper.zones.entries()) for (const layer of zone.layers) appendZone(root, version, zone, layer, index);
}

function cloneRoot(root: SExpression[]) {
    return structuredClone(root);
}

/** Materialize the package input/result as a native KiCad candidate. */
export async function materializeKiCadRoutingCandidate(
    context: KiCadRoutingContext,
    copper: RoutingCopper,
    rules: RoutingRules,
    outputPath: string,
    options: Readonly<{ refillZones?: boolean; replaceAllCopper?: boolean; lockTracksAndVias?: boolean }> = {},
) {
    const target = resolve(outputPath);
    if (target === context.document.path) throw new TypeError('routing transport cannot overwrite its source board');
    const root = cloneRoot(context.document.root);
    removeEditableCopper(root, context.existingCopper, options.replaceAllCopper === true);
    applyCopper(root, context.document.version, copper, options.lockTracksAndVias === true);
    await writeProjectRules(context.document.path, target, rules);
    const normalized = await inspectPcbCandidate(target, root, options.refillZones === true);
    await atomicCreate(target, serializePcb(normalized.root));
    return { outputPath: target, root: normalized.root, report: normalized.report };
}

function projectJsonPath(boardPath: string) {
    return `${boardPath.slice(0, -extname(boardPath).length)}.kicad_pro`;
}

function setEffectiveRules(project: Record<string, unknown>, rules: RoutingRules) {
    const netSettings = (project.net_settings && typeof project.net_settings === 'object')
        ? project.net_settings as Record<string, unknown>
        : (project.net_settings = {}) as Record<string, unknown>;
    const existingClasses = Array.isArray(netSettings.classes)
        ? netSettings.classes.filter(item => item && typeof item === 'object') as Record<string, unknown>[]
        : [];
    const template = existingClasses.find(item => item.name === 'Default') ?? {};
    const key = (value: RoutingRuleValues) => JSON.stringify(value);
    const groups = new Map<string, { values: RoutingRuleValues; nets: string[] }>();
    for (const entry of rules.nets) {
        const group = groups.get(key(entry.values)) ?? { values: entry.values, nets: [] };
        group.nets.push(entry.net);
        groups.set(key(entry.values), group);
    }
    const classes = [...groups.values()].map((group, index) => {
        const name = index === 0 ? 'Router_Default' : `Router_${index}`;
        return {
            ...template,
            name,
            clearance: group.values.clearanceMm,
            track_width: group.values.preferredTrackWidthMm,
            via_diameter: group.values.via.preferredDiameterMm,
            via_drill: group.values.via.preferredDrillMm,
            diff_pair_width: group.values.differential?.trackWidthMm ?? group.values.preferredTrackWidthMm,
            diff_pair_gap: group.values.differential?.gapMm ?? group.values.clearanceMm,
        };
    });
    netSettings.classes = classes;
    netSettings.netclass_assignments = Object.fromEntries([...groups.values()].flatMap((group, index) => (
        group.nets.map(net => [net, index === 0 ? 'Router_Default' : `Router_${index}`])
    )));
    netSettings.netclass_patterns = [];
}

async function writeProjectRules(sourceBoard: string, targetBoard: string, rules: RoutingRules) {
    const sourceProject = await findPcbProjectPath(sourceBoard);
    if (!sourceProject) throw new TypeError('runAll/applyDrcRules requires a KiCad project file');
    const project = JSON.parse(await readFile(sourceProject, 'utf8')) as Record<string, unknown>;
    setEffectiveRules(project, rules);
    const targetProject = projectJsonPath(targetBoard);
    await writeFile(targetProject, `${JSON.stringify(project, null, 2)}\n`, 'utf8');
    const sourceDru = sourceProject.replace(/\.kicad_pro$/i, '.kicad_dru');
    const targetDru = targetProject.replace(/\.kicad_pro$/i, '.kicad_dru');
    const previousRules = await readFile(sourceDru, 'utf8').catch(() => '');
    if (previousRules) await writeFile(`${targetDru}.source-backup`, previousRules, 'utf8');
    await writeFile(targetDru, customRulesSource(rules), 'utf8');
}

function quoteRule(value: string) {
    return value.replace(/'/g, "\\'");
}

function customRulesSource(rules: RoutingRules) {
    const lines = ['(version 1)', ''];
    for (const [index, entry] of rules.nets.entries()) {
        const values = entry.values;
        const condition = `A.NetName == '${quoteRule(entry.net)}'`;
        lines.push(
            `(rule "copilot-router ${index + 1}: ${entry.net}"`,
            `  (condition "${condition}")`,
            `  (constraint clearance (min ${values.clearanceMm}mm))`,
            `  (constraint track_width (min ${values.minTrackWidthMm}mm) (opt ${values.preferredTrackWidthMm}mm))`,
            `  (constraint via_diameter (min ${values.via.minDiameterMm}mm) (opt ${values.via.preferredDiameterMm}mm))`,
            `  (constraint hole_size (min ${values.via.minDrillMm}mm))`,
            ...(values.maxLengthMm === undefined
                ? []
                : [`  (constraint length (max ${values.maxLengthMm}mm))`]),
            ...(values.differential?.maxSkewMm === undefined
                ? []
                : [`  (constraint skew (max ${values.differential.maxSkewMm}mm))`]),
            ')',
            '',
        );
    }
    for (const [index, pair] of (rules.differentialPairs ?? []).entries()) {
        const positive = rules.nets.find(entry => entry.net === pair.positive)?.values;
        const negative = rules.nets.find(entry => entry.net === pair.negative)?.values;
        const differential = positive?.differential ?? negative?.differential;
        if (!differential) continue;
        const a = quoteRule(pair.positive);
        const b = quoteRule(pair.negative);
        lines.push(
            `(rule "copilot-router differential ${index + 1}: ${pair.id}"`,
            `  (condition "(A.NetName == '${a}' && B.NetName == '${b}') || (A.NetName == '${b}' && B.NetName == '${a}')")`,
            `  (constraint diff_pair_gap (min ${differential.gapMm}mm) (opt ${differential.gapMm}mm))`,
            ')',
            '',
        );
    }
    for (const [index, group] of (rules.matchedGroups ?? []).entries()) {
        const condition = group.nets.map(net => `A.NetName == '${quoteRule(net)}'`).join(' || ');
        lines.push(
            `(rule "copilot-router matched ${index + 1}: ${group.id}"`,
            `  (condition "${condition}")`,
            `  (constraint skew (max ${group.toleranceMm}mm))`,
            ')',
            '',
        );
    }
    return `${lines.join('\n')}\n`;
}

async function atomicCreate(path: string, contents: string) {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, contents, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

function errorCount(report: unknown) {
    const value = report && typeof report === 'object' ? report as Record<string, unknown> : {};
    const violations = Array.isArray(value.violations) ? value.violations : [];
    return violations.filter(item => item && typeof item === 'object'
        && (item as Record<string, unknown>).severity === 'error').length;
}

export async function applyKiCadRoutingResult(
    context: KiCadRoutingContext,
    result: RoutingResult,
    outputPath: string,
    options: Readonly<{ nativeVerify?: boolean }> = {},
): Promise<KiCadRoutingApplyResult> {
    const diagnostics: RoutingDiagnostic[] = [...result.diagnostics];
    const target = resolve(outputPath);
    if (target === context.document.path) return {
        diagnostics: [...diagnostics, {
            code: 'KICAD_SOURCE_OVERWRITE_FORBIDDEN', severity: 'error',
            message: 'Router package adapter writes a new board and never overwrites its captured source.',
        }],
        nativeVerification: 'not-run',
    };
    try {
        if (sourceHash(await readFile(context.document.path)) !== sourceHash(context.document.source)) {
            throw new TypeError('KiCad source changed after routing capture');
        }
        const root = cloneRoot(context.document.root);
        if (result.copper) {
            removeEditableCopper(root, context.existingCopper);
            applyCopper(root, context.document.version, result.copper);
        }
        if (result.rules.applyRequested) await writeProjectRules(context.document.path, target, result.rules.effective);
        else {
            const sourceProject = await findPcbProjectPath(context.document.path);
            if (sourceProject) {
                await copyFile(sourceProject, projectJsonPath(target));
                await copyFile(
                    sourceProject.replace(/\.kicad_pro$/i, '.kicad_dru'),
                    projectJsonPath(target).replace(/\.kicad_pro$/i, '.kicad_dru'),
                ).catch(() => undefined);
            }
        }
        let finalRoot = root;
        let report: unknown;
        let nativeVerification: KiCadRoutingApplyResult['nativeVerification'] = 'not-run';
        if (options.nativeVerify !== false) {
            const inspected = await inspectPcbCandidate(target, root, Boolean(result.copper?.zones.length));
            finalRoot = inspected.root;
            report = inspected.report;
            nativeVerification = errorCount(report) ? 'failed' : 'passed';
            if (nativeVerification === 'failed') diagnostics.push({
                code: 'KICAD_NATIVE_DRC_ERRORS', severity: 'error',
                message: `KiCad reports ${errorCount(report)} DRC error violation(s).`,
            });
        }
        await atomicCreate(target, serializePcb(finalRoot));
        return { outputPath: target, diagnostics, nativeVerification, ...(report === undefined ? {} : { report }) };
    } catch (error) {
        diagnostics.push({
            code: 'KICAD_ROUTING_APPLY_FAILED', severity: 'error',
            message: error instanceof Error ? error.message : String(error),
        });
        return { diagnostics, nativeVerification: 'not-run' };
    }
}

/** Utility for tests and hosts that need a DRC-only result. */
export const emptyKiCadEditableCopper = EMPTY_COPPER;
