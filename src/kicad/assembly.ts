import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ConvertedComponent, convertComponent } from '../components/converter';
import { getPowerSymbol } from '../components/kicad-library';
import { projectFootprintId, writeProjectLibraries } from '../components/project-library';
import { CircuitAssembly, ExplainCircuit } from '../types/circuit';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    parseSExpression,
    printSExpression,
    SExpression,
} from './sexpr/ast';
import { findLists, findQuotedProperty, quoteSExpression, SExpressionRange } from './sexpr/scan';
import {
    embeddedLibrarySymbol,
    LibraryPin,
    librarySymbolPins,
    normalizedComponentSymbol,
} from './symbol';
import { applySourceEdits, mutateSchematic, SourceEdit } from './schematic-writer';
import { planWireRemoval, pointTouchesWire, wireDirectionsAtPoint } from './wire-removal';

const SERVER_UNIT_MM = 0.254;
const GRID_MM = 1.27;
const CONNECTION_LENGTHS_MM = [
    20, 30,
    ...Array.from({ length: 39 }, (_, index) => 40 + index * 20),
    15, 10, 5,
].map((value) => value * SERVER_UNIT_MM);
const PORT_OFFSETS_MM = Array.from(
    { length: 80 },
    (_, index) => (index + 1) * 10 * SERVER_UNIT_MM,
).flatMap((value) => [value, -value]);

type Point = { x: number; y: number };
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
    const match = source.match(/\(uuid\s+"([^"]+)"\)/);
    if (!match) throw new Error('invalid KiCad schematic: root uuid not found');
    return match[1];
}

