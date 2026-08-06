import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { atom, findChild, isSExpressionList, listHead, parseSExpression, SExpression, token } from './sexpr/ast';
import { CACHE_DIR } from '../utils/dirs';
import { getSupportedKicadCli } from './cli';
import { runProcessChecked } from '../utils/process';

type LibraryEntry = { name: string; uri: string };
const upgradedLibraries = new Map<string, Promise<string>>();

async function exists(path: string) {
    return access(path).then(() => true, () => false);
}

function entries(source: string) {
    const root = parseSExpression(source);
    const result: LibraryEntry[] = [];
    for (const child of root) {
        if (!isSExpressionList(child) || listHead(child) !== 'lib') continue;
        const name = atom(findChild(child, 'name')?.[1]);
        const uri = atom(findChild(child, 'uri')?.[1]);
        if (name && uri) result.push({ name, uri });
    }
    return result;
}

function expandUri(uri: string, projectDirectory: string) {
    const variables: Record<string, string | undefined> = {
        KIPRJMOD: projectDirectory,
        ...process.env,
    };
    return uri
        .replace(/\$\{([^}]+)\}/g, (_, name: string) => variables[name] || '')
        .replace(/^~(?=[\\/])/, homedir());
}

async function tableEntries(path: string) {
    const source = await readFile(path, 'utf8').catch(() => undefined);
    return source ? entries(source) : [];
}

function globalTableCandidates() {
    if (process.platform === 'win32') {
        const appData = process.env.APPDATA || join(homedir(), 'AppData', 'Roaming');
        return [join(appData, 'kicad', '10.0', 'fp-lib-table'), join(appData, 'kicad', '9.0', 'fp-lib-table')];
    }
    return [join(homedir(), '.config', 'kicad', '10.0', 'fp-lib-table'), join(homedir(), '.config', 'kicad', '9.0', 'fp-lib-table')];
}

function standardLibraryDirectories(library: string) {
    const configured = ['KICAD10_FOOTPRINT_DIR', 'KICAD9_FOOTPRINT_DIR']
        .flatMap((name) => process.env[name] ? [process.env[name]!] : []);
    if (process.platform === 'win32') {
        const local = process.env.LOCALAPPDATA || '';
        configured.push(
            join(local, 'Programs', 'KiCad', '10.0', 'share', 'kicad', 'footprints'),
            join(local, 'Programs', 'KiCad', '9.0', 'share', 'kicad', 'footprints'),
        );
    }
    return configured.map((directory) => join(directory, `${library}.pretty`));
}

function splitIdentifier(identifier: string) {
    const separator = identifier.indexOf(':');
    if (separator <= 0 || separator === identifier.length - 1) {
        throw new Error(`invalid footprint identifier: ${identifier}`);
    }
    return { library: identifier.slice(0, separator), name: identifier.slice(separator + 1) };
}

function upgradedLibraryPath(sourceDirectory: string, modified: number) {
    const key = createHash('sha256').update(`${resolve(sourceDirectory)}\0${modified}`).digest('hex').slice(0, 20);
    return join(CACHE_DIR, 'footprint-upgrades', `${key}.pretty`);
}

async function upgradeLegacyLibrary(sourceDirectory: string) {
    const normalized = resolve(sourceDirectory);
    const modified = (await stat(normalized)).mtimeMs;
    const cacheKey = `${normalized}\0${modified}`;
    const cached = upgradedLibraries.get(cacheKey);
    if (cached) return cached;
    const promise = (async () => {
        const output = upgradedLibraryPath(normalized, modified);
        const marker = join(output, '.complete');
        if (await exists(marker)) return output;
        await rm(output, { recursive: true, force: true });
        await mkdir(dirname(output), { recursive: true });
        const cli = await getSupportedKicadCli();
        await runProcessChecked(cli.path, ['fp', 'upgrade', '--force', '--output', output, normalized], {
            timeoutMs: 120_000,
        });
        await mkdir(output, { recursive: true });
        await writeFile(marker, 'ok\n');
        return output;
    })();
    upgradedLibraries.set(cacheKey, promise);
    return promise;
}

export async function resolveFootprintDefinition(identifier: string, projectFile: string) {
    const { library, name } = splitIdentifier(identifier);
    const projectDirectory = dirname(resolve(projectFile));
    const projectEntries = await tableEntries(join(projectDirectory, 'fp-lib-table'));
    const globalEntries = (await Promise.all(globalTableCandidates().map(tableEntries))).flat();
    const matched = [...projectEntries, ...globalEntries].find((entry) => entry.name === library);
    const directories = [
        ...(matched ? [resolve(projectDirectory, expandUri(matched.uri, projectDirectory))] : []),
        ...(library === 'kicad-copilot' ? [join(projectDirectory, 'kicad-copilot.pretty')] : []),
        ...standardLibraryDirectories(library),
    ];

    for (const directory of [...new Set(directories)]) {
        const path = join(directory, `${name}.kicad_mod`);
        if (!(await exists(path))) continue;
        const source = await readFile(path, 'utf8');
        let root = parseSExpression(source) as SExpression[];
        if (listHead(root) === 'module') {
            const upgradedDirectory = await upgradeLegacyLibrary(directory);
            root = parseSExpression(await readFile(join(upgradedDirectory, basename(path)), 'utf8')) as SExpression[];
        }
        if (!['footprint', 'module'].includes(listHead(root) || '')) throw new Error(`invalid footprint file: ${path}`);
        root[0] = token('footprint');
        return { path, root };
    }

    throw new Error(`footprint not found: ${identifier}`);
}
