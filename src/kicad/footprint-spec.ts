import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    type SExpression,
} from './sexpr/ast';

const PAD_MARGIN_MM = 0.254;
const EASYEDA_UUID_RE = /^[a-f0-9]{32}$/i;

type Point = { x: number; y: number };
type Box = { left: number; right: number; top: number; bottom: number };
type GraphicLayer = 'silk' | 'body' | 'marking' | 'document' | 'other';
type Graphic =
    | { kind: 'path'; layer: GraphicLayer; points: Point[]; closed: boolean; strokeWidth: number }
    | { kind: 'circle'; layer: GraphicLayer; x: number; y: number; radius: number; strokeWidth: number };

export type KicadFootprintSpec = {
    name: string;
    width: number;
    height: number;
    pads: Array<{
        pin_number: string | number;
        name?: string;
        x: number;
        y: number;
        width: number;
        height: number;
        shape?: 'rect' | 'oval' | 'round';
        mount?: 'smd' | 'through_hole';
        drillDiameter?: number;
    }>;
    graphics?: Graphic[];
    sourceOriginOffset?: Point;
};

type ParsedGraphic = { graphic: Graphic; box: Box };
type ParsedPad = KicadFootprintSpec['pads'][number] & { box: Box };

function numberAt(node: SExpression[] | undefined, index: number, fallback = 0) {
    const value = Number(atom(node?.[index]));
    return Number.isFinite(value) ? value : fallback;
}

function pointAt(node: SExpression[] | undefined, xIndex = 1, yIndex = 2): Point {
    return { x: numberAt(node, xIndex), y: numberAt(node, yIndex) };
}

function rotate(point: Point, degrees: number): Point {
    const radians = degrees * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: point.x * cos - point.y * sin,
        y: point.x * sin + point.y * cos,
    };
}

function translate(point: Point, offset: Point): Point {
    return { x: point.x + offset.x, y: point.y + offset.y };
}

function pointsBox(points: Point[]): Box {
    return {
        left: Math.min(...points.map((point) => point.x)),
        right: Math.max(...points.map((point) => point.x)),
        top: Math.min(...points.map((point) => point.y)),
        bottom: Math.max(...points.map((point) => point.y)),
    };
}

function mergeBoxes(boxes: Box[]): Box {
    return {
        left: Math.min(...boxes.map((box) => box.left)),
        right: Math.max(...boxes.map((box) => box.right)),
        top: Math.min(...boxes.map((box) => box.top)),
        bottom: Math.max(...boxes.map((box) => box.bottom)),
    };
}

function inflateBox(box: Box, margin: number): Box {
    return {
        left: box.left - margin,
        right: box.right + margin,
        top: box.top - margin,
        bottom: box.bottom + margin,
    };
}

