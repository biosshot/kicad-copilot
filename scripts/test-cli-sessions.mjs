import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// A real MCP stdio server models an operation whose state exists only in its process.
const tmp = await mkdtemp(resolve('.cli-test-'));
const cli = join(tmp, 'cli.js');
const home = join(tmp, 'state');
const env = { ...process.env, KICAD_COPILOT_CLI_HOME: home };
let id;
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 15_000 });
try {
    await build({ entryPoints: ['src/cli.ts'], outfile: cli, bundle: true, platform: 'node', format: 'esm', packages: 'external' });
    await writeFile(join(tmp, 'index.js'), `
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
const server = new McpServer({ name: 'test', version: '1.0.0' });
let started = false;
server.registerTool('start_operation', { inputSchema: z.object({}) }, async () => { started = true; return { content: [{ type: 'text', text: 'started' }] }; });
server.registerTool('wait_operation', { inputSchema: z.object({}) }, async () => ({ content: [{ type: 'text', text: started ? 'found' : 'missing' }] }));
await server.connect(new StdioServerTransport());
`);
    const start = run('start'); assert.equal(start.status, 0, start.stderr); id = start.stdout.trim(); assert.match(id, /^[a-f0-9]{16}$/);
    const list = run(id, 'tools', 'list'); assert.equal(list.status, 0, list.stderr); assert(JSON.parse(list.stdout).tools.some(tool => tool.name === 'start_operation'));
    const help = run(id, 'tools', 'help', 'wait_operation'); assert.equal(help.status, 0, help.stderr); assert.equal(JSON.parse(help.stdout).name, 'wait_operation');
    const first = run(id, 'call', 'start_operation'); assert.equal(first.status, 0, first.stderr);
    const second = run(id, 'call', 'wait_operation'); assert.equal(JSON.parse(second.stdout).content[0].text, 'found');
    const ephemeral = run('call', 'wait_operation'); assert.equal(JSON.parse(ephemeral.stdout).content[0].text, 'missing');
    const batch = run(id, 'batch', JSON.stringify([{ name: 'wait_operation', arguments: {} }])); assert.equal(JSON.parse(batch.stdout)[0].content[0].text, 'found');
    const meta = JSON.parse(await readFile(join(home, id, 'session.json'), 'utf8'));
    assert.equal(meta.ready, true);
    let hash = 2166136261; for (const char of home) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const namespace = (hash >>> 0).toString(16);
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\kicad-copilot-${namespace}-${id}` : join((await import('node:os')).tmpdir(), `kicad-${namespace}-${id}.sock`);
    const unauthorized = await new Promise((resolveResponse, reject) => {
        const socket = createConnection(endpoint); let data = '';
        socket.on('connect', () => socket.write(JSON.stringify({ token: 'wrong', command: 'stop' }) + '\n'));
        socket.on('data', chunk => { data += chunk; }); socket.on('end', () => resolveResponse(JSON.parse(data))); socket.on('error', reject);
    });
    assert.equal(unauthorized.ok, false);
    assert.equal(run(id, 'status').status, 0);
    const stop = run(id, 'stop'); assert.equal(stop.status, 0, stop.stderr);
    const stale = run(id, 'status'); assert.notEqual(stale.status, 0); assert.equal(stale.error, undefined);
    id = undefined;
    console.log('CLI session persistence, authentication, batch and stop passed');
} finally {
    if (id) run(id, 'stop', '--force');
    await rm(tmp, { recursive: true, force: true });
}
