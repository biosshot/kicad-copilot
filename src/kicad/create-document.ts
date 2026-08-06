import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, parse, relative, resolve } from 'node:path';
import { getSupportedKicadCli } from './cli';
import { findLists } from './sexpr/scan';
import { projectTemplate, schematicTemplate, sheetSymbol } from './schematic-template';
import { pcbTemplate } from './pcb-template';
import { temporarySiblingPath, validateSchematicSource } from './schematic-validation';

export type CreateDocumentInput = {
    doc_type: 'project';
    path: string;
} | {
    doc_type: 'schematic';
    path: string;
} | {
    doc_type: 'schematic_page';
    path: string;
    parent_path: string;
} | {
    doc_type: 'pcb';
    path: string;
};

function requireExtension(path: string, extension: string) {
    if (extname(path).toLowerCase() !== extension) {
        throw new Error(`expected ${extension} path`);
    }
}

async function exists(path: string) {
    return access(path).then(() => true, () => false);
}

function hash(source: string) {
    return createHash('sha256').update(source).digest('hex');
}

async function writeNew(path: string, source: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, source, { encoding: 'utf8', flag: 'wx' }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(`file already exists: ${path}`);
        }
        throw error;
    });
}

function documentVersion(source: string) {
    const match = source.match(/\(version\s+(\d+)\)/);
    if (!match) throw new Error('invalid KiCad schematic: version not found');
    return match[1];
}

function documentUuid(source: string) {
    const match = source.match(/\(uuid\s+"([^"]+)"\)/);
    if (!match) throw new Error('invalid KiCad schematic: root uuid not found');
    return match[1];
}

function insertionOffset(source: string) {
    const sheetInstances = findLists(source, 'sheet_instances')[0];
    if (sheetInstances) return sheetInstances.start;
    const rootEmbeddedFonts = findLists(source, 'embedded_fonts').at(-1);
    if (rootEmbeddedFonts) return rootEmbeddedFonts.start;

    const root = findLists(source, 'kicad_sch')[0];
    if (!root) throw new Error('invalid KiCad schematic');
    return root.end - 1;
}

function insertSheet(source: string, symbol: string) {
    const offset = insertionOffset(source);
    return `${source.slice(0, offset).replace(/\s*$/, '\n')}${symbol}\n${source.slice(offset)}`;
}

function sheetPosition(source: string) {
    const index = findLists(source, 'sheet').length;
    return {
        x: 25.4 + (index % 3) * 63.5,
        y: 25.4 + Math.floor(index / 3) * 38.1,
    };
}

async function projectContext(parentPath: string, parentSource: string) {
    let directory = dirname(parentPath);
    let projectFiles: string[] = [];

    while (true) {
        projectFiles = (await readdir(directory, { withFileTypes: true }).catch(() => []))
            .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.kicad_pro')
            .map((entry) => resolve(directory, entry.name))
            .sort();
        if (projectFiles.length || directory === parse(directory).root) break;
        directory = dirname(directory);
    }

    const matching = projectFiles.find((path) =>
        basename(path, '.kicad_pro') === basename(parentPath, '.kicad_sch'));
    const projectPath = matching || projectFiles[0];

    if (!projectPath) {
        return {
            name: basename(parentPath, '.kicad_sch'),
            rootUuid: documentUuid(parentSource),
        };
    }

    const rootPath = resolve(dirname(projectPath), `${basename(projectPath, '.kicad_pro')}.kicad_sch`);
    const rootSource = await readFile(rootPath, 'utf8').catch(() => parentSource);
    return {
        name: basename(projectPath, '.kicad_pro'),
        rootUuid: documentUuid(rootSource),
    };
}

