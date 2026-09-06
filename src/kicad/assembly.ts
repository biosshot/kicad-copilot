import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { getSchematicContext } from './schematic-reader';
import { children, nativeAsset, nativeProperty, position, scalar, SchematicAsset, sheetFilePath as resolveSheetFile } from './schematic-assets';
import { placeLocalSymbol } from './local-symbol-writer';
import { parseSignal } from './scoped-signals';
import { ConvertedComponent, convertComponent } from '../components/converter';
import { projectFootprintId, writeProjectLibraries } from '../components/project-library';
import { CircuitAssembly, ExplainCircuit } from '../types/circuit';
import { DiagnosticReporter } from '../utils/diagnostics';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    parseSExpression,
    printSExpression,
    SExpression,
    token,
} from './sexpr/ast';
import {
    findLists,
    findQuotedProperty,
    findScalarValue,
    quoteSExpression,
    SExpressionRange,
} from './sexpr/scan';
import {
    embeddedLibrarySymbol,
    LibraryPin,
    LibraryPropertyPosition,
    normalizedComponentSymbol,
} from './symbol';
import { applySourceEdits, mutateSchematic, SourceEdit } from './schematic-writer';
import {
    planWireRemoval,
    pointTouchesWire,
    redundantJunctionRanges,
    wireDirectionsAtPoint,
} from './wire-removal';

const SERVER_UNIT_MM = 0.254;
const GRID_MM = 1.27;
const CONNECTION_LENGTHS_MM = [
    20, 30,
    ...Array.from({ length: 39 }, (_, index) => 40 + index * 20),
    15, 10, 5,
].map((value) => value * SERVER_UNIT_MM);
const PORT_OFFSET_LENGTHS_MM = Array.from(
    { length: 80 },
    (_, index) => (index + 1) * 10 * SERVER_UNIT_MM,
);
type Point = { x: number; y: number };
// Server layout is authoritative: a sheet placement may translate it, never rotate or scale it.
type Placement = { offset: Point; warning?: string };
type CircuitAssemblyComponent = CircuitAssembly['components'][number];
type Rect = { left: number; top: number; right: number; bottom: number };
type RoutedSegment = { start: Point; end: Point; signal?: string };
type EmbeddedSymbol = ReturnType<typeof embeddedLibrarySymbol>;
type ExistingSymbol = {
    range: SExpressionRange;
    reference: string;
    anchor: Point;
    pins: Map<string, Point>;
    pinLabelAngles: Map<string, number>;
    service: boolean;
};
type PlacedComponent = {
    source: CircuitAssemblyComponent;
    anchor: Point;
    pins: Map<string, Point>;
    kind: 'real' | 'port' | 'gnd';
};

function rounded(value: number) {
    return Number(value.toFixed(4));
}

function snapped(value: number) {
    return rounded(Math.round(value / GRID_MM) * GRID_MM);
}

function pointKey(point: Point) {
    return `${rounded(point.x)},${rounded(point.y)}`;
}

function normalizeRotation(value = 0) {
    return ((value % 360) + 360) % 360;
}

function kicadRotation(value = 0) {
    // Server page coordinates and KiCad schematic instances use the same
    // clockwise-on-a-Y-down-page orientation.
    return normalizeRotation(value);
}

function baseDesignator(value: string) {
    return value.trim().replace(/\.\d+$/, '');
}

function targetVersion(source: string) {
    const match = source.match(/\(version\s+(\d+)\)/);
    if (!match) throw new Error('invalid KiCad schematic: version not found');
    return Number(match[1]);
}

function targetUuid(source: string) {
    const uuid = findScalarValue(source, 'uuid');
    if (!uuid) throw new Error('invalid KiCad schematic: root uuid not found');
    return uuid;
}

