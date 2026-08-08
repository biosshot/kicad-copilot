import { randomUUID } from 'node:crypto';
import { BoardAssemble } from '../types/board-assemble';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    SExpression,
    token,
    visitSExpression,
} from './sexpr/ast';
import {
    footprintAt,
    footprintIsGenerated,
    footprintLayer,
    footprintReference,
    listChildren,
    pcbFootprints,
    propertyValue,
} from './pcb-reader';
import {
    footprintGeometryIsNormalized,
    normalizeEasyEdaFootprintGeometry,
} from './footprint-normalization';

const CLEAN_HEADS = new Set([
    'segment', 'arc', 'via', 'zone',
    'gr_line', 'gr_arc', 'gr_rect', 'gr_circle', 'gr_poly', 'gr_curve',
    'group',
]);

function setChild(node: SExpression[], head: string, values: SExpression[]) {
    const existing = findChild(node, head);
    const next: SExpression[] = [token(head), ...values];
    if (existing) node[node.indexOf(existing)] = next;
    else node.push(next);
}

function removeChildren(node: SExpression[], head: string) {
    for (let index = node.length - 1; index >= 0; index -= 1) {
        if (isSExpressionList(node[index]) && listHead(node[index]) === head) node.splice(index, 1);
    }
}

function normalizeRotation(value: number) {
    return ((value % 360) + 360) % 360;
}

function kicadPoint(point: { x: number; y: number }) {
    return { x: point.x, y: -point.y };
}

function kicadComponentRotation(
    placement: NonNullable<BoardAssemble['components']>[number],
    normalizedEasyEdaGeometry: boolean,
) {
    // BoardAssemble uses EasyEDA angles. For normalized geometry, top maps to B - 180;
    // the mirrored bottom transform maps to -B. Native KiCad geometry keeps its legacy fallback.
    if (placement.layer === 'bottom') return normalizeRotation(-placement.rotate);
    return normalizeRotation(normalizedEasyEdaGeometry
        ? placement.rotate - 180
        : 180 - placement.rotate);
}

const ABSOLUTE_ANGLE_HEADS = new Set(['pad', 'property', 'fp_text', 'fp_text_box']);

function rotateAbsoluteChildAngles(footprint: SExpression[], delta: number) {
    const normalizedDelta = normalizeRotation(delta);
    if (normalizedDelta === 0) return;
    for (const child of footprint) {
        if (!isSExpressionList(child) || !ABSOLUTE_ANGLE_HEADS.has(listHead(child) || '')) continue;
        const at = findChild(child, 'at');
        if (!at) continue;
        const x = atom(at[1]);
        const y = atom(at[2]);
        const rawAngle = atom(at[3]);
        const parsedAngle = Number(rawAngle ?? 0);
        const angle = Number.isFinite(parsedAngle) ? parsedAngle : 0;
        if (x === undefined || y === undefined) continue;
        const nextAngle = token(String(normalizeRotation(angle + normalizedDelta)));
        if (rawAngle === undefined || !Number.isFinite(parsedAngle)) at.splice(3, 0, nextAngle);
        else at[3] = nextAngle;
    }
}

function paperCenter(root: SExpression[]) {
    const paper = atom(findChild(root, 'paper')?.[1]) || 'A4';
    const sizes: Record<string, { x: number; y: number }> = {
        A5: { x: 210, y: 148 }, A4: { x: 297, y: 210 }, A3: { x: 420, y: 297 },
        A2: { x: 594, y: 420 }, A1: { x: 841, y: 594 }, A0: { x: 1189, y: 841 },
        Letter: { x: 279.4, y: 215.9 }, Legal: { x: 355.6, y: 215.9 },
    };
    const size = sizes[paper] || sizes.A4;
    return { x: size.x / 2, y: size.y / 2 };
}