function boxesOverlapOrTouch(a: Box, b: Box) {
    return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function physicalSilkBox(box: Box, physicalBaseBox: Box) {
    if (!boxesOverlapOrTouch(inflateBox(physicalBaseBox, 0.8), box)) return false;
    const merged = mergeBoxes([physicalBaseBox, box]);
    return merged.right - merged.left <= physicalBaseBox.right - physicalBaseBox.left + 1.6
        && merged.bottom - merged.top <= physicalBaseBox.bottom - physicalBaseBox.top + 1.6;
}

function roundMm(value: number) {
    return Number((Object.is(value, -0) ? 0 : value).toFixed(4));
}

function footprintName(node: SExpression[]) {
    const identifier = atom(node[1]) || 'KICAD_FOOTPRINT';
    return identifier.includes(':') ? identifier.slice(identifier.lastIndexOf(':') + 1) : identifier;
}

function graphicLayer(node: SExpression[]): GraphicLayer | undefined {
    const layer = atom(findChild(node, 'layer')?.[1]) || '';
    if (/^[FB]\.SilkS$/i.test(layer)) return 'silk';
    if (/^[FB]\.Fab$/i.test(layer)) return 'body';
    if (/^(Dwgs|Cmts)\.User$/i.test(layer)) return 'document';
    if (/^[FB]\.Adhes$/i.test(layer)) return 'marking';
    return undefined;
}

function strokeWidth(node: SExpression[]) {
    return Math.max(0, numberAt(findChild(node, 'width') || findChild(findChild(node, 'stroke') || [], 'width'), 1));
}

function pathGraphic(node: SExpression[], points: Point[], closed: boolean): ParsedGraphic | undefined {
    const layer = graphicLayer(node);
    if (!layer || points.length < 2) return undefined;
    return {
        graphic: { kind: 'path', layer, points, closed, strokeWidth: strokeWidth(node) },
        box: pointsBox(points),
    };
}

function arcPoints(start: Point, mid: Point, end: Point) {
    const determinant = 2 * (
        start.x * (mid.y - end.y)
        + mid.x * (end.y - start.y)
        + end.x * (start.y - mid.y)
    );
    if (Math.abs(determinant) < 1e-9) return [start, mid, end];
    const startSq = start.x ** 2 + start.y ** 2;
    const midSq = mid.x ** 2 + mid.y ** 2;
    const endSq = end.x ** 2 + end.y ** 2;
    const center = {
        x: (startSq * (mid.y - end.y) + midSq * (end.y - start.y) + endSq * (start.y - mid.y)) / determinant,
        y: (startSq * (end.x - mid.x) + midSq * (start.x - end.x) + endSq * (mid.x - start.x)) / determinant,
    };
    const angle = (point: Point) => Math.atan2(point.y - center.y, point.x - center.x);
    const tau = Math.PI * 2;
    const normalize = (value: number) => ((value % tau) + tau) % tau;
    const startAngle = normalize(angle(start));
    const midAngle = normalize(angle(mid));
    const endAngle = normalize(angle(end));
    const ccwSweep = normalize(endAngle - startAngle);
    const midSweep = normalize(midAngle - startAngle);
    const sweep = midSweep <= ccwSweep ? ccwSweep : ccwSweep - tau;
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const steps = Math.max(8, Math.ceil(Math.abs(sweep) / (Math.PI / 18)));
    return Array.from({ length: steps + 1 }, (_, index) => {
        const current = startAngle + sweep * index / steps;
        return { x: center.x + radius * Math.cos(current), y: center.y + radius * Math.sin(current) };
    });
}

function parseGraphic(node: SExpression[]): ParsedGraphic | undefined {
    const head = listHead(node);
    if (head === 'fp_line') {
        return pathGraphic(node, [pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))], false);
    }
    if (head === 'fp_rect') {
        const start = pointAt(findChild(node, 'start'));
        const end = pointAt(findChild(node, 'end'));
        return pathGraphic(node, [
            start,
            { x: end.x, y: start.y },
            end,
            { x: start.x, y: end.y },
            start,
        ], true);
    }
    if (head === 'fp_poly' || head === 'fp_curve') {
        const points = (findChild(node, 'pts') || []).slice(1).flatMap((item) => (
            isSExpressionList(item) && listHead(item) === 'xy' ? [pointAt(item)] : []
        ));
        const closed = points.length > 2
            && Math.hypot(points[0].x - points.at(-1)!.x, points[0].y - points.at(-1)!.y) < 0.001;
        return pathGraphic(node, points, closed);
    }
    if (head === 'fp_circle') {
        const layer = graphicLayer(node);
        if (!layer) return undefined;
        const center = pointAt(findChild(node, 'center'));
        const end = pointAt(findChild(node, 'end'));
        const radius = Math.hypot(end.x - center.x, end.y - center.y);
        return {
            graphic: { kind: 'circle', layer, x: center.x, y: center.y, radius, strokeWidth: strokeWidth(node) },
            box: { left: center.x - radius, right: center.x + radius, top: center.y - radius, bottom: center.y + radius },
        };
    }
    if (head === 'fp_arc') {
        const startNode = findChild(node, 'start');
        const midNode = findChild(node, 'mid');
        const endNode = findChild(node, 'end');
        if (midNode) return pathGraphic(node, arcPoints(pointAt(startNode), pointAt(midNode), pointAt(endNode)), false);
        const angle = numberAt(findChild(node, 'angle'), 1, Number.NaN);
        if (!Number.isFinite(angle)) return undefined;
        if (Math.abs(angle) >= 350) return undefined;
        const center = pointAt(startNode);
        const start = pointAt(endNode);
        const steps = Math.max(8, Math.ceil(Math.abs(angle) / 10));
        return pathGraphic(node, Array.from({ length: steps + 1 }, (_, index) => (
            translate(rotate({ x: start.x - center.x, y: start.y - center.y }, angle * index / steps), center)
        )), false);
    }
    return undefined;
}

function rotatedRectBox(center: Point, width: number, height: number, rotation: number) {
    const corners = [
        { x: -width / 2, y: -height / 2 },
        { x: width / 2, y: -height / 2 },
        { x: width / 2, y: height / 2 },
        { x: -width / 2, y: height / 2 },
    ].map((point) => translate(rotate(point, rotation), center));
    return pointsBox(corners);
}

