import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { CACHE_DIR } from '../utils/dirs';

type Checkpoint = {
    id: string;
    created_at: string;
    description: string;
};

type CheckpointMetadata = {
    path: string;
    checkpoints: Checkpoint[];
};

function normalizedPath(path: string) {
    const absolute = resolve(path);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function checkpointDirectory(path: string) {
    const key = createHash('sha256').update(normalizedPath(path)).digest('hex');
    return join(CACHE_DIR, 'checkpoints', key);
}

function metadataPath(path: string) {
    return join(checkpointDirectory(path), 'metadata.json');
}

function snapshotPath(path: string, id: string) {
    return join(checkpointDirectory(path), `${id}.snapshot`);
}

async function readMetadata(path: string): Promise<CheckpointMetadata> {
    const source = await readFile(metadataPath(path), 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!source) return { path: resolve(path), checkpoints: [] };

    try {
        const metadata = JSON.parse(source) as CheckpointMetadata;
        if (!Array.isArray(metadata.checkpoints)) throw new Error('invalid checkpoints');
        return metadata;
    } catch {
        throw new Error('invalid checkpoint metadata');
    }
}

async function writeMetadata(path: string, metadata: CheckpointMetadata) {
    const directory = checkpointDirectory(path);
    await mkdir(directory, { recursive: true });
    const target = metadataPath(path);
    const temporary = join(directory, `.metadata-${randomUUID()}.json`);

    try {
        await writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function saveCheckpointBytes(path: string, bytes: Buffer, description: string) {
    const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const checkpoint = {
        id,
        created_at: new Date().toISOString(),
        description,
    } satisfies Checkpoint;
    const metadata = await readMetadata(path);
    const directory = checkpointDirectory(path);
    await mkdir(directory, { recursive: true });
    await writeFile(snapshotPath(path, id), bytes, { flag: 'wx' });

    try {
        await writeMetadata(path, {
            path: resolve(path),
            checkpoints: [checkpoint, ...metadata.checkpoints],
        });
    } catch (error) {
        await rm(snapshotPath(path, id), { force: true });
        throw error;
    }

    return id;
}

export async function listCheckpoints(path: string) {
    const metadata = await readMetadata(resolve(path));
    return metadata.checkpoints.map(({ id, created_at, description }) => ({
        id,
        created_at,
        description,
    }));
}

export async function saveCheckpoint(path: string, description = 'Manual checkpoint') {
    const target = resolve(path);
    const bytes = await readFile(target).catch(() => {
        throw new Error(`path not found: ${target}`);
    });
    const resolvedDescription = description.trim() || 'Manual checkpoint';
    if (resolvedDescription.length > 100) throw new Error('checkpoint description exceeds 100 characters');
    return saveCheckpointBytes(target, bytes, resolvedDescription);
}

export async function restoreCheckpoint(path: string, id: string) {
    const target = resolve(path);
    const metadata = await readMetadata(target);
    if (!metadata.checkpoints.some((checkpoint) => checkpoint.id === id)) {
        throw new Error(`checkpoint not found: ${id}`);
    }

    const [currentBytes, checkpointBytes] = await Promise.all([
        readFile(target).catch(() => {
            throw new Error(`path not found: ${target}`);
        }),
        readFile(snapshotPath(target, id)).catch(() => {
            throw new Error(`checkpoint data not found: ${id}`);
        }),
    ]);
    await saveCheckpointBytes(target, currentBytes, 'Before restore_checkpoint');

    const currentAfterCheckpoint = await readFile(target);
    if (!currentAfterCheckpoint.equals(currentBytes)) throw new Error('file changed during operation');

    const temporary = join(
        dirname(target),
        `.${basename(target)}.${randomUUID()}.restore`,
    );
    try {
        await writeFile(temporary, checkpointBytes, { flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }

    return 'ok';
}