function layoutOffset(root: SExpression[], assemble: BoardAssemble) {
    const points = assemble.board?.polygon.map(kicadPoint);
    if (!points?.length) return { x: 0, y: 0 };
    const left = Math.min(...points.map((point) => point.x));
    const right = Math.max(...points.map((point) => point.x));
    const top = Math.min(...points.map((point) => point.y));
    const bottom = Math.max(...points.map((point) => point.y));
    const center = paperCenter(root);
    return { x: center.x - (left + right) / 2, y: center.y - (top + bottom) / 2 };
}

function swapSideLayers(node: SExpression[]) {
    const swaps: Record<string, string> = {
        'F.Cu': 'B.Cu', 'B.Cu': 'F.Cu', 'F.Paste': 'B.Paste', 'B.Paste': 'F.Paste',
        'F.Mask': 'B.Mask', 'B.Mask': 'F.Mask', 'F.SilkS': 'B.SilkS', 'B.SilkS': 'F.SilkS',
        'F.CrtYd': 'B.CrtYd', 'B.CrtYd': 'F.CrtYd', 'F.Fab': 'B.Fab', 'B.Fab': 'F.Fab',
        'F.Adhes': 'B.Adhes', 'B.Adhes': 'F.Adhes',
    };
    visitSExpression(node, (item) => {
        for (const value of item) {
            if (!isSExpressionList(value) && swaps[value.value]) value.value = swaps[value.value];
        }
    });
}

function setTextMirror(node: SExpression[], mirrored: boolean) {
    let effects = findChild(node, 'effects');
    if (!effects) {
        if (!mirrored) return;
        effects = [token('effects')];
        node.push(effects);
    }
    let justify = findChild(effects, 'justify');
    if (!justify) {
        if (!mirrored) return;
        justify = [token('justify')];
        effects.push(justify);
    }
    const hasMirror = justify.some((item) => !isSExpressionList(item) && atom(item) === 'mirror');
    if (mirrored && !hasMirror) justify.push(token('mirror'));
    if (!mirrored && hasMirror) {
        justify.splice(1, justify.length - 1, ...justify.slice(1).filter(
            (item) => isSExpressionList(item) || atom(item) !== 'mirror',
        ));
    }
    if (justify.length === 1) effects.splice(effects.indexOf(justify), 1);
}

export function setFootprintSide(node: SExpression[], targetLayer: 'F.Cu' | 'B.Cu') {
    if (footprintLayer(node) !== targetLayer) swapSideLayers(node);
    setChild(node, 'layer', [token(targetLayer, true)]);
    for (const child of node) {
        if (!isSExpressionList(child)) continue;
        const head = listHead(child);
        if (head === 'property' || head === 'fp_text') setTextMirror(child, targetLayer === 'B.Cu');
    }
}

function referenceProperty(footprint: SExpression[]) {
    return footprint.find((item) => isSExpressionList(item)
        && listHead(item) === 'property' && atom(item[1]) === 'Reference') as SExpression[] | undefined;
}

function localTextPosition(
    footprintX: number,
    footprintY: number,
    footprintRotation: number,
    side: 'top' | 'bottom',
    x: number,
    y: number,
) {
    // KiCad applies top rotations with the opposite screen-space sign; bottom is mirrored as well.
    const radians = (side === 'bottom' ? -footprintRotation : footprintRotation) * Math.PI / 180;
    const dx = x - footprintX;
    const dy = y - footprintY;
    const localX = dx * Math.cos(radians) - dy * Math.sin(radians);
    const localY = dx * Math.sin(radians) + dy * Math.cos(radians);
    return { x: side === 'bottom' ? -localX : localX, y: localY };
}

