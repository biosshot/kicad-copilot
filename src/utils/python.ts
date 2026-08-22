import { runProcess } from './process';

export type PythonCommand = {
    command: string;
    prefixArgs: string[];
};

let pythonDiscovery: Promise<PythonCommand> | undefined;

async function discoverPython() {
    const candidates: PythonCommand[] = process.platform === 'win32'
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

    throw new Error('Python 3 not found');
}

export function getPython() {
    pythonDiscovery ??= discoverPython().catch((error) => {
        pythonDiscovery = undefined;
        throw error;
    });
    return pythonDiscovery;
}
