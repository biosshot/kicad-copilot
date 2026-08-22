import { access, copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { getSupportedKicadCli } from './cli';
import { parsePcbSource, serializePcb } from './pcb-writer';
import { SExpression } from './sexpr/ast';
import { runProcessChecked } from '../utils/process';
import { findPcbProjectPath } from '../pcb/project-path';

async function prepareCandidate(targetPath: string, root: SExpression[]) {
    const targetDirectory = dirname(targetPath);
    const targetBasename = basename(targetPath, extname(targetPath));
    const directory = await mkdtemp(join(targetDirectory, `.${targetBasename}.candidate-`));
    const temporary = join(directory, `${targetBasename}.kicad_pcb`);
    const report = join(directory, `${targetBasename}.drc.json`);
    try {
        await writeFile(temporary, serializePcb(root), { encoding: 'utf8', flag: 'wx' });
        const projectPath = await findPcbProjectPath(targetPath);
        if (projectPath) {
            await copyFile(projectPath, join(directory, `${targetBasename}.kicad_pro`));
            const customRules = projectPath.replace(/\.kicad_pro$/i, '.kicad_dru');
            if (await access(customRules).then(() => true, () => false)) {
                await copyFile(customRules, join(directory, `${targetBasename}.kicad_dru`));
            }
        }
        return { directory, temporary, report };
    } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
    }
}

export async function normalizePcbCandidate(
    targetPath: string,
    root: SExpression[],
    refillZones = false,
) {
    const candidate = await prepareCandidate(targetPath, root);
    const cli = await getSupportedKicadCli();
    try {
        if (refillZones) {
            await runProcessChecked(cli.path, [
                'pcb', 'drc', '--refill-zones', '--save-board',
                '--format', 'json', '--output', candidate.report, candidate.temporary,
            ], { timeoutMs: 120_000 });
        }
        await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', candidate.temporary], { timeoutMs: 60_000 });
        return parsePcbSource(await readFile(candidate.temporary, 'utf8'));
    } finally {
        await rm(candidate.directory, { recursive: true, force: true });
    }
}

export async function inspectPcbCandidate(
    targetPath: string,
    root: SExpression[],
    refillZones = false,
) {
    const candidate = await prepareCandidate(targetPath, root);
    const cli = await getSupportedKicadCli();
    try {
        await runProcessChecked(cli.path, [
            'pcb', 'drc',
            ...(refillZones ? ['--refill-zones', '--save-board'] : []),
            '--severity-all', '--format', 'json', '--output', candidate.report, candidate.temporary,
        ], { timeoutMs: 120_000 });
        await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', candidate.temporary], { timeoutMs: 60_000 });
        const [boardSource, reportSource] = await Promise.all([
            readFile(candidate.temporary, 'utf8'),
            readFile(candidate.report, 'utf8').catch(() => '{}'),
        ]);
        let reportJson: unknown = {};
        try {
            reportJson = JSON.parse(reportSource);
        } catch {
            console.error('KiCad DRC returned invalid JSON');
        }
        return { root: parsePcbSource(boardSource), report: reportJson };
    } finally {
        await rm(candidate.directory, { recursive: true, force: true });
    }
}

export function pcbDrcMetrics(report: unknown) {
    const value = report && typeof report === 'object' ? report as Record<string, unknown> : {};
    const violations = Array.isArray(value.violations) ? value.violations : [];
    const unconnected = Array.isArray(value.unconnected_items) ? value.unconnected_items.length : 0;
    const shorts = violations.filter((violation) => (
        violation && typeof violation === 'object'
        && (violation as Record<string, unknown>).type === 'shorting_items'
    )).length;
    const errorViolations = violations.flatMap((violation) => {
        if (!violation || typeof violation !== 'object') return [];
        const item = violation as Record<string, unknown>;
        if (item.severity !== 'error') return [];
        const type = typeof item.type === 'string' ? item.type : 'unknown';
        const subjects = (Array.isArray(item.items) ? item.items : []).map((subject) => {
            if (!subject || typeof subject !== 'object') return String(subject);
            const fields = subject as Record<string, unknown>;
            if (typeof fields.uuid === 'string') return fields.uuid;
            return JSON.stringify({ description: fields.description, pos: fields.pos });
        }).sort();
        return [{ key: `${type}:${subjects.join('|')}`, type }];
    });
    return { shorts, unconnected, errorViolations };
}

export async function refillAndInspectPcbCandidate(targetPath: string, root: SExpression[]) {
    return inspectPcbCandidate(targetPath, root, true);
}
