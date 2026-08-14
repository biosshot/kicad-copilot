import assert from 'node:assert/strict';
import { copyFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { autoRoutePcb } from '../src/routing/routing-operation';
import { importKiCadRoutingBoard } from '../src/routing/router-package-adapter';
import { prepareKrtRuntime } from '@easyeda-copilot/router/backends/krt';

const fixtureBoard = fileURLToPath(new URL('../tests/fixtures/cap-chain.kicad_pcb', import.meta.url));

async function main() {
    const directory = await mkdtemp(join(tmpdir(), 'kicad-krt-transport-'));
    try {
        const boardPath = join(directory, 'board.kicad_pcb');
        await copyFile(fixtureBoard, boardPath);
        await writeFile(join(directory, 'board.kicad_pro'), '{}\n');
        const dslPath = join(directory, 'route.js');
        await writeFile(dslPath, `
            diffPair("DPA", { positive: "DPA_P", negative: "DPA_N", maxSkewMm: 0.2 })
            diffPair("DPB", { positive: "DPB_P", negative: "DPB_N", maxSkewMm: 0.2 })
            runRouting()
        `);
        // The transport test deliberately exercises package-managed KRT. No
        // KRT directory or Python environment variable is required.
        await prepareKrtRuntime();
        const result = await autoRoutePcb(boardPath, dslPath, { timeoutSec: 180 }, 180_000);
        await writeFile(join(directory, 'result.json'), JSON.stringify(result, null, 2));
        assert.equal(typeof result, 'object');
        assert.ok(result && 'status' in result && result.status !== 'running', 'public auto-route did not finish');
        const imported = await importKiCadRoutingBoard(boardPath, { existingCopper: 'fixed' });
        assert.ok(imported.board, imported.diagnostics.map(item => item.message).join('\n'));
        assert.ok(imported.board.copper.fixed.tracks.length > 0, 'public auto-route wrote no tracks');
        console.log(`Public KRT auto-route: ${result.status}, ${imported.board.copper.fixed.tracks.length} tracks`);
    } catch (error) {
        console.error(`KRT transport artifacts: ${directory}`);
        throw error;
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
