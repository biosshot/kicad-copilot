import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { ExplainCircuit } from '../types/circuit';
import { TEMP_DIR } from '../utils/dirs';
import { runProcessChecked } from '../utils/process';
import { getSupportedKicadCli } from './cli';
import { atom as sexprAtom, findChild as findSexprChild, isSExpressionList, listHead, parseSExpression } from './sexpr/ast';
import { findLists, findQuotedProperty } from './sexpr/scan';

type XmlValue = string | number | boolean | Record<string, unknown> | undefined | null;
type XmlNode = Record<string, unknown>;
type ExplainComponent = ExplainCircuit['components'][number];

const xmlParser = new XMLParser({
    ignoreAttributes: false,
    parseAttributeValue: false,
    parseTagValue: false,
    trimValues: true,
});

function node(value: unknown): XmlNode | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as XmlNode
        : undefined;
}

function array<T>(value: T | T[] | undefined | null): T[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function attribute(value: unknown, name: string) {
    const data = node(value);
    const result = data?.[`@_${name}`];
    return result === undefined || result === null ? '' : String(result);
}

function text(value: XmlValue) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }
    const data = node(value);
    const content = data?.['#text'];
    return content === undefined || content === null ? '' : String(content);
}

function child(value: unknown, name: string) {
    return node(value)?.[name];
}

function baseDesignator(reference: string) {
    return reference.trim().replace(/\.\d+$/, '');
}

