import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
    atom,
    isSExpressionList,
    listHead,
    parseSExpression,
    printSExpression,
    SExpression,
    token,
} from '../kicad/sexpr/ast';
import { findLists } from '../kicad/sexpr/scan';
import { ConvertedComponent } from './converter';
import { componentCacheDirectory } from './cache';

const LIBRARY_NAME = 'kicad-copilot';

export function projectFootprintId(asset: ConvertedComponent) {
    const footprint = asset.properties.Footprint || '';
    const name = footprint.includes(':') ? footprint.slice(footprint.indexOf(':') + 1) : footprint;
    return name ? `${LIBRARY_NAME}:${asset.product_code}_${name}` : '';
}

async function atomicWrite(path: string, source: string) {
    const current = await readFile(path, 'utf8').catch(() => undefined);
    if (current === source) return;
    await mkdir(dirname(path), { recursive: true });
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    try {
        await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function ensureLibraryTable(directory: string, filename: string, head: string, uri: string) {
    const path = join(directory, filename);
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    const entry = `(lib (name "${LIBRARY_NAME}")(type "KiCad")(uri "${uri}")(options "")(descr "KiCad Copilot project library"))`;
    if (!existing) {
        await atomicWrite(path, `(${head}\n  (version 7)\n  ${entry}\n)\n`);
        return;
    }
    if (new RegExp(`\\(name\\s+"?${LIBRARY_NAME}"?\\)`).test(existing)) return;
    const root = findLists(existing, head)[0];
    if (!root) throw new Error(`invalid ${filename}`);
    const insertion = root.end - 1;
    await atomicWrite(path, `${existing.slice(0, insertion).replace(/\s*$/, '\n')}  ${entry}\n${existing.slice(insertion)}`);
}

function externalSymbol(input: SExpression[]) {
    const symbol = structuredClone(input) as SExpression[];
    const id = atom(symbol[1]) || '';
    symbol[1] = token(id.startsWith(`${LIBRARY_NAME}:`) ? id.slice(LIBRARY_NAME.length + 1) : id, true);
    return symbol;
}

async function writeSymbolLibrary(directory: string, definitions: SExpression[][]) {
    const path = join(directory, `${LIBRARY_NAME}.kicad_sym`);
    const existing = await readFile(path, 'utf8').catch(() => undefined);
    const symbols = new Map<string, SExpression[]>();
    if (existing) {
        const root = parseSExpression(existing);
        for (const item of root) {
            if (isSExpressionList(item) && listHead(item) === 'symbol') {
                const name = atom(item[1]);
                if (name) symbols.set(name, item);
            }
        }
    }
    for (const definition of definitions) {
        const symbol = externalSymbol(definition);
        const name = atom(symbol[1]);
        if (name) symbols.set(name, symbol);
    }
    const root: SExpression[] = [
        token('kicad_symbol_lib'),
        [token('version'), token('20231120')],
        [token('generator'), token('kicad-copilot')],
        ...[...symbols].sort(([left], [right]) => left.localeCompare(right)).map(([, symbol]) => symbol),
    ];
    await atomicWrite(path, `${printSExpression(root)}\n`);
}

async function copyFootprints(directory: string, assets: Iterable<ConvertedComponent>) {
    const footprintDirectory = join(directory, `${LIBRARY_NAME}.pretty`);
    const modelDirectory = join(directory, `${LIBRARY_NAME}.3dshapes`);
    await Promise.all([mkdir(footprintDirectory, { recursive: true }), mkdir(modelDirectory, { recursive: true })]);

    for (const asset of assets) {
        const cacheDirectory = componentCacheDirectory(asset.part_uuid);
        const sourceFootprints = join(cacheDirectory, 'component.pretty');
        const sourceModels = join(cacheDirectory, 'component.3dshapes');
        const modelFiles = await readdir(sourceModels, { withFileTypes: true }).catch(() => []);
        const modelNames = new Map<string, string>();
        for (const entry of modelFiles) {
            if (!entry.isFile()) continue;
            const targetName = `${asset.product_code}_${entry.name}`;
            modelNames.set(entry.name, targetName);
            await copyFile(join(sourceModels, entry.name), join(modelDirectory, targetName));
        }

        const footprintFiles = await readdir(sourceFootprints, { withFileTypes: true }).catch(() => []);
        for (const entry of footprintFiles) {
            if (!entry.isFile() || !entry.name.endsWith('.kicad_mod')) continue;
            const sourcePath = join(sourceFootprints, entry.name);
            let source = await readFile(sourcePath, 'utf8');
            const originalName = basename(entry.name, '.kicad_mod');
            const targetName = `${asset.product_code}_${originalName}`;
            source = source.replace(/\(footprint\s+"[^"]+"/, `(footprint "${targetName}"`);
            for (const [originalModel, targetModel] of modelNames) {
                const escaped = originalModel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                source = source.replace(
                    new RegExp(`\\(model\\s+"[^"]*[\\\\/]${escaped}"`),
                    `(model "\${KIPRJMOD}/${LIBRARY_NAME}.3dshapes/${targetModel}"`,
                );
            }
            await atomicWrite(join(footprintDirectory, `${targetName}.kicad_mod`), source);
        }
    }
}

export async function writeProjectLibraries(
    schematicPath: string,
    definitions: SExpression[][],
    assets: Iterable<ConvertedComponent>,
) {
    const directory = dirname(resolve(schematicPath));
    await Promise.all([
        writeSymbolLibrary(directory, definitions),
        copyFootprints(directory, assets),
        ensureLibraryTable(directory, 'sym-lib-table', 'sym_lib_table', '${KIPRJMOD}/kicad-copilot.kicad_sym'),
        ensureLibraryTable(directory, 'fp-lib-table', 'fp_lib_table', '${KIPRJMOD}/kicad-copilot.pretty'),
    ]);
}
