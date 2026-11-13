import { execFileSync } from 'node:child_process';
import { readFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skill');
const info = JSON.parse(await readFile(join(root, 'build-info.json'), 'utf8'));
if (info.name !== 'kicad-copilot' || !['npm', 'bundled'].includes(info.distribution)) throw new Error('Invalid skill build-info.json');
for (const file of ['SKILL.md', 'install-guide.md', 'spice/SKILL.md', 'spice/scripts/simulate.mjs', 'datasheets/SKILL.md', 'datasheets/scripts/download.mjs', 'scripts/kicad-copilot-cli.js', 'scripts/runtime/dist/cli.js']) {
    await access(join(root, file));
}
if (info.distribution === 'bundled') {
    if (info.platform !== `${process.platform}-${process.arch}`) throw new Error('Bundled skill targets a different platform');
    execFileSync(process.execPath, [join(root, 'scripts/kicad-copilot-cli.js'), '--help'], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'scripts/kicad-copilot-cli.js'), 'list'], { stdio: 'pipe', timeout: 30000 });
}
console.log(`Skill package OK (${info.distribution}).`);
