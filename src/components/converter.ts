import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    atom,
    isSExpressionList,
    listHead,
    parseSExpression,
    SExpression,
} from '../kicad/sexpr/ast';
import { runProcessChecked } from '../utils/process';
import { componentCacheDirectory, readCacheJson, writeCacheJson } from './cache';
import { getEasyEda2Kicad } from './easyeda2kicad';
import { resolvePartUuid } from './resolver';

type ConversionMetadata = {
    part_uuid: string;
    product_code: string;
    symbol_file: string;
    symbol_name: string;
};

export type ConvertedComponent = ConversionMetadata & {
    symbol: SExpression[];
    properties: Record<string, string>;
};

const inflight = new Map<string, Promise<ConvertedComponent>>();

function symbolProperties(symbol: SExpression[]) {
    return Object.fromEntries(symbol
        .filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === 'property')
        .map((item) => [atom(item[1]) || '', atom(item[2]) || '']));
}

function findConvertedSymbol(source: string, productCode: string) {
    const root = parseSExpression(source);
    const symbols = root.filter(
        (item): item is SExpression[] => isSExpressionList(item) && listHead(item) === 'symbol',
    );
    const symbol = symbols.find((item) => atom(item[1])?.includes(productCode)) || symbols[0];
    const symbolName = atom(symbol?.[1]);
    if (!symbol || !symbolName) throw new Error('converted KiCad symbol not found');
    return { symbol, symbolName };
}

async function loadCached(partUuid: string) {
    const metadata = await readCacheJson<ConversionMetadata>(partUuid, 'conversion.json');
    if (!metadata) return undefined;
    const symbolPath = join(componentCacheDirectory(partUuid), metadata.symbol_file);
    if (!(await access(symbolPath).then(() => true, () => false))) return undefined;

    const converted = findConvertedSymbol(await readFile(symbolPath, 'utf8'), metadata.product_code);
    return {
        ...metadata,
        symbol: converted.symbol,
        properties: symbolProperties(converted.symbol),
    } satisfies ConvertedComponent;
}

async function convert(partUuid: string) {
    const cached = await loadCached(partUuid);
    if (cached) return cached;

    const device = await resolvePartUuid(partUuid);
    const converter = await getEasyEda2Kicad();
    const directory = componentCacheDirectory(partUuid);
    const symbolFile = 'component.kicad_sym';
    const symbolPath = join(directory, symbolFile);
    await mkdir(directory, { recursive: true });

    await runProcessChecked(converter.command, [
        ...converter.prefixArgs,
        '--lcsc_id',
        device.product_code,
        '--full',
        '--output',
        symbolPath,
        '--overwrite',
    ], { cwd: directory, timeoutMs: 300_000 });

    const converted = findConvertedSymbol(await readFile(symbolPath, 'utf8'), device.product_code);
    const metadata = {
        part_uuid: partUuid,
        product_code: device.product_code,
        symbol_file: symbolFile,
        symbol_name: converted.symbolName,
    } satisfies ConversionMetadata;
    await writeCacheJson(partUuid, 'conversion.json', metadata);

    return {
        ...metadata,
        symbol: converted.symbol,
        properties: symbolProperties(converted.symbol),
    } satisfies ConvertedComponent;
}

export function convertComponent(partUuid: string) {
    let pending = inflight.get(partUuid);
    if (!pending) {
        pending = convert(partUuid).finally(() => {
            inflight.delete(partUuid);
        });
        inflight.set(partUuid, pending);
    }
    return pending;
}
