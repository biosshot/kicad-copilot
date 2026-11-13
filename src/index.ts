#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio';
import { registerCircuitTools } from './tools/circuit';
import { registerCheckpointTools } from './tools/checkpoints';
import { registerAgentDocs } from './tools/docs';
import { registerDocumentTools } from './tools/documents';
import { registerPcbTools } from './tools/pcb/index';
import { registerAnalysisTools } from './tools/analysis';
import { registerOperationTools } from './tools/operations';
import { disposePcbLayoutBackend } from './pcb/layout-operation';
import { disposePcbRouting } from './routing/routing-operation';

function createServer() {
    const server = new McpServer({
        name: 'kicad-copilot',
        version: '0.1.0',
    });

    registerAgentDocs(server);
    registerCircuitTools(server);
    registerDocumentTools(server);
    registerCheckpointTools(server);
    registerPcbTools(server);
    registerAnalysisTools(server);
    registerOperationTools(server);

    return server;
}

async function main() {
    const server = createServer();
    const transport = new StdioServerTransport();
    let transportClosed = false;
    let closePromise: Promise<void> | undefined;

    const closeTransport = () => {
        if (closePromise) return closePromise;
        if (transportClosed) return Promise.resolve();

        transportClosed = true;
        closePromise = Promise.all([disposePcbLayoutBackend(), disposePcbRouting()]).then(() => transport.close()).catch((error) => {
            console.error(error);
        });
        return closePromise;
    };

    const requestClose = () => {
        void closeTransport();
    };

    transport.onclose = () => {
        transportClosed = true;
        void Promise.all([disposePcbLayoutBackend(), disposePcbRouting()]).catch(console.error);
    };
    process.stdin.once('end', requestClose);
    process.stdin.once('close', requestClose);
    process.once('SIGINT', requestClose);
    process.once('SIGTERM', requestClose);

    await server.connect(transport);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
