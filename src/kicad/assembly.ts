import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { ConvertedComponent, convertComponent } from '../components/converter';
import { getPowerSymbol } from '../components/kicad-library';
import { CircuitAssembly, CircuitAssemblyComponent, ExplainCircuit } from '../types/circuit';
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
import { embeddedLibrarySymbol, LibraryPin, librarySymbolPins } from './symbol';
import { applySourceEdits, mutateSchematic, SourceEdit } from './schematic-writer';

const SERVER_UNIT_MM = 0.254;
const GRID_MM = 1.27;

type Point = { x: number; y: number };
type Rect = { left: number; top: number; right: number; bottom: number };
type EmbeddedSymbol = ReturnType<typeof embeddedLibrarySymbol>;
type ExistingSymbol = {
    range: SExpressionRange;
    reference: string;
    anchor: Point;
    pins: Map<string, Point>;
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
    const mirror = Boolean(findChild(value, 'mirror'));
    const pins = new Map<string, Point>();
    for (const pin of uniquePins(librarySymbolPins(symbol)).values()) {
        pins.set(pin.number, transformedPin(pin, anchor, rotation, mirror));
    }
    return { range, reference: baseDesignator(reference), anchor, pins } satisfies ExistingSymbol;
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
        top: -(component.pos.y + component.pos.height) * SERVER_UNIT_MM,
        bottom: -component.pos.y * SERVER_UNIT_MM,
    }));
    for (const block of assembly.blocks_rect || []) {
        rects.push({
            left: block.x * SERVER_UNIT_MM,
            right: (block.x + block.width) * SERVER_UNIT_MM,
            top: -(block.y + block.height) * SERVER_UNIT_MM,
            bottom: -block.y * SERVER_UNIT_MM,
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
    return {
        x: snapped(offset.x + point.x * SERVER_UNIT_MM),
        y: snapped(offset.y - point.y * SERVER_UNIT_MM),
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

function property(name: string, value: string, x: number, y: number, hidden = true) {
    return `(property ${quoteSExpression(name)} ${quoteSExpression(value)} (at ${x} ${y} 0) (show_name no) (do_not_autoplace no) ${effects(hidden)})`;
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
}) {
    const reference = options.reference || baseDesignator(options.component.designator);
    const value = options.value || options.component.value;
    const rotation = normalizeRotation(options.component.pos.rotate);
    const mirror = options.component.pos.mirror ? '(mirror x)' : '';
    const properties = options.embedded.properties;
    const pins = [...uniquePins(options.embedded.pins).keys()]
        .map((number) => `(pin ${quoteSExpression(number)} (uuid ${quoteSExpression(randomUUID())}))`)
        .join(' ');
    return `(symbol
        (lib_id ${quoteSExpression(options.embedded.id)}) (at ${options.anchor.x} ${options.anchor.y} ${rotation})
        (unit ${unitNumber(options.component)}) ${mirror}
        (exclude_from_sim no) (in_bom yes) (on_board yes) (dnp no)
        (uuid ${quoteSExpression(randomUUID())})
        ${property('Reference', reference, options.anchor.x, options.anchor.y - 10.16, false)}
        ${property('Value', value, options.anchor.x, options.anchor.y + 10.16, false)}
        ${property('Footprint', properties.Footprint || '', options.anchor.x, options.anchor.y)}
        ${property('Datasheet', properties.Datasheet || '', options.anchor.x, options.anchor.y)}
        ${property('Description', properties.Description || '', options.anchor.x, options.anchor.y)}
        ${property('MPN', properties.MPN || value, options.anchor.x, options.anchor.y)}
        ${property('LCSC Part', properties['LCSC Part'] || '', options.anchor.x, options.anchor.y)}
        ${property('EasyEDA part_uuid', options.component.part_uuid || '', options.anchor.x, options.anchor.y)}
        ${pins}
        (instances (project ${quoteSExpression(options.projectName)}
            (path ${quoteSExpression(`/${options.documentUuid}`)}
                (reference ${quoteSExpression(reference)}) (unit ${unitNumber(options.component)})))))`;
}

function globalLabel(name: string, point: Point, angle = 0) {
    return `(global_label ${quoteSExpression(name)}
        (shape bidirectional) (at ${point.x} ${point.y} ${normalizeRotation(angle)})
        (fields_autoplaced yes) ${effects()} (uuid ${quoteSExpression(randomUUID())})
        (property "Intersheetrefs" "${'${INTERSHEET_REFS}'}"
            (at ${point.x} ${point.y} ${normalizeRotation(angle)})
            (effects (font (size 1.27 1.27)) (hide yes))))`;
}

function localLabel(name: string, point: Point) {
    return `(label ${quoteSExpression(name)}
        (at ${point.x} ${point.y} 0) ${effects()}
        (uuid ${quoteSExpression(randomUUID())}))`;
}

function wireSegment(start: Point, end: Point) {
    return `(wire (pts (xy ${start.x} ${start.y}) (xy ${end.x} ${end.y}))
        (stroke (width 0) (type default)) (uuid ${quoteSExpression(randomUUID())}))`;
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

function outwardStub(pin: Point, owner: Point, distance = 5.08) {
    switch (pinDirection(pin, owner)) {
        case 'left': return { x: snapped(pin.x - distance), y: pin.y };
        case 'right': return { x: snapped(pin.x + distance), y: pin.y };
        case 'up': return { x: pin.x, y: snapped(pin.y - distance) };
        case 'down': return { x: pin.x, y: snapped(pin.y + distance) };
    }
}

function insertionOffset(source: string) {
    const preferred = [
        ...findLists(source, 'sheet_instances'),
        ...findLists(source, 'embedded_fonts'),
    ].sort((left, right) => left.start - right.start)[0];
    if (preferred) return preferred.start;
    const root = findLists(source, 'kicad_sch')[0];
    if (!root) throw new Error('invalid KiCad schematic');
    return root.end - 1;
}

function nextPowerReference(source: string) {
    const numbers = [...source.matchAll(/#PWR0*(\d+)/g)].map((match) => Number(match[1]));
    let value = (numbers.length ? Math.max(...numbers) : 0) + 1;
    return () => `#PWR${String(value++).padStart(4, '0')}`;
}

function preparedRealAssets(assembly: CircuitAssembly) {
    const uuids = [...new Set(assembly.components
        .filter((component) => component.part_uuid
            && component.part_uuid !== 'GND'
            && component.part_uuid !== 'VCC'
            && component.value !== 'unknown_shortsym'
            && !component.designator.includes('|'))
        .map((component) => component.part_uuid!))];
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

    const realAssets = await preparedRealAssets(assembly);
    const needsGround = assembly.components.some((component) => component.part_uuid === 'GND')
        || assembly.added_net?.some((net) => net.net === 'GND');
    const groundSource = needsGround ? await getPowerSymbol('GND') : undefined;

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
        const offset = placementOffset(source, assembly, retained, removed);
        const edits: SourceEdit[] = removed.map(({ range }) => ({
            start: range.start,
            end: range.end,
            text: '',
        }));

        const existingPinPoints = new Map<string, Point>();
        const ownerAnchors = new Map<string, Point>();
        for (const item of allExisting) {
            ownerAnchors.set(item.reference, item.anchor);
            for (const [pin, point] of item.pins) {
                existingPinPoints.set(`${item.reference}_pin_${pin}`, point);
            }
        }
        const disconnectPoints = new Set(removed.flatMap((item) => [...item.pins.values()].map(pointKey)));
        for (const net of assembly.rm_net || []) {
            const signal = inputSignal(input, net.designator, net.pin_number);
            if (signal && signal !== net.net) continue;
            const point = existingPinPoints.get(`${baseDesignator(net.designator)}_pin_${net.pin_number}`);
            if (point) disconnectPoints.add(pointKey(point));
        }
        for (const range of findLists(source, 'wire')) {
            const points = xyPoints(range);
            if (points.some((point, index) =>
                (index === 0 || index === points.length - 1) && disconnectPoints.has(pointKey(point)))) {
                edits.push({ start: range.start, end: range.end, text: '' });
            }
        }
        for (const head of ['no_connect', 'global_label', 'label']) {
            for (const range of findLists(source, head)) {
                const point = rangeAtPoint(range);
                if (point && disconnectPoints.has(pointKey(point))) {
                    edits.push({ start: range.start, end: range.end, text: '' });
                }
            }
        }

        const definitions = new Map<string, EmbeddedSymbol>();
        const objects: string[] = [];
        const placed: PlacedComponent[] = [];
        const edgePins = new Map(existingPinPoints);
        const edgeRoutePins = new Map<string, Point>();
        const edgePinDirections = new Map<string, ReturnType<typeof pinDirection>>();
        const edgeSignals = new Map<string, string>();
        const globalSignals = new Set<string>(['GND']);
        const powerReference = nextPowerReference(source);

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

        for (const component of assembly.components) {
            const anchor = componentAnchor(component, offset);
            const rotation = normalizeRotation(component.pos.rotate);
            const componentPins = new Map<string, Point>();
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
                }));
                for (const pin of uniquePins(groundEmbedded.pins).values()) {
                    componentPins.set(pin.number, transformedPin(pin, anchor, rotation, false));
                }
            } else if (component.part_uuid === 'VCC'
                || component.value === 'unknown_shortsym'
                || component.designator.includes('|')) {
                kind = 'port';
                const signal = component.pins.find((pin) => pin.signal_name.trim())?.signal_name.trim();
                if (!signal) throw new Error(`port signal missing: ${component.designator}`);
                globalSignals.add(signal);
                objects.push(globalLabel(signal, anchor, rotation));
                for (const pin of component.pins) componentPins.set(String(pin.pin_number), anchor);
            } else {
                kind = 'real';
                if (!component.part_uuid) throw new Error(`part_uuid missing: ${component.designator}`);
                const converted = realAssets.get(component.part_uuid) as ConvertedComponent | undefined;
                if (!converted) throw new Error(`component conversion missing: ${component.designator}`);
                const embedded = embeddedLibrarySymbol(converted.symbol, 'kicad-copilot', version);
                definitions.set(embedded.id, embedded);
                objects.push(symbolInstance({
                    embedded,
                    component,
                    anchor,
                    projectName,
                    documentUuid,
                }));
                for (const pin of uniquePins(embedded.pins).values()) {
                    componentPins.set(
                        pin.number,
                        transformedPin(pin, anchor, rotation, Boolean(component.pos.mirror)),
                    );
                }
            }

            const placedComponent = { source: component, anchor, pins: componentPins, kind };
            placed.push(placedComponent);
            const exact = component.designator;
            const base = baseDesignator(exact);
            ownerAnchors.set(exact, anchor);
            ownerAnchors.set(base, anchor);
            const directionLanes = new Map<string, number>();
            for (const [pin, point] of componentPins) {
                const exactShape = `${exact}_pin_${pin}`;
                const baseShape = `${base}_pin_${pin}`;
                edgePins.set(exactShape, point);
                if (!edgePins.has(baseShape)) edgePins.set(baseShape, point);
                if (kind === 'real') {
                    const direction = pinDirection(point, anchor);
                    const lane = directionLanes.get(direction) || 0;
                    directionLanes.set(direction, lane + 1);
                    const routePoint = outwardStub(point, anchor, 2.54 + lane * GRID_MM);
                    edgeRoutePins.set(exactShape, routePoint);
                    edgePinDirections.set(exactShape, direction);
                    if (!edgeRoutePins.has(baseShape)) edgeRoutePins.set(baseShape, routePoint);
                    if (!edgePinDirections.has(baseShape)) edgePinDirections.set(baseShape, direction);
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
        type RoutedTerminal = {
            actual: Point;
            route: Point;
            direction?: ReturnType<typeof pinDirection>;
        };
        const routedNets = new Map<string, {
            signal?: string;
            terminals: Map<string, RoutedTerminal>;
        }>();
        for (const edge of assembly.edges) {
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
                const netKey = signal ? `signal:${signal}` : `edge:${section.id}`;
                const routedNet = routedNets.get(netKey) || { signal, terminals: new Map() };
                const addTerminal = (shape: string | undefined, actual: Point) => {
                    const key = shape || `point:${pointKey(actual)}`;
                    routedNet.terminals.set(key, {
                        actual,
                        route: shape ? edgeRoutePins.get(shape) || actual : actual,
                        direction: shape ? edgePinDirections.get(shape) : undefined,
                    });
                };
                addTerminal(section.incomingShape, start);
                addTerminal(section.outgoingShape, end);
                routedNets.set(netKey, routedNet);
            }
        }

        for (const routedNet of routedNets.values()) {
            for (const terminal of routedNet.terminals.values()) {
                if (!terminal.direction) continue;
                if (pointKey(terminal.actual) !== pointKey(terminal.route)) {
                    objects.push(wireSegment(terminal.actual, terminal.route));
                }
                if (!routedNet.signal) continue;
                objects.push(globalSignals.has(routedNet.signal)
                    ? globalLabel(routedNet.signal, terminal.route)
                    : localLabel(routedNet.signal, terminal.route));
            }
        }

        const connectionKeys = new Set<string>();
        const addNamedConnection = (designator: string, pinNumber: string | number, signal: string) => {
            const base = baseDesignator(designator);
            const shape = `${base}_pin_${pinNumber}`;
            const pin = edgePins.get(shape) || edgePins.get(`${designator}_pin_${pinNumber}`);
            if (!pin) throw new Error(`pin not found: ${shape}`);
            const key = `${shape}\u0000${signal}`;
            if (connectionKeys.has(key)) return;
            connectionKeys.add(key);
            const owner = ownerAnchors.get(base) || pin;
            const end = outwardStub(pin, owner);
            if (pointKey(pin) !== pointKey(end)) objects.push(wireSegment(pin, end));
            if (signal === 'GND') {
                if (!groundEmbedded) throw new Error('GND symbol not prepared');
                const service: CircuitAssemblyComponent = {
                    designator: powerReference(),
                    value: 'GND',
                    pins: [{ pin_number: '1', name: 'GND', signal_name: 'GND' }],
                    block_name: '',
                    search_query: '',
                    part_uuid: 'GND',
                    pos: { x: 0, y: 0, width: 0, height: 0 },
                };
                objects.push(symbolInstance({
                    embedded: groundEmbedded,
                    component: service,
                    anchor: end,
                    projectName,
                    documentUuid,
                    reference: service.designator,
                    value: 'GND',
                }));
            } else {
                objects.push(globalLabel(signal, end));
            }
        };

        for (const item of assembly.added_net || []) {
            const oldSignal = inputSignal(input, item.designator, item.pin_number);
            if (oldSignal === item.net) continue;
            if (oldSignal && oldSignal !== item.net) {
                throw new Error(`pin already connected to ${oldSignal}: ${item.designator}.${item.pin_number}`);
            }
            addNamedConnection(item.designator, item.pin_number, item.net);
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
                    addNamedConnection(item.source.designator, pin.pin_number, pin.signal_name.trim());
                }
            }
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

        const newDefinitions = [...definitions.values()].filter(
            (definition) => !library.symbols.has(definition.id),
        );
        if (newDefinitions.length) {
            edits.push({
                start: library.range.end - 1,
                end: library.range.end - 1,
                text: `\n\t\t${newDefinitions.map((item) => printSExpression(item.symbol)).join('\n\t\t')}\n\t`,
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

        return applySourceEdits(source, edits);
    });
}
