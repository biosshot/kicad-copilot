import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { KicadCli } from './cli';
import { runProcessChecked } from '../utils/process';

export async function validateSchematicSource(
    cli: KicadCli,
    targetDirectory: string,
    source: string,
) {
    const token = randomUUID();
    const schematicPath = join(targetDirectory, `.${token}.kicad_sch`);
    const netlistPath = join(targetDirectory, `.${token}.net.xml`);

    try {
        await writeFile(schematicPath, source, { encoding: 'utf8', flag: 'wx' });
        await runProcessChecked(cli.path, [
            'sch',
            'export',
            'netlist',
            '--format',
            'kicadxml',
            '--output',
            netlistPath,
            schematicPath,
        ], { timeoutMs: 60_000 });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`invalid KiCad schematic: ${message}`);
    } finally {
        await Promise.all([
            rm(schematicPath, { force: true }),
            rm(netlistPath, { force: true }),
        ]);
    }
}

export function temporarySiblingPath(targetPath: string) {
    return join(dirname(targetPath), `.${basename(targetPath)}.${randomUUID()}.tmp`);
}
