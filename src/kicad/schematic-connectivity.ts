import { basename, resolve } from 'node:path';
import { ExplainCircuit } from '../types/circuit';
import { atom, findChild, parseSExpression, SExpression } from './sexpr/ast';
import { children, nativeInstances, nativeProperty, pageScope, Point, position, scalar, SchematicAsset, sheetFilePath, filePartUuid } from './schematic-assets';
import { globalSignal, parseSignal } from './scoped-signals';

const key = (p: Point) => `${Number(p.x.toFixed(5))},${Number(p.y.toFixed(5))}`;
const onSegment = (p: Point, a: Point, b: Point) => Math.abs((p.x - a.x) * (b.y - a.y) - (p.y - a.y) * (b.x - a.x)) < 0.00001
    && p.x >= Math.min(a.x, b.x) - 0.00001 && p.x <= Math.max(a.x, b.x) + 0.00001
    && p.y >= Math.min(a.y, b.y) - 0.00001 && p.y <= Math.max(a.y, b.y) + 0.00001;
export class Connections {
    private parents = new Map<string, string>();
    find(id: string): string {
        const parent = this.parents.get(id);
        if (parent === undefined) { this.parents.set(id, id); return id; }
        if (parent === id) return id;
        const root = this.find(parent);
        this.parents.set(id, root);
        return root;
    }
    join(a: string, b: string) { this.parents.set(this.find(a), this.find(b)); }
}
type PagePin = { designator: string; number: string; point: Point; sheet?: boolean };
type PageLabel = { kind: 'local' | 'global' | 'hier'; name: string; point: Point; node: SExpression[] };
export function readPage(source: string, path: string, rootPath: string, assets: Map<string, SchematicAsset>) {
    const root = parseSExpression(source);
    if (children(root, 'bus').length || children(root, 'bus_entry').length) {
        throw new Error('schematic buses are not supported by component layout; expand bus connections before editing this page');
    }
    const scope = pageScope(path, rootPath);
    const graph = new Connections();
    const pins: PagePin[] = [];
    const labels: PageLabel[] = [];
    const components: ExplainCircuit['components'] = [];
    const sheets = children(root, 'sheet');
    const points: Point[] = [];
    const wires = children(root, 'wire').map(w => {
        const ends = children(findChild(w, 'pts') ?? [], 'xy').map(p => ({ x: Number(atom(p[1])), y: Number(atom(p[2])) }));
        if (ends.length !== 2) throw new Error('invalid schematic wire');
        points.push(...ends);
        graph.join(key(ends[0]), key(ends[1]));
        return ends;
    });
    for (const [head, kind] of [['label', 'local'], ['global_label', 'global'], ['hierarchical_label', 'hier']] as const) {
        for (const node of children(root, head)) labels.push({ kind, name: atom(node[1]) ?? '', point: position(node), node });
    }
    for (const { instance, asset, reference, designator } of nativeInstances(source)) {
        const anchor = position(instance);
        const rotation = Number(atom(findChild(instance, 'at')?.[3]) ?? 0) * Math.PI / 180;
        const service = reference.startsWith('#');
        const symbolPins = asset.pins.map(p => ({ ...p, point: {
            x: anchor.x + p.x * Math.cos(rotation) - p.y * Math.sin(rotation),
            y: anchor.y - p.x * Math.sin(rotation) - p.y * Math.cos(rotation),
        } }));
        const power = findChild(asset.library, 'power');
        if (!power) for (const p of symbolPins.filter(p => p.hidden && p.electricalType === 'power_in')) {
            labels.push({ kind: 'global', name: p.name, point: p.point, node: instance });
        }
        if (power && nativeProperty(instance, 'Value') !== 'PWR_FLAG') {
            const kind = atom(power[1]) === 'local' ? 'local' : 'global';
            for (const p of symbolPins) labels.push({ kind, name: nativeProperty(instance, 'Value'), point: p.point, node: instance });
        }
        if (service && !power && reference.startsWith('#PORT')) {
            for (const p of symbolPins) labels.push({ kind: 'global', name: nativeProperty(instance, 'Value'), point: p.point, node: instance });
        }
        if (!service) {
            assets.set(asset.partUuid, { ...asset, path });
            components.push({ designator, value: nativeProperty(instance, 'Value'),
                part_uuid: nativeProperty(instance, 'EasyEDA part_uuid') || asset.partUuid,
                pins: symbolPins.map(p => ({ pin_number: p.number, name: p.name, signal_name: '' })),
                footprint_name: nativeProperty(instance, 'Footprint') || null,
                footprint_uuid: nativeProperty(instance, 'EasyEDA footprint_uuid') || null,
                block_name: nativeProperty(instance, 'Block Name') || null,
                pos: { ...anchor, rotate: rotation * 180 / Math.PI, mirror: Boolean(asset.mirror) } });
            pins.push(...symbolPins.map(p => ({ designator, number: p.number, point: p.point })));
        }
        points.push(...symbolPins.map(p => p.point));
    }
    for (const sheet of sheets) {
        const designator = nativeProperty(sheet, 'Sheetname');
        if (!designator || components.some(c => c.designator === designator)) throw new Error(`duplicate or empty sheet designator: ${designator}`);
        const childPath = sheetFilePath(path, sheet, resolve(rootPath, '..'));
        const asset = [...assets.values()].find((a): a is Extract<SchematicAsset, { kind: 'sheet' }> => a.kind === 'sheet' && a.path === childPath);
        if (!asset) throw new Error(`sheet not found: ${childPath}`);
        const ports = children(sheet, 'pin');
        components.push({ designator, value: nativeProperty(sheet, 'Sheetfile'), part_uuid: asset.partUuid,
            pins: ports.map(p => ({ pin_number: atom(p[1]) ?? '', name: atom(p[1]) ?? '', signal_name: '' })),
            pos: position(sheet), block_name: nativeProperty(sheet, 'Block Name') || null });
        pins.push(...ports.map(p => ({ designator, number: atom(p[1]) ?? '', point: position(p), sheet: true })));
    }
    const junctions = children(root, 'junction').map(j => position(j));
    points.push(...pins.map(p => p.point), ...labels.map(l => l.point), ...junctions);
    for (const point of points) graph.find(key(point));
    // Wire endpoints and pins connect by their shared coordinate. A wire passing
    // through another pin/end does not connect in KiCad without a junction.
    for (const point of [...junctions, ...labels.map(l => l.point)]) {
        for (const [a, b] of wires) if (onSegment(point, a, b)) graph.join(key(point), key(a));
    }
    // Equal label text connects on a page even when the label types differ.
    const names = new Map<string, string>();
    for (const label of labels) {
        if (names.has(label.name)) graph.join(key(label.point), names.get(label.name)!);
        else names.set(label.name, key(label.point));
    }
    const physicalPins = new Map<string, string>();
    for (const pin of pins.filter(p => !p.sheet)) {
        const id = `${pin.designator.replace(/\.\d+$/, '')}\u0000${pin.number}`;
        if (physicalPins.has(id)) graph.join(key(pin.point), physicalPins.get(id)!);
        else physicalPins.set(id, key(pin.point));
    }
    const nc = new Set(children(root, 'no_connect').map(n => key(position(n))));
    const groups = new Map<string, string>();
    for (const point of points) {
        const id = graph.find(key(point));
        if (groups.has(id)) continue;
        const sameLabels = labels.filter(l => graph.find(key(l.point)) === id);
        const samePins = pins.filter(p => graph.find(key(p.point)) === id);
        const global = sameLabels.find(l => l.kind === 'global');
        const local = sameLabels.find(l => l.kind === 'local');
        const hier = sameLabels.find(l => l.kind === 'hier');
        const port = samePins.find(p => p.sheet);
        const automatic = samePins.length > 1 || wires.some(([a]) => graph.find(key(a)) === id);
        const first = samePins[0];
        groups.set(id, global ? globalSignal(global.name) : local ? `local:${scope}:${local.name}`
            : hier ? `hier:${scope}:${hier.name}` : port && automatic ? `hier:${port.designator}:${port.number}`
            : automatic && first ? `local:${scope}:Net-(${first.designator}-${first.number})` : '');
    }
    const pinGroup = (designator: string, number: string | number) => {
        const pin = pins.find(p => (p.designator === designator || p.designator.replace(/\.\d+$/, '') === designator) && p.number === String(number));
        return pin ? graph.find(key(pin.point)) : undefined;
    };
    for (const component of components) for (const pin of component.pins) {
        const physical = pins.find(p => p.designator === component.designator && p.number === String(pin.pin_number))!;
        pin.signal_name = nc.has(key(physical.point)) ? 'NC' : groups.get(graph.find(key(physical.point))) ?? '';
    }
    const signalFor = (signal: string) => {
        const ref = parseSignal(signal);
        if (ref.kind === 'empty' || ref.kind === 'nc') return signal;
        if (ref.kind === 'local' && ref.sheet !== scope) throw new Error(`local signal belongs to another sheet: ${signal}; current sheet: ${scope}`);
        if (ref.kind === 'hier' && ref.sheet !== scope) {
            const sheet = sheets.find(s => nativeProperty(s, 'Sheetname') === ref.sheet);
            if (!sheet) throw new Error(`hierarchical sheet is not on this page: ${ref.sheet}`);
            if (!children(sheet, 'pin').some(p => atom(p[1]) === ref.name)) throw new Error(`unknown sheet pin: ${ref.sheet}.${ref.name}`);
            const group = pinGroup(ref.sheet!, ref.name);
            return (group && groups.get(group)) || signal;
        }
        const alias = labels.find(l => l.name === ref.name && l.kind === ref.kind);
        if (alias) return groups.get(graph.find(key(alias.point))) || signal;
        const conflicting = labels.find(l => l.name === ref.name && ((l.kind === 'global') !== (ref.kind === 'global')));
        if (conflicting) throw new Error(`local/global label collision on ${scope}: ${ref.name}`);
        return ref.kind === 'global' ? globalSignal(ref.name) : signal;
    };
    return { circuit: { components } as ExplainCircuit, source, path, scope, graph, pins, labels, sheets, groups, pinGroup, signalFor,
        groupAt: (point: Point) => graph.find(key(point)) };
}
export type SchematicPage = ReturnType<typeof readPage>;

