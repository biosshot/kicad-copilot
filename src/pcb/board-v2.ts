import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import ClipperLib from 'clipper-lib';
import type { FilledPolygons, PointMm, PolygonMm, PourZoneV2, RoutingBoardV2, RoutingCopperV2 } from 'eda-copilot-backend/types';
import { importKiCadRoutingBoard } from 'eda-copilot-router/adapters/kicad';
import type { RoutingDiagnostic } from 'eda-copilot-router';
import { childText, listChildren, propertyValue } from '../kicad/pcb-reader';
import { atom, findChild, type SExpression } from '../kicad/sexpr/ast';
import { TEMP_DIR } from '../utils/dirs';
import { arcPoints } from './board-geometry';

const unitsPerMm = 1_000_000;
const point = (node: SExpression[]): PointMm => ({ x: Number(atom(node[1])), y: Number(atom(node[2])) });
const ring = (node: SExpression[]) => listChildren(findChild(node, 'pts') ?? [], 'xy').map(point);
const identity = (node: SExpression[]) => childText(node, 'uuid') ?? childText(node, 'tstamp');
const numeric = (node: SExpression[], key: string) => {
    const value = Number(childText(node, key));
    return Number.isFinite(value) ? value : undefined;
};

function filledPolygons(rings: PointMm[][]): PolygonMm[] {
    // KiCad saves fractured contours, connecting holes to the outer ring with
    // coincident edges. Recover independent outlines and holes at KiCad precision.
    const clipper = new ClipperLib.Clipper();
    clipper.StrictlySimple = true;
    clipper.AddPaths(rings.map(points => points.map(({ x, y }) => ({
        X: Math.round(x * unitsPerMm), Y: Math.round(y * unitsPerMm),
    }))), ClipperLib.PolyType.ptSubject, true);
    const tree = new ClipperLib.PolyTree();
    if (!clipper.Execute(ClipperLib.ClipType.ctUnion, tree)) {
        throw new Error('Could not recover KiCad fill contours.');
    }
    const inMm = (path: ClipperLib.Path) => path.map(({ X, Y }) => ({ x: X / unitsPerMm, y: Y / unitsPerMm }));
    const polygons: PolygonMm[] = [];
    function visit(parent: ClipperLib.PolyNode) {
        for (const node of parent.Childs()) {
            if (!node.IsHole()) {
                const holes = node.Childs().map(hole => inMm(hole.Contour()));
                polygons.push({ outer: inMm(node.Contour()), ...(holes.length ? { holes } : {}) });
            }
            visit(node);
        }
    }
    visit(tree);
    return polygons;
}

