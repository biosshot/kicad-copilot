import { CircuitMod } from '../types/circuit';
import { getSchematicContext } from '../kicad/schematic-reader';
import { assetSymbols, children, loadSchematicAssets, nativeProperty, registeredAsset, sheetFilePath } from '../kicad/schematic-assets';
import { parseSExpression } from '../kicad/sexpr/ast';
import { globalSignal, parseSignal, HierarchicalDirection } from '../kicad/scoped-signals';

export async function prepareSchematicInput(path: string, input: CircuitMod) {
    const context = await getSchematicContext(path);
    const circuit = structuredClone(input);
    if (circuit.rm_components) circuit.rm_components = [...new Set(circuit.rm_components.flatMap(designator => {
        const matches = context.target.components.filter(c => c.designator === designator || c.designator.replace(/\.\d+$/, '') === designator);
        if (!matches.length) throw new Error(`component not on target page: ${designator}`);
        return matches.map(c => c.designator);
    }))];
    for (const edit of [...(circuit.external_connect ?? []), ...(circuit.external_rm_connect ?? [])]) {
        const target = context.target.components.find(c => (c.designator === edit.designator || c.designator.replace(/\.\d+$/, '') === edit.designator)
            && c.pins.some(p => String(p.pin_number) === String(edit.pin_number)));
        if (!target) throw new Error(`pin not on target page: ${edit.designator}.${edit.pin_number}`);
        edit.designator = target.designator;
    }
    const added = new Set<string>();
    for (const component of circuit.add_components) {
        if (!component.designator || /[|:]/.test(component.designator)) throw new Error(`invalid component designator: ${component.designator}`);
        if (added.has(component.designator)) throw new Error(`duplicate component designator: ${component.designator}`);
        added.add(component.designator);
        const existing = context.target.components.find(c => c.designator === component.designator);
        if (existing && !circuit.rm_components?.includes(component.designator)) throw new Error(`component already exists: ${component.designator}; remove it before replacing`);
        if (!context.assets.has(component.part_uuid)) {
            const asset = await registeredAsset(component.part_uuid);
            if (asset?.path) {
                const extra = await loadSchematicAssets(context.rootPath, [asset.path]);
                for (const [id, value] of extra.assets) context.assets.set(id, value);
                for (const [file, source] of extra.files) context.files.set(file, source);
            } else if (asset) context.assets.set(component.part_uuid, asset);
        }
        const asset = context.assets.get(component.part_uuid);
        if (asset?.kind === 'native' && asset.multiUnit) {
            const suffix = component.designator.match(/\.(\d+)$/);
            if (suffix && Number(suffix[1]) !== asset.unit) throw new Error(`part_uuid does not describe unit ${component.designator}`);
            if (!suffix) {
                component.designator = `${component.designator}.${asset.unit}`;
                if (added.has(component.designator)) throw new Error(`duplicate component designator: ${component.designator}`);
                added.add(component.designator);
                if (context.target.components.some(c => c.designator === component.designator) && !circuit.rm_components?.includes(component.designator)) {
                    throw new Error(`component already exists: ${component.designator}`);
                }
            }
        }
        if (new Set(component.pins.map(p => String(p.pin_number))).size !== component.pins.length) throw new Error(`duplicate pin: ${component.designator}`);
        if (asset?.kind === 'sheet') {
            if (component.designator === context.page.scope || /\.\d+$/.test(component.designator)) {
                throw new Error(`sheet designator conflicts with a scope or unit address: ${component.designator}`);
            }
            const reachesTarget = (file: string, seen = new Set<string>()): boolean => {
                if (file === context.page.path) return true;
                if (seen.has(file)) return false;
                seen.add(file);
                return children(parseSExpression(context.files.get(file)!), 'sheet').some(s =>
                    reachesTarget(sheetFilePath(file, s, context.projectDirectory), seen));
            };
            if (reachesTarget(asset.path)) throw new Error('cannot insert a sheet into itself or its descendant');
        }
        if (asset) {
            for (const pin of component.pins) if (!asset.symbol.pins.some(p => String(p.num) === String(pin.pin_number))) {
                throw new Error(`unknown pin: ${component.designator}.${pin.pin_number}`);
            }
            // Empty ports still form part of the reusable interface.
            for (const pin of asset.symbol.pins) if (!component.pins.some(p => String(p.pin_number) === String(pin.num))) {
                component.pins.push({ pin_number: pin.num, name: pin.name, signal_name: '' });
            }
            if (asset.kind === 'native') for (const pin of asset.pins.filter(p => p.hidden && p.electricalType === 'power_in')) {
                const connection = component.pins.find(p => String(p.pin_number) === pin.number)!;
                if (!connection.signal_name) connection.signal_name = globalSignal(pin.name);
            }
        }
    }
    const labelDirections = new Map<string, HierarchicalDirection>();
    for (const pin of [...circuit.add_components.flatMap(c => c.pins), ...(circuit.external_connect ?? []),
        ...circuit.add_reused_blocks.flatMap(b => b.ports)]) {
        const ref = parseSignal(pin.signal_name);
        if (ref.kind !== 'hier' || !ref.direction) continue;
        if (ref.sheet === context.page.scope) {
            const previous = labelDirections.get(ref.name);
            if (previous && previous !== ref.direction) throw new Error(`conflicting hierarchical directions: ${ref.name}`);
            labelDirections.set(ref.name, ref.direction);
        } else {
            const sheet = [...circuit.add_components, ...context.target.components].find(c => c.designator === ref.sheet);
            const asset = sheet?.part_uuid ? context.assets.get(sheet.part_uuid) : undefined;
            if (asset?.kind !== 'sheet') throw new Error(`hierarchical sheet is not on this page: ${ref.sheet}`);
            const port = asset.ports.find(p => p.name === ref.name);
            if (!port) throw new Error(`unknown sheet pin: ${ref.sheet}.${ref.name}`);
            if (port.direction !== ref.direction) throw new Error(`hierarchical direction mismatch: ${ref.sheet}.${ref.name}; change its type on the defining sheet`);
        }
        // Direction is KiCad metadata. The layout server sees the existing net format.
        pin.signal_name = `hier:${ref.sheet}:${ref.name}`;
    }
    const connectPort = (signal: string, resolving: string[] = []): string => {
        const ref = parseSignal(signal);
        if (ref.kind !== 'hier' || ref.sheet === context.page.scope) return context.page.signalFor(signal);
        const newSheet = circuit.add_components.find(c => c.designator === ref.sheet && context.assets.get(c.part_uuid)?.kind === 'sheet');
        if (newSheet) {
            const pin = newSheet.pins.find(p => String(p.pin_number) === ref.name);
            if (!pin) throw new Error(`unknown sheet pin: ${ref.sheet}.${ref.name}`);
            if (!pin.signal_name) pin.signal_name = signal;
            if (pin.signal_name === signal) return signal;
            // Resolve links between sheets added by this same request, including
            // forward references. A cycle of port aliases is one electrical net.
            const cycle = resolving.indexOf(signal);
            if (cycle >= 0) return resolving.slice(cycle).sort()[0];
            pin.signal_name = connectPort(pin.signal_name, [...resolving, signal]);
            return pin.signal_name;
        }
        const canonical = context.page.signalFor(signal);
        const existing = context.target.components.find(c => c.designator === ref.sheet)!;
        const pin = existing.pins.find(p => String(p.pin_number) === ref.name)!;
        if (!pin.signal_name) {
            circuit.external_connect ??= [];
            if (!circuit.external_connect.some(c => c.designator === ref.sheet && String(c.pin_number) === ref.name)) {
                circuit.external_connect.push({ designator: ref.sheet!, pin_number: ref.name, signal_name: canonical });
            }
        }
        return canonical;
    };
    for (const c of circuit.add_components) for (const p of c.pins) p.signal_name = connectPort(p.signal_name);
    for (const c of circuit.external_connect ?? []) c.signal_name = connectPort(c.signal_name);
    for (const block of circuit.add_reused_blocks) for (const port of block.ports) port.signal_name = connectPort(port.signal_name);
    const names = new Map<string, Set<string>>();
    for (const signal of [...circuit.add_components.flatMap(c => c.pins.map(p => p.signal_name)),
        ...(circuit.external_connect ?? []).map(c => c.signal_name)]) {
        const ref = parseSignal(signal);
        if (ref.kind !== 'global' && ref.kind !== 'local') continue;
        const kinds = names.get(ref.name) ?? new Set();
        kinds.add(ref.kind); names.set(ref.name, kinds);
        if (kinds.size > 1) throw new Error(`local/global label collision: ${ref.name}`);
    }
    for (const edit of [...(circuit.external_connect ?? []), ...(circuit.external_rm_connect ?? [])]) {
        if (!context.target.components.some(c => (c.designator === edit.designator || c.designator.replace(/\.\d+$/, '') === edit.designator)
            && c.pins.some(p => String(p.pin_number) === String(edit.pin_number)))) throw new Error(`pin not on target page: ${edit.designator}.${edit.pin_number}`);
    }
    for (const designator of circuit.rm_components ?? []) if (!context.target.components.some(c =>
        c.designator === designator || c.designator.replace(/\.\d+$/, '') === designator)) throw new Error(`component not on target page: ${designator}`);
    const ids = [...context.target.components.map(c => c.part_uuid), ...circuit.add_components.map(c => c.part_uuid)].filter((id): id is string => Boolean(id));
    return { ...context, circuit, labelDirections, symbols: assetSymbols(context.assets, ids) };
}