function primitiveBox(node: SExpression[]): Box | undefined {
    const head = listHead(node);
    const lineWidth = Math.max(0, numberAt(findChild(node, 'width'), 1)) / 2;
    if (head === 'gr_poly' || head === 'gr_curve') {
        const points = (findChild(node, 'pts') || []).slice(1).flatMap((item) => (
            isSExpressionList(item) && listHead(item) === 'xy' ? [pointAt(item)] : []
        ));
        return points.length ? pointsBox(points) : undefined;
    }
    if (head === 'gr_rect') {
        return inflateBox(pointsBox([pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))]), lineWidth);
    }
    if (head === 'gr_line') {
        return inflateBox(pointsBox([pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))]), lineWidth);
    }
    if (head === 'gr_circle') {
        const center = pointAt(findChild(node, 'center'));
        const end = pointAt(findChild(node, 'end'));
        const radius = Math.hypot(end.x - center.x, end.y - center.y) + lineWidth;
        return { left: center.x - radius, right: center.x + radius, top: center.y - radius, bottom: center.y + radius };
    }
    if (head === 'gr_arc') {
        const start = pointAt(findChild(node, 'start'));
        const midNode = findChild(node, 'mid');
        const end = pointAt(findChild(node, 'end'));
        if (midNode) return inflateBox(pointsBox(arcPoints(start, pointAt(midNode), end)), lineWidth);
        const angle = numberAt(findChild(node, 'angle'), 1, Number.NaN);
        if (!Number.isFinite(angle)) return undefined;
        const steps = Math.max(8, Math.ceil(Math.abs(angle) / 10));
        const points = Array.from({ length: steps + 1 }, (_, index) => (
            translate(rotate({ x: end.x - start.x, y: end.y - start.y }, angle * index / steps), start)
        ));
        return inflateBox(pointsBox(points), lineWidth);
    }
    return undefined;
}

function courtyardBox(node: SExpression[]): Box | undefined {
    const layer = atom(findChild(node, 'layer')?.[1]) || '';
    if (!/^[FB]\.CrtYd$/i.test(layer)) return undefined;
    const head = listHead(node);
    if (head === 'fp_line') return pointsBox([pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))]);
    if (head === 'fp_rect') return pointsBox([pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))]);
    if (head === 'fp_poly' || head === 'fp_curve') {
        const points = (findChild(node, 'pts') || []).slice(1).flatMap((item) => (
            isSExpressionList(item) && listHead(item) === 'xy' ? [pointAt(item)] : []
        ));
        return points.length ? pointsBox(points) : undefined;
    }
    if (head === 'fp_circle') {
        const center = pointAt(findChild(node, 'center'));
        const end = pointAt(findChild(node, 'end'));
        const radius = Math.hypot(end.x - center.x, end.y - center.y);
        return { left: center.x - radius, right: center.x + radius, top: center.y - radius, bottom: center.y + radius };
    }
    if (head === 'fp_arc') {
        const start = pointAt(findChild(node, 'start'));
        const midNode = findChild(node, 'mid');
        const end = pointAt(findChild(node, 'end'));
        if (midNode) return pointsBox(arcPoints(start, pointAt(midNode), end));
        const angle = numberAt(findChild(node, 'angle'), 1, Number.NaN);
        if (!Number.isFinite(angle)) return undefined;
        const steps = Math.max(8, Math.ceil(Math.abs(angle) / 10));
        return pointsBox(Array.from({ length: steps + 1 }, (_, index) => (
            translate(rotate({ x: end.x - start.x, y: end.y - start.y }, angle * index / steps), start)
        )));
    }
    return undefined;
}

function padDrillDiameter(node: SExpression[]) {
    const drill = findChild(node, 'drill');
    if (!drill) return undefined;
    const values = drill.slice(1).map(atom).map(Number).filter((value) => Number.isFinite(value) && value > 0);
    return values.length ? Math.max(...values) : undefined;
}

function padShape(node: SExpression[]) {
    const shape = atom(node[3]) || 'rect';
    if (shape === 'circle') return 'round' as const;
    if (shape === 'oval') return 'oval' as const;
    return 'rect' as const;
}

