import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { getSupportedKicadCli } from './cli';
import { temporarySiblingPath, validateSchematicSource } from './schematic-validation';

export type SourceEdit = {
    start: number;
    end: number;
    text: string;
};

const transaction = new AsyncLocalStorage<Map<string, { before: string; after: string }>>();
export async function withSchematicChanges<T>(action: () => Promise<T>): Promise<T> {
    if (transaction.getStore()) return action();
    const changes = new Map<string, { before: string; after: string }>();
    return transaction.run(changes, async () => {
        try { return await action(); }
        catch (error) {
            const failures: unknown[] = [];
            for (const [path, change] of [...changes].reverse()) {
                try {
                    if (await readFile(path, 'utf8') !== change.after) throw new Error(`file changed externally; rollback left it intact: ${path}`);
                    const temporary = temporarySiblingPath(path);
                    try {
                        await writeFile(temporary, change.before, { flag: 'wx' });
                        await rename(temporary, path);
                    } finally { await rm(temporary, { force: true }); }
                } catch (rollbackError) { failures.push(rollbackError); }
            }
            if (failures.length) throw new AggregateError([error, ...failures], 'schematic operation failed; rollback incomplete');
            throw error;
        }
    });
}

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
        const changes = transaction.getStore();
        if (changes) changes.set(target, { before: changes.get(target)?.before ?? original, after: candidate });
    } finally {
        await rm(temporary, { force: true });
    }

    return 'ok';
}
