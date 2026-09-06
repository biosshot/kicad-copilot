import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import { atom, findChild, isSExpressionList, listHead, parseSExpression, printSExpression, SExpression, visitSExpression } from './sexpr/ast';
import { librarySymbolPins, LibraryPin } from './symbol';
import { readCacheJson, writeCacheJson } from '../components/cache';

export const SYMBOL_UNIT_MM = 0.254;
export type SymbolData = {
    width: number; height: number; center: { x: number; y: number };
    pins: { num: string; name: string; x: number; y: number; signal_name: string; part: string }[];
};
export type Point = { x: number; y: number };
export type SheetPort = { name: string; direction: string };
export type SheetAsset = { kind: 'sheet'; partUuid: string; path: string; source: string; ports: SheetPort[]; symbol: SymbolData };
export type NativeAsset = {
    kind: 'native'; partUuid: string; library: SExpression[]; instance: SExpression[];
    pins: LibraryPin[]; symbol: SymbolData; unit: number; multiUnit: boolean; mirror: string;
    path?: string;
};
export type SchematicAsset = SheetAsset | NativeAsset;
type AssetSource = { path: string; rootPath: string };
const knownSources = new Map<string, AssetSource>();

export function children(node: SExpression[], head: string) {
    return node.filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === head);
}
export function scalar(node: SExpression[], head: string, fallback = '') {
    return atom(findChild(node, head)?.[1]) ?? fallback;
}
export function nativeProperty(node: SExpression[], name: string) {
    return atom(children(node, 'property').find(p => atom(p[1]) === name)?.[2]) ?? '';
}
export function position(node: SExpression[], head = 'at'): Point {
    const at = findChild(node, head);
    return { x: Number(atom(at?.[1]) ?? 0), y: Number(atom(at?.[2]) ?? 0) };
}
export function filePartUuid(source: string) {
    const uuid = scalar(parseSExpression(source), 'uuid').replaceAll('-', '').toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(uuid) || /^0+$/.test(uuid)) throw new Error('schematic UUID is missing or invalid');
    return uuid;
}
export function sheetFilePath(parent: string, sheet: SExpression[], projectDirectory = dirname(parent)) {
    const file = nativeProperty(sheet, 'Sheetfile');
    if (!file) throw new Error('sheet has no Sheetfile');
    return resolve(dirname(parent), file.replaceAll('${KIPRJMOD}', projectDirectory));
}
export function sheetPorts(source: string): SheetPort[] {
    const ports = new Map<string, SheetPort>();
    for (const label of children(parseSExpression(source), 'hierarchical_label')) {
        const name = atom(label[1]) ?? '';
        if (!name) throw new Error('hierarchical label has no name');
        const direction = scalar(label, 'shape', 'bidirectional');
        if (ports.has(name) && ports.get(name)!.direction !== direction) throw new Error(`conflicting port directions: ${name}`);
        ports.set(name, { name, direction });
    }
    return [...ports.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export function sheetSymbolData(ports: SheetPort[]): SymbolData {
    const left = ports.filter(p => p.direction !== 'output');
    const right = ports.filter(p => p.direction === 'output');
    const width = Math.max(200, Math.ceil(Math.max(0, ...ports.map(p => p.name.length)) * 5 / 10) * 20 + 80);
    const height = Math.max(100, (Math.max(left.length, right.length) + 1) * 20);
    return {
        width, height, center: { x: 0, y: 0 },
        pins: [...left.map((p, i) => ({ p, x: 0, y: (i + 1) * 20 })),
            ...right.map((p, i) => ({ p, x: width, y: (i + 1) * 20 }))]
            .map(({ p, x, y }) => ({ num: p.name, name: p.name, x, y, signal_name: '', part: '1' })),
    };
}
export function selectedLibraryUnit(library: SExpression[], unit: number, style = 1) {
    const clone = structuredClone(library);
    for (let i = clone.length - 1; i >= 0; i--) {
        const child = clone[i];
        if (!isSExpressionList(child) || listHead(child) !== 'symbol') continue;
        const suffix = atom(child[1])?.match(/_(\d+)_(\d+)$/);
        if (suffix && !((Number(suffix[1]) === 0 || Number(suffix[1]) === unit)
            && (Number(suffix[2]) === 0 || Number(suffix[2]) === style))) clone.splice(i, 1);
    }
    return clone;
}
export function nativeAsset(library: SExpression[], instance: SExpression[]): NativeAsset {
    const unit = Number(scalar(instance, 'unit', '1'));
    const selected = selectedLibraryUnit(library, unit, Number(scalar(instance, 'convert', '1')));
    const mirror = scalar(instance, 'mirror');
    const mx = mirror === 'y' ? -1 : 1;
    const my = mirror === 'x' ? -1 : 1;
    const pins = librarySymbolPins(selected).map(p => ({ ...p, x: p.x * mx, y: p.y * my,
        angle: mirror === 'x' ? -p.angle : mirror === 'y' ? 180 - p.angle : p.angle }));
    const points: Point[] = [{ x: 0, y: 0 }, ...pins];
    // Unit graphics determine the bounds; top-level library property positions are not body geometry.
    for (const graphics of children(selected, 'symbol')) visitSExpression(graphics, node => {
        for (const head of ['xy', 'start', 'end', 'mid', 'center', 'at']) {
            for (const p of children(node, head)) points.push({ x: Number(atom(p[1])) * mx, y: Number(atom(p[2])) * my });
        }
        if (listHead(node) === 'circle') {
            const center = position(node, 'center');
            const radius = Number(scalar(node, 'radius', '0'));
            points.push({ x: center.x * mx - radius, y: center.y * my - radius },
                { x: center.x * mx + radius, y: center.y * my + radius });
        }
    });
    const gridFloor = (v: number) => Math.floor(v / 1.27) * 1.27;
    const gridCeil = (v: number) => Math.ceil(v / 1.27) * 1.27;
    const left = gridFloor(Math.min(...points.map(p => p.x)) - 2.54);
    const top = gridFloor(Math.min(...points.map(p => -p.y)) - 2.54);
    const right = gridCeil(Math.max(...points.map(p => p.x)) + 2.54);
    const bottom = gridCeil(Math.max(...points.map(p => -p.y)) + 2.54);
    const partUuid = createHash('sha256').update(JSON.stringify(['kicad-symbol', printSExpression(selected), mirror,
        nativeProperty(instance, 'Footprint'), nativeProperty(instance, 'MPN')])).digest('hex').slice(0, 32);
    return {
        kind: 'native', partUuid, library, instance, pins, unit, mirror,
        multiUnit: children(library, 'symbol').some(n => Number(atom(n[1])?.match(/_(\d+)_\d+$/)?.[1] ?? 0) > 1),
        symbol: { width: (right - left) / SYMBOL_UNIT_MM, height: (bottom - top) / SYMBOL_UNIT_MM,
            center: { x: -left / SYMBOL_UNIT_MM, y: -top / SYMBOL_UNIT_MM },
            pins: pins.map(p => ({ num: p.number, name: p.name, x: (p.x - left) / SYMBOL_UNIT_MM,
                y: (-p.y - top) / SYMBOL_UNIT_MM, signal_name: '', part: String(unit) })) },
    };
}
export function nativeInstances(source: string) {
    const root = parseSExpression(source);
    const libraries = new Map(children(findChild(root, 'lib_symbols') ?? [], 'symbol').map(n => [atom(n[1]), n]));
    return children(root, 'symbol').map(instance => {
        const libId = scalar(instance, 'lib_id');
        const library = libraries.get(libId);
        if (!library) throw new Error(`embedded symbol missing: ${libId}`);
        const asset = nativeAsset(library, instance);
        const reference = nativeProperty(instance, 'Reference');
        const designator = asset.multiUnit ? `${reference}.${asset.unit}` : reference;
        return { instance, asset, reference, designator };
    });
}
export async function loadSchematicAssets(rootPath: string, additional: string[] = []) {
    const assets = new Map<string, SchematicAsset>();
    const files = new Map<string, string>();
    const projectDirectory = dirname(resolve(rootPath));
    const walk = async (path: string, ancestors: Set<string>) => {
        path = resolve(path);
        if (ancestors.has(path)) throw new Error(`cyclic schematic hierarchy: ${path}`);
        if (files.has(path)) return;
        const source = await readFile(path, 'utf8');
        files.set(path, source);
        const partUuid = filePartUuid(source);
        const previous = assets.get(partUuid);
        if (previous?.kind === 'sheet' && previous.path !== path) throw new Error(`duplicate schematic UUID: ${previous.path}, ${path}`);
        const ports = sheetPorts(source);
        assets.set(partUuid, { kind: 'sheet', partUuid, path, source, ports, symbol: sheetSymbolData(ports) });
        for (const { asset } of nativeInstances(source)) assets.set(asset.partUuid, { ...asset, path });
        for (const sheet of children(parseSExpression(source), 'sheet')) {
            await walk(sheetFilePath(path, sheet, projectDirectory), new Set(ancestors).add(path));
        }
    };
    await walk(rootPath, new Set());
    for (const path of additional) await walk(path, new Set());
    for (const [id, asset] of assets) if (asset.path) {
        const source = { path: asset.path, rootPath: resolve(rootPath) };
        const previous = knownSources.get(id);
        if (previous?.path === source.path && previous.rootPath === source.rootPath) continue;
        await writeCacheJson(id, 'schematic-source.json', source);
        knownSources.set(id, source);
    }
    return { assets, files, rootPath: resolve(rootPath), projectDirectory };
}
export async function registeredAsset(partUuid: string) {
    if (!/^[0-9a-f]{32}$/i.test(partUuid)) return undefined;
    partUuid = partUuid.toLowerCase();
    const source = knownSources.get(partUuid) ?? await readCacheJson<AssetSource>(partUuid, 'schematic-source.json');
    if (!source) return undefined;
    // The source remains local across MCP restarts; never send a known local UUID to the catalogue.
    const refreshed = await loadSchematicAssets(source.rootPath, [source.path]);
    const asset = refreshed.assets.get(partUuid);
    if (!asset) throw new Error('local asset changed; refresh get_project_info or get_schematic');
    return asset;
}
export function assetSymbols(assets: Map<string, SchematicAsset>, ids: Iterable<string>) {
    const result: Record<string, SymbolData> = {};
    for (const id of ids) {
        const asset = assets.get(id);
        if (asset) result[id] = structuredClone(asset.symbol);
    }
    return result;
}
export function pageScope(path: string, rootPath: string) {
    return resolve(path) === resolve(rootPath) ? 'ROOT' : relative(dirname(rootPath), path).replaceAll('\\', '/').replace(/\.kicad_sch$/i, '');
}