async function createProject(path: string) {
    requireExtension(path, '.kicad_pro');
    const cli = await getSupportedKicadCli();
    const major = cli.major as 9 | 10;
    const projectPath = resolve(path);
    const schematicPath = resolve(dirname(projectPath), `${basename(projectPath, '.kicad_pro')}.kicad_sch`);
    if (await exists(projectPath)) throw new Error(`file already exists: ${projectPath}`);
    if (await exists(schematicPath)) throw new Error(`file already exists: ${schematicPath}`);

    await mkdir(dirname(projectPath), { recursive: true });
    const rootUuid = randomUUID();
    const schematic = schematicTemplate({ uuid: rootUuid, major });
    await validateSchematicSource(cli, dirname(schematicPath), schematic);

    await writeNew(schematicPath, schematic);
    try {
        await writeNew(projectPath, projectTemplate(projectPath, rootUuid));
    } catch (error) {
        await rm(schematicPath, { force: true });
        throw error;
    }
}

async function createSchematic(path: string) {
    requireExtension(path, '.kicad_sch');
    const cli = await getSupportedKicadCli();
    const major = cli.major as 9 | 10;
    const schematicPath = resolve(path);
    if (await exists(schematicPath)) throw new Error(`file already exists: ${schematicPath}`);

    await mkdir(dirname(schematicPath), { recursive: true });
    const source = schematicTemplate({ uuid: randomUUID(), major });
    await validateSchematicSource(cli, dirname(schematicPath), source);
    await writeNew(schematicPath, source);
}

async function createPcb(path: string) {
    requireExtension(path, '.kicad_pcb');
    const cli = await getSupportedKicadCli();
    const target = resolve(path);
    if (await exists(target)) throw new Error(`file already exists: ${target}`);
    await writeNew(target, pcbTemplate(cli.major as 9 | 10));
}

async function createSchematicPage(path: string, parentPathInput: string) {
    requireExtension(path, '.kicad_sch');
    requireExtension(parentPathInput, '.kicad_sch');
    const cli = await getSupportedKicadCli();
    const childPath = resolve(path);
    const parentPath = resolve(parentPathInput);
    if (await exists(childPath)) throw new Error(`file already exists: ${childPath}`);

    const parentSource = await readFile(parentPath, 'utf8').catch(() => {
        throw new Error(`path not found: ${parentPath}`);
    });
    const version = documentVersion(parentSource);
    const paperForm = findLists(parentSource, 'paper')[0]?.text || '(paper "A4")';
    const childSource = schematicTemplate({
        uuid: randomUUID(),
        version,
        paperForm,
        root: false,
    });
    await mkdir(dirname(childPath), { recursive: true });
    await validateSchematicSource(cli, dirname(childPath), childSource);

    const context = await projectContext(parentPath, parentSource);
    const position = sheetPosition(parentSource);
    const sheetName = basename(childPath, '.kicad_sch');
    const sheetFile = relative(dirname(parentPath), childPath).replace(/\\/g, '/');
    const symbol = sheetSymbol({
        name: sheetName,
        sheetFile,
        uuid: randomUUID(),
        projectName: context.name,
        rootUuid: context.rootUuid,
        page: findLists(parentSource, 'sheet').length + 2,
        ...position,
    });
    const parentCandidate = insertSheet(parentSource, symbol);

    await writeNew(childPath, childSource);
    const temporaryParent = temporarySiblingPath(parentPath);
    try {
        await validateSchematicSource(cli, dirname(parentPath), parentCandidate);
        const currentSource = await readFile(parentPath, 'utf8');
        if (hash(currentSource) !== hash(parentSource)) {
            throw new Error('file changed during operation');
        }

        await writeFile(temporaryParent, parentCandidate, { encoding: 'utf8', flag: 'wx' });
        await rename(temporaryParent, parentPath);
    } catch (error) {
        await Promise.all([
            rm(childPath, { force: true }),
            rm(temporaryParent, { force: true }),
        ]);
        throw error;
    }
}

export async function createDocument(doc: CreateDocumentInput) {
    if (doc.doc_type === 'project') await createProject(doc.path);
    else if (doc.doc_type === 'schematic') await createSchematic(doc.path);
    else if (doc.doc_type === 'schematic_page') await createSchematicPage(doc.path, doc.parent_path);
    else await createPcb(doc.path);
    return 'ok';
}
