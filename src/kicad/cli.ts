import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess } from '../utils/process';

export type KicadCli = {
    path: string;
    version: string;
    major: number;
};

let discovery: Promise<KicadCli> | undefined;

function supported(cli: KicadCli) {
    return cli.major === 9 || cli.major === 10;
}

export function preferredSupportedKicadCli(candidates: KicadCli[]) {
    return candidates
        .filter(supported)
        .sort((left, right) => right.major - left.major)[0];
}

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
    if (configured) {
        const cli = await inspectCandidate(configured);
        if (!cli) throw new Error(`KICAD_CLI_PATH is not a working kicad-cli: ${configured}`);
        if (!supported(cli)) throw new Error(`unsupported KiCad version: ${cli.version}`);
        return cli;
    }

    const candidates = ['kicad-cli', ...standardCandidates()];
    const discovered: KicadCli[] = [];

    for (const candidate of [...new Set(candidates)]) {
        const cli = await inspectCandidate(candidate);
        if (cli) discovered.push(cli);
    }

    const preferred = preferredSupportedKicadCli(discovered);
    if (preferred) return preferred;

    if (discovered.length) {
        throw new Error(`unsupported KiCad version: ${discovered.map((item) => item.version).join(', ')}`);
    }

    throw new Error('kicad-cli not found');
}

export function getKicadCli() {
    if (!discovery) {
        const pending = discoverKicadCli();
        discovery = pending;
        void pending.catch(() => {
            if (discovery === pending) discovery = undefined;
        });
    }
    return discovery;
}

export async function getSupportedKicadCli() {
    const cli = await getKicadCli();
    if (cli.major === 9 || cli.major === 10) return cli;
    throw new Error(`unsupported KiCad version: ${cli.version}`);
}
