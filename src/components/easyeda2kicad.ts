import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CACHE_DIR } from '../utils/dirs';
import { runProcess, runProcessChecked } from '../utils/process';

export type ConverterCommand = {
    command: string;
    prefixArgs: string[];
};

let converterDiscovery: Promise<ConverterCommand> | undefined;

function managedEnvironment() {
    const root = join(CACHE_DIR, 'easyeda2kicad', 'venv');
    if (process.platform === 'win32') {
        return {
            root,
            python: join(root, 'Scripts', 'python.exe'),
            command: join(root, 'Scripts', 'easyeda2kicad.exe'),
        };
    }
    return {
        root,
        python: join(root, 'bin', 'python'),
        command: join(root, 'bin', 'easyeda2kicad'),
    };
}

async function commandExists(path: string) {
    if (path === 'easyeda2kicad') return true;
    return access(path).then(() => true, () => false);
}

async function inspectConverter(command: string) {
    if (!(await commandExists(command))) return undefined;
    const result = await runProcess(command, ['--help'], { timeoutMs: 15_000 }).catch(() => undefined);
    if (!result) return undefined;
    const output = `${result.stdout}\n${result.stderr}`;
    return /easyeda2kicad/i.test(output) ? { command, prefixArgs: [] } : undefined;
}

async function findPython() {
    const candidates: ConverterCommand[] = process.platform === 'win32'
        ? [
            { command: 'python', prefixArgs: [] },
            { command: 'py', prefixArgs: ['-3'] },
            { command: 'python3', prefixArgs: [] },
        ]
        : [
            { command: 'python3', prefixArgs: [] },
            { command: 'python', prefixArgs: [] },
        ];

    for (const candidate of candidates) {
        const result = await runProcess(
            candidate.command,
            [...candidate.prefixArgs, '--version'],
            { timeoutMs: 10_000 },
        ).catch(() => undefined);
        if (result?.exitCode === 0 && /Python\s+3\./i.test(`${result.stdout}${result.stderr}`)) {
            return candidate;
        }
    }

    throw new Error('Python 3 not found for EasyEDA2KiCad installation');
}

async function installManagedConverter() {
    const environment = managedEnvironment();
    await mkdir(join(CACHE_DIR, 'easyeda2kicad'), { recursive: true });
    const python = await findPython();

    try {
        await runProcessChecked(
            python.command,
            [...python.prefixArgs, '-m', 'venv', environment.root],
            { timeoutMs: 120_000 },
        );
        await runProcessChecked(
            environment.python,
            ['-m', 'pip', 'install', '--disable-pip-version-check', 'easyeda2kicad'],
            { timeoutMs: 300_000 },
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`EasyEDA2KiCad installation failed: ${message}`);
    }

    const converter = await inspectConverter(environment.command);
    if (!converter) throw new Error('EasyEDA2KiCad installation failed: command not found');
    return converter;
}

async function discoverConverter() {
    const environment = managedEnvironment();
    const managed = await inspectConverter(environment.command);
    if (managed) return managed;

    const existing = await inspectConverter('easyeda2kicad');
    if (existing) return existing;

    return installManagedConverter();
}

export function getEasyEda2Kicad() {
    converterDiscovery ??= discoverConverter().catch((error) => {
        converterDiscovery = undefined;
        throw error;
    });
    return converterDiscovery;
}
