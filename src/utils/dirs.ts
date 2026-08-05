import findUp from 'find-up';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = findUp.sync('package.json', { cwd: moduleDir });

if (!packageJsonPath) {
    throw new Error('kicad-copilot package root not found');
}

export const ROOT_DIR = dirname(packageJsonPath);
export const DOCS_DIR = join(ROOT_DIR, 'docs');
export const SKILL_DOC_PATH = join(DOCS_DIR, 'SKILL.md');
export const TEMP_DIR = join(tmpdir(), 'kicad-copilot-mcp');

function defaultCacheDir() {
    if (process.platform === 'win32') {
        return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'kicad-copilot');
    }

    if (process.platform === 'darwin') {
        return join(homedir(), 'Library', 'Caches', 'kicad-copilot');
    }

    return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'kicad-copilot');
}

export const CACHE_DIR = process.env.KICAD_COPILOT_CACHE_DIR || defaultCacheDir();
