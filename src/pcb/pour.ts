import { randomUUID } from 'node:crypto';
import { saveCheckpoint } from '../checkpoints/store';
import { childText, listChildren, padNet, pcbFootprints, readPcb } from '../kicad/pcb-reader';
import { refillAndInspectPcbCandidate } from '../kicad/pcb-validation';
import { atomicWritePcb } from '../kicad/pcb-writer';
import { atom, findChild, isSExpressionList, listHead, SExpression, token } from '../kicad/sexpr/ast';
import { boardOutline, copperLayerId } from './board-geometry';

type Point = { x: number; y: number };

export type PourOptions = {
    net: string;
    layers: string[];
    stitchVias?: boolean;
    stitchGridMm?: number;
    viaDiameterMm?: number;
    viaDrillMm?: number;
    edgeMarginMm?: number;
    maxVias?: number;
};

type AppliedPour = { generatedViaIds: string[]; zones: number };

function knownNets(root: SExpression[]) {
    const result = new Set<string>();
    for (const footprint of pcbFootprints(root)) {
        for (const pad of listChildren(footprint, 'pad')) {
            const name = padNet(pad);
            if (name) result.add(name);
        }
    }
    return result;
}

function legacyNetId(root: SExpression[], name: string) {
    const net = listChildren(root, 'net').find((item) => atom(item[2]) === name);
    if (!net) throw new Error(`PCB net not found: ${name}`);
    return atom(net[1]) || '0';
}

function zoneNetForms(root: SExpression[], version: number, name: string) {
    return version >= 20250000
        ? [[token('net'), token(name, true)] as SExpression[]]
        : [
            [token('net'), token(legacyNetId(root, name))] as SExpression[],
            [token('net_name'), token(name, true)] as SExpression[],
        ];
}

function itemUuid(node: SExpression[]) {
    return childText(node, 'uuid') || childText(node, 'tstamp') || '';
}

function managedGroupName(net: string) {
    return `kicad-copilot:stitch:${net}`;
}

function removeManagedItems(root: SExpression[], net: string) {
    const zonePrefix = `kicad-copilot:${net}:`;
    const groupName = managedGroupName(net);
    const managedViaIds = new Set<string>();
    for (const group of listChildren(root, 'group')) {
        if (atom(group[1]) !== groupName) continue;
        const members = findChild(group, 'members');
        for (const member of members?.slice(1) ?? []) {
            const id = atom(member);
            if (id) managedViaIds.add(id);
        }
    }
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const item = root[index];
        if (!isSExpressionList(item)) continue;
        const head = listHead(item);
        const removeZone = head === 'zone' && (childText(item, 'name') || '').startsWith(zonePrefix);
        const removeGroup = head === 'group' && atom(item[1]) === groupName;
        const removeVia = head === 'via' && managedViaIds.has(itemUuid(item));
        if (removeZone || removeGroup || removeVia) root.splice(index, 1);
    }
}

function pointInPolygon(point: Point, polygon: Point[]) {
    let inside = false;
    for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
        const a = polygon[index];
        const b = polygon[previous];
        if (((a.y > point.y) !== (b.y > point.y))
            && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside;
}

function distanceToSegment(point: Point, start: Point, end: Point) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length2 = dx * dx + dy * dy;
    if (!length2) return Math.hypot(point.x - start.x, point.y - start.y);
    const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / length2));
    return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function farFromEdge(point: Point, polygon: Point[], margin: number) {
    return polygon.every((start, index) => distanceToSegment(point, start, polygon[(index + 1) % polygon.length]) >= margin);
}

function makeZone(root: SExpression[], version: number, net: string, layer: string, points: Point[]) {
    return [
        token('zone'),
        ...zoneNetForms(root, version, net),
        [token('layer'), token(layer, true)],
        [token('uuid'), token(randomUUID(), true)],
        [token('name'), token(`kicad-copilot:${net}:${layer}`, true)],
        [token('hatch'), token('edge'), token('0.5')],
        [token('connect_pads'), [token('clearance'), token('0.5')]],
        [token('min_thickness'), token('0.25')],
        [
            token('fill'),
            [token('thermal_gap'), token('0.5')],
            [token('thermal_bridge_width'), token('0.5')],
            [token('island_removal_mode'), token('0')],
        ],
        [
            token('polygon'),
            [token('pts'), ...points.map((point) => [
                token('xy'), token(String(point.x)), token(String(point.y)),
            ] as SExpression[])],
        ],
    ] as SExpression[];
}

