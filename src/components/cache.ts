import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../utils/dirs';

export function validatePartUuid(partUuid: string) {
    if (!/^[a-f0-9]{32}$/i.test(partUuid)) throw new Error(`invalid part_uuid: ${partUuid}`);
    return partUuid.toLowerCase();
}

export function componentCacheDirectory(partUuid: string) {
    return join(CACHE_DIR, 'components', validatePartUuid(partUuid));
}

export async function readCacheJson<T>(partUuid: string, filename: string) {
    const path = join(componentCacheDirectory(partUuid), filename);
    const source = await readFile(path, 'utf8').catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    });
    if (!source) return undefined;

    try {
        return JSON.parse(source) as T;
    } catch {
        return undefined;
    }
}

export async function writeCacheJson(partUuid: string, filename: string, value: unknown) {
    const directory = componentCacheDirectory(partUuid);
    await mkdir(directory, { recursive: true });
    const target = join(directory, filename);
    const temporary = join(directory, `.${filename}.${randomUUID()}.tmp`);

    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}
