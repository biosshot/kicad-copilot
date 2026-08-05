import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { findLists, findQuotedProperty } from './sexpr/scan';

const KICAD_EXTENSIONS = new Set([
    '.kicad_pro',
    '.kicad_sch',
    '.kicad_pcb',
    '.kicad_sym',
    '.kicad_mod',
    '.kicad_dru',
    '.kicad_prl',
]);
const KICAD_FILENAMES = new Set(['sym-lib-table', 'fp-lib-table']);

type KiCadFileNode = {
    name: string;
    path: string;
};

export type SchematicTreeNode = KiCadFileNode & {
    sheets: SchematicTreeNode[];
};

export type KiCadProjectTree = {
    name: string;
    path: string;
    schematics: SchematicTreeNode[];
    pcbs: KiCadFileNode[];
    libraries: KiCadFileNode[];
    other_files: KiCadFileNode[];
};

type SheetReference = {
    name: string;
    path: string;
};

function isKiCadFile(path: string) {
    return KICAD_EXTENSIONS.has(extname(path).toLowerCase()) || KICAD_FILENAMES.has(basename(path));
}

async function scanKiCadFiles(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true });
    const nested = await Promise.all(entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return scanKiCadFiles(path);
        return entry.isFile() && isKiCadFile(path) ? [path] : [];
    }));
    return nested.flat();
}

function relativePath(projectDirectory: string, path: string) {
    return relative(projectDirectory, path).replace(/\\/g, '/');
}

function fileNode(projectDirectory: string, path: string): KiCadFileNode {
    return {
        name: basename(path),
        path: relativePath(projectDirectory, path),
    };
}

function sheetReferences(source: string, parentPath: string, projectDirectory: string) {
    return findLists(source, 'sheet').flatMap(({ text }) => {
        const sheetFile = findQuotedProperty(text, 'Sheetfile');
        if (!sheetFile) return [];

        const expanded = sheetFile.replace(/^\$\{KIPRJMOD\}[\\/]/, `${projectDirectory}/`);
        return [{
            name: findQuotedProperty(text, 'Sheetname') || basename(sheetFile, '.kicad_sch'),
            path: resolve(dirname(parentPath), expanded),
        } satisfies SheetReference];
    });
}

async function collectSheetReferences(initialPaths: string[], projectDirectory: string) {
    const references = new Map<string, SheetReference[]>();
    const queue = [...initialPaths];

    while (queue.length) {
        const path = queue.shift()!;
        if (references.has(path)) continue;

        const source = await readFile(path, 'utf8').catch(() => undefined);
        if (source === undefined) {
            references.set(path, []);
            continue;
        }

        const children = sheetReferences(source, path, projectDirectory);
        references.set(path, children);
        for (const child of children) {
            if (!references.has(child.path)) queue.push(child.path);
        }
    }

    return references;
}

function buildSchematicNode(
    projectDirectory: string,
    path: string,
    references: Map<string, SheetReference[]>,
    stack: Set<string>,
    displayName?: string,
): SchematicTreeNode {
    const nextStack = new Set(stack).add(path);
    const sheets = (references.get(path) || []).map((child) => ({
        child,
        cyclic: nextStack.has(child.path),
    })).map(({ child, cyclic }) => cyclic
        ? {
            name: child.name,
            path: relativePath(projectDirectory, child.path),
            sheets: [],
        }
        : buildSchematicNode(projectDirectory, child.path, references, nextStack, child.name));

    return {
        name: displayName || basename(path),
        path: relativePath(projectDirectory, path),
        sheets,
    };
}

function sortPaths(paths: string[]) {
    return [...paths].sort((left, right) => left.localeCompare(right));
}

async function buildProjectTree(projectPath: string): Promise<KiCadProjectTree> {
    const projectDirectory = dirname(projectPath);
    const files = await scanKiCadFiles(projectDirectory);
    const schematicPaths = sortPaths(files.filter((path) => extname(path).toLowerCase() === '.kicad_sch'));
    const references = await collectSheetReferences(schematicPaths, projectDirectory);
    const referencedPaths = new Set([...references.values()].flat().map(({ path }) => path));
    let rootPaths = schematicPaths.filter((path) => !referencedPaths.has(path));
    if (!rootPaths.length) rootPaths = schematicPaths;

    const projectBasename = basename(projectPath, '.kicad_pro');
    rootPaths.sort((left, right) => {
        const leftRoot = basename(left, '.kicad_sch') === projectBasename;
        const rightRoot = basename(right, '.kicad_sch') === projectBasename;
        if (leftRoot !== rightRoot) return leftRoot ? -1 : 1;
        return left.localeCompare(right);
    });

    const byExtension = (extension: string) => sortPaths(
        files.filter((path) => extname(path).toLowerCase() === extension),
    ).map((path) => fileNode(projectDirectory, path));

    const libraryPaths = files.filter((path) =>
        ['.kicad_sym', '.kicad_mod'].includes(extname(path).toLowerCase())
        || KICAD_FILENAMES.has(basename(path)));
    const otherPaths = files.filter((path) =>
        ['.kicad_dru', '.kicad_prl'].includes(extname(path).toLowerCase()));

    return {
        name: projectBasename,
        path: basename(projectPath),
        schematics: rootPaths.map((path) => buildSchematicNode(
            projectDirectory,
            path,
            references,
            new Set(),
        )),
        pcbs: byExtension('.kicad_pcb'),
        libraries: sortPaths(libraryPaths).map((path) => fileNode(projectDirectory, path)),
        other_files: sortPaths(otherPaths).map((path) => fileNode(projectDirectory, path)),
    };
}

export async function getProjectInfo(inputPath: string) {
    const absolutePath = resolve(inputPath);
    const inputStat = await stat(absolutePath).catch(() => undefined);
    if (!inputStat) throw new Error(`path not found: ${absolutePath}`);

    const searchDirectory = inputStat.isDirectory() ? absolutePath : dirname(absolutePath);
    const projectPaths = inputStat.isFile() && extname(absolutePath).toLowerCase() === '.kicad_pro'
        ? [absolutePath]
        : (await scanKiCadFiles(searchDirectory)).filter(
            (path) => extname(path).toLowerCase() === '.kicad_pro',
        );

    if (!projectPaths.length) throw new Error('KiCad project not found');

    const projects = await Promise.all(sortPaths(projectPaths).map(buildProjectTree));
    return { projects };
}