function viaNetForm(root: SExpression[], version: number, name: string) {
    return version >= 20250000
        ? [token('net'), token(name, true)] as SExpression[]
        : [token('net'), token(legacyNetId(root, name))] as SExpression[];
}

export function applySimplePour(root: SExpression[], version: number, options: PourOptions): AppliedPour {
    if (!options.layers.length) throw new Error('pour layers cannot be empty');
    if (!knownNets(root).has(options.net)) throw new Error(`PCB net not found: ${options.net}`);
    for (const layer of options.layers) {
        if (copperLayerId(layer) === undefined) throw new Error(`unsupported copper layer: ${layer}`);
    }
    removeManagedItems(root, options.net);
    const outline = boardOutline(root);
    for (const layer of options.layers) root.push(makeZone(root, version, options.net, layer, outline.points));

    const generatedViaIds: string[] = [];
    if (options.stitchVias !== false) {
        const grid = options.stitchGridMm ?? 4;
        const margin = options.edgeMarginMm ?? 1;
        const diameter = options.viaDiameterMm ?? 0.61;
        const drill = options.viaDrillMm ?? 0.305;
        const max = options.maxVias ?? 500;
        if (grid <= 0 || diameter <= 0 || drill <= 0 || drill >= diameter || max < 0) {
            throw new Error('invalid stitching via settings');
        }
        const left = Math.min(...outline.points.map((point) => point.x));
        const right = Math.max(...outline.points.map((point) => point.x));
        const top = Math.min(...outline.points.map((point) => point.y));
        const bottom = Math.max(...outline.points.map((point) => point.y));
        for (let y = top + margin; y <= bottom - margin && generatedViaIds.length < max; y += grid) {
            for (let x = left + margin; x <= right - margin && generatedViaIds.length < max; x += grid) {
                const point = { x, y };
                if (!pointInPolygon(point, outline.points) || !farFromEdge(point, outline.points, margin)) continue;
                if (outline.holes.some((hole) => pointInPolygon(point, hole))) continue;
                const uuid = randomUUID();
                generatedViaIds.push(uuid);
                root.push([
                    token('via'),
                    [token('at'), token(String(x)), token(String(y))],
                    [token('size'), token(String(diameter))],
                    [token('drill'), token(String(drill))],
                    [token('layers'), token('F.Cu', true), token('B.Cu', true)],
                    viaNetForm(root, version, options.net),
                    [token('uuid'), token(uuid, true)],
                ]);
            }
        }
        if (generatedViaIds.length) {
            root.push([
                token('group'), token(managedGroupName(options.net), true),
                [token('uuid'), token(randomUUID(), true)],
                [token('members'), ...generatedViaIds.map((id) => token(id, true))],
            ]);
        }
    }
    return { generatedViaIds, zones: options.layers.length };
}

function removeInvalidGeneratedVias(root: SExpression[], generatedViaIds: string[], report: unknown) {
    const reportText = JSON.stringify(report);
    const invalid = new Set(generatedViaIds.filter((id) => reportText.includes(id)));
    if (!invalid.size) return 0;
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const item = root[index];
        if (isSExpressionList(item) && listHead(item) === 'via' && invalid.has(itemUuid(item))) root.splice(index, 1);
    }
    for (const group of listChildren(root, 'group')) {
        const members = findChild(group, 'members');
        if (!members) continue;
        for (let index = members.length - 1; index >= 1; index -= 1) {
            if (invalid.has(atom(members[index]) || '')) members.splice(index, 1);
        }
    }
    return invalid.size;
}

export async function finalizeSimplePourCandidate(path: string, root: SExpression[], applied: AppliedPour) {
    let inspected = await refillAndInspectPcbCandidate(path, root);
    const removed = removeInvalidGeneratedVias(inspected.root, applied.generatedViaIds, inspected.report);
    if (removed) inspected = await refillAndInspectPcbCandidate(path, inspected.root);
    return { root: inspected.root, report: inspected.report, removedVias: removed };
}

export async function pourPcbLayers(path: string, options: PourOptions) {
    const pcb = await readPcb(path);
    const applied = applySimplePour(pcb.root, pcb.version, options);
    const finalized = await finalizeSimplePourCandidate(pcb.path, pcb.root, applied);
    await saveCheckpoint(pcb.path, 'Before PCB layer pour');
    await atomicWritePcb(pcb.path, pcb.source, finalized.root);
    return 'ok';
}