function setReferenceText(
    footprint: SExpression[],
    placement: NonNullable<BoardAssemble['components']>[number],
    x: number,
    y: number,
    footprintRotation: number,
    offset: { x: number; y: number },
) {
    const property = referenceProperty(footprint);
    if (!property) return;
    removeChildren(property, 'hide');
    if (!placement.designatorText) {
        property.push([token('hide'), token('yes')]);
        return;
    }
    const text = placement.designatorText;
    const textPoint = kicadPoint(text);
    const local = localTextPosition(
        x, y, footprintRotation, placement.layer,
        textPoint.x + offset.x, textPoint.y + offset.y,
    );
    setChild(property, 'at', [
        token(String(local.x)), token(String(local.y)),
        token(String(normalizeRotation(-text.rotate))),
    ]);
    setChild(property, 'layer', [token(placement.layer === 'top' ? 'F.SilkS' : 'B.SilkS', true)]);
    let effects = findChild(property, 'effects');
    if (!effects) {
        effects = [token('effects')];
        property.push(effects);
    }
    let font = findChild(effects, 'font');
    if (!font) {
        font = [token('font')];
        effects.push(font);
    }
    setChild(font, 'size', [token(String(text.height)), token(String(text.height))]);
}

function moveComponents(root: SExpression[], assemble: BoardAssemble, offset: { x: number; y: number }) {
    const byReference = new Map(pcbFootprints(root).flatMap((footprint) => {
        const reference = footprintReference(footprint);
        return reference ? [[reference.toUpperCase(), footprint] as const] : [];
    }));
    for (const placement of assemble.components ?? []) {
        const footprint = byReference.get(placement.designator.trim().toUpperCase());
        if (!footprint) {
            console.error(`[assemble_pcb_layout] component not found: ${placement.designator}`);
            continue;
        }
        normalizeEasyEdaFootprintGeometry(footprint);
        const normalizedEasyEdaGeometry = footprintGeometryIsNormalized(footprint);
        const previousRotation = footprintAt(footprint).rotate;
        const targetLayer = placement.layer === 'top' ? 'F.Cu' : 'B.Cu';
        setFootprintSide(footprint, targetLayer);
        const point = kicadPoint(placement);
        const x = point.x + offset.x;
        const y = point.y + offset.y;
        const rotation = kicadComponentRotation(placement, normalizedEasyEdaGeometry);
        rotateAbsoluteChildAngles(footprint, rotation - previousRotation);
        setChild(footprint, 'at', [
            token(String(x)), token(String(y)), token(String(rotation)),
        ]);
        setReferenceText(footprint, placement, x, y, rotation, offset);
    }
}

function outlineSegments(assemble: BoardAssemble, offset: { x: number; y: number }) {
    const points = assemble.board?.polygon ?? [];
    if (points.length < 3) return [];
    const normalized = points.length > 1
        && points[0].x === points.at(-1)?.x && points[0].y === points.at(-1)?.y
        ? points.slice(0, -1) : points;
    return normalized.map((point, index): SExpression[] => {
        const current = kicadPoint(point);
        const next = kicadPoint(normalized[(index + 1) % normalized.length]);
        return [
            token('gr_line'),
            [token('start'), token(String(current.x + offset.x)), token(String(current.y + offset.y))],
            [token('end'), token(String(next.x + offset.x)), token(String(next.y + offset.y))],
            [token('stroke'), [token('width'), token('0.05')], [token('type'), token('default')]],
            [token('layer'), token('Edge.Cuts', true)],
            [token('uuid'), token(randomUUID(), true)],
        ];
    });
}

function property(name: string, value: string): SExpression[] {
    return [
        token('property'), token(name, true), token(value, true),
        [token('at'), token('0'), token('0'), token('0')],
        [token('layer'), token('F.Fab', true)], [token('hide'), token('yes')],
        [token('uuid'), token(randomUUID(), true)],
        [token('effects'), [token('font'), [token('size'), token('1'), token('1')]]],
    ];
}

function padNetForm(version: number, net: string, legacyIds: Map<string, number>, root: SExpression[]) {
    if (!net) return [];
    if (version >= 20250000) return [[token('net'), token(net, true)] as SExpression[]];
    let id = legacyIds.get(net);
    if (id === undefined) {
        id = Math.max(0, ...legacyIds.values()) + 1;
        legacyIds.set(net, id);
        root.push([token('net'), token(String(id)), token(net, true)]);
    }
    return [[token('net'), token(String(id)), token(net, true)] as SExpression[]];
}