function parsePad(node: SExpression[], mechanicalIndex: number): ParsedPad | undefined {
    const type = atom(node[2]) || 'smd';
    const shape = atom(node[3]) || 'rect';
    const atNode = findChild(node, 'at');
    const rotation = numberAt(atNode, 3);
    let center = pointAt(atNode);
    const size = findChild(node, 'size');
    let width = Math.max(0, numberAt(size, 1));
    let height = Math.max(0, numberAt(size, 2, width));
    const offsetNode = findChild(node, 'offset');
    if (offsetNode) center = translate(center, rotate(pointAt(offsetNode), rotation));

    if (shape === 'custom') {
        const primitives = findChild(node, 'primitives');
        const boxes = primitives?.slice(1).flatMap((item) => {
            if (!isSExpressionList(item)) return [];
            const box = primitiveBox(item);
            return box ? [box] : [];
        }) ?? [];
        if (boxes.length) {
            const box = mergeBoxes(boxes);
            const localCenter = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
            center = translate(center, rotate(localCenter, rotation));
            width = box.right - box.left;
            height = box.bottom - box.top;
        }
    }
    if (!(width > 0 && height > 0)) return undefined;

    const box = rotatedRectBox(center, width, height, rotation);
    const rawNumber = atom(node[1]) || '';
    const pinNumber = rawNumber || `MH${mechanicalIndex}`;
    const drillDiameter = padDrillDiameter(node);
    return {
        pin_number: pinNumber,
        name: pinNumber,
        x: center.x,
        y: center.y,
        width: box.right - box.left,
        height: box.bottom - box.top,
        shape: padShape(node),
        mount: type === 'smd' && drillDiameter === undefined ? 'smd' : 'through_hole',
        ...(drillDiameter === undefined ? {} : { drillDiameter }),
        box,
    };
}

function normalizeGraphic(graphic: Graphic, center: Point): Graphic {
    if (graphic.kind === 'circle') {
        return {
            ...graphic,
            x: roundMm(graphic.x - center.x),
            y: roundMm(graphic.y - center.y),
            radius: roundMm(graphic.radius),
            strokeWidth: roundMm(graphic.strokeWidth),
        };
    }
    return {
        ...graphic,
        points: graphic.points.map((point) => ({
            x: roundMm(point.x - center.x),
            y: roundMm(point.y - center.y),
        })),
        strokeWidth: roundMm(graphic.strokeWidth),
    };
}

export function validEasyEdaUuid(value: string | null | undefined): value is string {
    return Boolean(value && EASYEDA_UUID_RE.test(value) && !/^0+$/.test(value));
}

export function kicadFootprintToSpec(node: SExpression[]): KicadFootprintSpec {
    let mechanicalIndex = 1;
    const pads = node.flatMap((item) => {
        if (!isSExpressionList(item) || listHead(item) !== 'pad') return [];
        const parsed = parsePad(item, mechanicalIndex);
        if (!atom(item[1])) mechanicalIndex += 1;
        return parsed ? [parsed] : [];
    });
    if (!pads.length) throw new Error(`KiCad footprint ${footprintName(node)} has no supported pads`);

    const graphics = node.flatMap((item) => {
        if (!isSExpressionList(item)) return [];
        const parsed = parseGraphic(item);
        return parsed ? [parsed] : [];
    });
    const courtyardBoxes = node.flatMap((item) => {
        if (!isSExpressionList(item)) return [];
        const box = courtyardBox(item);
        return box ? [box] : [];
    });
    const bodyBoxes = [
        ...graphics.filter((item) => item.graphic.layer === 'body').map((item) => item.box),
        ...courtyardBoxes,
    ];
    const silkBoxes = graphics
        .filter((item) => item.graphic.layer === 'silk')
        .filter((item) => item.graphic.kind !== 'circle' || item.graphic.radius > 0.05)
        .map((item) => item.box);
    const paddedPadBox = inflateBox(mergeBoxes(pads.map((pad) => pad.box)), PAD_MARGIN_MM);
    const bodyBox = bodyBoxes.length ? mergeBoxes(bodyBoxes) : undefined;
    const physicalBaseBox = bodyBox ? mergeBoxes([bodyBox, paddedPadBox]) : paddedPadBox;
    const physicalSilkBoxes = bodyBox
        ? silkBoxes.filter((box) => physicalSilkBox(box, physicalBaseBox))
        : silkBoxes;
    const footprintBox = mergeBoxes([physicalBaseBox, ...physicalSilkBoxes]);
    const center = {
        x: (footprintBox.left + footprintBox.right) / 2,
        y: (footprintBox.top + footprintBox.bottom) / 2,
    };

    return {
        name: footprintName(node),
        width: roundMm(footprintBox.right - footprintBox.left),
        height: roundMm(footprintBox.bottom - footprintBox.top),
        pads: pads.map(({ box: _box, ...pad }) => ({
            ...pad,
            x: roundMm(pad.x - center.x),
            y: roundMm(pad.y - center.y),
            width: roundMm(pad.width),
            height: roundMm(pad.height),
            ...(pad.drillDiameter === undefined ? {} : { drillDiameter: roundMm(pad.drillDiameter) }),
        })),
        ...(graphics.length ? { graphics: graphics.map((item) => normalizeGraphic(item.graphic, center)) } : {}),
        sourceOriginOffset: { x: roundMm(-center.x), y: roundMm(-center.y) },
    };
}
