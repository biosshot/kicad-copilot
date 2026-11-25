import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

await mkdir('.test-output', { recursive: true });
const dir = await mkdtemp(resolve('.test-output/cli-pcb-'));
const env = { ...process.env, KICAD_COPILOT_CLI_HOME: join(dir, 'sessions'), KICAD_COPILOT_CACHE_DIR: join(dir, 'cache') };
const cli = join(dir, 'cli.js');
const pcb = join(dir, 'main.kicad_pcb');
let id, passed = false;
function run(...args) {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(result.status, 0, `${args[0]}: ${result.stderr}\n${result.stdout}`);
    return result.stdout.trim();
}
function call(name, args) {
    const result = JSON.parse(run(id, 'call', name, JSON.stringify(args)));
    assert.ok(!result.isError, JSON.stringify(result));
    try { return JSON.parse(result.content[0].text); } catch { return result.content[0].text; }
}
try {
    const sdk = resolve(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/package.json'), '../../esm/server');
    await build({ entryPoints: ['src/cli.ts', 'src/index.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'sdk', setup(b) {
        b.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\// }, args => ({ path: args.path, external: true }));
        b.onResolve({ filter: /^@modelcontextprotocol\/sdk\/server\/(mcp|stdio)$/ }, args => ({ path: join(sdk, `${args.path.split('/').at(-1)}.js`) }));
    } }] });
    const root = randomUUID();
    const symbol = `(symbol "Device:R" (pin_names (offset 0)) (in_bom yes) (on_board yes)
      (property "Reference" "R" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
      (property "Value" "R" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
      (symbol "R_0_1" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))
      (symbol "R_1_1" (pin passive line (at -2.54 0 0) (length 1.27) (name "1" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 2.54 0 180) (length 1.27) (name "2" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
    const instances = ['R1', 'R2'].map((ref, i) => `(symbol (lib_id "Device:R") (at ${50 + i * 15} 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${randomUUID()}")
      (property "Reference" "${ref}" (at ${50 + i * 15} 48 0) (effects (font (size 1.27 1.27))))
      (property "Value" "1k" (at ${50 + i * 15} 52 0) (effects (font (size 1.27 1.27))))
      (property "Footprint" "Test:R_0603" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))
      (instances (project "main" (path "/${root}" (reference "${ref}") (unit 1)))))`).join('\n');
    await writeFile(join(dir, 'main.kicad_sch'), `(kicad_sch (version 20250114) (generator "eeschema") (uuid "${root}") (paper "A4") (lib_symbols ${symbol}) ${instances}
      (wire (pts (xy 52.54 50) (xy 62.46 50)) (stroke (width 0) (type default)) (uuid "${randomUUID()}"))
      (sheet_instances (path "/" (page "1"))))`);
    await writeFile(join(dir, 'main.kicad_pro'), '{}');
    await mkdir(join(dir, 'Test.pretty'));
    await writeFile(join(dir, 'fp-lib-table'), '(fp_lib_table (version 7) (lib (name "Test") (type "KiCad") (uri "${KIPRJMOD}/Test.pretty") (options "") (descr "")))');
    await writeFile(join(dir, 'Test.pretty/R_0603.kicad_mod'), `(footprint "R_0603" (version 20240108) (generator "pcbnew") (layer "F.Cu")
      (property "Reference" "REF**" (at 0 -2) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
      (property "Value" "R_0603" (at 0 2) (layer "F.Fab") (effects (font (size 1 1) (thickness 0.15))))
      (pad "1" smd rect (at -0.7 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
      (pad "2" smd rect (at 0.7 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask")))`);
    const dsl = join(dir, 'layout.js');
    await writeFile(dsl, 'board.rect(20, 12); block("divider", ["R1", "R2"], "generic");');
    id = run('start');
    call('create_doc', { doc: { doc_type: 'pcb', path: pcb } });
    call('import_pcb_changes', { path: pcb });
    const imported = await readFile(pcb, 'utf8');
    call('import_pcb_changes', { path: pcb });
    const parser = join(dir, 'pcb-parser.mjs');
    await build({
        stdin: {
            contents: `export { parseSExpression } from './src/kicad/sexpr/ast';
                       export { pcbFootprints, childText } from './src/kicad/pcb-reader';`,
            resolveDir: resolve('.'),
        },
        outfile: parser, bundle: true, platform: 'node', format: 'esm',
    });
    const { parseSExpression, pcbFootprints, childText } = await import(pathToFileURL(parser));
    const footprintIds = source => pcbFootprints(parseSExpression(source)).map(item => childText(item, 'uuid'));
    const originalIds = footprintIds(imported);
    assert.equal(originalIds.length, 2);
    assert.equal(new Set(originalIds).size, 2);
    assert.ok(originalIds.every(Boolean));
    assert.deepEqual(footprintIds(await readFile(pcb, 'utf8')), originalIds, 'reimport must preserve footprint identities');
    const sizes = call('get_pcb_component_sizes', { path: pcb, include_all: true });
    assert.match(sizes, /selected: 2/);
    let result = call('make_pcb_layout', { path: pcb, file: dsl, wait_ms: 1000 });
    const operation = result.operation_id;
    assert.ok(operation, JSON.stringify(result));
    const initial = result;
    for (let i = 0; (i === 0 || result.status === 'running') && i < 20; i++) result = call('wait_operation', { operation_id: operation, wait_ms: 10000 });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    if (initial.status === 'ok') assert.equal(result.layout_id, initial.layout_id);
    assert.equal(result.applied, true);
    const board = await readFile(pcb, 'utf8');
    assert.match(board, /Edge\.Cuts/);
    assert.match(board, /"R1"/); assert.match(board, /"R2"/);
    const metadata = call('list_checkpoints', { path: pcb });
    assert.equal(metadata.checkpoints.filter(item => item.description === 'Before PCB layout assembly').length, 1);
    const native = spawnSync(env.KICAD_CLI_PATH || 'kicad-cli', ['pcb', 'upgrade', '--force', pcb], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(native.status, 0, native.stderr);
    passed = true;
    console.log('Persistent CLI PCB placement passed: sizes, wait, applied checkpoint and KiCad upgrade');
} finally {
    if (id) { try { run(id, 'stop', '--force'); } catch {} }
    if (passed) await rm(dir, { recursive: true, force: true });
    else console.error(`Failed PCB artifacts: ${dir}`);
}