function legacyNetIds(root: SExpression[]) {
    const result = new Map<string, number>();
    for (const net of listChildren(root, 'net')) {
        const id = Number(atom(net[1]));
        const name = atom(net[2]);
        if (Number.isFinite(id) && name) result.set(name, id);
    }
    return result;
}

function generatedFootprintBase(name: string, x: number, y: number, layer = 'F.Cu'): SExpression[] {
    return [
        token('footprint'), token(`kicad-copilot:${name}`, true),
        [token('layer'), token(layer, true)], [token('uuid'), token(randomUUID(), true)],
        [token('at'), token(String(x)), token(String(y))],
        property('Reference', `#${name}`), property('kicad_copilot:generated', 'yes'),
        [token('attr'), token('board_only'), token('exclude_from_pos_files'), token('exclude_from_bom')],
    ];
}

function generatedPads(
    root: SExpression[],
    assemble: BoardAssemble,
    offset: { x: number; y: number },
    version: number,
) {
    const result: SExpression[][] = [];
    const netIds = legacyNetIds(root);
    for (const [index, item] of (assemble.pads ?? []).entries()) {
        const layer = item.layer === 'bottom' ? 'B.Cu' : 'F.Cu';
        const point = kicadPoint(item);
        const footprint = generatedFootprintBase(`PAD_${index + 1}`, point.x + offset.x, point.y + offset.y, layer);
        const round = item.shape === 'round';
        const width = item.diameter ?? item.width ?? 0.5;
        const height = item.diameter ?? item.height ?? width;
        const through = item.layer === 'multi';
        const pad: SExpression[] = [
            token('pad'), token(item.name, true), token(through ? 'thru_hole' : 'smd'),
            token(round ? 'circle' : item.shape),
            [token('at'), token('0'), token('0')],
            [token('size'), token(String(width)), token(String(height))],
            ...(through ? [[
                token('drill'), token(String(item.hole!.diameter)),
                ...(item.hole?.offset ? [[
                    token('offset'), token(String(item.hole.offset.x ?? 0)), token(String(-(item.hole.offset.y ?? 0))),
                ]] : []),
            ]] : []),
            [token('layers'), ...(through
                ? [token('*.Cu', true), token('*.Mask', true)]
                : [token(layer, true), token(layer === 'F.Cu' ? 'F.Paste' : 'B.Paste', true), token(layer === 'F.Cu' ? 'F.Mask' : 'B.Mask', true)])],
            ...padNetForm(version, item.net, netIds, root),
            [token('uuid'), token(randomUUID(), true)],
        ];
        footprint.push(pad);
        result.push(footprint);
    }
    for (const [index, via] of (assemble.vias ?? []).filter((item) => !item.net).entries()) {
        const point = kicadPoint(via);
        const footprint = generatedFootprintBase(`HOLE_${index + 1}`, point.x + offset.x, point.y + offset.y);
        footprint.push([
            token('pad'), token('', true), token('np_thru_hole'), token('circle'),
            [token('at'), token('0'), token('0')],
            [token('size'), token(String(via.diameter)), token(String(via.diameter))],
            [token('drill'), token(String(via.drill))],
            [token('layers'), token('*.Cu', true), token('*.Mask', true)],
            [token('uuid'), token(randomUUID(), true)],
        ]);
        result.push(footprint);
    }
    return result;
}

export function applyBoardAssemble(root: SExpression[], version: number, assemble: BoardAssemble) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const item = root[index];
        if (!isSExpressionList(item)) continue;
        if (CLEAN_HEADS.has(listHead(item) || '') || (listHead(item) === 'footprint' && footprintIsGenerated(item))) {
            root.splice(index, 1);
        }
    }
    const offset = layoutOffset(root, assemble);
    moveComponents(root, assemble, offset);
    root.push(...outlineSegments(assemble, offset));
    root.push(...generatedPads(root, assemble, offset, version));
    return root;
}