// Expand file definitions into instances only for electrical verification, never for page layout.
export function projectConnections(rootPath: string, files: Map<string, string>, assets: Map<string, SchematicAsset>) {
    const graph = new Connections();
    const endpoints = new Map<string, string>();
    const netlistPins = new Map<string, string>();
    const namedGroups = new Set<string>();
    const pages = new Map<string, SchematicPage>();
    for (const [path, source] of files) pages.set(path, readPage(source, path, rootPath, assets));
    const globals = new Map<string, string>();
    const walk = (path: string, instance: string, ancestors: Set<string>) => {
        if (ancestors.has(path)) throw new Error(`cyclic schematic hierarchy: ${path}`);
        const page = pages.get(path)!;
        const group = (id: string) => `${instance}\u0000${id}`;
        for (const pin of page.pins) {
            const id = group(page.groupAt(pin.point));
            endpoints.set(`${instance}/${pin.designator}.${pin.number}`, id);
            graph.find(id);
        }
        const normalizedPath = (value: string) => value.replaceAll('-', '').replace(/^\/+|\/+$/g, '');
        for (const item of nativeInstances(page.source).filter(n => !n.reference.startsWith('#'))) {
            const project = children(findChild(item.instance, 'instances') ?? [], 'project').find(p => atom(p[1]) === basename(rootPath, '.kicad_sch'));
            const record = children(project ?? [], 'path').find(p => normalizedPath(atom(p[1]) ?? '') === normalizedPath(instance));
            const reference = record ? scalar(record, 'reference') : item.reference;
            for (const pin of page.pins.filter(p => p.designator === item.designator)) {
                const id = `${reference}\u0000${pin.number}`;
                const connection = group(page.groupAt(pin.point));
                const old = netlistPins.get(id);
                if (old) graph.join(old, connection); // Shared pins of units of the same annotated component.
                netlistPins.set(id, connection);
            }
        }
        for (const label of page.labels.filter(l => l.kind === 'global')) {
            const id = group(page.groupAt(label.point));
            if (globals.has(label.name)) graph.join(id, globals.get(label.name)!);
            else globals.set(label.name, id);
        }
        for (const label of page.labels) namedGroups.add(group(page.groupAt(label.point)));
        for (const sheet of page.sheets) {
            const childPath = sheetFilePath(path, sheet, resolve(rootPath, '..'));
            const child = pages.get(childPath)!;
            const childInstance = `${instance}/${scalar(sheet, 'uuid')}`;
            walk(childPath, childInstance, new Set(ancestors).add(path));
            for (const pin of children(sheet, 'pin')) {
                for (const label of child.labels.filter(l => l.kind === 'hier' && l.name === atom(pin[1]))) {
                    graph.join(group(page.groupAt(position(pin))), `${childInstance}\u0000${child.groupAt(label.point)}`);
                }
            }
        }
    };
    walk(resolve(rootPath), filePartUuid(files.get(resolve(rootPath))!), new Set());
    return { graph, endpoints, pages, netlistPins, namedGroups: new Set([...namedGroups].map(id => graph.find(id))) };
}

