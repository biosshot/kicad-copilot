import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from 'eda-copilot-router';
import { applyKiCadRoutingResult, importKiCadRoutingBoard } from 'eda-copilot-router/adapters/kicad';
import { runPcbRouterDsl, waitPcbDsl } from '../src/routing/routing-operation';

const fixture = fileURLToPath(new URL('../tests/fixtures/cap-chain.kicad_pcb', import.meta.url));
const directory = await mkdtemp(join(tmpdir(), 'kicad-router-integration-'));
const require = createRequire(import.meta.url);
const routerRoot = dirname(require.resolve('eda-copilot-router/package.json'));

assert.equal(
    (await readFile(fileURLToPath(new URL('../docs/pcb-routing/dsl.d.ts', import.meta.url)), 'utf8')).replace(/\r\n/g, '\n'),
    (await readFile(join(routerRoot, 'docs', 'routing-dsl.d.ts'), 'utf8')).replace(/\r\n/g, '\n'),
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

    async function executeDsl(name: string, code: string) {
        const dsl = join(directory, `${name}.js`);
        await writeFile(dsl, code);
        let result = await runPcbRouterDsl(source, dsl, 55_000);
        while (result && 'operation_id' in result) {
            result = await waitPcbDsl(result.operation_id, 55_000);
        }
        assert.ok(result && typeof result === 'object' && 'status' in result);
        assert.notEqual(result.status, 'running');
        return result;
    }

    await executeDsl('rules', 'applyDrcRules()\n');

    const routeResult = await executeDsl('route', 'runRouting()\n');
    assert.ok('tracks' in routeResult && Number(routeResult.tracks) > 0, JSON.stringify(routeResult));
    assert.ok('native_verification' in routeResult && routeResult.native_verification !== 'not-run');
    assert.match(await readFile(source, 'utf8'), /\(segment\b/);

    const stackResult = await executeDsl('stack', `
stack({
  boardThicknessMm: 1.2,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", name: "PREPREG", thicknessMm: 0.2, relativePermittivity: 4.2 },
    { kind: "copper", name: "INNER_1", thicknessOz: 1 },
    { kind: "dielectric", name: "CORE", thicknessMm: 0.9, relativePermittivity: 4.2 },
    { kind: "copper", name: "INNER_2", thicknessOz: 1 },
    { kind: "dielectric", name: "PREPREG_2", thicknessMm: 0.2, relativePermittivity: 4.2 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 },
  ],
})
applyStackup()
`);
    assert.equal('operation' in stackResult ? stackResult.operation : undefined, 'apply-stackup');
    assert.match(await readFile(source, 'utf8'), /\(4 "In1\.Cu" signal\)/);
    assert.match(await readFile(source, 'utf8'), /\(6 "In2\.Cu" signal\)/);

    const removableUuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const withTrack = (await readFile(source, 'utf8')).replace(/\)\s*$/, `
  (segment (start 60 60) (end 61 60) (width 0.2) (layer "F.Cu") (net "DPA_P") (uuid "${removableUuid}"))
)\n`);
    await writeFile(source, withTrack);
    const clearResult = await executeDsl('clear', `
clearRouting({ nets: "all", items: ["tracks", "vias"] })
runCopper()
`);
    assert.equal('operation' in clearResult ? clearResult.operation : undefined, 'copper');
    assert.doesNotMatch(await readFile(source, 'utf8'), new RegExp(removableUuid));

    const copperResult = await executeDsl('copper', `
plane({ net: "DPA_P", layers: "BOTTOM", region: board() })
runCopper()
`);
    assert.equal('operation' in copperResult ? copperResult.operation : undefined, 'copper');
    assert.ok('zones' in copperResult && Number(copperResult.zones) > 0);
    assert.match(await readFile(source, 'utf8'), /\(zone\b/);

    assert.ok((await readFile(source, 'utf8')).includes('(kicad_pcb'));
    process.stdout.write('Published router routing, stack, cleanup, and copper integration: ok\n');
} finally {
    await rm(directory, { recursive: true, force: true });
}