function atPoint(list: SExpression[] | undefined) {
    if (!list) return undefined;
    const x = Number(atom(list[1]));
    const y = Number(atom(list[2]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    return { x, y };
}

function transformedLocalPoint(
    point: Pick<LibraryPin, 'x' | 'y'>,
    anchor: Point,
    rotation: number,
    mirror: boolean,
) {
    const radians = rotation * Math.PI / 180;
    const localY = mirror ? -point.y : point.y;
    return {
        x: rounded(anchor.x + point.x * Math.cos(radians) - localY * Math.sin(radians)),
        y: rounded(anchor.y - point.x * Math.sin(radians) - localY * Math.cos(radians)),
    };
}

function transformedPin(pin: LibraryPin, anchor: Point, rotation: number, mirror: boolean) {
    return transformedLocalPoint(pin, anchor, rotation, mirror);
}

function transformedPropertyPosition(
    position: LibraryPropertyPosition,
    anchor: Point,
    rotation: number,
    mirror: boolean,
) {
    return {
        ...transformedLocalPoint(position, anchor, rotation, mirror),
        angle: normalizeRotation(rotation + (mirror ? -position.angle : position.angle)),
    };
}

function transformedPinLabelAngle(pin: LibraryPin, rotation: number, mirror: boolean) {
    return normalizeRotation(rotation + 180 + (mirror ? -pin.angle : pin.angle));
}

function uniquePins(pins: LibraryPin[]) {
    const output = new Map<string, LibraryPin>();
    for (const pin of pins) if (!output.has(pin.number)) output.set(pin.number, pin);
    return output;
}

function embeddedSymbols(source: string) {
    const range = findLists(source, 'lib_symbols')[0];
    if (!range) throw new Error('invalid KiCad schematic: lib_symbols not found');
    const root = parseSExpression(range.text);
    const symbols = new Map<string, SExpression[]>();
    for (const item of root) {
        if (!isSExpressionList(item) || listHead(item) !== 'symbol') continue;
        const name = atom(item[1]);
        if (name) symbols.set(name, item);
    }
    return { range, symbols };
}

function instanceData(range: SExpressionRange, symbols: Map<string, SExpression[]>) {
    const value = parseSExpression(range.text);
    const libId = atom(findChild(value, 'lib_id')?.[1]);
    const reference = findQuotedProperty(range.text, 'Reference');
    const at = findChild(value, 'at');
    const anchor = atPoint(at);
    if (!libId || !reference || !anchor) return undefined;
    const symbol = symbols.get(libId);
    if (!symbol) return undefined;

    const rotation = normalizeRotation(Number(atom(at?.[3]) || 0));
    const native = nativeAsset(symbol, value);
    const pins = new Map<string, Point>();
    const pinLabelAngles = new Map<string, number>();
    for (const pin of uniquePins(native.pins).values()) {
        pins.set(pin.number, transformedPin(pin, anchor, rotation, false));
        pinLabelAngles.set(pin.number, transformedPinLabelAngle(pin, rotation, false));
    }
    return {
        range,
        reference: native.multiUnit ? `${baseDesignator(reference)}.${native.unit}` : baseDesignator(reference),
        anchor,
        pins,
        pinLabelAngles,
        service: reference.startsWith('#PWR') || reference.startsWith('#PORT'),
    } satisfies ExistingSymbol;
}

function existingSymbols(source: string, symbols: Map<string, SExpression[]>) {
    const nativeSymbols = findLists(source, 'symbol')
        .map((range) => instanceData(range, symbols))
        .filter((value): value is ExistingSymbol => Boolean(value));
    const sheets: ExistingSymbol[] = findLists(source, 'sheet').map(range => {
        const sheet = parseSExpression(range.text);
        const pins = children(sheet, 'pin');
        return { range, reference: nativeProperty(sheet, 'Sheetname'), anchor: position(sheet), service: false,
            pins: new Map(pins.map(p => [atom(p[1])!, position(p)])),
            pinLabelAngles: new Map(pins.map(p => [atom(p[1])!, Number(atom(findChild(p, 'at')?.[3]) ?? 0)])) };
    });
    return [...nativeSymbols, ...sheets];
}

function xyPoints(range: SExpressionRange) {
    const value = parseSExpression(range.text);
    const pts = findChild(value, 'pts');
    if (!pts) return [];
    return pts.filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === 'xy')
        .map(atPoint)
        .filter((point): point is Point => Boolean(point));
}

function rangeAtPoint(range: SExpressionRange) {
    const value = parseSExpression(range.text);
    return atPoint(findChild(value, 'at'));
}

function pageSize(source: string) {
    const paper = findLists(source, 'paper')[0]?.text || '';
    const name = paper.match(/\(paper\s+"([^"]+)"/)?.[1] || 'A4';
    const custom = paper.match(/\(paper\s+"User"\s+([\d.]+)\s+([\d.]+)/i);
    if (custom) return { x: Number(custom[1]), y: Number(custom[2]) };
    const sizes: Record<string, Point> = {
        A5: { x: 210, y: 148 },
        A4: { x: 297, y: 210 },
        A3: { x: 420, y: 297 },
        A2: { x: 594, y: 420 },
        A1: { x: 841, y: 594 },
        A0: { x: 1189, y: 841 },
        Letter: { x: 279.4, y: 215.9 },
        Legal: { x: 355.6, y: 215.9 },
    };
    return sizes[name] || sizes.A4;
}

function serviceComponent(component: CircuitAssemblyComponent) {
    return component.part_uuid === 'GND'
        || component.part_uuid === 'VCC'
        || component.value === 'unknown_shortsym'
        || component.designator.includes('|');
}

export function serverRect(assembly: CircuitAssembly) {
    const rects: Rect[] = [];
    for (const component of assembly.components) {
        const center = component.pos.center || {
            x: component.pos.width / 2,
            y: component.pos.height / 2,
        };
        if (serviceComponent(component)) {
            const x = (component.pos.x + center.x) * SERVER_UNIT_MM;
            const y = (component.pos.y + center.y) * SERVER_UNIT_MM;
            rects.push({ left: x, right: x, top: y, bottom: y });
            continue;
        }
        rects.push({
            left: component.pos.x * SERVER_UNIT_MM,
            right: (component.pos.x + component.pos.width) * SERVER_UNIT_MM,
            top: component.pos.y * SERVER_UNIT_MM,
            bottom: (component.pos.y + component.pos.height) * SERVER_UNIT_MM,
        });
    }
    for (const edge of assembly.edges) {
        for (const section of edge.sections || []) {
            for (const point of [section.startPoint, ...(section.bendPoints || []), section.endPoint]) {
                const x = point.x * SERVER_UNIT_MM;
                const y = point.y * SERVER_UNIT_MM;
                rects.push({ left: x, right: x, top: y, bottom: y });
            }
        }
    }
    for (const block of assembly.assembly_options?.draw_blocks ? assembly.blocks_rect || [] : []) {
        rects.push({
            left: block.x * SERVER_UNIT_MM,
            right: (block.x + block.width) * SERVER_UNIT_MM,
            top: block.y * SERVER_UNIT_MM,
            bottom: (block.y + block.height) * SERVER_UNIT_MM,
        });
    }
    if (!rects.length) return { left: 0, top: 0, right: 10, bottom: 10 };
    return {
        left: Math.min(...rects.map((rect) => rect.left)),
        top: Math.min(...rects.map((rect) => rect.top)),
        right: Math.max(...rects.map((rect) => rect.right)),
        bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
}

function intersects(left: Rect, right: Rect) {
    return left.left < right.right && left.right > right.left
        && left.top < right.bottom && left.bottom > right.top;
}

function translated(rect: Rect, offset: Point, padding = 0): Rect {
    return {
        left: rect.left + offset.x - padding,
        right: rect.right + offset.x + padding,
        top: rect.top + offset.y - padding,
        bottom: rect.bottom + offset.y + padding,
    };
}

function placementOffset(
    source: string,
    assembly: CircuitAssembly,
    retained: ExistingSymbol[],
    removed: ExistingSymbol[],
) {
    const paper = pageSize(source);
    const bounds = serverRect(assembly);
    const occupied: Rect[] = retained.map(({ anchor }) => ({
        left: anchor.x - 15,
        right: anchor.x + 15,
        top: anchor.y - 10,
        bottom: anchor.y + 10,
    }));
    for (const range of findLists(source, 'sheet')) {
        if (removed.some(item => item.range.start === range.start)) continue;
        const value = parseSExpression(range.text);
        const at = atPoint(findChild(value, 'at'));
        const size = atPoint(findChild(value, 'size'));
        if (at && size) occupied.push({
            left: at.x,
            top: at.y,
            right: at.x + size.x,
            bottom: at.y + size.y,
        });
    }

    const target = removed.length
        ? {
            x: removed.reduce((sum, item) => sum + item.anchor.x, 0) / removed.length,
            y: removed.reduce((sum, item) => sum + item.anchor.y, 0) / removed.length,
        }
        : { x: paper.x / 2, y: paper.y / 2 };
    const step = GRID_MM;
    const maxRadius = Math.ceil(Math.max(paper.x, paper.y) / step);
    const center = {
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
    };
    const initial = {
        x: snapped(target.x - center.x),
        y: snapped(target.y - center.y),
    };
    let fallback = initial;
    let fallbackScore = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const tried = new Set<string>();
    for (let radius = 0; radius <= maxRadius; radius += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
            for (let dy = -radius; dy <= radius; dy += 1) {
                if (radius && Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue;
                const offset = {
                    x: snapped(initial.x + dx * step),
                    y: snapped(initial.y + dy * step),
                };
                const key = pointKey(offset);
                if (tried.has(key)) continue;
                tried.add(key);
                const rawCandidate = translated(bounds, offset);
                const overlapCount = occupied.filter((rect) => intersects(rawCandidate, rect)).length;
                const overflow = Math.max(0, -rawCandidate.left)
                    + Math.max(0, -rawCandidate.top)
                    + Math.max(0, rawCandidate.right - paper.x)
                    + Math.max(0, rawCandidate.bottom - paper.y);
                const distance = Math.abs(offset.x - initial.x) + Math.abs(offset.y - initial.y);
                const score = [overlapCount, overflow, distance];
                if (score.some((value, index) => value < fallbackScore[index]
                    && score.slice(0, index).every((item, prefix) => item === fallbackScore[prefix]))) {
                    fallback = offset;
                    fallbackScore = score;
                }
                const candidate = translated(bounds, offset, 5.08);
                if (candidate.left < 0 || candidate.top < 0
                    || candidate.right > paper.x || candidate.bottom > paper.y) continue;
                if (!occupied.some((rect) => intersects(candidate, rect))) return { offset };
            }
        }
    }

    const warning = `no free area on schematic sheet: paper=${paper.x}x${paper.y}, `
        + `assembly=${rounded(bounds.right - bounds.left)}x${rounded(bounds.bottom - bounds.top)}, `
        + `obstacles=${occupied.length}; using best-effort placement at `
        + `${rounded(fallback.x)},${rounded(fallback.y)}`;
    return { offset: fallback, warning };
}

export function emptySheetPlacement(source: string, assembly: CircuitAssembly, target?: Point) {
    const removed = target ? [{ anchor: target } as ExistingSymbol] : [];
    return placementOffset(source, assembly, [], removed);
}

function serverPoint(point: Point, placement: Placement) {
    return {
        x: snapped(placement.offset.x + point.x * SERVER_UNIT_MM),
        y: snapped(placement.offset.y + point.y * SERVER_UNIT_MM),
    };
}

function componentAnchor(component: CircuitAssemblyComponent, placement: Placement) {
    const center = component.pos.center || {
        x: component.pos.width / 2,
        y: component.pos.height / 2,
    };
    return serverPoint({
        x: component.pos.x + center.x,
        y: component.pos.y + center.y,
    }, placement);
}

function effects(hidden = false) {
    return `${hidden ? '(hide yes) ' : ''}(effects (font (size 1.27 1.27)))`;
}

function property(name: string, value: string, x: number, y: number, hidden = true, angle = 0) {
    return `(property ${quoteSExpression(name)} ${quoteSExpression(value)} (at ${x} ${y} ${normalizeRotation(angle)}) (show_name no) (do_not_autoplace no) ${effects(hidden)})`;
}

function unitNumber(component: CircuitAssemblyComponent) {
    const match = component.sub_part_name?.match(/\.(\d+)$/);
    return match ? Number(match[1]) : 1;
}

function symbolInstance(options: {
    embedded: EmbeddedSymbol;
    component: CircuitAssemblyComponent;
    anchor: Point;
    projectName: string;
    documentUuid: string;
    reference?: string;
    value?: string;
    power?: 'ground' | 'port';
    hideValue?: boolean;
    rotation?: number;
}) {
    const reference = options.reference || baseDesignator(options.component.designator);
    const value = options.value || options.component.value;
    const rotation = kicadRotation(options.rotation ?? options.component.pos.rotate);
    const mirror = options.component.pos.mirror ? '(mirror x)' : '';
    const properties = options.embedded.properties;
    const power = options.power;
    const referenceY = power === 'ground'
        ? options.anchor.y + 6.35
        : options.anchor.y - 6.35;
    const valueY = power === 'ground'
        ? options.anchor.y + 3.556
        : options.anchor.y - 3.556;
    const realReference = transformedPropertyPosition(
        options.embedded.propertyPositions.get('Reference') || { x: 0, y: 5.08, angle: 0 },
        options.anchor,
        rotation,
        Boolean(options.component.pos.mirror),
    );
    const realValue = transformedPropertyPosition(
        options.embedded.propertyPositions.get('Value') || { x: 0, y: -5.08, angle: 0 },
        options.anchor,
        rotation,
        Boolean(options.component.pos.mirror),
    );
    const pins = [...uniquePins(options.embedded.pins).keys()]
        .map((number) => `(pin ${quoteSExpression(number)} (uuid ${quoteSExpression(randomUUID())}))`)
        .join(' ');
    return `(symbol
        (lib_id ${quoteSExpression(options.embedded.id)}) (at ${options.anchor.x} ${options.anchor.y} ${rotation})
        (unit ${unitNumber(options.component)}) ${mirror}
        (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        (uuid ${quoteSExpression(randomUUID())})
        ${property('Reference', reference, power ? options.anchor.x : realReference.x, power ? referenceY : realReference.y, Boolean(power), power ? 0 : realReference.angle)}
        ${property('Value', value, power ? options.anchor.x : realValue.x, power ? valueY : realValue.y, Boolean(options.hideValue), power ? 0 : realValue.angle)}
        ${property('Footprint', properties.Footprint || '', options.anchor.x, options.anchor.y)}
        ${property('Datasheet', properties.Datasheet || '', options.anchor.x, options.anchor.y)}
        ${property('Description', properties.Description || '', options.anchor.x, options.anchor.y)}
        ${property('MPN', properties.MPN || value, options.anchor.x, options.anchor.y)}
        ${property('LCSC Part', properties['LCSC Part'] || '', options.anchor.x, options.anchor.y)}
        ${property('EasyEDA part_uuid', options.component.part_uuid || '', options.anchor.x, options.anchor.y)}
        ${property('Block Name', options.component.block_name || '', options.anchor.x, options.anchor.y)}
        ${pins}
        (instances (project ${quoteSExpression(options.projectName)}
            (path ${quoteSExpression(`/${options.documentUuid}`)}
                (reference ${quoteSExpression(reference)}) (unit ${unitNumber(options.component)})))))`;
}

function globalLabel(name: string, point: Point, angle = 0) {
    const rotation = canonicalDirectionAngle(angle);
    const justify = rotation === 0 || rotation === 90 ? 'left' : 'right';
    return `(global_label ${quoteSExpression(name)} (shape bidirectional)
        (at ${point.x} ${point.y} ${rotation})
        (effects (font (size 1.27 1.27)) (justify ${justify}))
        (uuid ${quoteSExpression(randomUUID())})
        ${property('Intersheetrefs', '${INTERSHEET_REFS}', point.x, point.y, true)})`;
}

function localLabel(name: string, point: Point) {
    return `(label ${quoteSExpression(name)} (at ${point.x} ${point.y} 0)
        ${effects()}
        (uuid ${quoteSExpression(randomUUID())}))`;
}

function wireSegment(start: Point, end: Point) {
    return `(wire (pts (xy ${start.x} ${start.y}) (xy ${end.x} ${end.y}))
        (stroke (width 0) (type default)) (uuid ${quoteSExpression(randomUUID())}))`;
}

function orthogonalPoints(points: Point[]) {
    const output: Point[] = [];
    for (const point of points) {
        const previous = output.at(-1);
        if (!previous) {
            output.push(point);
            continue;
        }
        if (previous.x !== point.x && previous.y !== point.y) {
            const dx = Math.abs(previous.x - point.x);
            const dy = Math.abs(previous.y - point.y);
            output.push(dx < dy
                ? { x: point.x, y: previous.y }
                : { x: previous.x, y: point.y });
        }
        if (pointKey(output.at(-1)!) !== pointKey(point)) output.push(point);
    }
    return output;
}

function nearlyEqual(left: number, right: number) {
    return Math.abs(left - right) < 1e-6;
}

export function routedSectionPoints(
    section: CircuitAssembly['edges'][number]['sections'][number],
    start: Point,
    end: Point,
    placement: Placement,
) {
    const rawBends = section.bendPoints || [];
    const serverStart = serverPoint(section.startPoint, placement);
    const serverEnd = serverPoint(section.endPoint, placement);
    if (!rawBends.length) {
        if (nearlyEqual(serverStart.x, serverEnd.x)) {
            const serverX = serverStart.x;
            const routeX = nearlyEqual(start.x, end.x)
                ? start.x
                : nearlyEqual(start.x, serverX) || nearlyEqual(end.x, serverX)
                    ? serverX
                    : start.x;
            return orthogonalPoints([
                start,
                { x: routeX, y: start.y },
                { x: routeX, y: end.y },
                end,
            ]);
        }
        if (nearlyEqual(serverStart.y, serverEnd.y)) {
            const serverY = serverStart.y;
            const routeY = nearlyEqual(start.y, end.y)
                ? start.y
                : nearlyEqual(start.y, serverY) || nearlyEqual(end.y, serverY)
                    ? serverY
                    : start.y;
            return orthogonalPoints([
                start,
                { x: start.x, y: routeY },
                { x: end.x, y: routeY },
                end,
            ]);
        }
        return orthogonalPoints([start, end]);
    }

    const bends = rawBends.map((point) => serverPoint(point, placement));
    const firstRaw = bends[0];
    if (nearlyEqual(serverStart.y, firstRaw.y)) bends[0].y = start.y;
    else if (nearlyEqual(serverStart.x, firstRaw.x)) bends[0].x = start.x;

    const lastIndex = rawBends.length - 1;
    const lastRaw = bends[lastIndex];
    if (nearlyEqual(serverEnd.y, lastRaw.y)) bends[lastIndex].y = end.y;
    else if (nearlyEqual(serverEnd.x, lastRaw.x)) bends[lastIndex].x = end.x;

    return orthogonalPoints([start, ...bends, end]);
}

function junction(point: Point) {
    return `(junction (at ${point.x} ${point.y}) (diameter 0) (color 0 0 0 0)
        (uuid ${quoteSExpression(randomUUID())}))`;
}

function pointOnSegment(point: Point, start: Point, end: Point) {
    if (start.x === end.x && point.x === start.x) {
        return point.y >= Math.min(start.y, end.y) && point.y <= Math.max(start.y, end.y);
    }
    if (start.y === end.y && point.y === start.y) {
        return point.x >= Math.min(start.x, end.x) && point.x <= Math.max(start.x, end.x);
    }
    return false;
}

function segmentKey(start: Point, end: Point) {
    const first = pointKey(start);
    const second = pointKey(end);
    return first < second ? `${first}|${second}` : `${second}|${first}`;
}

function perpendicularIntersection(left: RoutedSegment, right: RoutedSegment) {
    const leftVertical = nearlyEqual(left.start.x, left.end.x);
    const rightVertical = nearlyEqual(right.start.x, right.end.x);
    if (leftVertical === rightVertical) return undefined;
    const vertical = leftVertical ? left : right;
    const horizontal = leftVertical ? right : left;
    const point = { x: vertical.start.x, y: horizontal.start.y };
    return pointOnSegment(point, vertical.start, vertical.end)
        && pointOnSegment(point, horizontal.start, horizontal.end)
        ? point
        : undefined;
}

function pointIsSegmentEndpoint(point: Point, segment: RoutedSegment) {
    const key = pointKey(point);
    return key === pointKey(segment.start) || key === pointKey(segment.end);
}

function collinearSegmentsOverlap(left: RoutedSegment, right: RoutedSegment) {
    const leftVertical = nearlyEqual(left.start.x, left.end.x);
    const rightVertical = nearlyEqual(right.start.x, right.end.x);
    if (leftVertical !== rightVertical) return false;
    if (leftVertical) {
        if (!nearlyEqual(left.start.x, right.start.x)) return false;
        return Math.min(Math.max(left.start.y, left.end.y), Math.max(right.start.y, right.end.y))
            > Math.max(Math.min(left.start.y, left.end.y), Math.min(right.start.y, right.end.y));
    }
    if (!nearlyEqual(left.start.y, right.start.y)) return false;
    return Math.min(Math.max(left.start.x, left.end.x), Math.max(right.start.x, right.end.x))
        > Math.max(Math.min(left.start.x, left.end.x), Math.min(right.start.x, right.end.x));
}

function segmentsConflict(left: RoutedSegment, right: RoutedSegment) {
    if (collinearSegmentsOverlap(left, right)) return true;
    const intersection = perpendicularIntersection(left, right);
    return Boolean(intersection
        && (pointIsSegmentEndpoint(intersection!, left) || pointIsSegmentEndpoint(intersection!, right)));
}

function normalizedNetSegments(segments: RoutedSegment[]) {
    const groups = new Map<string, RoutedSegment[]>();
    segments.forEach((segment, index) => {
        const key = segment.signal || `__unknown_${index}`;
        const group = groups.get(key) || [];
        group.push(segment);
        groups.set(key, group);
    });

    const output: RoutedSegment[] = [];
    for (const [signalKey, group] of groups) {
        const nodes = new Map<string, Point>();
        for (const segment of group) {
            nodes.set(pointKey(segment.start), segment.start);
            nodes.set(pointKey(segment.end), segment.end);
        }
        for (let leftIndex = 0; leftIndex < group.length; leftIndex += 1) {
            for (let rightIndex = leftIndex + 1; rightIndex < group.length; rightIndex += 1) {
                const point = perpendicularIntersection(group[leftIndex], group[rightIndex]);
                if (point) nodes.set(pointKey(point), point);
            }
        }

        const deduplicated = new Map<string, RoutedSegment>();
        for (const segment of group) {
            const split = [...nodes.values()]
                .filter((point) => pointOnSegment(point, segment.start, segment.end))
                .sort((left, right) => nearlyEqual(segment.start.x, segment.end.x)
                    ? left.y - right.y
                    : left.x - right.x);
            for (let index = 1; index < split.length; index += 1) {
                const start = split[index - 1];
                const end = split[index];
                if (pointKey(start) === pointKey(end)) continue;
                const signal = signalKey.startsWith('__unknown_') ? undefined : signalKey;
                deduplicated.set(segmentKey(start, end), { start, end, signal });
            }
        }
        output.push(...deduplicated.values());
    }
    return output;
}

function calculatedJunctions(segments: RoutedSegment[]) {
    const degrees = new Map<string, { point: Point; signal: string; segments: Set<string> }>();
    for (const segment of segments) {
        if (!segment.signal) continue;
        for (const point of [segment.start, segment.end]) {
            const key = `${segment.signal}\u0000${pointKey(point)}`;
            const node = degrees.get(key) || { point, signal: segment.signal, segments: new Set<string>() };
            node.segments.add(segmentKey(segment.start, segment.end));
            degrees.set(key, node);
        }
    }
    return [...degrees.values()].filter((node) => node.segments.size >= 3).map((node) => node.point);
}

function noConnect(point: Point) {
    return `(no_connect (at ${point.x} ${point.y}) (uuid ${quoteSExpression(randomUUID())}))`;
}

function pinDirection(pin: Point, owner: Point) {
    const dx = pin.x - owner.x;
    const dy = pin.y - owner.y;
    if (Math.abs(dx) >= Math.abs(dy)) {
        return dx < 0 ? 'left' : 'right';
    }
    return dy < 0 ? 'up' : 'down';
}

function outwardLabelAngle(pin: Point, owner: Point) {
    switch (pinDirection(pin, owner)) {
        case 'left': return 180;
        case 'right': return 0;
        case 'up': return 90;
        case 'down': return 270;
    }
}

function canonicalDirectionAngle(angle: number) {
    return normalizeRotation(Math.round(normalizeRotation(angle) / 90) * 90);
}

function directionVector(angle: number) {
    switch (canonicalDirectionAngle(angle)) {
        case 0: return { x: 1, y: 0 };
        case 90: return { x: 0, y: -1 };
        case 180: return { x: -1, y: 0 };
        default: return { x: 0, y: 1 };
    }
}

function directionAngles(primary: number, pinCount: number) {
    const normalized = canonicalDirectionAngle(primary);
    if (pinCount >= 3) return [normalized];
    return [normalized, normalizeRotation(normalized + 90), normalizeRotation(normalized - 90)];
}

export function portDirectionAngles() {
    // KiCad sheet Y grows downwards: up, down, right, left.
    return [90, 270, 0, 180];
}

export function portOffsetCandidates(angle: number) {
    const vector = directionVector(angle);
    if (vector.x === 0) return [0];
    return PORT_OFFSET_LENGTHS_MM.flatMap((length) => [-length, length]);
}

function insertionOffset(source: string) {
    const sheetInstances = findLists(source, 'sheet_instances')[0];
    if (sheetInstances) return sheetInstances.start;
    const library = findLists(source, 'lib_symbols')[0];
    const rootEmbeddedFonts = findLists(source, 'embedded_fonts')
        .find((range) => !library || range.start >= library.end);
    if (rootEmbeddedFonts) return rootEmbeddedFonts.start;
    const root = findLists(source, 'kicad_sch')[0];
    if (!root) throw new Error('invalid KiCad schematic');
    return root.end - 1;
}

async function preparedRealAssets(
    assembly: CircuitAssembly,
    input: ExplainCircuit,
    report: DiagnosticReporter,
    localAssets: Map<string, SchematicAsset>,
) {
    const uuids = [...new Set([
        ...assembly.components
            .filter((component) => component.part_uuid
                && component.part_uuid !== 'GND'
                && component.part_uuid !== 'VCC'
                && component.value !== 'unknown_shortsym'
                && !component.designator.includes('|'))
            .map((component) => component.part_uuid!),
        ...input.components.flatMap((component) => component.part_uuid ? [component.part_uuid] : []),
    ])];
    const entries = await Promise.all(uuids.filter(id => !localAssets.has(id)).map(async (partUuid) => {
        try {
            return [partUuid, await convertComponent(partUuid)] as const;
        } catch (error) {
            const designators = [...assembly.components, ...input.components]
                .filter((component) => component.part_uuid === partUuid)
                .map((component) => component.designator);
            report(error, `component conversion failed (${designators.join(', ') || partUuid})`);
            return undefined;
        }
    }));
    return new Map(entries.filter((entry): entry is readonly [string, ConvertedComponent] => Boolean(entry)));
}

function inputSignal(input: ExplainCircuit, designator: string, pinNumber: string | number) {
    return input.components
        .find((component) => baseDesignator(component.designator) === baseDesignator(designator)
            && component.pins.some(pin => String(pin.pin_number) === String(pinNumber)))
        ?.pins.find((pin) => String(pin.pin_number) === String(pinNumber))
        ?.signal_name || '';
}

export async function applyCircuitAssembly(
    path: string,
    assembly: CircuitAssembly,
    input: ExplainCircuit,
    report: DiagnosticReporter = (error, context) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[schematic assembly] ${context ? `${context}: ` : ''}${message}`);
    },
    warn: DiagnosticReporter = (warning, context) => {
        const message = warning instanceof Error ? warning.message : String(warning);
        console.error(`[schematic assembly warning] ${context ? `${context}: ` : ''}${message}`);
    },
    context?: Awaited<ReturnType<typeof getSchematicContext>>,
) {
    if (!Array.isArray(assembly.components) || !Array.isArray(assembly.edges)) {
        throw new Error('invalid CircuitAssembly response');
    }

    const localContext = context ?? await getSchematicContext(path);
    const realAssets = await preparedRealAssets(assembly, input, report, localContext.assets);
    const parentInstancePaths: string[] = [];
    const collectPaths = (file: string, instancePath: string, ancestors = new Set<string>()) => {
        if (ancestors.has(file)) throw new Error('cyclic schematic hierarchy');
        if (file === localContext.page.path) parentInstancePaths.push(instancePath);
        const source = localContext.files.get(file);
        if (!source) return;
        for (const sheet of children(parseSExpression(source), 'sheet')) {
            const asset = [...localContext.assets.values()].find(a => a.kind === 'sheet'
                && a.path === resolveSheetFile(file, sheet, localContext.projectDirectory));
            if (asset?.kind === 'sheet') collectPaths(asset.path, `${instancePath}/${scalar(sheet, 'uuid')}`, new Set(ancestors).add(file));
        }
    };
    collectPaths(localContext.rootPath, `/${scalar(parseSExpression(localContext.files.get(localContext.rootPath)!), 'uuid')}`);
    const namedLabel = (signal: string, point: Point, angle = 0) => {
        const ref = parseSignal(signal);
        if (ref.kind === 'empty' || ref.kind === 'nc') throw new Error(`invalid label signal: ${signal}`);
        if (ref.kind === 'global') return globalLabel(ref.name, point, angle);
        if (ref.kind === 'local') {
            if (ref.sheet !== localContext.page.scope) throw new Error(`local signal belongs to another sheet: ${signal}`);
            return localLabel(ref.name, point);
        }
        if (ref.sheet !== localContext.page.scope) {
            const alias = `${ref.sheet}:${ref.name}`;
            const collision = localContext.page.labels.find(l => l.name === alias);
            if (collision && localContext.page.groupAt(collision.point) !== localContext.page.pinGroup(ref.sheet!, ref.name)) {
                throw new Error(`sheet port label collision: ${alias}`);
            }
            return localLabel(alias, point);
        }
        const existing = localContext.page.labels.find(l => l.kind === 'hier' && l.name === ref.name);
        const shape = existing ? scalar(existing.node, 'shape', 'bidirectional') : 'bidirectional';
        return `(hierarchical_label ${quoteSExpression(ref.name)} (shape ${shape}) (at ${point.x} ${point.y} ${canonicalDirectionAngle(angle)})
            ${effects()} (uuid ${quoteSExpression(randomUUID())}))`;
    };

    return mutateSchematic(path, async (source) => {
        const version = targetVersion(source);
        const documentUuid = targetUuid(source);
        const projectName = basename(path, '.kicad_sch');
        const library = embeddedSymbols(source);
        const allExisting = existingSymbols(source, library.symbols);
        const removalDesignators = new Set([
            ...(assembly.rm_components || []),
            ...(assembly.replace_components || []),
        ]);
        if (assembly.replace_components?.length) {
            console.error(`In-place replacement fallback: ${assembly.replace_components.join(', ')}`);
        }
        const isRemoved = (item: ExistingSymbol) => removalDesignators.has(item.reference) || removalDesignators.has(baseDesignator(item.reference));
        const removed = allExisting.filter(isRemoved);
        const retained = allExisting.filter(item => !isRemoved(item));
        for (const designator of removalDesignators) {
            if (!allExisting.some((item) => item.reference === designator || baseDesignator(item.reference) === designator)) {
                report(`component not found: ${designator}`, 'component removal skipped');
            }
        }
        const retainedReal = retained.filter((item) => !item.service);
        const interfacePoints = findLists(source, 'hierarchical_label').map(rangeAtPoint).filter((p): p is Point => Boolean(p));
        const fullPhysicalRebuild = removed.length > 0 && retainedReal.length === 0;
        const edits: SourceEdit[] = removed.map(({ range }) => ({
            start: range.start,
            end: range.end,
            text: '',
        }));
        const inputByDesignator = new Map(input.components.map((component) => [component.designator, component]));
        for (const item of retainedReal) {
            const partUuid = inputByDesignator.get(item.reference)?.part_uuid;
            const asset = partUuid ? realAssets.get(partUuid) : undefined;
            if (!asset) continue;
            const footprint = projectFootprintId(asset);
            if (!footprint) continue;
            const normalized = item.range.text.replace(
                /(\(property\s+"Footprint"\s+)"[^"]*"/,
                `$1${quoteSExpression(footprint)}`,
            );
            if (normalized !== item.range.text) {
                edits.push({ start: item.range.start, end: item.range.end, text: normalized });
            }
        }

        const existingPinPoints = new Map<string, Point>();
        const pinLabelAngles = new Map<string, number>();
        const ownerAnchors = new Map<string, Point>();
        const pinOwners = new Map<string, Point>();
        const ownerPins = new Map<string, Point[]>();
        for (const item of allExisting) {
            ownerAnchors.set(item.reference, item.anchor);
            ownerPins.set(item.reference, [...item.pins.values()]);
            for (const [pin, point] of item.pins) {
                const shape = `${item.reference}_pin_${pin}`;
                existingPinPoints.set(shape, point);
                const baseShape = `${baseDesignator(item.reference)}_pin_${pin}`;
                if (!existingPinPoints.has(baseShape)) existingPinPoints.set(baseShape, point);
                const labelAngle = item.pinLabelAngles.get(pin);
                if (labelAngle !== undefined) pinLabelAngles.set(shape, labelAngle);
                pinOwners.set(shape, item.anchor);
            }
        }
        const disconnectPoints = new Set(removed.flatMap((item) => [...item.pins.values()].map(pointKey)));
        for (const net of assembly.rm_net || []) {
            const signal = inputSignal(input, net.designator, net.pin_number);
            if (signal && signal !== net.net) {
                report(
                    `expected ${net.net}, found ${signal}`,
                    `net removal signal mismatch (${net.designator}.${net.pin_number})`,
                );
            }
            const point = existingPinPoints.get(`${baseDesignator(net.designator)}_pin_${net.pin_number}`);
            if (point) disconnectPoints.add(pointKey(point));
            else report(
                `pin not found: ${baseDesignator(net.designator)}_pin_${net.pin_number}`,
                'net removal skipped',
            );
        }
        const retainedPinPoints = [...interfacePoints, ...retainedReal
            .flatMap((item) => [...item.pins.values()])
            .filter((point) => !disconnectPoints.has(pointKey(point)))];
        const parsedDisconnectPoints = [...disconnectPoints].map((key) => {
            const [x, y] = key.split(',').map(Number);
            return { x, y };
        });
        const wirePlan = planWireRemoval(source, parsedDisconnectPoints, retainedPinPoints);
        if (fullPhysicalRebuild) {
            for (const range of findLists(source, 'wire')) {
                edits.push({ start: range.start, end: range.end, text: '' });
            }
            wirePlan.retained.length = 0;
        } else {
            for (const wire of wirePlan.removed) {
                edits.push({ start: wire.range.start, end: wire.range.end, text: '' });
            }
        }
        const retainedPinKeys = new Set(retainedPinPoints.map(pointKey));
        const touchedByRemoval = (point: Point) => disconnectPoints.has(pointKey(point))
            || wirePlan.removed.some((wire) => pointTouchesWire(point, wire));
        const remainsConnected = (point: Point) => retainedPinKeys.has(pointKey(point))
            || wirePlan.retained.some((wire) => pointTouchesWire(point, wire));

        const removedServices = new Set<ExistingSymbol>();
        for (const item of retained.filter((symbol) => symbol.service)) {
            const connectionPoints = item.pins.size ? [...item.pins.values()] : [item.anchor];
            if (fullPhysicalRebuild
                || (connectionPoints.some(touchedByRemoval) && !connectionPoints.some(remainsConnected))) {
                edits.push({ start: item.range.start, end: item.range.end, text: '' });
                removedServices.add(item);
            }
        }
        for (const head of ['no_connect', 'global_label', 'hierarchical_label', 'label']) {
            for (const range of findLists(source, head)) {
                const point = rangeAtPoint(range);
                // A kept interface label at an old coordinate can short a newly routed
                // net. Move connected labels with the rebuilt circuit; restore aliases below.
                const rebuiltLabel = fullPhysicalRebuild && head !== 'no_connect' && point
                    && localContext.page.pins.some(pin => localContext.page.groupAt(pin.point) === localContext.page.groupAt(point)
                        && removed.some(item => item.reference === pin.designator));
                if (rebuiltLabel) {
                    edits.push({ start: range.start, end: range.end, text: '' });
                    continue;
                }
                if (head === 'hierarchical_label') continue;
                if (head !== 'no_connect' && point && !touchedByRemoval(point)) continue;
                if (fullPhysicalRebuild
                    || (point && touchedByRemoval(point) && !remainsConnected(point))) {
                    edits.push({ start: range.start, end: range.end, text: '' });
                }
            }
        }
        for (const range of findLists(source, 'junction')) {
            const point = rangeAtPoint(range);
            if (fullPhysicalRebuild
                || (point && touchedByRemoval(point)
                    && wireDirectionsAtPoint(point, wirePlan.retained) < 3)) {
                edits.push({ start: range.start, end: range.end, text: '' });
            }
        }

        const placement = placementOffset(
            source,
            assembly,
            retained.filter((item) => !removedServices.has(item)),
            fullPhysicalRebuild ? [] : removed,
        );
        if (placement.warning) warn(placement.warning, 'schematic placement');
        const serverShapePoints = new Map<string, Point>();
        for (const edge of assembly.edges) {
            for (const section of edge.sections || []) {
                if (section.incomingShape) {
                    serverShapePoints.set(section.incomingShape, serverPoint(section.startPoint, placement));
                }
                if (section.outgoingShape) {
                    serverShapePoints.set(section.outgoingShape, serverPoint(section.endPoint, placement));
                }
            }
        }

        const definitions = new Map<string, EmbeddedSymbol>();
        const nativeDefinitions = new Map<string, SExpression[]>();
        const embeddedAssets = new Map<string, EmbeddedSymbol>();
        const representativeDesignators = new Map<string, string>();
        for (const component of input.components) {
            if (component.part_uuid) representativeDesignators.set(component.part_uuid, component.designator);
        }
        for (const component of assembly.components) {
            if (component.part_uuid) representativeDesignators.set(component.part_uuid, component.designator);
        }
        for (const [partUuid, asset] of realAssets) {
            try {
                const normalized = normalizedComponentSymbol(
                    asset.symbol,
                    representativeDesignators.get(partUuid) || 'U',
                    'kicad-copilot',
                    `${asset.product_code}_`,
                );
                const embedded = embeddedLibrarySymbol(normalized, 'kicad-copilot', version);
                embeddedAssets.set(partUuid, embedded);
                definitions.set(embedded.id, embedded);
            } catch (error) {
                report(error, `symbol preparation failed (${representativeDesignators.get(partUuid) || partUuid})`);
            }
        }
        const objects: string[] = [];
        const placed: PlacedComponent[] = [];
        const edgePins = new Map(existingPinPoints);
        const edgeSignals = new Map<string, string>();

        for (const component of input.components) {
            for (const pin of component.pins) {
                const signal = pin.signal_name.trim();
                if (signal) edgeSignals.set(`${baseDesignator(component.designator)}_pin_${pin.pin_number}`, signal);
            }
        }

        const paper = pageSize(source);
        for (const component of assembly.components) {
            const objectCount = objects.length;
            try {
                const exact = component.designator;
                const primaryPin = component.pins[0]
                    ? `${exact}_pin_${component.pins[0].pin_number}`
                    : undefined;
                const shortAnchor = primaryPin ? serverShapePoints.get(primaryPin) : undefined;
                const anchor = (component.part_uuid === 'GND'
                    || component.part_uuid === 'VCC'
                    || component.value === 'unknown_shortsym'
                    || component.designator.includes('|'))
                    ? shortAnchor || componentAnchor(component, placement)
                    : componentAnchor(component, placement);
                const rotation = kicadRotation(component.pos.rotate || 0);
                const componentPins = new Map<string, Point>();
                const componentPinLabelAngles = new Map<string, number>();
                let kind: PlacedComponent['kind'];

                const localAsset = component.part_uuid ? localContext.assets.get(component.part_uuid) : undefined;
                if (localAsset) {
                    kind = 'real';
                    const original = removed.find(item => item.reference === exact);
                    const local = placeLocalSymbol(localAsset, component, anchor, path, localContext.rootPath,
                        parentInstancePaths, original ? parseSExpression(original.range.text) : undefined);
                    objects.push(local.text);
                    for (const [number, point] of local.pins) componentPins.set(number, point);
                    for (const [number, angle] of local.pinLabelAngles) componentPinLabelAngles.set(number, angle);
                    if (local.library) nativeDefinitions.set(atom(local.library[1])!, local.library);
                } else if (component.part_uuid === 'GND' || component.part_uuid === 'VCC'
                    || component.value === 'unknown_shortsym' || component.designator.includes('|')) {
                    kind = 'port';
                    const signal = component.pins.find(p => p.signal_name)?.signal_name;
                    if (!signal) throw new Error(`port signal missing: ${exact}`);
                    objects.push(namedLabel(signal, anchor));
                    for (const pin of component.pins) componentPins.set(String(pin.pin_number), anchor);
                } else {
                    kind = 'real';
                    if (!component.part_uuid) throw new Error(`part_uuid missing: ${component.designator}`);
                    const converted = realAssets.get(component.part_uuid) as ConvertedComponent | undefined;
                    const embedded = embeddedAssets.get(component.part_uuid);
                    if (!converted || !embedded) throw new Error(`component conversion missing: ${component.designator}`);
                    objects.push(symbolInstance({
                        embedded,
                        component,
                        anchor,
                        projectName,
                        documentUuid,
                        rotation,
                    }));
                    const requestedPins = new Set(component.pins.map((pin) => String(pin.pin_number)));
                    for (const pin of uniquePins(embedded.pins).values()) {
                        if (!requestedPins.has(pin.number)) continue;
                        componentPins.set(
                            pin.number,
                            transformedPin(pin, anchor, rotation, Boolean(component.pos.mirror)),
                        );
                        componentPinLabelAngles.set(
                            pin.number,
                            transformedPinLabelAngle(pin, rotation, Boolean(component.pos.mirror)),
                        );
                    }
                }

                const placedComponent = {
                    source: component,
                    anchor,
                    pins: componentPins,
                    kind,
                };
                placed.push(placedComponent);
                const base = baseDesignator(exact);
                ownerAnchors.set(exact, anchor);
                ownerAnchors.set(base, anchor);
                ownerPins.set(exact, [...componentPins.values()]);
                if (!ownerPins.has(base)) ownerPins.set(base, [...componentPins.values()]);
                for (const [pin, point] of componentPins) {
                    const exactShape = `${exact}_pin_${pin}`;
                    const baseShape = `${base}_pin_${pin}`;
                    edgePins.set(exactShape, point);
                    pinOwners.set(exactShape, anchor);
                    const labelAngle = componentPinLabelAngles.get(pin);
                    if (labelAngle !== undefined) pinLabelAngles.set(exactShape, labelAngle);
                    if (!edgePins.has(baseShape)) edgePins.set(baseShape, point);
                    if (!pinOwners.has(baseShape)) pinOwners.set(baseShape, anchor);
                    if (labelAngle !== undefined && !pinLabelAngles.has(baseShape)) {
                        pinLabelAngles.set(baseShape, labelAngle);
                    }
                }
                for (const pin of component.pins) {
                    const signal = pin.signal_name.trim();
                    if (!signal) continue;
                    edgeSignals.set(`${exact}_pin_${pin.pin_number}`, signal);
                    if (!edgeSignals.has(`${base}_pin_${pin.pin_number}`)) {
                        edgeSignals.set(`${base}_pin_${pin.pin_number}`, signal);
                    }
                }
            } catch (error) {
                objects.length = objectCount;
                if (component.part_uuid && localContext.assets.has(component.part_uuid)) throw error;
                report(error, `component skipped (${component.designator})`);
            }
        }

        const usedShapes = new Set<string>();
        const generatedSegments: RoutedSegment[] = [];
        const edgeLabels: { signal: string; point: Point; segments: RoutedSegment[] }[] = [];
        const requestedJunctions: Point[] = [];
        for (const edge of assembly.edges) {
            const segmentStart = generatedSegments.length;
            let edgeApplied = false;
            let edgeLabel: { signal: string; point: Point } | undefined;
            for (const section of edge.sections || []) {
                const serverStart = serverPoint(section.startPoint, placement);
                const serverEnd = serverPoint(section.endPoint, placement);
                const resolvedStart = section.incomingShape
                    ? edgePins.get(section.incomingShape)
                    : undefined;
                const resolvedEnd = section.outgoingShape
                    ? edgePins.get(section.outgoingShape)
                    : undefined;
                if (section.incomingShape && !resolvedStart) {
                    report(`pin not found: ${section.incomingShape}`, `edge ${section.id}`);
                }
                if (section.outgoingShape && !resolvedEnd) {
                    report(`pin not found: ${section.outgoingShape}`, `edge ${section.id}`);
                }
                const start = resolvedStart || serverStart;
                const end = resolvedEnd || serverEnd;

                const sectionSignals = new Set([
                    section.incomingShape ? edgeSignals.get(section.incomingShape) : undefined,
                    section.outgoingShape ? edgeSignals.get(section.outgoingShape) : undefined,
                ].filter((signal): signal is string => Boolean(signal)));
                if (sectionSignals.size > 1) {
                    // EasyEDA still draws the server edge and reports the inconsistent metadata.
                    report(
                        `conflicting edge signals: ${[...sectionSignals].join(', ')}`,
                        `edge ${section.id} uses its first endpoint signal`,
                    );
                }
                const signal = (section.incomingShape && edgeSignals.get(section.incomingShape))
                    || (section.outgoingShape && edgeSignals.get(section.outgoingShape));
                try {
                    const points = routedSectionPoints(section, start, end, placement);
                    for (let index = 1; index < points.length; index += 1) {
                        const segment = { start: points[index - 1], end: points[index], signal };
                        if (pointKey(segment.start) === pointKey(segment.end)) continue;
                        generatedSegments.push(segment);
                        if (!edgeLabel && signal && signal.toUpperCase() !== 'NC') {
                            edgeLabel = { signal, point: segment.start };
                        }
                    }
                    if (section.incomingShape) usedShapes.add(section.incomingShape);
                    if (section.outgoingShape) usedShapes.add(section.outgoingShape);
                    edgeApplied = true;
                } catch (error) {
                    report(error, `edge ${section.id} skipped`);
                }
            }
            const junctionPoints = (edge as typeof edge & { junctionPoints?: Point[] }).junctionPoints;
            for (const point of edgeApplied ? junctionPoints || [] : []) {
                requestedJunctions.push(serverPoint(point, placement));
            }
            if (edgeApplied && edgeLabel) edgeLabels.push({ ...edgeLabel, segments: generatedSegments.slice(segmentStart) });
        }
        const normalizedSegments = normalizedNetSegments(generatedSegments);
        for (const segment of normalizedSegments) objects.push(wireSegment(segment.start, segment.end));
        for (const label of edgeLabels) {
            const candidates = [label.point, ...label.segments.flatMap(segment => [segment.start, segment.end,
                { x: snapped((segment.start.x + segment.end.x) / 2), y: snapped((segment.start.y + segment.end.y) / 2) }])];
            const point = candidates.find(point => !normalizedSegments.some(segment => segment.signal !== label.signal
                && pointOnSegment(point, segment.start, segment.end)));
            if (!point) throw new Error(`no safe label position on routed net: ${label.signal}`);
            objects.push(namedLabel(label.signal, point));
        }

        const addedJunctions = new Set<string>();
        for (const point of [...requestedJunctions, ...calculatedJunctions(normalizedSegments)]) {
            if (wireDirectionsAtPoint(point, normalizedSegments) < 3) continue;
            const key = pointKey(point);
            if (addedJunctions.has(key)) continue;
            addedJunctions.add(key);
            objects.push(junction(point));
        }

        const routingObstacles: RoutedSegment[] = [
            ...wirePlan.retained.map((wire) => ({ start: wire.start, end: wire.end })),
            ...normalizedSegments,
        ];
        const allPinPoints = [...new Map(
            [...edgePins.values()].map((point) => [pointKey(point), point]),
        ).values()];
        const connectionTerminals: Point[] = [];

        const connectionKeys = new Set<string>();
        const removedNoConnects = new Set<number>(
            edits.filter((edit) => edit.text === '').map((edit) => edit.start),
        );
        const removeNoConnectAt = (point: Point) => {
            for (const range of findLists(source, 'no_connect')) {
                const existing = rangeAtPoint(range);
                if (!existing || pointKey(existing) !== pointKey(point)) continue;
                if (removedNoConnects.has(range.start)) continue;
                edits.push({ start: range.start, end: range.end, text: '' });
                removedNoConnects.add(range.start);
            }
        };
        const pendingConnections: Array<{
            designator: string;
            pinNumber: string | number;
            signal: string;
        }> = [];
        const queueNamedConnection = (
            designator: string,
            pinNumber: string | number,
            signal: string,
        ) => {
            const base = baseDesignator(designator);
            const shape = `${base}_pin_${pinNumber}`;
            const exactShape = `${designator}_pin_${pinNumber}`;
            const resolvedShape = edgePins.has(exactShape) ? exactShape : shape;
            if (!edgePins.has(resolvedShape)) {
                report(`pin not found: ${shape}`, `connection skipped (${designator}.${pinNumber}, ${signal})`);
                return false;
            }
            const key = `${shape}\u0000${signal}`;
            if (connectionKeys.has(key)) return true;
            connectionKeys.add(key);
            pendingConnections.push({ designator, pinNumber, signal });
            return true;
        };
        const addNamedConnection = (
            designator: string,
            pinNumber: string | number,
            signal: string,
            preferLabel: boolean,
        ) => {
            preferLabel = true;
            const base = baseDesignator(designator);
            const shape = `${base}_pin_${pinNumber}`;
            const exactShape = `${designator}_pin_${pinNumber}`;
            const resolvedShape = edgePins.has(exactShape) ? exactShape : shape;
            const pin = edgePins.get(resolvedShape);
            if (!pin) throw new Error(`pin not found: ${shape}`);
            const owner = pinOwners.get(resolvedShape) || ownerAnchors.get(base) || pin;
            const ownerPinPoints = ownerPins.get(designator) || ownerPins.get(base) || [];
            const primaryAngle = pinLabelAngles.get(resolvedShape) ?? outwardLabelAngle(pin, owner);
            const variants = preferLabel ? [false] : [true, false];
            let selected: {
                segments: RoutedSegment[];
                terminal: Point;
                terminalAngle: number;
                port: boolean;
            } | undefined;

            const angles = preferLabel
                ? directionAngles(primaryAngle, ownerPinPoints.length || 10)
                : portDirectionAngles();
            search: for (const angle of angles) {
                const vector = directionVector(angle);
                const ownerVector = {
                    x: owner.x - pin.x,
                    y: owner.y - pin.y,
                };
                if (vector.x * ownerVector.x + vector.y * ownerVector.y > 1e-6) {
                    continue;
                }
                for (const port of variants) {
                    const lengths = preferLabel
                        ? [...CONNECTION_LENGTHS_MM, 0]
                        : CONNECTION_LENGTHS_MM;
                    for (const length of lengths) {
                        const elbow = {
                            x: snapped(pin.x + vector.x * length),
                            y: snapped(pin.y + vector.y * length),
                        };
                        const offsets = port ? portOffsetCandidates(angle) : [0];
                        for (const offset of offsets) {
                            const terminal = {
                                x: elbow.x,
                                y: snapped(elbow.y + offset),
                            };
                            const points = [pin, elbow, terminal];
                            if (points.some((point) => point.x < 0 || point.y < 0
                                || point.x > paper.x || point.y > paper.y)) continue;
                            if (port && vector.x !== 0 && ownerPinPoints.some((point) => (
                                pointKey(point) !== pointKey(pin) && nearlyEqual(point.y, terminal.y)
                            ))) continue;
                            const segments = points.slice(1).flatMap((point, index): RoutedSegment[] => (
                                pointKey(points[index]) === pointKey(point)
                                    ? []
                                    : [{ start: points[index], end: point, signal }]
                            ));

                            const otherPins = allPinPoints.filter((point) => pointKey(point) !== pointKey(pin));
                            if (otherPins.some((point) => segments.some((segment) => (
                                pointOnSegment(point, segment.start, segment.end)
                            )))) continue;
                            if (connectionTerminals.some((point) => segments.some((segment) => (
                                pointOnSegment(point, segment.start, segment.end)
                            )))) continue;
                            if (routingObstacles.some((obstacle) => {
                                if (obstacle.signal === signal) return false;
                                return segments.some((segment) => segmentsConflict(segment, obstacle));
                            })) continue;
                            if (segments.length && routingObstacles.some((obstacle) => (
                                pointOnSegment(terminal, obstacle.start, obstacle.end)
                            ))) continue;

                            selected = {
                                segments,
                                terminal,
                                terminalAngle: port && vector.x !== 0
                                    ? (offset < 0 ? 90 : 270)
                                    : angle,
                                port,
                            };
                            break search;
                        }
                    }
                }
            }

            if (!selected) {
                throw new Error(`no free connection path: ${designator}.${pinNumber} (${signal})`);
            }
            removeNoConnectAt(pin);
            for (const segment of selected.segments) {
                objects.push(wireSegment(segment.start, segment.end));
                routingObstacles.push(segment);
            }
            connectionTerminals.push(selected.terminal);

            objects.push(namedLabel(signal, selected.terminal, selected.terminalAngle));
        };

        for (const item of assembly.added_net || []) {
            const oldSignal = inputSignal(input, item.designator, item.pin_number);
            if (oldSignal === item.net) continue;
            if (oldSignal && oldSignal.trim().toUpperCase() !== 'NC' && oldSignal !== item.net
                && !assembly.rm_net?.some(n => n.designator === item.designator && String(n.pin_number) === String(item.pin_number))) {
                report(
                    `pin already connected to ${oldSignal}`,
                    `connection signal mismatch (${item.designator}.${item.pin_number}, ${item.net})`,
                );
            }
            queueNamedConnection(item.designator, item.pin_number, item.net);
        }

        for (const item of placed) {
            if (item.kind !== 'real') continue;
            for (const pin of item.source.pins) {
                const exactShape = `${item.source.designator}_pin_${pin.pin_number}`;
                const baseShape = `${baseDesignator(item.source.designator)}_pin_${pin.pin_number}`;
                if (usedShapes.has(exactShape) || usedShapes.has(baseShape)) continue;
                const point = item.pins.get(String(pin.pin_number));
                if (!point) {
                    report(`pin not found: ${baseShape}`, `unused pin skipped (${item.source.designator})`);
                    continue;
                }
                if (pin.signal_name.trim().toUpperCase() === 'NC') objects.push(noConnect(point));
                else if (pin.signal_name.trim()) {
                    queueNamedConnection(item.source.designator, pin.pin_number, pin.signal_name.trim());
                }
            }
        }

        for (const connection of pendingConnections) {
            try {
                addNamedConnection(
                    connection.designator,
                    connection.pinNumber,
                    connection.signal,
                    true,
                );
            } catch (error) {
                report(
                    error,
                    `connection skipped (${connection.designator}.${connection.pinNumber}, ${connection.signal})`,
                );
            }
        }

        // Keep native net aliases when their old wire branch was removed. Attach
        // them to a surviving pin, without changing the label's scope or text.
        const markers = new Set<string>();
        for (const object of objects) {
            const node = parseSExpression(object);
            if (['label', 'global_label', 'hierarchical_label'].includes(listHead(node) ?? '')) markers.add(`${listHead(node)}\u0000${atom(node[1])}`);
        }
        for (const head of ['label', 'global_label', 'hierarchical_label']) {
            const ranges = findLists(source, head);
            for (const range of ranges.filter(r => !edits.some(e => e.start === r.start && e.end === r.end && !e.text))) {
                markers.add(`${head}\u0000${atom(parseSExpression(range.text)[1])}`);
            }
            for (const range of ranges.filter(r => edits.some(e => e.start === r.start && e.end === r.end && !e.text))) {
                const node = parseSExpression(range.text);
                const marker = `${head}\u0000${atom(node[1])}`;
                if (markers.has(marker)) continue;
                const group = localContext.page.groupAt(position(node));
                let terminal: Point | undefined;
                for (const pin of localContext.page.pins.filter(p => localContext.page.groupAt(p.point) === group)) {
                    const originalSignal = inputSignal(input, pin.designator, pin.number);
                    const replacement = placed.find(p => p.source.designator === pin.designator);
                    if (replacement) {
                        if (replacement.source.pins.find(p => String(p.pin_number) === pin.number)?.signal_name === originalSignal) terminal = replacement.pins.get(pin.number);
                    } else if (!removed.some(item => item.reference === pin.designator)
                        && !assembly.rm_net?.some(n => n.designator === pin.designator && String(n.pin_number) === pin.number)) {
                        terminal = pin.point;
                    }
                    if (terminal) break;
                }
                if (!terminal) continue;
                const at = findChild(node, 'at')!;
                at[1] = token(String(terminal.x)); at[2] = token(String(terminal.y));
                const uuid = findChild(node, 'uuid');
                if (uuid) uuid[1] = token(randomUUID(), true);
                objects.push(printSExpression(node));
                markers.add(marker);
            }
        }

        if (assembly.assembly_options?.draw_blocks) {
            for (const block of assembly.blocks_rect || []) {
                if (block.name.includes('__v_root__')) continue;
                const first = serverPoint({ x: block.x, y: block.y }, placement);
                const second = serverPoint({
                    x: block.x + block.width,
                    y: block.y + block.height,
                }, placement);
                const start = { x: Math.min(first.x, second.x) - GRID_MM, y: Math.min(first.y, second.y) - GRID_MM };
                const end = { x: Math.max(first.x, second.x) + GRID_MM, y: Math.max(first.y, second.y) + GRID_MM };
                objects.push(`(rectangle (start ${start.x} ${start.y}) (end ${end.x} ${end.y})
                    (stroke (width 0) (type default)) (fill (type none))
                    (uuid ${quoteSExpression(randomUUID())}))`);
                objects.push(`(text ${quoteSExpression(`${block.name}: ${block.description}`)}
                    (exclude_from_sim no) (at ${start.x} ${start.y - GRID_MM} 0)
                    ${effects()} (uuid ${quoteSExpression(randomUUID())}))`);
            }
        }

        if (definitions.size || nativeDefinitions.size) {
            const root = parseSExpression(library.range.text);
            for (const [id, definition] of nativeDefinitions) {
                const existing = root.find(item => isSExpressionList(item) && listHead(item) === 'symbol' && atom(item[1]) === id);
                if (existing && printSExpression(existing) !== printSExpression(definition)) throw new Error(`conflicting native symbol definition: ${id}`);
                if (!existing) root.push(definition);
            }
            for (const definition of definitions.values()) {
                const index = root.findIndex((item) => isSExpressionList(item)
                    && listHead(item) === 'symbol'
                    && atom(item[1]) === definition.id);
                if (index < 0) root.push(definition.symbol);
                else root[index] = definition.symbol;
            }
            edits.push({
                start: library.range.start,
                end: library.range.end,
                text: printSExpression(root),
            });
        }
        if (objects.length) {
            const at = insertionOffset(source);
            edits.push({
                start: at,
                end: at,
                text: `${objects.map((item) => `\t${item}`).join('\n')}\n`,
            });
        }

        await writeProjectLibraries(
            path,
            [...definitions.values()]
                .filter((definition) => definition.id.startsWith('kicad-copilot:'))
                .map((definition) => definition.symbol),
            realAssets.values(),
        );
        const candidate = applySourceEdits(source, edits);
        return applySourceEdits(candidate, redundantJunctionRanges(candidate).map((range) => ({
            start: range.start,
            end: range.end,
            text: '',
        })));
    });
}
