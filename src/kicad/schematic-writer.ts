import { createHash } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getSupportedKicadCli } from './cli';
import { temporarySiblingPath, validateSchematicSource } from './schematic-validation';

export type SourceEdit = {
    start: number;
    end: number;
    text: string;
};

function sourceHash(source: string) {
    return createHash('sha256').update(source).digest('hex');
}

export function applySourceEdits(source: string, edits: SourceEdit[]) {
    const ordered = [...edits].sort((left, right) => right.start - left.start);
    let previousStart = source.length;
    let previousEdit: SourceEdit | undefined;
    let output = source;

    for (const edit of ordered) {
        if (edit.start < 0 || edit.end < edit.start || edit.end > source.length) {
            throw new Error('invalid schematic source edit');
        }
        if (edit.end > previousStart) {
            throw new Error(
                `overlapping schematic source edits: ${edit.start}-${edit.end} overlaps `
                + `${previousEdit?.start}-${previousEdit?.end}`,
            );
        }
        output = `${output.slice(0, edit.start)}${edit.text}${output.slice(edit.end)}`;
        previousStart = edit.start;
        previousEdit = edit;
    }

    return output;
}

export async function mutateSchematic(
    path: string,
    transform: (source: string) => string | Promise<string>,
) {
    const target = resolve(path);
    const original = await readFile(target, 'utf8').catch(() => {
        throw new Error(`path not found: ${target}`);
    });
    const candidate = await transform(original);
    if (candidate === original) return 'unchanged';

    const cli = await getSupportedKicadCli();
    await validateSchematicSource(cli, dirname(target), candidate);

    const current = await readFile(target, 'utf8');
    if (sourceHash(current) !== sourceHash(original)) throw new Error('file changed during operation');

    const temporary = temporarySiblingPath(target);
    try {
        await writeFile(temporary, candidate, { encoding: 'utf8', flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }

    return 'ok';
}