export function validateRetainedConnections(before: SchematicPage, after: SchematicPage, circuit: import('../types/circuit').CircuitMod) {
    const forward = new Map<string, string>(), reverse = new Map<string, string>();
    for (const component of before.circuit.components) for (const pin of component.pins) {
        if ([...(circuit.external_connect ?? []), ...(circuit.external_rm_connect ?? [])].some(c => c.designator === component.designator && String(c.pin_number) === String(pin.pin_number))) continue;
        if (circuit.rm_components?.includes(component.designator)) {
            const replacement = circuit.add_components.find(c => c.designator === component.designator);
            if (!replacement || replacement.pins.find(p => String(p.pin_number) === String(pin.pin_number))?.signal_name !== pin.signal_name) continue;
        }
        const oldGroup = before.pinGroup(component.designator, pin.pin_number)!;
        const newGroup = after.pinGroup(component.designator, pin.pin_number);
        if (!newGroup) throw new Error(`unmodified pin disappeared: ${component.designator}.${pin.pin_number}`);
        if ((forward.has(oldGroup) && forward.get(oldGroup) !== newGroup) || (reverse.has(newGroup) && reverse.get(newGroup) !== oldGroup)) {
            throw new Error(`unrequested connectivity change: ${component.designator}.${pin.pin_number}`);
        }
        forward.set(oldGroup, newGroup); reverse.set(newGroup, oldGroup);
    }
}

