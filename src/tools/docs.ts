import { McpServer } from '@modelcontextprotocol/sdk/server/mcp';
import { DOCS_DIR, SKILL_DOC_PATH } from '../utils/dirs';

const SKILL_DOC_URI = 'kicad-copilot-mcp://local-docs/SKILL.md';

function localSkillDocText() {
    return [
        'KiCad Copilot MCP documentation is installed locally.',
        `Skill file: ${SKILL_DOC_PATH}`,
        `Docs directory: ${DOCS_DIR}`,
        'Read SKILL.md first. It points to the smallest relevant workflow document.',
    ].join('\n');
}

export function registerAgentDocs(server: McpServer) {
    server.registerResource(
        'kicad_copilot_mcp_skill',
        SKILL_DOC_URI,
        {
            title: 'KiCad Copilot MCP Skill',
            description: 'Path to the locally installed KiCad Copilot MCP agent instructions.',
            mimeType: 'text/plain',
        },
        async (uri) => ({
            contents: [{
                uri: uri.toString(),
                mimeType: 'text/plain',
                text: localSkillDocText(),
            }],
        }),
    );

    server.registerPrompt(
        'kicad_copilot_mcp_skill',
        {
            title: 'KiCad Copilot MCP Skill',
            description: 'Use the locally installed KiCad Copilot MCP agent instructions.',
        },
        async () => ({
            description: 'Local KiCad Copilot MCP agent documentation.',
            messages: [{
                role: 'user',
                content: {
                    type: 'text',
                    text: localSkillDocText(),
                },
            }],
        }),
    );
}
