import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { listCheckpoints, restoreCheckpoint, saveCheckpoint } from '../checkpoints/store';
import { SKILL_DOC_PATH } from '../utils/dirs';
import { enqueueMutation } from '../utils/mutation-queue';
import { runTool } from '../utils/tool-result';

export function registerCheckpointTools(server: McpServer) {
    server.registerTool(
        'list_checkpoints',
        {
            title: 'List KiCad Checkpoints',
            description: `List file checkpoints saved by KiCad Copilot. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target KiCad file path.'),
            }),
        },
        async ({ path }) => runTool(() => listCheckpoints(path)),
    );

    server.registerTool(
        'save_checkpoint',
        {
            title: 'Save KiCad Checkpoint',
            description: `Save an exact checkpoint of one KiCad file. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target KiCad file path.'),
                description: z.string().max(100).optional().describe('Short checkpoint description.'),
            }),
        },
        async ({ path, description }) => runTool(
            () => enqueueMutation(() => saveCheckpoint(path, description)),
        ),
    );

    server.registerTool(
        'restore_checkpoint',
        {
            title: 'Restore KiCad Checkpoint',
            description: `Restore one exact file checkpoint by id. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target KiCad file path.'),
                id: z.string().min(1).describe('Checkpoint id from list_checkpoints.'),
            }),
        },
        async ({ path, id }) => runTool(
            () => enqueueMutation(() => restoreCheckpoint(path, id)),
        ),
    );
}