export function validateKiCadConnectivity(expected: ReturnType<typeof projectConnections>, actual: ExplainCircuit) {
    const forward = new Map<string, string>(), reverse = new Map<string, string>();
    const references = new Set([...expected.netlistPins.keys()].map(key => key.split('\u0000')[0]));
    const seen = new Set<string>();
    for (const component of actual.components) for (const pin of component.pins) {
        const key = `${component.designator}\u0000${pin.pin_number}`;
        const group = expected.netlistPins.get(key);
        // The XML reader includes library pins belonging to units that are not placed.
        if (!group && !pin.signal_name && references.has(component.designator)) continue;
        if (!group) throw new Error(`KiCad exported an unrecognized pin: ${component.designator}.${pin.pin_number}`);
        seen.add(key);
        const expectedNet = expected.graph.find(group);
        const actualNet = pin.signal_name || `\u0000${key}`;
        if (!pin.signal_name && expected.namedGroups.has(expectedNet)) {
            throw new Error(`KiCad did not connect the named net: ${component.designator}.${pin.pin_number}`);
        }
        if ((forward.has(expectedNet) && forward.get(expectedNet) !== actualNet)
            || (reverse.has(actualNet) && reverse.get(actualNet) !== expectedNet)) {
            throw new Error(`KiCad connectivity differs from the requested schematic: ${component.designator}.${pin.pin_number}`);
        }
        forward.set(expectedNet, actualNet); reverse.set(actualNet, expectedNet);
    }
    for (const key of expected.netlistPins.keys()) if (!seen.has(key)) {
        throw new Error(`KiCad did not export a placed pin: ${key.replace('\u0000', '.')}`);
    }
}
