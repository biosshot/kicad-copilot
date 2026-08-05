import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getSupportedKicadCli } from '../kicad/cli';
import { atom, isSExpressionList, listHead, parseSExpression, SExpression } from '../kicad/sexpr/ast';

function powerLibraryCandidates(cliPath: string) {
    const installRoot = resolve(dirname(cliPath), '..');
    return [
        resolve(installRoot, 'share', 'kicad', 'symbols', 'power.kicad_sym'),
        '/usr/share/kicad/symbols/power.kicad_sym',
        '/usr/local/share/kicad/symbols/power.kicad_sym',
    ];
}

let powerLibrary: Promise<SExpression[]> | undefined;

async function loadPowerLibrary() {
    const cli = await getSupportedKicadCli();
    for (const path of powerLibraryCandidates(cli.path)) {
        if (!(await access(path).then(() => true, () => false))) continue;
        return parseSExpression(await readFile(path, 'utf8'));
    }
    throw new Error('KiCad power symbol library not found');
}

export async function getPowerSymbol(name: string) {
    powerLibrary ??= loadPowerLibrary();
    const root = await powerLibrary;
    const symbol = root.find((item): item is SExpression[] =>
        isSExpressionList(item)
        && listHead(item) === 'symbol'
        && atom(item[1]) === name);
    if (!symbol) throw new Error(`KiCad power symbol not found: ${name}`);
    return symbol;
}
