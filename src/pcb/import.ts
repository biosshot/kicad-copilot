import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { saveCheckpoint } from '../checkpoints/store';
import { resolveFootprintDefinition } from '../kicad/footprint-library';
import { normalizeEasyEdaFootprintGeometry } from '../kicad/footprint-normalization';
import { setFootprintSide } from '../kicad/board-assemble';
import {
    childText,
    footprintAt,
    footprintIsBoardOnly,
    footprintLayer,
    footprintPath,
    footprintReference,
    listChildren,
    padNumber,
    pcbFootprints,
    propertyValue,
    readPcb,
} from '../kicad/pcb-reader';
import { atomicWritePcb } from '../kicad/pcb-writer';
import { getPcbSchematic, PcbSchematicComponent } from '../kicad/schematic-reader';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    SExpression,
    token,
    visitSExpression,
} from '../kicad/sexpr/ast';
import { associatedSchematicPath } from './paths';

function setChild(node: SExpression[], head: string, values: SExpression[]) {
    const existing = findChild(node, head);
    const replacement: SExpression[] = [token(head), ...values];
    if (existing) node[node.indexOf(existing)] = replacement;
    else node.push(replacement);
}

function removeChildren(node: SExpression[], head: string) {
    for (let index = node.length - 1; index >= 0; index -= 1) {
        if (isSExpressionList(node[index]) && listHead(node[index]) === head) node.splice(index, 1);
    }
}

function setProperty(node: SExpression[], name: string, value: string, hidden = true) {
    const existing = node.find((item) => isSExpressionList(item)
        && listHead(item) === 'property' && atom(item[1]) === name) as SExpression[] | undefined;
    if (existing) {
        existing[2] = token(value, true);
        return;
    }
    node.push([
        token('property'), token(name, true), token(value, true),
        [token('at'), token('0'), token('0'), token('0')],
        [token('layer'), token('F.Fab', true)],
        ...(hidden ? [[token('hide'), token('yes')]] : []),
        [token('uuid'), token(randomUUID(), true)],
        [token('effects'), [token('font'), [token('size'), token('1'), token('1')]]],
    ] as SExpression[]);
}

function renewUuids(node: SExpression[]) {
    visitSExpression(node, (item) => {
        if (listHead(item) === 'uuid' || listHead(item) === 'tstamp') {
            if (item.length > 1) item[1] = token(randomUUID(), true);
        }
    });
}

function pinNets(component: PcbSchematicComponent) {
    const result = new Map<string, string>();
    for (const pin of component.pins) {
        const number = String(pin.pin_number);
        const signal = pin.signal_name || '';
        const previous = result.get(number);
        if (previous !== undefined && previous !== signal && previous && signal) {
            throw new Error(`${component.designator}: conflicting nets on pin ${number}`);
        }
        if (signal || previous === undefined) result.set(number, signal);
    }
    return result;
}

function rootNetIds(root: SExpression[]) {
    const result = new Map<string, number>();
    for (const item of listChildren(root, 'net')) {
        const id = Number(atom(item[1]));
        const name = atom(item[2]);
        if (Number.isFinite(id) && name !== undefined) result.set(name, id);
    }
    return result;
}

function ensureLegacyNet(root: SExpression[], ids: Map<string, number>, name: string) {
    const existing = ids.get(name);
    if (existing !== undefined) return existing;
    const id = Math.max(0, ...ids.values()) + 1;
    ids.set(name, id);
    root.push([token('net'), token(String(id)), token(name, true)]);
    return id;
}

function assignPadNets(root: SExpression[], footprint: SExpression[], component: PcbSchematicComponent, version: number) {
    const nets = pinNets(component);
    const legacyIds = rootNetIds(root);
    for (const pad of listChildren(footprint, 'pad')) {
        const number = padNumber(pad);
        if (!number || !nets.has(number)) continue;
        removeChildren(pad, 'net');
        const name = nets.get(number) || '';
        if (!name) continue;
        if (version >= 20250000) pad.push([token('net'), token(name, true)]);
        else pad.push([token('net'), token(String(ensureLegacyNet(root, legacyIds, name))), token(name, true)]);
    }
}

function synchronizeAttrs(footprint: SExpression[], component: PcbSchematicComponent) {
    let attr = findChild(footprint, 'attr');
    if (!attr) {
        attr = [token('attr')];
        footprint.push(attr);
    }
    const preserved = attr.slice(1).map(atom).filter((value): value is string => Boolean(value))
        .filter((value) => !['dnp', 'exclude_from_bom'].includes(value));
    if (component.dnp) preserved.push('dnp');
    if (!component.in_bom) preserved.push('exclude_from_bom');
    attr.splice(1, attr.length - 1, ...[...new Set(preserved)].map((value) => token(value)));
}

function updateFootprintMetadata(
    root: SExpression[],
    footprint: SExpression[],
    component: PcbSchematicComponent,
    schematicPath: string,
    version: number,
) {
    setProperty(footprint, 'Reference', component.designator, false);
    setProperty(footprint, 'Value', component.value, false);
    setProperty(footprint, 'EasyEDA part_uuid', component.part_uuid || '');
    setProperty(footprint, 'EasyEDA footprint_uuid', component.footprint_uuid || '');
    setProperty(footprint, 'Block Name', component.block_name || '');
    setChild(footprint, 'path', [token(component.identity, true)]);
    setChild(footprint, 'sheetname', [token('/', true)]);
    setChild(footprint, 'sheetfile', [token(basename(schematicPath), true)]);
    synchronizeAttrs(footprint, component);
    assignPadNets(root, footprint, component, version);
}

function footprintIdentifier(node: SExpression[]) {
    return atom(node[1]) || '';
}

