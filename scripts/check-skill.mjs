import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
    if (!info.nativeSolver?.filename || !info.nativeSolver?.sha256) throw new Error('Native solver metadata missing');
    const nativePath = join(root, 'scripts/runtime/node_modules/eda-copilot-backend/native/pcb-board-packer', info.nativeSolver.filename);
    const hash = createHash('sha256').update(await readFile(nativePath)).digest('hex');
    if (hash !== info.nativeSolver.sha256) throw new Error('Native solver checksum mismatch');
    execFileSync(process.execPath, [join(root, 'scripts/kicad-copilot-cli.js'), '--help'], { stdio: 'inherit' });
    execFileSync(process.execPath, [join(root, 'scripts/kicad-copilot-cli.js'), 'list'], { stdio: 'pipe', timeout: 30000 });
}
console.log(`Skill package OK (${info.distribution}).`);