export async function captureBoardV2(path: string) {
    if (extname(path).toLowerCase() !== '.kicad_pcb') throw new Error('Expected a .kicad_pcb file.');
    const imported = await importKiCadRoutingBoard(path, { existingCopper: 'fixed' });
    if (!imported.board || !imported.context) {
        throw new Error(imported.diagnostics.map(item => `${item.code}: ${item.message}`).join('\n'));
    }
    const { board: source, context: { root } } = imported;
    const diagnostics: RoutingDiagnostic[] = [...imported.diagnostics];
    if (listChildren(root, 'gr_curve').some(item => childText(item, 'layer') === 'Edge.Cuts')) {
        throw new Error('Board V2 capture does not support Bézier Edge.Cuts.');
    }
    const nativeLayers = (findChild(root, 'layers') ?? []).flatMap(item => {
        const name = Array.isArray(item) ? atom(item[1]) : undefined;
        return name?.endsWith('.Cu') ? [name] : [];
    });
    const layerNames = new Map(nativeLayers.map((name, index) => [name, source.layers[index].name]));
    const numberToNet = new Map(listChildren(root, 'net').map(net => [atom(net[1]), atom(net[2])]));
    function netName(node: SExpression[]) {
        const net = findChild(node, 'net');
        const token = net?.[1];
        const value = atom(token);
        if (token && !Array.isArray(token) && token.quoted) return value || undefined;
        return atom(net?.[2]) || childText(node, 'net_name') || numberToNet.get(value)
            || (value && !/^\d+$/.test(value) ? value : undefined);
    }

    const footprints = [...listChildren(root, 'footprint'), ...listChildren(root, 'module')];
    if (footprints.some(footprint => listChildren(footprint, 'zone').length)) {
        diagnostics.push({ code: 'KICAD_FOOTPRINT_ZONES_UNSUPPORTED', severity: 'warning',
            message: 'Footprint-local zones and rule areas were omitted by Board V2 capture.' });
    }
    const components = source.components.map((component, index) => {
        const footprint = footprints[index];
        const partUuid = propertyValue(footprint, 'EasyEDA part_uuid');
        const value = propertyValue(footprint, 'Value') ??
            atom(listChildren(footprint, 'fp_text').find(text => atom(text[1]) === 'value')?.[2]);
        return {
            ...component, id: identity(footprint), footprintName: atom(footprint[1]), value,
            partUuid: partUuid as RoutingBoardV2['components'][number]['partUuid'],
            rotationDeg: -component.rotationDeg,
        };
    });
    const nativePads = footprints.flatMap(footprint => listChildren(footprint, 'pad'));
    const holes: NonNullable<RoutingBoardV2['holes']>[number][] = [];
    const pads = source.pads.flatMap((pad, index) => {
        const id = pad.id!;
        if (pad.hole && !pad.hole.plated) {
            const { hole } = pad;
            const rotationDeg = -pad.rotationDeg;
            const radians = rotationDeg * Math.PI / 180;
            const { x, y } = hole.offset ?? { x: 0, y: 0 };
            holes.push({
                id, at: { x: pad.at.x + x * Math.cos(radians) - y * Math.sin(radians),
                    y: pad.at.y + x * Math.sin(radians) + y * Math.cos(radians) },
                hole: { ...hole, offset: undefined, rotationDeg: rotationDeg + (hole.rotationDeg ?? 0) },
            });
            return [];
        }
        const nativePad = nativePads[index];
        const native = findChild(nativePad, 'layers')?.slice(1).map(atom) ?? [];
        const layers = native.includes('*.Cu') ? source.layers.map(layer => layer.name)
            : native.flatMap(layer => layer && layerNames.has(layer) ? [layerNames.get(layer)!] : []);
        if (!layers.length) return [];
        if (findChild(nativePad, 'padstack') || childText(nativePad, 'remove_unused_layers') === 'yes') {
            diagnostics.push({ code: 'KICAD_PADSTACK_PARTIAL', severity: 'warning',
                message: `Pad ${pad.component}.${pad.number} uses per-layer pad settings. Capture uses its base shape and layer set.` });
        }
        return [{ ...pad, id, net: netName(nativePad), layers, rotationDeg: -pad.rotationDeg }];
    });

    const zones: RoutingCopperV2['zones'][number][] = [];
    for (const [index, node] of listChildren(root, 'zone').entries()) {
        if (findChild(node, 'keepout')) continue;
        const native = findChild(node, 'layers')?.slice(1).map(atom) ?? [childText(node, 'layer')];
        const layers = native.includes('*.Cu') ? source.layers.map(layer => layer.name)
            : native.flatMap(layer => layer && layerNames.has(layer) ? [layerNames.get(layer)!] : []);
        if (!layers.length) continue;
        const id = identity(node) ?? `zone-${index}`;
        const [outer, ...inner] = listChildren(node, 'polygon').map(ring);
        if (!outer || outer.length < 3) throw new Error(`Missing outline for KiCad copper zone ${id}.`);
        const stored = listChildren(node, 'filled_polygon');
        const fills = layers.map((layer): FilledPolygons => {
            const contours = stored.filter(fill => {
                const nativeLayer = childText(fill, 'layer');
                return (nativeLayer ? layerNames.get(nativeLayer) : layers.length === 1 ? layers[0] : undefined) === layer;
            }).map(ring);
            if (!contours.length) {
                diagnostics.push({ code: 'KICAD_ZONE_FILL_MISSING', severity: 'warning', message: `Zone ${id} has no saved fill on ${layer}.` });
                return { layer, source: 'cad', status: 'missing', reason: 'No filled polygon saved in the PCB file.' };
            }
            try {
                return { layer, source: 'cad', status: 'available', freshness: 'unknown', polygons: filledPolygons(contours) };
            } catch (error) {
                const reason = error instanceof Error ? error.message : String(error);
                diagnostics.push({ code: 'KICAD_ZONE_FILL_FAILED', severity: 'warning', message: `Zone ${id} on ${layer}: ${reason}` });
                return { layer, source: 'cad', status: 'failed', reason };
            }
        });
        const connect = findChild(node, 'connect_pads') ?? [];
        zones.push({
            id, kind: 'pour', net: netName(node), layers, priority: numeric(node, 'priority'),
            outline: { outer, ...(inner.length ? { holes: inner } : {}) }, filledPolygons: fills,
            refillRules: {
                status: 'partial', clearanceMm: numeric(connect, 'clearance'),
                unresolved: ['effective per-pad connection and zone refill rules'],
            },
        } satisfies PourZoneV2);
    }
    for (const graphic of source.copper.fixed.zones.filter(zone => /^(?:gr|fp)-/.test(zone.id ?? ''))) {
        zones.push({ id: graphic.id!, kind: 'fill', layers: graphic.layers, outline: graphic.outline,
            filledPolygons: graphic.layers.map(layer => ({
                layer, source: 'cad', status: 'available', freshness: 'unknown', polygons: [graphic.outline],
            })) });
    }
    if (zones.some(zone => zone.kind === 'fill')) {
        diagnostics.push({ code: 'KICAD_GRAPHIC_COPPER_APPROXIMATED', severity: 'warning',
            message: 'Copper graphics use routing-adapter geometry and have no attributed electrical net.' });
    }

    const copperNodes = new Map(['segment', 'arc', 'via'].flatMap(kind =>
        listChildren(root, kind).map((node, index) => [identity(node) ?? `${kind}-${index}`, node] as const)));
    const fixed = {
        tracks: [...source.copper.fixed.tracks] as RoutingCopperV2['tracks'][number][],
        vias: source.copper.fixed.vias.map(via => {
            const node = copperNodes.get(via.id ?? '');
            const type = atom(node?.[1]);
            return { ...via, type: type === 'micro' || type === 'blind'
                ? 'blind-buried' as const : 'through' as const };
        }) as RoutingCopperV2['vias'][number][],
        zones,
    };
    const capturedCopper = new Set([...fixed.tracks, ...fixed.vias].map(item => item.id));
    for (const [id, node] of copperNodes) {
        if (capturedCopper.has(id)) continue;
        const layer = layerNames.get(childText(node, 'layer') ?? '');
        const widthMm = numeric(node, 'width');
        const start = findChild(node, 'start');
        const end = findChild(node, 'end');
        const viaLayerNames = (findChild(node, 'layers') ?? []).slice(1).map(atom);
        const fromLayer = layerNames.get(viaLayerNames[0] ?? '');
        const toLayer = layerNames.get(viaLayerNames.at(-1) ?? '');
        const diameterMm = numeric(node, 'size');
        const drillMm = numeric(node, 'drill');
        const at = findChild(node, 'at');
        if (layer && start && end && widthMm && widthMm > 0) {
            fixed.tracks.push({ id, net: netName(node), layer, widthMm,
                points: atom(node[0]) === 'arc' ? arcPoints(node) : [point(start), point(end)] });
        } else if (at && fromLayer && toLayer && diameterMm && drillMm && drillMm > 0 && diameterMm > drillMm) {
            const type = atom(node[1]);
            fixed.vias.push({ id, net: netName(node), at: point(at), fromLayer, toLayer, diameterMm, drillMm,
                type: type === 'blind' || type === 'micro' ? 'blind-buried' : 'through' });
        } else {
            diagnostics.push({ code: 'KICAD_COPPER_NOT_CAPTURED', severity: 'warning',
                message: `Track or via ${id} is missing geometry or a layer and was omitted.` });
        }
    }
    const stack = findChild(findChild(root, 'setup') ?? [], 'stackup');
    const hasExplicitCopper = stack && nativeLayers.every(layer =>
        listChildren(stack, 'layer').some(item => atom(item[1]) === layer && (numeric(item, 'thickness') ?? 0) > 0));
    const { stackup, ...geometry } = source;
    const explicitStack = stackup && hasExplicitCopper ? {
        boardThicknessMm: stackup.boardThicknessMm, layers: stackup.layers, solderMask: stackup.solderMask,
    } : undefined;
    if (!explicitStack) diagnostics.push({ code: 'KICAD_STACKUP_INCOMPLETE', severity: 'warning',
        message: 'The PCB lacks explicit copper thickness on every layer. Supply a verified physical stackup in the analysis DSL.' });
    if (explicitStack?.boardThicknessMm !== undefined) {
        const total = explicitStack.layers.reduce((sum, layer) => sum + layer.thicknessMm, 0);
        const nominal = explicitStack.boardThicknessMm;
        if (Math.abs(total - nominal) > 1e-9 * Math.max(total, nominal, 1)) {
            explicitStack.boardThicknessMm = undefined;
            diagnostics.push({ code: 'KICAD_NOMINAL_STACKUP_THICKNESS', severity: 'warning',
                message: `Nominal KiCad thickness ${nominal} mm differs from the explicit layer sum ${Number(total.toFixed(9))} mm. The capture retains the explicit layers.` });
        }
    }

    const nets = new Set(source.nets.map(net => net.name));
    for (const item of [...pads, ...fixed.tracks, ...fixed.vias, ...zones]) if (item.net) nets.add(item.net);
    const board: RoutingBoardV2 = { ...geometry, nets: [...nets].sort().map(name => ({ name })),
        components, pads, holes, stackup: explicitStack,
        copper: { fixed, editable: { tracks: [], vias: [], zones: [] } } };
    return { board, diagnostics };
}

export async function exportBoardV2(path: string) {
    const snapshot = await captureBoardV2(path);
    await mkdir(TEMP_DIR, { recursive: true });
    const directory = await mkdtemp(join(TEMP_DIR, 'pcb-board-v2-'));
    const output = join(directory, 'routing-board-v2.json');
    await writeFile(output, JSON.stringify(snapshot));
    return { status: 'ok', format: 'RoutingBoardV2', path: output,
        diagnostic_codes: [...new Set(snapshot.diagnostics.map(item => item.code))] };
}
