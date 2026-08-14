import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type {
    BackendRouteRequest,
    KrtBoardTransport,
    PointMm,
    RoutedTrack,
    RoutedVia,
    RoutingCopper,
} from '@easyeda-copilot/router';
import { serializePcb } from '../kicad/pcb-writer';
import {
    importKiCadRoutingBoard,
    materializeKiCadRoutingCandidate,
    type KiCadRoutingContext,
} from './router-package-adapter';

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
            await writeFile(inputBoard, serializePcb(materialized.root), 'utf8');
            return { inputBoard };
        },
        async read(request: BackendRouteRequest, preparedBoard: string, routedBoard: string) {
            void preparedBoard;
            const imported = await importKiCadRoutingBoard(routedBoard, { existingCopper: 'fixed' });
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
