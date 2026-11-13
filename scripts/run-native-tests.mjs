import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// Keep native acceptance separate from quick CI: requires KiCad 9/10 and
// installed router assets. Missing native dependencies are failures, not skips.
const root = resolve('.test-output/native-acceptance');
await mkdir(root, { recursive: true });
for (const name of ['schematic-hierarchy', 'ground-layout', 'pcb-scenarios', 'local-backend', 'routing-integration']) {
    const result = spawnSync(process.execPath, [`dist/test-${name}.js`], {
        stdio: 'inherit', windowsHide: true, timeout: 600_000,
        env: { ...process.env, KICAD_COPILOT_CACHE_DIR: resolve(root, name) },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
}
