import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../utils/process';

export type KicadCli = {
    path: string;
    version: string;
    major: number;
};

let discovery: Promise<KicadCli> | undefined;

function standardCandidates() {
    if (process.platform === 'win32') {
        const roots = [
            process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs'),
            process.env.ProgramFiles,
            process.env['ProgramFiles(x86)'],
        ].filter((value): value is string => Boolean(value));

        return roots.flatMap((root) => [
            join(root, 'KiCad', '10.0', 'bin', 'kicad-cli.exe'),
            join(root, 'KiCad', '9.0', 'bin', 'kicad-cli.exe'),
        ]);
    }

    if (process.platform === 'darwin') {
        return [
            '/Applications/KiCad/KiCad.app/Contents/MacOS/kicad-cli',
            '/Applications/KiCad 10/KiCad.app/Contents/MacOS/kicad-cli',
            '/Applications/KiCad 9/KiCad.app/Contents/MacOS/kicad-cli',
        ];
    }

    return ['/usr/local/bin/kicad-cli', '/usr/bin/kicad-cli'];
}

async function isExplicitFile(candidate: string) {
    if (candidate === 'kicad-cli') return true;
    return access(candidate).then(() => true, () => false);
}

async function inspectCandidate(candidate: string) {
    if (!(await isExplicitFile(candidate))) return undefined;

    const result = await runProcess(candidate, ['--version'], { timeoutMs: 10_000 }).catch(() => undefined);
    if (!result || result.exitCode !== 0) return undefined;

    const version = result.stdout.trim() || result.stderr.trim();
    const match = version.match(/(\d+)(?:\.\d+)?/);
    if (!match) return undefined;

    return {
        path: candidate,
        version,
        major: Number(match[1]),
    } satisfies KicadCli;
}

async function discoverKicadCli() {
    const configured = process.env.KICAD_CLI_PATH;
    const candidates = [configured, 'kicad-cli', ...standardCandidates()]
        .filter((value): value is string => Boolean(value));

    for (const candidate of [...new Set(candidates)]) {
        const cli = await inspectCandidate(candidate);
        if (cli) return cli;
    }

    throw new Error('kicad-cli not found');
}

export function getKicadCli() {
    discovery ??= discoverKicadCli();
    return discovery;
}

export async function getSupportedKicadCli() {
    const cli = await getKicadCli();
    if (cli.major === 9 || cli.major === 10) return cli;
    throw new Error(`unsupported KiCad version: ${cli.version}`);
}
