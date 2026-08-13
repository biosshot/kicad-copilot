import { randomUUID } from 'node:crypto';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import type {
    BackendRouteRequest,
    KrtBoardTransport,
    PointMm,
    RoutedTrack,
    RoutedVia,
    RoutingCopper,
} from '@easyeda-copilot/router';
import { childText, listChildren } from '../kicad/pcb-reader';
import { parsePcbSource, serializePcb } from '../kicad/pcb-writer';
import { atom, findChild, isSExpressionList, listHead, token, type SExpression } from '../kicad/sexpr/ast';
import {
    importKiCadRoutingBoard,
    materializeKiCadRoutingCandidate,
    type KiCadRoutingContext,
} from './router-package-adapter';

type Point = { x: number; y: number };
type ProxyManifest = { segmentUuids: string[] };

const EPSILON = 1e-7;

function pointAt(node: SExpression[] | undefined): Point {
    return { x: Number(atom(node?.[1]) ?? 0), y: Number(atom(node?.[2]) ?? 0) };
}

function nodeNetName(root: SExpression[], node: SExpression[]) {
    const net = findChild(node, 'net');
    if (!net) return '';
    if (net.length >= 3) return atom(net[2]) ?? '';
    const value = atom(net[1]) ?? '';
    if (!/^\d+$/.test(value)) return value;
    return atom(listChildren(root, 'net').find(item => atom(item[1]) === value)?.[2]) ?? '';
}

function netNode(root: SExpression[], net: string): SExpression[] {
    const version = Number(atom(findChild(root, 'version')?.[1]) ?? 0);
    if (version >= 20250000) return [token('net'), token(net, true)];
    const entry = listChildren(root, 'net').find(item => atom(item[2]) === net);
    if (!entry) throw new TypeError(`KiCad net not found while materializing filled copper: ${net}`);
    return [token('net'), token(atom(entry[1]) ?? '0')];
}

function scanIntervals(ring: Point[], value: number, horizontal: boolean) {
    const intersections: number[] = [];
    for (let index = 0; index < ring.length; index += 1) {
        const a = ring[index];
        const b = ring[(index + 1) % ring.length];
        const first = horizontal ? a.y : a.x;
        const second = horizontal ? b.y : b.x;
        if (!((first <= value && second > value) || (second <= value && first > value))) continue;
        const ratio = (value - first) / (second - first);
        intersections.push((horizontal ? a.x : a.y)
            + ratio * ((horizontal ? b.x : b.y) - (horizontal ? a.x : a.y)));
    }
    intersections.sort((left, right) => left - right);
    const output: Array<[number, number]> = [];
    for (let index = 0; index + 1 < intersections.length; index += 2) {
        if (intersections[index + 1] - intersections[index] > EPSILON) {
            output.push([intersections[index], intersections[index + 1]]);
        }
    }
    return output;
}

function gridValues(minimum: number, maximum: number, pitch: number) {
    const values: number[] = [];
    for (let value = Math.ceil(minimum / pitch) * pitch; value <= maximum + EPSILON; value += pitch) {
        values.push(Math.round(value * 1_000_000) / 1_000_000);
    }
    return values;
}

/**
 * KRT does not model native zone fills as maze obstacles. A temporary locked
 * cross-hatched mesh makes the exact refilled components visible to KRT and
 * is removed before the routing result is converted back to RoutingCopper.
 */
function appendFilledCopperProxy(root: SExpression[], widthMm: number, pitchMm: number): ProxyManifest {
    const segmentUuids: string[] = [];
    const add = (start: Point, end: Point, layer: string, net: string) => {
        if (Math.hypot(end.x - start.x, end.y - start.y) <= EPSILON) return;
        const uuid = randomUUID();
        root.push([
            token('segment'),
            [token('start'), token(String(start.x)), token(String(start.y))],
            [token('end'), token(String(end.x)), token(String(end.y))],
            [token('width'), token(String(widthMm))],
            [token('locked'), token('yes')],
            [token('layer'), token(layer, true)],
            netNode(root, net),
            [token('uuid'), token(uuid, true)],
        ]);
        segmentUuids.push(uuid);
    };
    for (const zone of listChildren(root, 'zone')) {
        const net = nodeNetName(root, zone);
        const zoneLayer = childText(zone, 'layer') ?? 'F.Cu';
        if (!net) continue;
        for (const filled of listChildren(zone, 'filled_polygon')) {
            const ring = listChildren(findChild(filled, 'pts') ?? [], 'xy').map(pointAt);
            if (ring.length < 3) continue;
            const layer = childText(filled, 'layer') ?? zoneLayer;
            const xs = ring.map(point => point.x);
            const ys = ring.map(point => point.y);
            for (const y of gridValues(Math.min(...ys), Math.max(...ys), pitchMm)) {
                for (const [from, to] of scanIntervals(ring, y, true)) add({ x: from, y }, { x: to, y }, layer, net);
            }
            for (const x of gridValues(Math.min(...xs), Math.max(...xs), pitchMm)) {
                for (const [from, to] of scanIntervals(ring, x, false)) add({ x, y: from }, { x, y: to }, layer, net);
            }
        }
    }
    return { segmentUuids };
}

