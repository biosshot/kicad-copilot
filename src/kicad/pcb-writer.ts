import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { listHead, parseSExpression, printSExpression, SExpression } from './sexpr/ast';

export function sourceHash(source: string | Buffer) {
    return createHash('sha256').update(source).digest('hex');
}

export async function fileHash(path: string) {
    return sourceHash(await readFile(resolve(path)));
}

export function parsePcbSource(source: string) {
    const root = parseSExpression(source);
    if (!Array.isArray(root) || listHead(root) !== 'kicad_pcb') throw new Error('invalid KiCad PCB');
    return root;
}

export function serializePcb(root: SExpression[]) {
    return `${printSExpression(root)}\n`;
}

export async function atomicWritePcb(path: string, expectedSource: string, root: SExpression[]) {
    const target = resolve(path);
    const current = await readFile(target, 'utf8');
    if (sourceHash(current) !== sourceHash(expectedSource)) throw new Error('file changed during operation');
    const candidate = serializePcb(root);
    parsePcbSource(candidate);
    const temporary = `${dirname(target)}\\.${basename(target)}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
        await writeFile(temporary, candidate, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}
