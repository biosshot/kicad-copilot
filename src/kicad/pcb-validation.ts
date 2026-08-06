import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { getSupportedKicadCli } from './cli';
import { parsePcbSource, serializePcb } from './pcb-writer';
import { SExpression } from './sexpr/ast';
import { runProcessChecked } from '../utils/process';

export async function normalizePcbCandidate(
    targetPath: string,
    root: SExpression[],
    refillZones = false,
) {
    const id = randomUUID();
    const temporary = join(dirname(targetPath), `.${basename(targetPath)}.${id}.kicad_pcb`);
    const report = join(dirname(targetPath), `.${basename(targetPath)}.${id}.drc.json`);
    const cli = await getSupportedKicadCli();
    try {
        await writeFile(temporary, serializePcb(root), { encoding: 'utf8', flag: 'wx' });
        if (refillZones) {
            await runProcessChecked(cli.path, [
                'pcb', 'drc', '--refill-zones', '--save-board',
                '--format', 'json', '--output', report, temporary,
            ], { timeoutMs: 120_000 });
        }
        await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', temporary], { timeoutMs: 60_000 });
        return parsePcbSource(await readFile(temporary, 'utf8'));
    } finally {
        await Promise.all([
            rm(temporary, { force: true }),
            rm(report, { force: true }),
        ]);
    }
}

export async function refillAndInspectPcbCandidate(targetPath: string, root: SExpression[]) {
    const id = randomUUID();
    const temporary = join(dirname(targetPath), `.${basename(targetPath)}.${id}.kicad_pcb`);
    const report = join(dirname(targetPath), `.${basename(targetPath)}.${id}.drc.json`);
    const cli = await getSupportedKicadCli();
    try {
        await writeFile(temporary, serializePcb(root), { encoding: 'utf8', flag: 'wx' });
        await runProcessChecked(cli.path, [
            'pcb', 'drc', '--refill-zones', '--save-board', '--severity-all',
            '--format', 'json', '--output', report, temporary,
        ], { timeoutMs: 120_000 });
        await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', temporary], { timeoutMs: 60_000 });
        const [boardSource, reportSource] = await Promise.all([
            readFile(temporary, 'utf8'),
            readFile(report, 'utf8').catch(() => '{}'),
        ]);
        let reportJson: unknown = {};
        try {
            reportJson = JSON.parse(reportSource);
        } catch {
            console.error('KiCad DRC returned invalid JSON');
        }
        return { root: parsePcbSource(boardSource), report: reportJson };
    } finally {
        await Promise.all([
            rm(temporary, { force: true }),
            rm(report, { force: true }),
        ]);
    }
}