function removeFilledCopperProxy(root: SExpression[], manifest: ProxyManifest) {
    const expected = new Set(manifest.segmentUuids);
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const node = root[index];
        if (!isSExpressionList(node) || listHead(node) !== 'segment') continue;
        if (expected.has(childText(node, 'uuid') ?? '')) root.splice(index, 1);
    }
}

function copySidecars(source: string, target: string) {
    const sourceStem = source.slice(0, -extname(source).length);
    const targetStem = target.slice(0, -extname(target).length);
    return Promise.all(['.kicad_pro', '.kicad_dru', '.kicad_prl'].map(suffix => (
        copyFile(`${sourceStem}${suffix}`, `${targetStem}${suffix}`).catch(() => undefined)
    )));
}

function samePoint(left: PointMm, right: PointMm) {
    return Math.abs(left.x - right.x) <= 1e-6 && Math.abs(left.y - right.y) <= 1e-6;
}

function trackSegments(track: RoutedTrack) {
    return track.points.slice(0, -1).map((start, index) => ({
        net: track.net, layer: track.layer, widthMm: track.widthMm,
        start, end: track.points[index + 1],
    }));
}

function trackKey(track: ReturnType<typeof trackSegments>[number]) {
    const points = [track.start, track.end].sort((left, right) => left.x - right.x || left.y - right.y);
    const rounded = (value: number) => Math.round(value * 1_000_000);
    return [track.net, track.layer, rounded(track.widthMm), ...points.flatMap(point => [rounded(point.x), rounded(point.y)])].join('|');
}

function viaKey(via: RoutedVia) {
    const rounded = (value: number) => Math.round(value * 1_000_000);
    return [via.net, rounded(via.at.x), rounded(via.at.y), rounded(via.diameterMm), rounded(via.drillMm),
        via.fromLayer, via.toLayer, via.type ?? 'through'].join('|');
}

function subtractCopper(source: RoutingCopper, output: RoutingCopper): RoutingCopper {
    const sourceTracks = new Map<string, number>();
    for (const segment of source.tracks.flatMap(trackSegments)) {
        const key = trackKey(segment);
        sourceTracks.set(key, (sourceTracks.get(key) ?? 0) + 1);
    }
    const tracks: RoutedTrack[] = [];
    for (const segment of output.tracks.flatMap(trackSegments)) {
        const key = trackKey(segment);
        const count = sourceTracks.get(key) ?? 0;
        if (count) sourceTracks.set(key, count - 1);
        else tracks.push({
            net: segment.net, layer: segment.layer, widthMm: segment.widthMm,
            points: [segment.start, segment.end],
        });
    }
    const sourceVias = new Map<string, number>();
    for (const via of source.vias) sourceVias.set(viaKey(via), (sourceVias.get(viaKey(via)) ?? 0) + 1);
    const vias = output.vias.filter(via => {
        const key = viaKey(via);
        const count = sourceVias.get(key) ?? 0;
        if (!count) return true;
        sourceVias.set(key, count - 1);
        return false;
    });
    return { tracks, vias, zones: [] };
}

export function createKiCadKrtBoardTransport(context: KiCadRoutingContext): KrtBoardTransport {
    let manifest: ProxyManifest = { segmentUuids: [] };
    return {
        async prepare(request: BackendRouteRequest, directory: string) {
            const inputBoard = resolve(directory, '01-krt-input.kicad_pcb');
            const copper: RoutingCopper = {
                tracks: [...request.board.copper.fixed.tracks, ...request.board.copper.editable.tracks],
                vias: [...request.board.copper.fixed.vias, ...request.board.copper.editable.vias],
                zones: [...request.board.copper.fixed.zones, ...request.board.copper.editable.zones],
            };
            const materialized = await materializeKiCadRoutingCandidate(context, copper, request.rules, inputBoard, {
                replaceAllCopper: true,
                lockTracksAndVias: true,
                refillZones: copper.zones.length > 0,
            });
            const minimumTrack = Math.min(request.rules.default.minTrackWidthMm,
                ...request.rules.nets.map(item => item.values.minTrackWidthMm));
            const width = Math.max(0.02, Math.min(0.1, minimumTrack / 2));
            manifest = appendFilledCopperProxy(materialized.root, width, Math.max(width * 2, 0.1));
            await writeFile(inputBoard, serializePcb(materialized.root), 'utf8');
            return { inputBoard };
        },
        async read(request: BackendRouteRequest, preparedBoard: string, routedBoard: string) {
            const routedRoot = parsePcbSource(await readFile(routedBoard, 'utf8'));
            removeFilledCopperProxy(routedRoot, manifest);
            const cleanBoard = `${routedBoard.slice(0, -extname(routedBoard).length)}.clean.kicad_pcb`;
            await writeFile(cleanBoard, serializePcb(routedRoot), 'utf8');
            await copySidecars(routedBoard, cleanBoard);
            const imported = await importKiCadRoutingBoard(cleanBoard, { existingCopper: 'fixed' });
            if (!imported.board) return {
                copper: { tracks: [], vias: [], zones: [] }, diagnostics: imported.diagnostics,
            };
            const source: RoutingCopper = {
                tracks: [...request.board.copper.fixed.tracks, ...request.board.copper.editable.tracks],
                vias: [...request.board.copper.fixed.vias, ...request.board.copper.editable.vias],
                zones: [],
            };
            return {
                copper: subtractCopper(source, imported.board.copper.fixed),
                diagnostics: imported.diagnostics,
            };
        },
    };
}
