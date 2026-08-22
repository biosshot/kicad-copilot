import { readFile, readdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

export async function findPcbProjectPath(pcbPath: string) {
    const absolute = resolve(pcbPath);
    const directory = dirname(absolute);
    const matching = join(directory, `${basename(absolute, extname(absolute))}.kicad_pro`);
    if (await readFile(matching, 'utf8').then(() => true, () => false)) return matching;
    const candidates = (await readdir(directory, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.kicad_pro'));
    return candidates.length === 1 ? join(directory, candidates[0].name) : undefined;
}