function atPoint(list: SExpression[] | undefined) {
    if (!list) return undefined;
    const x = Number(atom(list[1]));
    const y = Number(atom(list[2]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    return { x, y };
}

function transformedPin(pin: LibraryPin, anchor: Point, rotation: number, mirror: boolean) {
    const radians = rotation * Math.PI / 180;
    const localY = mirror ? -pin.y : pin.y;
    return {
        x: rounded(anchor.x + pin.x * Math.cos(radians) - localY * Math.sin(radians)),
        y: rounded(anchor.y - pin.x * Math.sin(radians) - localY * Math.cos(radians)),
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

function renamedPowerSymbol(source: SExpression[], signal: string) {
    const cloned = structuredClone(source) as SExpression[];
    const replace = (node: SExpression) => {
        if (!isSExpressionList(node)) {
            if (node.value === 'VCC') node.value = signal;
            else if (node.value.startsWith('VCC_')) node.value = `${signal}${node.value.slice(3)}`;
            else if (node.quoted && node.value.includes('VCC')) {
                node.value = node.value.replaceAll('VCC', signal);
            }
            return;
        }
        for (const item of node) replace(item);
    };
    replace(cloned);
    return cloned;
}

function signalPortSymbol(source: SExpression[], signal: string) {
    const cloned = renamedPowerSymbol(source, signal);
    for (let index = cloned.length - 1; index >= 0; index -= 1) {
        const item = cloned[index];
        if (isSExpressionList(item) && listHead(item) === 'power') cloned.splice(index, 1);
    }
    const normalize = (node: SExpression) => {
        if (!isSExpressionList(node)) return;
        if (listHead(node) === 'pin' && !isSExpressionList(node[1])) {
            node[1].value = 'passive';
        }
        if (listHead(node) === 'property' && atom(node[1]) === 'Reference'
            && !isSExpressionList(node[2])) {
            node[2].value = '#PORT';
        }
        for (const item of node) normalize(item);
    };
    normalize(cloned);
    return cloned;
}

function isPowerSignal(signalName: string) {
    if (!signalName) return false;
    const signal = signalName.toUpperCase();
    if (signal.includes('GND')) return false;
    if (signal === 'BATTERY') return true;
    if (/^USB_[V\d]/i.test(signalName)) return true;
    if (/^V(?:CC|DD|BAT|IN|OUT|REF|REG|PP|SS|EE|BUS|[0-9])/i.test(signalName)) return true;
    if (/^[AVDG]?V(?:DD|CC)/i.test(signalName)) return true;
    if (/^[+-]?V[+-]?$|^V$/i.test(signalName)) return true;
    if (/^[+-]?\d+(?:\.\d+)?V/i.test(signalName)) return true;
    if (/^\d+V\d+$/i.test(signalName)) return true;
    return false;
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
    const mirror = Boolean(findChild(value, 'mirror'));
    const pins = new Map<string, Point>();
    const pinLabelAngles = new Map<string, number>();
    for (const pin of uniquePins(librarySymbolPins(symbol)).values()) {
        pins.set(pin.number, transformedPin(pin, anchor, rotation, mirror));
        pinLabelAngles.set(pin.number, transformedPinLabelAngle(pin, rotation, mirror));
    }
    return {
        range,
        reference: baseDesignator(reference),
        anchor,
        pins,
        pinLabelAngles,
        service: reference.startsWith('#PWR') || reference.startsWith('#PORT'),
    } satisfies ExistingSymbol;
}

function existingSymbols(source: string, symbols: Map<string, SExpression[]>) {
    return findLists(source, 'symbol')
        .map((range) => instanceData(range, symbols))
        .filter((value): value is ExistingSymbol => Boolean(value));
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

function serverRect(assembly: CircuitAssembly) {
    const rects = assembly.components.map((component) => ({
        left: component.pos.x * SERVER_UNIT_MM,
        right: (component.pos.x + component.pos.width) * SERVER_UNIT_MM,
        top: component.pos.y * SERVER_UNIT_MM,
        bottom: (component.pos.y + component.pos.height) * SERVER_UNIT_MM,
    }));
    for (const block of assembly.blocks_rect || []) {
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
    const center = {
        x: (bounds.left + bounds.right) / 2,
        y: (bounds.top + bounds.bottom) / 2,
    };
    const initial = {
        x: snapped(target.x - center.x),
        y: snapped(target.y - center.y),
    };
    const step = 5.08;
    const maxRadius = Math.ceil(Math.max(paper.x, paper.y) / step);
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
                const candidate = translated(bounds, offset, 5.08);
                if (candidate.left < 0 || candidate.top < 0
                    || candidate.right > paper.x || candidate.bottom > paper.y) continue;
                if (!occupied.some((rect) => intersects(candidate, rect))) return offset;
            }
        }
    }

    throw new Error('no free area on schematic sheet');
}

function serverPoint(point: Point, offset: Point) {
    // KiCad sheet coordinates are Y-down, just like the assembly server.
    // Only library-local pin coordinates need the Y conversion in transformedPin().
    return {
        x: snapped(offset.x + point.x * SERVER_UNIT_MM),
        y: snapped(offset.y + point.y * SERVER_UNIT_MM),
    };
}

function componentAnchor(component: CircuitAssemblyComponent, offset: Point) {
    const center = component.pos.center || {
        x: component.pos.width / 2,
        y: component.pos.height / 2,
    };
    return serverPoint({
        x: component.pos.x + center.x,
        y: component.pos.y + center.y,
    }, offset);
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
}) {
    const reference = options.reference || baseDesignator(options.component.designator);
    const value = options.value || options.component.value;
    const rotation = kicadRotation(options.component.pos.rotate);
    const mirror = options.component.pos.mirror ? '(mirror x)' : '';
    const properties = options.embedded.properties;
    const power = options.power;
    const sideways = !power && (rotation === 90 || rotation === 270);
    const referenceY = power === 'ground'
        ? options.anchor.y + 6.35
        : options.anchor.y - 6.35;
    const valueY = power === 'ground'
        ? options.anchor.y + 3.556
        : options.anchor.y - 3.556;
    const realReference = sideways
        ? { x: options.anchor.x + 8.89, y: options.anchor.y - 1.27, angle: rotation }
        : { x: options.anchor.x, y: options.anchor.y - 10.16, angle: 0 };
    const realValue = sideways
        ? { x: options.anchor.x + 8.89, y: options.anchor.y + 1.27, angle: rotation }
        : { x: options.anchor.x, y: options.anchor.y + 10.16, angle: 0 };
    const pins = [...uniquePins(options.embedded.pins).keys()]
        .map((number) => `(pin ${quoteSExpression(number)} (uuid ${quoteSExpression(randomUUID())}))`)
        .join(' ');
    return `(symbol
        (lib_id ${quoteSExpression(options.embedded.id)}) (at ${options.anchor.x} ${options.anchor.y} ${rotation})
        (unit ${unitNumber(options.component)}) ${mirror}
        (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        (uuid ${quoteSExpression(randomUUID())})
        ${property('Reference', reference, power ? options.anchor.x : realReference.x, power ? referenceY : realReference.y, Boolean(power), power ? 0 : realReference.angle)}
        ${property('Value', value, power ? options.anchor.x : realValue.x, power ? valueY : realValue.y, false, power ? 0 : realValue.angle)}
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

function globalLabel(name: string, point: Point, angle = 0, hidden = false) {
    const rotation = canonicalDirectionAngle(angle);
    const justify = rotation === 0 || rotation === 90 ? 'left' : 'right';
    return `(global_label ${quoteSExpression(name)} (shape bidirectional)
        (at ${point.x} ${point.y} ${rotation})
        (effects (font (size 1.27 1.27)) (justify ${justify})${hidden ? ' (hide yes)' : ''})
        (uuid ${quoteSExpression(randomUUID())})
        ${property('Intersheetrefs', '${INTERSHEET_REFS}', point.x, point.y, true)})`;
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
            output.push({ x: point.x, y: previous.y });
        }
        if (pointKey(output.at(-1)!) !== pointKey(point)) output.push(point);
    }
    return output;
}

function nearlyEqual(left: number, right: number) {
    return Math.abs(left - right) < 1e-6;
}

function routedSectionPoints(
    section: CircuitAssembly['edges'][number]['sections'][number],
    start: Point,
    end: Point,
    offset: Point,
) {
    const rawBends = section.bendPoints || [];
    if (!rawBends.length) {
        if (nearlyEqual(section.startPoint.x, section.endPoint.x)) {
            return orthogonalPoints([start, { x: start.x, y: end.y }, end]);
        }
        if (nearlyEqual(section.startPoint.y, section.endPoint.y)) {
            return orthogonalPoints([start, { x: end.x, y: start.y }, end]);
        }
        return orthogonalPoints([start, end]);
    }

    const bends = rawBends.map((point) => serverPoint(point, offset));
    const firstRaw = rawBends[0];
    if (nearlyEqual(section.startPoint.y, firstRaw.y)) bends[0].y = start.y;
    else if (nearlyEqual(section.startPoint.x, firstRaw.x)) bends[0].x = start.x;

    const lastIndex = rawBends.length - 1;
    const lastRaw = rawBends[lastIndex];
    if (nearlyEqual(section.endPoint.y, lastRaw.y)) bends[lastIndex].y = end.y;
    else if (nearlyEqual(section.endPoint.x, lastRaw.x)) bends[lastIndex].x = end.x;

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

function segmentDirectionAngle(start: Point, end: Point) {
    if (nearlyEqual(start.x, end.x)) return end.y < start.y ? 90 : 270;
    return end.x < start.x ? 180 : 0;
}

function insertionOffset(source: string) {
    const sheetInstances = findLists(source, 'sheet_instances')[0];
    if (sheetInstances) return sheetInstances.start;
    const rootEmbeddedFonts = findLists(source, 'embedded_fonts').at(-1);
    if (rootEmbeddedFonts) return rootEmbeddedFonts.start;
    const root = findLists(source, 'kicad_sch')[0];
    if (!root) throw new Error('invalid KiCad schematic');
    return root.end - 1;
}

function nextPowerReference(source: string) {
    const numbers = [...source.matchAll(/#PWR0*(\d+)/g)].map((match) => Number(match[1]));
    let value = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return () => `#PWR${String(value++).padStart(4, '0')}`;
}

function nextPortReference(source: string) {
    const numbers = [...source.matchAll(/#PORT0*(\d+)/g)].map((match) => Number(match[1]));
    let value = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return () => `#PORT${String(value++).padStart(4, '0')}`;
}

function preparedRealAssets(assembly: CircuitAssembly, input: ExplainCircuit) {
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
    return Promise.all(uuids.map(async (partUuid) => [partUuid, await convertComponent(partUuid)] as const))
        .then((entries) => new Map(entries));
}

function inputSignal(input: ExplainCircuit, designator: string, pinNumber: string | number) {
    return input.components
        .find((component) => component.designator === baseDesignator(designator))
        ?.pins.find((pin) => String(pin.pin_number) === String(pinNumber))
        ?.signal_name || '';
}

export async function applyCircuitAssembly(
    path: string,
    assembly: CircuitAssembly,
    input: ExplainCircuit,
) {
    if (!Array.isArray(assembly.components) || !Array.isArray(assembly.edges)) {
        throw new Error('invalid CircuitAssembly response');
    }

    const realAssets = await preparedRealAssets(assembly, input);
    const needsGround = assembly.components.some((component) => component.part_uuid === 'GND')
        || assembly.added_net?.some((net) => net.net === 'GND');
    const [groundSource, portSource] = await Promise.all([
        needsGround ? getPowerSymbol('GND') : undefined,
        getPowerSymbol('VCC'),
    ]);

    return mutateSchematic(path, async (source) => {
        const version = targetVersion(source);
        const documentUuid = targetUuid(source);
        const projectName = basename(path, '.kicad_sch');
        const library = embeddedSymbols(source);
        const allExisting = existingSymbols(source, library.symbols);
        const removalDesignators = new Set([
            ...(assembly.rm_components || []),
            ...(assembly.replace_components || []),
        ].map(baseDesignator));
        if (assembly.replace_components?.length) {
            console.error(`In-place replacement fallback: ${assembly.replace_components.join(', ')}`);
        }
        const removed = allExisting.filter((item) => removalDesignators.has(item.reference));
        const retained = allExisting.filter((item) => !removalDesignators.has(item.reference));
        const retainedReal = retained.filter((item) => !item.service);
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
                const labelAngle = item.pinLabelAngles.get(pin);
                if (labelAngle !== undefined) pinLabelAngles.set(shape, labelAngle);
                pinOwners.set(shape, item.anchor);
            }
        }
        const disconnectPoints = new Set(removed.flatMap((item) => [...item.pins.values()].map(pointKey)));
        for (const net of assembly.rm_net || []) {
            const signal = inputSignal(input, net.designator, net.pin_number);
            if (signal && signal !== net.net) continue;
            const point = existingPinPoints.get(`${baseDesignator(net.designator)}_pin_${net.pin_number}`);
            if (point) disconnectPoints.add(pointKey(point));
        }
        const retainedPinPoints = retainedReal
            .flatMap((item) => [...item.pins.values()])
            .filter((point) => !disconnectPoints.has(pointKey(point)));
        const parsedDisconnectPoints = [...disconnectPoints].map((key) => {
            const [x, y] = key.split(',').map(Number);
            return { x, y };
        });
        const wirePlan = planWireRemoval(source, parsedDisconnectPoints, retainedPinPoints);
        for (const wire of wirePlan.removed) {
            edits.push({ start: wire.range.start, end: wire.range.end, text: '' });
        }
        const retainedPinKeys = new Set(retainedPinPoints.map(pointKey));
        const touchedByRemoval = (point: Point) => disconnectPoints.has(pointKey(point))
            || wirePlan.removed.some((wire) => pointTouchesWire(point, wire));
        const remainsConnected = (point: Point) => retainedPinKeys.has(pointKey(point))
            || wirePlan.retained.some((wire) => pointTouchesWire(point, wire));

        const removedServices = new Set<ExistingSymbol>();
        for (const item of retained.filter((symbol) => symbol.service)) {
            const connectionPoints = item.pins.size ? [...item.pins.values()] : [item.anchor];
            if (connectionPoints.some(touchedByRemoval) && !connectionPoints.some(remainsConnected)) {
                edits.push({ start: item.range.start, end: item.range.end, text: '' });
                removedServices.add(item);
            }
        }
        for (const head of ['no_connect', 'global_label', 'hierarchical_label', 'label']) {
            for (const range of findLists(source, head)) {
                const point = rangeAtPoint(range);
                if (point && touchedByRemoval(point) && !remainsConnected(point)) {
                    edits.push({ start: range.start, end: range.end, text: '' });
                }
            }
        }
        for (const range of findLists(source, 'junction')) {
            const point = rangeAtPoint(range);
            if (point && touchedByRemoval(point)
                && wireDirectionsAtPoint(point, wirePlan.retained) < 3) {
                edits.push({ start: range.start, end: range.end, text: '' });
            }
        }

        const offset = placementOffset(
            source,
            assembly,
            retained.filter((item) => !removedServices.has(item)),
            removed,
        );
        const serverShapePoints = new Map<string, Point>();
        for (const edge of assembly.edges) {
            for (const section of edge.sections || []) {
                if (section.incomingShape) {
                    serverShapePoints.set(section.incomingShape, serverPoint(section.startPoint, offset));
                }
                if (section.outgoingShape) {
                    serverShapePoints.set(section.outgoingShape, serverPoint(section.endPoint, offset));
                }
            }
        }

        const definitions = new Map<string, EmbeddedSymbol>();
        const embeddedAssets = new Map<string, EmbeddedSymbol>();
        const representativeDesignators = new Map<string, string>();
        for (const component of input.components) {
            if (component.part_uuid) representativeDesignators.set(component.part_uuid, component.designator);
        }
        for (const component of assembly.components) {
            if (component.part_uuid) representativeDesignators.set(component.part_uuid, component.designator);
        }
        for (const [partUuid, asset] of realAssets) {
            const normalized = normalizedComponentSymbol(
                asset.symbol,
                representativeDesignators.get(partUuid) || 'U',
                'kicad-copilot',
                `${asset.product_code}_`,
            );
            const embedded = embeddedLibrarySymbol(normalized, 'kicad-copilot', version);
            embeddedAssets.set(partUuid, embedded);
            definitions.set(embedded.id, embedded);
        }
        const objects: string[] = [];
        const placed: PlacedComponent[] = [];
        const edgePins = new Map(existingPinPoints);
        const edgeSignals = new Map<string, string>();
        const powerReference = nextPowerReference(source);
        const portReference = nextPortReference(source);

        for (const component of input.components) {
            for (const pin of component.pins) {
                const signal = pin.signal_name.trim();
                if (signal) edgeSignals.set(`${baseDesignator(component.designator)}_pin_${pin.pin_number}`, signal);
            }
        }

        const groundEmbedded = groundSource
            ? embeddedLibrarySymbol(groundSource, 'power', version)
            : undefined;
        if (groundEmbedded) definitions.set(groundEmbedded.id, groundEmbedded);

        const portDefinitions = new Map<string, EmbeddedSymbol>();
        const portEmbedded = (signal: string, power: boolean) => {
            const key = `${power ? 'power' : 'signal'}:${signal}`;
            const existing = portDefinitions.get(key);
            if (existing) return existing;
            const embedded = embeddedLibrarySymbol(
                power ? renamedPowerSymbol(portSource, signal) : signalPortSymbol(portSource, signal),
                'kicad-copilot',
                version,
            );
            portDefinitions.set(key, embedded);
            definitions.set(embedded.id, embedded);
            return embedded;
        };

        for (const component of assembly.components) {
            const exact = component.designator;
            const primaryPin = component.pins[0]
                ? `${exact}_pin_${component.pins[0].pin_number}`
                : undefined;
            const shortAnchor = primaryPin ? serverShapePoints.get(primaryPin) : undefined;
            const anchor = (component.part_uuid === 'GND'
                || component.part_uuid === 'VCC'
                || component.value === 'unknown_shortsym'
                || component.designator.includes('|'))
                ? shortAnchor || componentAnchor(component, offset)
                : componentAnchor(component, offset);
            const rotation = kicadRotation(component.pos.rotate);
            const componentPins = new Map<string, Point>();
            const componentPinLabelAngles = new Map<string, number>();
            let kind: PlacedComponent['kind'];

            if (component.part_uuid === 'GND') {
                if (!groundEmbedded) throw new Error('GND symbol not prepared');
                kind = 'gnd';
                const reference = powerReference();
                objects.push(symbolInstance({
                    embedded: groundEmbedded,
                    component,
                    anchor,
                    projectName,
                    documentUuid,
                    reference,
                    value: 'GND',
                    power: 'ground',
                }));
                for (const pin of uniquePins(groundEmbedded.pins).values()) {
                    componentPins.set(pin.number, transformedPin(pin, anchor, rotation, false));
                    componentPinLabelAngles.set(
                        pin.number,
                        transformedPinLabelAngle(pin, rotation, false),
                    );
                }
            } else if (component.part_uuid === 'VCC'
                || component.value === 'unknown_shortsym'
                || component.designator.includes('|')) {
                kind = 'port';
                const signal = component.pins.find((pin) => pin.signal_name.trim())?.signal_name.trim();
                if (!signal) throw new Error(`port signal missing: ${component.designator}`);
                const power = component.part_uuid === 'VCC' || isPowerSignal(signal);
                const embedded = portEmbedded(signal, power);
                const reference = power ? powerReference() : portReference();
                objects.push(symbolInstance({
                    embedded,
                    component,
                    anchor,
                    projectName,
                    documentUuid,
                    reference,
                    value: signal,
                    power: 'port',
                }));
                if (!power) objects.push(globalLabel(signal, anchor, rotation, true));
                for (const pin of component.pins) {
                    componentPins.set(String(pin.pin_number), anchor);
                }
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
        }

        const usedShapes = new Set<string>();
        const generatedSegments: RoutedSegment[] = [];
        const requestedJunctions: Point[] = [];
        const signalForEdge = (edge: CircuitAssembly['edges'][number]) => {
            for (const section of edge.sections || []) {
                const signal = (section.incomingShape && edgeSignals.get(section.incomingShape))
                    || (section.outgoingShape && edgeSignals.get(section.outgoingShape));
                if (signal) return signal;
            }
            return '';
        };
        const signalCounts = new Map<string, number>();
        for (const edge of assembly.edges) {
            const signal = signalForEdge(edge);
            signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
        }
        const signalPriority = (signal: string) => {
            if (signal === 'GND') return 0;
            if (/^(\+|VCC|VDD)/i.test(signal)) return 1;
            return 10 - (signalCounts.get(signal) || 0);
        };
        const routedEdges = [...assembly.edges].sort((left, right) =>
            signalPriority(signalForEdge(left)) - signalPriority(signalForEdge(right)));
        for (const edge of routedEdges) {
            for (const section of edge.sections || []) {
                const start = section.incomingShape
                    ? edgePins.get(section.incomingShape)
                    : serverPoint(section.startPoint, offset);
                const end = section.outgoingShape
                    ? edgePins.get(section.outgoingShape)
                    : serverPoint(section.endPoint, offset);
                if (section.incomingShape && !start) throw new Error(`pin not found: ${section.incomingShape}`);
                if (section.outgoingShape && !end) throw new Error(`pin not found: ${section.outgoingShape}`);
                if (!start || !end) throw new Error(`edge endpoint not found: ${section.id}`);
                if (section.incomingShape) usedShapes.add(section.incomingShape);
                if (section.outgoingShape) usedShapes.add(section.outgoingShape);

                const sectionSignals = new Set([
                    section.incomingShape ? edgeSignals.get(section.incomingShape) : undefined,
                    section.outgoingShape ? edgeSignals.get(section.outgoingShape) : undefined,
                ].filter((signal): signal is string => Boolean(signal)));
                if (sectionSignals.size > 1) {
                    throw new Error(`conflicting edge signals: ${section.id}`);
                }
                const signal = sectionSignals.size === 1 ? [...sectionSignals][0] : undefined;
                const points = routedSectionPoints(section, start, end, offset);
                for (let index = 1; index < points.length; index += 1) {
                    const segment = { start: points[index - 1], end: points[index], signal };
                    if (pointKey(segment.start) === pointKey(segment.end)) continue;
                    generatedSegments.push(segment);
                }
            }
            const junctionPoints = (edge as typeof edge & { junctionPoints?: Point[] }).junctionPoints;
            for (const point of junctionPoints || []) {
                requestedJunctions.push(serverPoint(point, offset));
            }
        }
        const normalizedSegments = normalizedNetSegments(generatedSegments);
        for (const segment of normalizedSegments) objects.push(wireSegment(segment.start, segment.end));

        const addedJunctions = new Set<string>();
        for (const point of [...requestedJunctions, ...calculatedJunctions(normalizedSegments)]) {
            if (!normalizedSegments.some((segment) => pointOnSegment(point, segment.start, segment.end))) continue;
            const key = pointKey(point);
            if (addedJunctions.has(key)) continue;
            addedJunctions.add(key);
            objects.push(junction(point));
        }

        const paper = pageSize(source);
        const routingObstacles: RoutedSegment[] = [
            ...wirePlan.retained.map((wire) => ({ start: wire.start, end: wire.end })),
            ...normalizedSegments,
        ];
        const allPinPoints = [...new Map(
            [...edgePins.values()].map((point) => [pointKey(point), point]),
        ).values()];
        const connectionTerminals: Point[] = [];

        const connectionKeys = new Set<string>();
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
            if (!edgePins.has(resolvedShape)) throw new Error(`pin not found: ${shape}`);
            const key = `${shape}\u0000${signal}`;
            if (connectionKeys.has(key)) return;
            connectionKeys.add(key);
            pendingConnections.push({ designator, pinNumber, signal });
        };
        const addNamedConnection = (
            designator: string,
            pinNumber: string | number,
            signal: string,
            preferLabel: boolean,
        ) => {
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

            search: for (const angle of directionAngles(primaryAngle, ownerPinPoints.length || 10)) {
                const vector = directionVector(angle);
                for (const port of variants) {
                    for (const length of CONNECTION_LENGTHS_MM) {
                        const elbow = {
                            x: snapped(pin.x + vector.x * length),
                            y: snapped(pin.y + vector.y * length),
                        };
                        const offsets = port && vector.x !== 0 ? PORT_OFFSETS_MM : [0];
                        for (const portOffset of offsets) {
                            const terminal = {
                                x: elbow.x,
                                y: snapped(elbow.y + portOffset),
                            };
                            const points = pointKey(elbow) === pointKey(terminal)
                                ? [pin, elbow]
                                : [pin, elbow, terminal];
                            if (points.some((point) => point.x < 0 || point.y < 0
                                || point.x > paper.x || point.y > paper.y)) continue;
                            const segments: RoutedSegment[] = [];
                            for (let index = 1; index < points.length; index += 1) {
                                if (pointKey(points[index - 1]) === pointKey(points[index])) continue;
                                segments.push({
                                    start: points[index - 1],
                                    end: points[index],
                                    signal,
                                });
                            }
                            if (!segments.length) continue;

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
                            if (routingObstacles.some((obstacle) => (
                                pointOnSegment(terminal, obstacle.start, obstacle.end)
                            ))) continue;

                            if (port) {
                                const otherOwnerPins = ownerPinPoints.filter(
                                    (point) => pointKey(point) !== pointKey(pin),
                                );
                                if (vector.x !== 0 && otherOwnerPins.some((point) => (
                                    nearlyEqual(point.y, terminal.y)
                                ))) continue;
                                if (vector.y !== 0 && otherOwnerPins.some((point) => (
                                    nearlyEqual(point.x, terminal.x)
                                ))) continue;
                            }

                            selected = {
                                segments,
                                terminal,
                                terminalAngle: segmentDirectionAngle(
                                    segments.at(-1)!.start,
                                    segments.at(-1)!.end,
                                ),
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
            for (const segment of selected.segments) {
                objects.push(wireSegment(segment.start, segment.end));
                routingObstacles.push(segment);
            }
            connectionTerminals.push(selected.terminal);

            if (!selected.port) {
                objects.push(globalLabel(signal, selected.terminal, selected.terminalAngle));
                return;
            }
            if (signal === 'GND') {
                if (!groundEmbedded) throw new Error('GND symbol not prepared');
                const service: CircuitAssemblyComponent = {
                    designator: powerReference(),
                    value: 'GND',
                    pins: [{ pin_number: '1', name: 'GND', signal_name: 'GND' }],
                    block_name: '',
                    search_query: '',
                    part_uuid: 'GND',
                    pos: {
                        x: 0,
                        y: 0,
                        center: { x: 0, y: 0 },
                        width: 0,
                        height: 0,
                        rotate: normalizeRotation(selected.terminalAngle - 270),
                    },
                };
                objects.push(symbolInstance({
                    embedded: groundEmbedded,
                    component: service,
                    anchor: selected.terminal,
                    projectName,
                    documentUuid,
                    reference: service.designator,
                    value: 'GND',
                    power: 'ground',
                }));
            } else {
                const power = isPowerSignal(signal);
                const service: CircuitAssemblyComponent = {
                    designator: power ? powerReference() : portReference(),
                    value: signal,
                    pins: [{ pin_number: '1', name: signal, signal_name: signal }],
                    block_name: '',
                    search_query: '',
                    part_uuid: power ? 'VCC' : '7523d33c197549a39030c4ac7fddee68',
                    pos: {
                        x: 0,
                        y: 0,
                        center: { x: 0, y: 0 },
                        width: 0,
                        height: 0,
                        rotate: normalizeRotation(selected.terminalAngle - 90),
                    },
                };
                objects.push(symbolInstance({
                    embedded: portEmbedded(signal, power),
                    component: service,
                    anchor: selected.terminal,
                    projectName,
                    documentUuid,
                    reference: service.designator,
                    value: signal,
                    power: 'port',
                }));
                if (!power) {
                    objects.push(globalLabel(signal, selected.terminal, service.pos.rotate, true));
                }
            }
        };

        for (const item of assembly.added_net || []) {
            const oldSignal = inputSignal(input, item.designator, item.pin_number);
            if (oldSignal === item.net) continue;
            if (oldSignal && oldSignal !== item.net) {
                throw new Error(`pin already connected to ${oldSignal}: ${item.designator}.${item.pin_number}`);
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
                if (!point) throw new Error(`pin not found: ${baseShape}`);
                if (pin.signal_name.trim().toUpperCase() === 'NC') objects.push(noConnect(point));
                else if (pin.signal_name.trim()) {
                    queueNamedConnection(item.source.designator, pin.pin_number, pin.signal_name.trim());
                }
            }
        }

        const connectionCounts = new Map<string, number>();
        for (const item of placed) {
            if (item.kind !== 'real') continue;
            const designator = baseDesignator(item.source.designator);
            const namedPins = item.source.pins.filter((pin) => pin.signal_name.trim()).length;
            connectionCounts.set(designator, namedPins);
        }
        const pendingCounts = new Map<string, number>();
        for (const connection of pendingConnections) {
            const designator = baseDesignator(connection.designator);
            pendingCounts.set(designator, (pendingCounts.get(designator) || 0) + 1);
        }
        for (const [designator, count] of pendingCounts) {
            connectionCounts.set(designator, Math.max(connectionCounts.get(designator) || 0, count));
        }
        for (const connection of pendingConnections) {
            const useLabel = (connectionCounts.get(baseDesignator(connection.designator)) || 0) >= 5;
            addNamedConnection(
                connection.designator,
                connection.pinNumber,
                connection.signal,
                useLabel,
            );
        }

        if (assembly.assembly_options?.draw_blocks) {
            for (const block of assembly.blocks_rect || []) {
                if (block.name.includes('__v_root__')) continue;
                const first = serverPoint({ x: block.x, y: block.y }, offset);
                const second = serverPoint({
                    x: block.x + block.width,
                    y: block.y + block.height,
                }, offset);
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

        if (definitions.size) {
            const root = parseSExpression(library.range.text);
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
        return applySourceEdits(source, edits);
    });
}
