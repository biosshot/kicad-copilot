#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { openMcpClient } from './mcp-client';

const usage = `Usage:
  kicad-copilot-cli list
  kicad-copilot-cli call <tool> [JSON | @file.json | -]
  kicad-copilot-cli batch <JSON | @file.json | ->

Batch input: [{ "name": "get_project_info", "arguments": { "path": "..." } }, ...]
Calls in a batch share one MCP session and stop on the first error.
Use - to read JSON from stdin. Results are MCP JSON; errors exit with code 1.`;

async function readJson(input: string) {
    if (input === '-') {
        const chunks: Buffer[] = [];
        for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, ''));
    }
    return JSON.parse((input.startsWith('@') ? await readFile(input.slice(1), 'utf8') : input).replace(/^\uFEFF/, ''));
}

async function main() {
    const [command, first, second, ...extra] = process.argv.slice(2);
    if (!command || command === '--help' || command === '-h') { console.log(usage); return; }
    if (extra.length || !['list', 'call', 'batch'].includes(command)
        || (command === 'list' && first) || (command !== 'list' && !first)
        || (command === 'batch' && second)) throw new Error(usage);
    const calls = command === 'call' ? [{ name: first!, arguments: await readJson(second ?? '{}') }]
        : command === 'batch' ? await readJson(first!) : [];
    if (!Array.isArray(calls) || calls.some(call => !call || typeof call.name !== 'string'
        || !call.arguments || typeof call.arguments !== 'object' || Array.isArray(call.arguments))) {
        throw new Error('Expected calls with name and an arguments object.');
    }
    const client = await openMcpClient();
    try {
        if (command === 'list') { console.log(JSON.stringify(await client.listTools(), null, 2)); return; }
        const results = [];
        for (const call of calls) {
            const result = await client.callTool(call, undefined, { timeout: 600_000 });
            results.push(result);
            if (result.isError) { process.exitCode = 1; break; }
        }
        console.log(JSON.stringify(command === 'call' ? results[0] : results, null, 2));
    } finally { await client.close(); }
}

main().catch(error => {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    process.exitCode = 1;
});
