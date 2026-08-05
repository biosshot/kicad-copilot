import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { ExplainCircuit, ExplainComponent } from '../types/circuit';
import { TEMP_DIR } from '../utils/dirs';
import { runProcessChecked } from '../utils/process';
import { getSupportedKicadCli } from './cli';

type XmlValue = string | number | boolean | Record<string, unknown> | undefined | null;
type XmlNode = Record<string, unknown>;

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
            signals.set(key, signal);
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

        let component = componentsByDesignator.get(designator);
        if (!component) {
            component = {
                designator,
                value: text(child(comp, 'value') as XmlValue),
                pins: [],
                part_uuid: partUuid,
                footprint_name: footprint,
            };
            componentsByDesignator.set(designator, component);
            componentOrder.push(component);
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

export async function getSchematic(path: string) {
    const schematicPath = resolve(path);
    const schematicStat = await stat(schematicPath).catch(() => undefined);
    if (!schematicStat?.isFile()) throw new Error(`path not found: ${schematicPath}`);

    const cli = await getSupportedKicadCli();
    await mkdir(TEMP_DIR, { recursive: true });
    const netlistPath = join(TEMP_DIR, `${basename(schematicPath, '.kicad_sch')}-${randomUUID()}.net.xml`);

    try {
        await runProcessChecked(cli.path, [
            'sch',
            'export',
            'netlist',
            '--format',
            'kicadxml',
            '--output',
            netlistPath,
            schematicPath,
        ], { timeoutMs: 60_000 });
        return parseKicadXmlNetlist(await readFile(netlistPath, 'utf8'));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`failed to read KiCad schematic: ${message}`);
    } finally {
        await rm(netlistPath, { force: true });
    }
}