function outlineRight(root: SExpression[]) {
    let right: number | undefined;
    for (const head of ['gr_line', 'gr_arc', 'gr_rect', 'gr_circle', 'gr_poly']) {
        for (const item of listChildren(root, head)) {
            if (childText(item, 'layer') !== 'Edge.Cuts') continue;
            visitSExpression(item, (value) => {
                if (!['start', 'end', 'mid', 'center', 'xy'].includes(listHead(value) || '')) return;
                const x = Number(atom(value[1]));
                if (Number.isFinite(x)) right = Math.max(right ?? x, x);
            });
        }
    }
    return right;
}

function stagingAt(root: SExpression[], index: number) {
    const originX = outlineRight(root);
    return {
        x: (originX === undefined ? 20 : originX + 10) + (index % 8) * 5,
        y: 20 + Math.floor(index / 8) * 5,
        rotate: 0,
    };
}

function byUniqueReference(footprints: SExpression[][]) {
    const result = new Map<string, SExpression[]>();
    const duplicates = new Set<string>();
    for (const footprint of footprints) {
        const reference = footprintReference(footprint)?.toUpperCase();
        if (!reference || footprintIsBoardOnly(footprint)) continue;
        if (result.has(reference)) duplicates.add(reference);
        else result.set(reference, footprint);
    }
    for (const duplicate of duplicates) result.delete(duplicate);
    return { result, duplicates };
}

function replaceRootItem(root: SExpression[], previous: SExpression[], next: SExpression[]) {
    const index = root.indexOf(previous);
    if (index < 0) throw new Error('PCB footprint disappeared during import');
    root[index] = next;
}

export async function importPcbChanges(pcbPathInput: string, schematicOverride?: string | null) {
    const pcb = await readPcb(pcbPathInput);
    const schematicPath = await associatedSchematicPath(pcb.path, schematicOverride);
    const { components } = await getPcbSchematic(schematicPath);
    const active = components.filter((component) => component.on_board && component.footprint_name);
    const allByIdentity = new Map(components.map((component) => [component.identity, component]));
    const activeByReference = new Map(active.map((component) => [component.designator.toUpperCase(), component]));
    const footprints = pcbFootprints(pcb.root);
    const byPath = new Map<string, SExpression[]>();
    const duplicatePaths = new Set<string>();
    for (const footprint of footprints) {
        const path = footprintPath(footprint);
        if (!path || footprintIsBoardOnly(footprint)) continue;
        if (byPath.has(path)) duplicatePaths.add(path);
        else byPath.set(path, footprint);
    }
    for (const path of duplicatePaths) byPath.delete(path);
    const unique = byUniqueReference(footprints);

    for (const reference of unique.duplicates) {
        if (!activeByReference.has(reference)) continue;
        const component = activeByReference.get(reference)!;
        if (!byPath.has(component.identity)) throw new Error(`ambiguous PCB designator: ${component.designator}`);
    }
    for (const component of active) {
        if (duplicatePaths.has(component.identity)) {
            throw new Error(`ambiguous PCB identity: ${component.designator}`);
        }
    }

    const resolvedDefinitions = new Map<string, Awaited<ReturnType<typeof resolveFootprintDefinition>>>();
    for (const component of active) {
        const current = byPath.get(component.identity) || unique.result.get(component.designator.toUpperCase());
        const identifier = component.footprint_name!;
        if (current && footprintIdentifier(current) === identifier) continue;
        if (!resolvedDefinitions.has(identifier)) {
            resolvedDefinitions.set(identifier, await resolveFootprintDefinition(identifier, pcb.path));
        }
    }

    let added = 0;
    for (const component of components) {
        let current = byPath.get(component.identity) || unique.result.get(component.designator.toUpperCase());
        if (!component.on_board || !component.footprint_name) {
            if (current && !footprintIsBoardOnly(current)) pcb.root.splice(pcb.root.indexOf(current), 1);
            else if (!component.footprint_name && !current) console.error(`[import_pcb_changes] ${component.designator}: footprint is not assigned`);
            continue;
        }

        const assignmentChanged = current && footprintIdentifier(current) !== component.footprint_name;
        if (!current || assignmentChanged) {
            const definition = resolvedDefinitions.get(component.footprint_name)!;
            const next = structuredClone(definition.root) as SExpression[];
            renewUuids(next);
            next[1] = token(component.footprint_name, true);
            const placement = current ? footprintAt(current) : stagingAt(pcb.root, added++);
            const layer = current ? footprintLayer(current) : 'F.Cu';
            setFootprintSide(next, layer === 'B.Cu' ? 'B.Cu' : 'F.Cu');
            setChild(next, 'at', [token(String(placement.x)), token(String(placement.y)), token(String(placement.rotate))]);
            updateFootprintMetadata(pcb.root, next, component, schematicPath, pcb.version);
            normalizeEasyEdaFootprintGeometry(next);
            if (current) replaceRootItem(pcb.root, current, next);
            else pcb.root.push(next);
            current = next;
        } else {
            updateFootprintMetadata(pcb.root, current, component, schematicPath, pcb.version);
        }
    }

    for (const footprint of [...pcbFootprints(pcb.root)]) {
        if (footprintIsBoardOnly(footprint)) continue;
        const path = footprintPath(footprint);
        const reference = footprintReference(footprint)?.toUpperCase();
        if (!path) continue;
        if (allByIdentity.has(path) || (reference && activeByReference.has(reference))) continue;
        pcb.root.splice(pcb.root.indexOf(footprint), 1);
    }

    await saveCheckpoint(pcb.path, 'Before PCB import');
    await atomicWritePcb(pcb.path, pcb.source, pcb.root);
    return 'ok';
}
