import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import * as z from 'zod/v4';
import { createDocument } from '../kicad/create-document';
import { getProjectInfo } from '../kicad/project-tree';
import { getSchematic } from '../kicad/schematic-reader';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SKILL_DOC_PATH, TEMP_DIR } from '../utils/dirs';
import { enqueueMutation } from '../utils/mutation-queue';
import { runTool } from '../utils/tool-result';

export function registerDocumentTools(server: McpServer) {
    server.registerTool(
        'get_schematic',
        {
            title: 'Get KiCad Schematic',
            description: `Get exactly one KiCad .kicad_sch file as a compact component and net list. For circuit workflow docs, read the local docs folder: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Target .kicad_sch file path.'),
            }),
        },
        async ({ path }) => runTool(async () => {
            const schematic = await getSchematic(path);
            if (schematic.components.length <= 40) return schematic;

            await mkdir(TEMP_DIR, { recursive: true });
            const savePath = join(TEMP_DIR, `sch-${randomUUID().slice(0, 8)}.json`);
            await writeFile(savePath, JSON.stringify(schematic, null, 2));
            return {
                message: `Schematic too big, so it was saved to a file. components len: ${schematic.components.length}`,
                path: savePath,
            };
        }),
    );

    server.registerTool(
        'create_doc',
        {
            title: 'Create KiCad Document',
            description: `Create a KiCad project, schematic, hierarchical page, or empty PCB without overwriting files. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                doc: z.discriminatedUnion('doc_type', [
                    z.object({
                        doc_type: z.literal('project'),
                        path: z.string().min(1).describe('Destination .kicad_pro path.'),
                    }),
                    z.object({
                        doc_type: z.literal('schematic'),
                        path: z.string().min(1).describe('Destination .kicad_sch path.'),
                    }),
                    z.object({
                        doc_type: z.literal('schematic_page'),
                        path: z.string().min(1).describe('Destination child .kicad_sch path.'),
                        parent_path: z.string().min(1).describe('Existing parent .kicad_sch path.'),
                    }),
                    z.object({
                        doc_type: z.literal('pcb'),
                        path: z.string().min(1).describe('Destination .kicad_pcb path.'),
                    }),
                ]),
            }),
        },
        async ({ doc }) => runTool(() => enqueueMutation(() => createDocument(doc))),
    );

    server.registerTool(
        'get_project_info',
        {
            title: 'Get KiCad Project Info',
            description: `Build KiCad project and hierarchical schematic trees from a file or directory path. Agent instructions: ${SKILL_DOC_PATH}`,
            inputSchema: z.object({
                path: z.string().min(1).describe('Path to a KiCad file or directory.'),
            }),
        },
        async ({ path }) => runTool(() => getProjectInfo(path)),
    );
}
