#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMcpClient } from './mcp-client';

const home = resolve(process.env.KICAD_COPILOT_CLI_HOME || join(homedir(), '.kicad-copilot', 'cli'));
const namespace = randomNamespace(home);
const entry = fileURLToPath(import.meta.url);
const maxBytes = 64 * 1024 * 1024;
const timeout = 600_000;
const usage = `Usage:
  kicad-copilot-cli start
  kicad-copilot-cli <id> list | tools list | tools help <tool> | status
  kicad-copilot-cli <id> call <tool> [JSON | @file.json | - | --json JSON | --input file.json]
  kicad-copilot-cli <id> batch <JSON | @file.json | ->
  kicad-copilot-cli <id> stop [--force]
  kicad-copilot-cli stop <id> [--force]
  kicad-copilot-cli list | call <tool> [JSON | @file.json | -] | batch <JSON | @file.json | ->
Batch input: [{ "name": "tool", "arguments": {} }, ...]. Results are MCP JSON.
Sessions preserve asynchronous operations across CLI invocations. Stopping a session ends its operations.`;
function randomNamespace(value: string) {
    // Stable across processes while keeping socket names short.
    let hash = 2166136261;
    for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return (hash >>> 0).toString(16);
}
function statePath(id: string) {
    if (!/^[a-f0-9]{16}$/.test(id)) throw new Error('Invalid session ID.');
    return join(home, id, 'session.json');
}
function endpoint(id: string) {
    statePath(id);
    return process.platform === 'win32' ? `\\\\.\\pipe\\kicad-copilot-${namespace}-${id}` : join(tmpdir(), `kicad-${namespace}-${id}.sock`);
}
type Meta = { id: string; token: string; ready: boolean; pid?: number };
type Call = { name: string; arguments: Record<string, unknown> };
type Request = { token: string; command: string; calls?: Call[]; name?: string; force?: boolean };
type Response = { ok: boolean; result?: unknown; error?: string; toolError?: boolean };
async function metadata(id: string): Promise<Meta> {
    try {
        const meta = JSON.parse(await readFile(statePath(id), 'utf8')) as Meta;
        if (meta.id !== id || !/^[a-f0-9]{64}$/.test(meta.token)) throw new Error('Invalid metadata');
        return meta;
    } catch { throw new Error(`Session ${id} is unavailable. Start a new session; its old operations cannot be resumed.`); }
}
async function request(id: string, body: Omit<Request, 'token'>, wait = timeout): Promise<Response> {
    const meta = await metadata(id);
    return new Promise((done, reject) => {
        const socket = createConnection(endpoint(id));
        let buffer = '', bytes = 0, settled = false;
        const finish = (error?: Error, result?: Response) => {
            if (settled) return; settled = true; clearTimeout(timer); socket.destroy();
            if (error) reject(error); else done(result!);
        };
        const timer = setTimeout(() => finish(new Error('Request timed out; execution may still be running. Inspect before retrying.')), wait);
        socket.setEncoding('utf8');
        socket.on('connect', () => socket.write(JSON.stringify({ ...body, token: meta.token }) + '\n'));
        socket.on('data', chunk => {
            bytes += Buffer.byteLength(chunk);
            if (bytes > maxBytes) return finish(new Error('Response exceeds 64 MiB.'));
            buffer += chunk;
            const end = buffer.indexOf('\n');
            if (end < 0) return;
            try { finish(undefined, JSON.parse(buffer.slice(0, end))); } catch { finish(new Error('Invalid session response.')); }
        });
        socket.on('error', error => finish(new Error(`Cannot reach session ${id}: ${error.message}. Requests are not retried.`)));
        socket.on('close', () => finish(new Error('Session disconnected; execution outcome may be unknown.')));
    });
}
async function readJson(input: string): Promise<unknown> {
    if (input === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    }
    return JSON.parse((input.startsWith('@') ? await readFile(input.slice(1), 'utf8') : input).replace(/^\uFEFF/, ''));
}
function validateCalls(calls: unknown): asserts calls is Call[] {
    if (!Array.isArray(calls) || calls.some(call => !call || typeof call.name !== 'string' || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) throw new Error('Expected calls with name and an arguments object.');
}
async function execute(client: Awaited<ReturnType<typeof openMcpClient>>, command: string, calls: Call[] = [], name?: string) {
    if (command === 'list' || command === 'help') {
        const tools = [];
        let cursor: string | undefined;
        do {
            const page = await client.listTools(cursor ? { cursor } : undefined);
            tools.push(...page.tools); cursor = page.nextCursor;
        } while (cursor);
        if (command === 'list') return { result: { tools } };
        const tool = tools.find(tool => tool.name === name);
        if (!tool) throw new Error(`Unknown tool: ${name}`);
        return { result: tool };
    }
    validateCalls(calls);
    const results = [];
    let toolError = false;
    for (const call of calls) {
        const result = await client.callTool(call, undefined, { timeout });
        results.push(result);
        if (result.isError) { toolError = true; break; }
    }
    return { result: command === 'call' ? results[0] : results, toolError };
}
async function serve(id: string) {
    const meta = await metadata(id);
    const client = await openMcpClient();
    let active = 0, stopping = false;
    const sockets = new Set<import('node:net').Socket>();
    const listener = createServer(socket => {
        sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => undefined);
        socket.setEncoding('utf8'); socket.setTimeout(10_000, () => socket.destroy());
        let buffer = '', bytes = 0, received = false;
        socket.on('data', chunk => {
            if (received) return;
            bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) { socket.destroy(); return; }
            buffer += chunk; const end = buffer.indexOf('\n'); if (end < 0) return;
            received = true; socket.setTimeout(0);
            void (async () => {
                let input: Request | undefined; let response: Response;
                try {
                    input = JSON.parse(buffer.slice(0, end)) as Request;
                    if (input.token !== meta.token) throw new Error('Invalid session token.');
                    if (stopping) throw new Error('Session is stopping.');
                    if (input.command === 'stop') {
                        if (active && !input.force) throw new Error('Session has active calls. Wait or use stop --force.');
                        stopping = true; response = { ok: true, result: { id, stopped: true } };
                    } else if (input.command === 'status') response = { ok: true, result: { id, pid: process.pid, activeCalls: active } };
                    else if (['list', 'help', 'call', 'batch'].includes(input.command)) {
                        active++;
                        try { response = { ok: true, ...await execute(client, input.command, input.calls, input.name) }; }
                        finally { active--; }
                    } else throw new Error('Unknown command.');
                } catch (error) { response = { ok: false, error: error instanceof Error ? error.message : String(error) }; }
                socket.end(JSON.stringify(response) + '\n', () => {
                    if (stopping && response.ok && input?.command === 'stop') void shutdown();
                });
            })();
        });
    });
    let shuttingDown = false;
    async function shutdown() {
        if (shuttingDown) return; shuttingDown = true; stopping = true;
        listener.close();
        const deadline = setTimeout(() => process.exit(1), 5000); deadline.unref();
        await client.close().catch(() => undefined);
        for (const socket of sockets) socket.destroy();
        await rm(dirname(statePath(id)), { recursive: true, force: true });
        if (process.platform !== 'win32') await rm(endpoint(id), { force: true });
        clearTimeout(deadline);
    }
    await new Promise<void>((done, reject) => { listener.once('error', reject); listener.listen(endpoint(id), done); });
    if (process.platform !== 'win32') { const { chmod } = await import('node:fs/promises'); await chmod(endpoint(id), 0o600); }
    await writeFile(statePath(id), JSON.stringify({ ...meta, pid: process.pid, ready: true }), { mode: 0o600 });
    process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
}
async function start() {
    await mkdir(home, { recursive: true, mode: 0o700 });
    const id = randomBytes(8).toString('hex');
    await mkdir(dirname(statePath(id)), { mode: 0o700 });
    await writeFile(statePath(id), JSON.stringify({ id, token: randomBytes(32).toString('hex'), ready: false }), { mode: 0o600 });
    const logPath = join(dirname(statePath(id)), 'session.log');
    const log = openSync(logPath, 'a', 0o600);
    const child = spawn(process.execPath, [entry, '__serve', id], { detached: true, windowsHide: true, stdio: ['ignore', log, log] });
    closeSync(log); let error: Error | undefined; let exited = false;
    child.once('error', e => { error = e; }); child.once('exit', () => { exited = true; }); child.unref();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !error && !exited) {
        try { if ((await metadata(id)).ready && (await request(id, { command: 'status' }, 2000)).ok) { console.log(id); return; } } catch { /* readiness only */ }
        await new Promise(done => setTimeout(done, 100));
    }
    child.kill();
    throw new Error(`Session failed to start: ${error?.message ?? 'see log'} (${logPath})`);
}
async function main() {
    const argv = process.argv.slice(2);
    if (!argv.length || ['--help', '-h', 'help'].includes(argv[0])) { console.log(usage); return; }
    if (argv[0] === '__serve' && argv.length === 2) { await serve(argv[1]); return; }
    if (argv[0] === 'start' && argv.length === 1) { await start(); return; }
    if (argv[0] === 'stop' && argv[1]) argv.splice(0, 2, argv[1], 'stop');
    const session = /^[a-f0-9]{16}$/.test(argv[0]) ? argv.shift() : undefined;
    let command = argv.shift();
    if (command === 'tools' && argv[0] === 'list' && argv.length === 1) { command = 'list'; argv.shift(); }
    else if (command === 'tools' && argv[0] === 'help' && argv.length === 2) { command = 'help'; argv.shift(); }
    let calls: Call[] = []; let name: string | undefined;
    if (command === 'call' && argv.length >= 1) {
        name = argv.shift(); let input = argv.shift();
        if (input === '--json') input = argv.shift();
        else if (input === '--input') { const path = argv.shift(); input = path ? '@' + path : undefined; }
        if (argv.length || input === undefined && process.argv.slice(2).some(arg => arg === '--json' || arg === '--input')) throw new Error(usage);
        calls = [{ name: name!, arguments: await readJson(input ?? '{}') as Record<string, unknown> }]; validateCalls(calls);
    } else if (command === 'batch' && argv.length === 1) { const parsed = await readJson(argv[0]); validateCalls(parsed); calls = parsed; }
    else if (command === 'help' && argv.length === 1) name = argv[0];
    else if ((command === 'list' || command === 'status') && !argv.length) { /* valid */ }
    else if (command === 'stop' && (argv.length === 0 || argv.length === 1 && argv[0] === '--force')) { /* valid */ }
    else throw new Error(usage);
    if (!session && ['status', 'stop', 'help'].includes(command!)) throw new Error(usage);
    let response: Response;
    if (session) response = await request(session, { command: command!, calls, name, force: argv[0] === '--force' });
    else {
        const client = await openMcpClient();
        try { response = { ok: true, ...await execute(client, command!, calls, name) }; } finally { await client.close(); }
    }
    if (!response.ok) throw new Error(response.error);
    console.log(JSON.stringify(response.result, null, 2));
    if (response.toolError) process.exitCode = 1;
}
main().catch(error => { console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); process.exitCode = 1; });


