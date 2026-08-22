import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'eda-copilot-router';
import { applyKiCadRoutingResult, importKiCadRoutingBoard } from 'eda-copilot-router/adapters/kicad';
import { autoRoutePcb } from '../src/routing/routing-operation';

const fixture = fileURLToPath(new URL('../tests/fixtures/cap-chain.kicad_pcb', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'kicad-router-integration-'));
const require = createRequire(import.meta.url);
const routerRoot = dirname(require.resolve('eda-copilot-router/package.json'));

assert.equal(
    await readFile(fileURLToPath(new URL('../docs/pcb-routing/dsl.d.ts', import.meta.url)), 'utf8'),
    await readFile(join(routerRoot, 'docs', 'routing-dsl.d.ts'), 'utf8'),
    'installed routing DSL declarations are out of sync with eda-copilot-router',
);

try {
    const source = join(directory, 'board.kicad_pcb');
    const output = join(directory, 'candidate.kicad_pcb');
    await copyFile(fixture, source);
    await writeFile(join(directory, 'board.kicad_pro'), '{}\n');
    const before = await readFile(source, 'utf8');
    const imported = await importKiCadRoutingBoard(source);
    assert.ok(imported.board && imported.context, imported.diagnostics.map(item => item.message).join('\n'));

    const result = await run({
        board: imported.board,
        dsl: 'applyDrcRules()',
    });
    assert.equal(result.status, 'complete', JSON.stringify(result.diagnostics));
    const applied = await applyKiCadRoutingResult(imported.context, result, output);
    assert.equal(applied.outputPath, output, applied.diagnostics.map(item => item.message).join('\n'));
    assert.equal(applied.nativeVerification, 'not-run');
    assert.equal(await readFile(source, 'utf8'), before, 'router package changed its source board');
    assert.ok((await readFile(output, 'utf8')).includes('(kicad_pcb'));
    assert.ok((await readFile(output.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8')).length > 0);

    const dsl = join(directory, 'rules.js');
    await writeFile(dsl, 'applyDrcRules()\n');
    const routed = await autoRoutePcb(source, dsl, { timeoutSec: 30 }, 180_000);
    assert.ok(routed && typeof routed === 'object' && 'status' in routed);
    assert.notEqual(routed.status, 'running');
    assert.ok((await readFile(source, 'utf8')).includes('(kicad_pcb'));
    process.stdout.write('Published router integration: ok\n');
} finally {
    await rm(directory, { recursive: true, force: true });
}
