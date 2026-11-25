import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { cancelOperation, waitOperation } from '../operations/control';
import { OPERATION_ID_PATTERN } from '../operations/id';
import { runCompactTool } from '../utils/tool-result';

const operationId = z.string().regex(
    OPERATION_ID_PATTERN,
    'Expected a prefixed operation ID returned by a long-running tool.',
);

export function registerOperationTools(server: McpServer) {
    server.registerTool(
        'wait_operation',
        {
            title: 'Wait Operation',
            description: 'Wait for a running PCB layout, routing, analysis, or lifecycle audit operation.',
            inputSchema: z.object({
                operation_id: operationId,
                wait_ms: z.number().int().min(1_000).max(55_000).default(30_000)
                    .describe('Wait below the common 60-second MCP request timeout.'),
            }),
        },
        async ({ operation_id, wait_ms }) => runCompactTool(
            () => waitOperation(operation_id, wait_ms),
        ),
    );

    server.registerTool(
        'cancel_operation',
        {
            title: 'Cancel Operation',
            description: 'Cancel a running PCB layout, routing, analysis, or lifecycle audit operation.',
            inputSchema: z.object({ operation_id: operationId }),
        },
        async ({ operation_id }) => runCompactTool(() => cancelOperation(operation_id)),
    );
}
