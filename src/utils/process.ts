import { spawn } from 'node:child_process';

type RunProcessOptions = {
    cwd?: string;
    timeoutMs?: number;
};

export type ProcessResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
};

export function runProcess(command: string, args: string[], options: RunProcessOptions = {}) {
    return new Promise<ProcessResult>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (action: () => void) => {
            if (settled) return;
            settled = true;
            if (timeout) clearTimeout(timeout);
            action();
        };

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.once('error', (error) => finish(() => reject(error)));
        child.once('close', (exitCode) => finish(() => resolve({
            exitCode: exitCode ?? -1,
            stdout,
            stderr,
        })));

        const timeout = options.timeoutMs
            ? setTimeout(() => {
                child.kill();
                finish(() => reject(new Error(`${command} timed out`)));
            }, options.timeoutMs)
            : undefined;
    });
}

export async function runProcessChecked(command: string, args: string[], options: RunProcessOptions = {}) {
    const result = await runProcess(command, args, options);
    if (result.exitCode === 0) return result;

    const detail = result.stderr.trim() || result.stdout.trim();
    throw new Error(detail || `${command} exited with code ${result.exitCode}`);
}
