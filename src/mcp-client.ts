import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

/** Use the same stdio protocol and tool validation as an external MCP host. */
export async function openMcpClient() {
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL('./index.js', import.meta.url))],
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        stderr: 'inherit',
    });
    const client = new Client({ name: 'kicad-copilot-cli', version: '0.1.0' });
    try { await client.connect(transport); }
    catch (error) { await transport.close(); throw error; }
    return client;
}