function normalizeSignalName(name: string) {
    if (/^unconnected-\(/i.test(name)) return '';
    if (/^\/[^/]+$/.test(name)) return name.slice(1);
    return name;
}

function normalizePinName(pinFunction: string, pinNumber: string) {
    const suffix = `_${pinNumber}`;
    return pinFunction.endsWith(suffix)
        ? pinFunction.slice(0, -suffix.length)
        : pinFunction;
}

function namedValue(items: unknown, targetName: string) {
    const item = array(items).find((candidate) => attribute(candidate, 'name') === targetName);
    if (!item) return undefined;
    return attribute(item, 'value') || text(item as XmlValue) || undefined;
}

function libpartKey(lib: string, part: string) {
    return `${lib}\u0000${part}`;
}

function signalKey(reference: string, pin: string) {
    return `${reference}\u0000${pin}`;
}

export function parseKicadXmlNetlist(xml: string): ExplainCircuit {
    const parsed = node(xmlParser.parse(xml));
    const exported = node(parsed?.export);
    if (!exported) throw new Error('invalid KiCad XML netlist');

    const libparts = new Map<string, Map<string, string>>();
    for (const libpart of array(child(child(exported, 'libparts'), 'libpart'))) {
        const lib = attribute(libpart, 'lib');
        const part = attribute(libpart, 'part');
        const pins = new Map<string, string>();
        for (const pin of array(child(child(libpart, 'pins'), 'pin'))) {
            pins.set(attribute(pin, 'num'), attribute(pin, 'name'));
        }
        libparts.set(libpartKey(lib, part), pins);
    }

    const signals = new Map<string, string>();
    const pinFunctions = new Map<string, string>();
    for (const net of array(child(child(exported, 'nets'), 'net'))) {
        const signal = normalizeSignalName(attribute(net, 'name'));
        for (const netNode of array(child(net, 'node'))) {
            const reference = baseDesignator(attribute(netNode, 'ref'));
            const pin = attribute(netNode, 'pin');
            const key = signalKey(reference, pin);
            const previous = signals.get(key);
            if (previous && signal && previous !== signal) {
                throw new Error(`${reference}: conflicting nets on pin ${pin}`);
            }
            if (signal || !signals.has(key)) signals.set(key, signal);
            const pinFunction = attribute(netNode, 'pinfunction');
            if (pinFunction) pinFunctions.set(key, normalizePinName(pinFunction, pin));
        }
    }

    const componentsByDesignator = new Map<string, ExplainComponent>();
    const componentOrder: ExplainComponent[] = [];

    for (const comp of array(child(child(exported, 'components'), 'comp'))) {
        const rawReference = attribute(comp, 'ref');
        const designator = baseDesignator(rawReference);
        if (!designator || designator.startsWith('#') || designator.includes('|')) continue;

        const properties = child(comp, 'property');
        const fields = child(child(comp, 'fields'), 'field');
        const partUuid = namedValue(properties, 'EasyEDA part_uuid')
            || namedValue(fields, 'EasyEDA part_uuid')
            || null;
        const footprint = text(child(comp, 'footprint') as XmlValue)
            || namedValue(properties, 'Footprint')
            || namedValue(fields, 'Footprint')
            || null;
        const footprintUuid = namedValue(properties, 'EasyEDA footprint_uuid')
            || namedValue(fields, 'EasyEDA footprint_uuid')
            || null;
        const blockName = namedValue(properties, 'Block Name')
            || namedValue(fields, 'Block Name')
            || null;

        let component = componentsByDesignator.get(designator);
        if (!component) {
            component = {
                designator,
                value: text(child(comp, 'value') as XmlValue),
                pins: [],
                part_uuid: partUuid,
                footprint_name: footprint,
                footprint_uuid: footprintUuid,
                block_name: blockName,
            };
            componentsByDesignator.set(designator, component);
            componentOrder.push(component);
        } else if (component.footprint_name && footprint && component.footprint_name !== footprint) {
            throw new Error(`${designator}: conflicting footprint assignments`);
        }

        const libsource = child(comp, 'libsource');
        const libraryPins = libparts.get(libpartKey(
            attribute(libsource, 'lib'),
            attribute(libsource, 'part'),
        )) || new Map<string, string>();
        const unitPins = array(child(child(comp, 'units'), 'unit'))
            .flatMap((unit) => array(child(child(unit, 'pins'), 'pin')));
        const pins = unitPins.length
            ? unitPins
            : [...libraryPins].map(([num, name]) => ({ '@_num': num, '@_name': name }));

        for (const pin of pins) {
            const pinNumber = attribute(pin, 'num');
            const key = signalKey(designator, pinNumber);
            component.pins.push({
                pin_number: pinNumber,
                name: pinFunctions.get(key) || attribute(pin, 'name') || libraryPins.get(pinNumber) || '',
                signal_name: signals.get(key) || '',
            });
        }
    }

    return { components: componentOrder };
}

export type PcbSchematicComponent = ExplainComponent & {
    identity: string;
    footprint_uuid: string | null;
    on_board: boolean;
    in_bom: boolean;
    dnp: boolean;
};

export function parsePcbSchematicComponents(xml: string) {
    const circuit = parseKicadXmlNetlist(xml);
    const parsed = node(xmlParser.parse(xml));
    const exported = node(parsed?.export);
    const byDesignator = new Map(circuit.components.map((component) => [component.designator, component]));
    const components: PcbSchematicComponent[] = [];

    for (const comp of array(child(child(exported, 'components'), 'comp'))) {
        const designator = baseDesignator(attribute(comp, 'ref'));
        const base = byDesignator.get(designator);
        if (!base || components.some((item) => item.designator === designator)) continue;
        const properties = child(comp, 'property');
        const fields = child(child(comp, 'fields'), 'field');
        const sheetPath = attribute(child(comp, 'sheetpath'), 'tstamps') || '/';
        const symbolPath = text(child(comp, 'tstamps') as XmlValue);
        const identity = `${sheetPath.replace(/\/$/, '')}/${symbolPath}`.replace(/\/+/g, '/');
        components.push({
            ...base,
            identity,
            footprint_uuid: namedValue(properties, 'EasyEDA footprint_uuid')
                || namedValue(fields, 'EasyEDA footprint_uuid')
                || null,
            on_board: true,
            in_bom: true,
            dnp: false,
        });
    }

    return { circuit, components };
}

async function exportKicadXmlNetlist(path: string) {
    const schematicPath = resolve(path);
    const schematicStat = await stat(schematicPath).catch(() => undefined);
    if (!schematicStat?.isFile()) throw new Error(`path not found: ${schematicPath}`);

    const cli = await getSupportedKicadCli();
    await mkdir(TEMP_DIR, { recursive: true });
    const netlistPath = join(TEMP_DIR, `${basename(schematicPath, '.kicad_sch')}-${randomUUID()}.net.xml`);
    try {
        await runProcessChecked(cli.path, [
            'sch', 'export', 'netlist', '--format', 'kicadxml', '--output', netlistPath, schematicPath,
        ], { timeoutMs: 60_000 });
        return await readFile(netlistPath, 'utf8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to read KiCad schematic: ${message}`);
    } finally {
        await rm(netlistPath, { force: true });
    }
}

export async function getSchematic(path: string) {
    return parseKicadXmlNetlist(await exportKicadXmlNetlist(path));
}

async function projectRootSchematic(path: string) {
    const target = resolve(path);
    const targetStat = await stat(target).catch(() => undefined);
    if (!targetStat?.isFile()) throw new Error(`path not found: ${target}`);

    let directory = dirname(target);
    while (true) {
        const projectFiles = (await readdir(directory, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.kicad_pro')
            .map((entry) => resolve(directory, entry.name))
            .sort();
        const matches: string[] = [];
        for (const projectFile of projectFiles) {
            const root = resolve(directory, `${basename(projectFile, '.kicad_pro')}.kicad_sch`);
            const rootStat = await stat(root).catch(() => undefined);
            if (!rootStat?.isFile()) continue;
            const reachable = await reachableSchematicFiles(root);
            if (reachable.some((file) => file.toLowerCase() === target.toLowerCase())) matches.push(root);
        }
        if (matches.length > 1) {
            throw new Error(`schematic belongs to multiple KiCad projects: ${target}`);
        }
        if (matches.length === 1) return matches[0];

        const parent = dirname(directory);
        if (parent === directory) return target;
        directory = parent;
    }
}

async function physicalDesignators(path: string) {
    const source = await readFile(path, 'utf8');
    const designators = new Set<string>();
    for (const range of findLists(source, 'symbol')) {
        const value = parseSExpression(range.text);
        if (!findSexprChild(value, 'lib_id')) continue;
        const reference = sexprProperty(value, 'Reference') || '';
        if (reference && !reference.startsWith('#')) designators.add(baseDesignator(reference));
    }
    return designators;
}

export async function getSchematicContext(path: string) {
    const targetPath = resolve(path);
    const projectPath = await projectRootSchematic(targetPath);
    const exportedTarget = await getSchematic(targetPath);
    const targetDesignators = await physicalDesignators(targetPath);
    const target = {
        components: exportedTarget.components.filter((component) => (
            targetDesignators.has(component.designator)
        )),
    };
    const project = projectPath.toLowerCase() === targetPath.toLowerCase()
        ? exportedTarget
        : await getSchematic(projectPath);
    return { target, project, projectPath };
}

export async function getPcbSchematic(path: string) {
    const parsed = parsePcbSchematicComponents(await exportKicadXmlNetlist(path));
    const flags = await readSchematicInstanceFlags(path);
    for (const component of parsed.components) {
        const uuid = component.identity.split('/').filter(Boolean).at(-1) || '';
        const value = flags.byUuid.get(uuid) || flags.byReference.get(component.designator.toUpperCase());
        if (!value) continue;
        component.on_board = value.on_board;
        component.in_bom = value.in_bom;
        component.dnp = value.dnp;
    }
    for (const value of flags.excluded) {
        if (parsed.components.some((item) => item.designator.toUpperCase() === value.designator.toUpperCase())) continue;
        parsed.components.push({
            designator: value.designator,
            value: value.value,
            pins: [],
            part_uuid: value.part_uuid,
            footprint_name: value.footprint_name,
            footprint_uuid: value.footprint_uuid,
            block_name: value.block_name,
            identity: `/${value.uuid}`,
            on_board: false,
            in_bom: value.in_bom,
            dnp: value.dnp,
        });
    }
    return parsed;
}

type InstanceFlags = {
    uuid: string;
    designator: string;
    value: string;
    footprint_name: string | null;
    footprint_uuid: string | null;
    part_uuid: string | null;
    block_name: string | null;
    on_board: boolean;
    in_bom: boolean;
    dnp: boolean;
};

function sexprProperty(node: ReturnType<typeof parseSExpression>, name: string) {
    for (const item of node) {
        if (!isSExpressionList(item) || listHead(item) !== 'property') continue;
        if (sexprAtom(item[1]) === name) return sexprAtom(item[2]);
    }
    return undefined;
}

function yes(node: ReturnType<typeof parseSExpression>, head: string, fallback: boolean) {
    const value = sexprAtom(findSexprChild(node, head)?.[1]);
    return value === undefined ? fallback : value === 'yes';
}

async function reachableSchematicFiles(rootPath: string) {
    const root = resolve(rootPath);
    const projectDirectory = dirname(root);
    const queue = [root];
    const visited = new Set<string>();
    const files: string[] = [];

    while (queue.length) {
        const file = queue.shift()!;
        const key = file.toLowerCase();
        if (visited.has(key)) continue;
        visited.add(key);

        const source = await readFile(file, 'utf8');
        files.push(file);
        for (const range of findLists(source, 'sheet')) {
            const sheetFile = findQuotedProperty(range.text, 'Sheetfile');
            if (!sheetFile) continue;
            const expanded = sheetFile.replace(/\$\{KIPRJMOD\}/g, projectDirectory);
            const childPath = resolve(dirname(file), expanded);
            const childStat = await stat(childPath).catch(() => undefined);
            if (!childStat?.isFile()) throw new Error(`hierarchical sheet not found: ${childPath}`);
            queue.push(childPath);
        }
    }

    return files;
}

async function readSchematicInstanceFlags(rootPath: string) {
    const files = await reachableSchematicFiles(rootPath);
    const values: InstanceFlags[] = [];
    for (const file of files) {
        const source = await readFile(file, 'utf8');
        for (const range of findLists(source, 'symbol')) {
            const node = parseSExpression(range.text);
            if (!findSexprChild(node, 'lib_id')) continue;
            const designator = sexprProperty(node, 'Reference') || '';
            const uuid = sexprAtom(findSexprChild(node, 'uuid')?.[1]) || '';
            if (!designator || !uuid || designator.startsWith('#')) continue;
            values.push({
                uuid,
                designator: baseDesignator(designator),
                value: sexprProperty(node, 'Value') || '',
                footprint_name: sexprProperty(node, 'Footprint') || null,
                footprint_uuid: sexprProperty(node, 'EasyEDA footprint_uuid') || null,
                part_uuid: sexprProperty(node, 'EasyEDA part_uuid') || null,
                block_name: sexprProperty(node, 'Block Name') || null,
                on_board: yes(node, 'on_board', true),
                in_bom: yes(node, 'in_bom', true),
                dnp: yes(node, 'dnp', false),
            });
        }
    }
    const byPhysicalReference = new Map<string, InstanceFlags>();
    for (const value of values) {
        const key = value.designator.toUpperCase();
        const previous = byPhysicalReference.get(key);
        if (previous && (
            previous.footprint_name !== value.footprint_name
            || previous.on_board !== value.on_board
            || previous.in_bom !== value.in_bom
            || previous.dnp !== value.dnp
        )) {
            throw new Error(`${value.designator}: conflicting multi-unit PCB properties`);
        }
        byPhysicalReference.set(key, value);
    }
    return {
        byUuid: new Map(values.map((value) => [value.uuid, value])),
        byReference: byPhysicalReference,
        excluded: values.filter((value) => !value.on_board),
    };
}
