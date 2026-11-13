import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

await mkdir('.test-output', { recursive: true });
const dir = await mkdtemp(resolve('.test-output/checkpoint-concurrency-'));
const cli = process.env.KICAD_COPILOT_TEST_CLI ? resolve(process.env.KICAD_COPILOT_TEST_CLI) : join(dir, 'cli.js');
const env = { ...process.env, KICAD_COPILOT_CLI_HOME: join(dir, 'sessions'), KICAD_COPILOT_CACHE_DIR: join(dir, 'cache'), COPILOT_ROUTER_CACHE_DIR: join(dir, 'router') };
const ids = []; let passed = false;
function run(...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}\n${r.stdout}`);
  return r.stdout.trim();
}
function call(id, name, args) {
  const r = JSON.parse(run(id, 'call', name, JSON.stringify(args)));
  assert.ok(!r.isError, JSON.stringify(r));
  const text = r.content[0].text;
  try { return JSON.parse(text); } catch { return text; }
}
function asyncCall(id, name, args) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(process.execPath, [cli, id, 'call', name, JSON.stringify(args)], { env });
    let stdout = '', stderr = ''; p.stdout.on('data', x => stdout += x); p.stderr.on('data', x => stderr += x);
    p.on('error', reject); p.on('close', status => {
      if (status !== 0) return reject(new Error(`${name}: ${stderr}\n${stdout}`));
      try { const r = JSON.parse(stdout); assert.ok(!r.isError); resolvePromise(r.content[0].text); } catch (e) { reject(e); }
    });
  });
}
try {
  if (!process.env.KICAD_COPILOT_TEST_CLI) {
  const sdk = resolve(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/package.json'), '../../esm/server');
  await build({ entryPoints: ['src/cli.ts', 'src/index.ts'], outdir: dir, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'sdk', setup(b) {
    b.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\// }, args => ({ path: args.path, external: true }));
    b.onResolve({ filter: /^@modelcontextprotocol\/sdk\/server\/(mcp|stdio)$/ }, args => ({ path: join(sdk, `${args.path.split('/').at(-1)}.js`) }));
  } }] });
  }
  for (let i = 0; i < 8; i++) ids.push(run('start'));
  for (const count of [2, 8]) for (let round = 0; round < 4; round++) {
    const file = join(dir, `target-${count}-${round}.kicad_sch`), bytes = Buffer.from(`exact bytes ${randomUUID()}\r\n`);
    await writeFile(file, bytes);
    const saved = await Promise.all(ids.slice(0, count).map((id, i) => asyncCall(id, 'save_checkpoint', { path: file, description: `parallel-${i}` })));
    assert.equal(new Set(saved).size, count);
    const list = call(ids[0], 'list_checkpoints', { path: file, limit: 100 });
    assert.equal(list.total, count); assert.deepEqual(new Set(list.checkpoints.map(x => x.id)), new Set(saved));
    for (const id of saved) {
      await writeFile(file, 'changed');
      assert.equal(call(ids[0], 'restore_checkpoint', { path: file, id }), 'ok');
      assert.deepEqual(await readFile(file), bytes);
    }
    const firstPage = call(ids[0], 'list_checkpoints', { path: file, limit: 2, page: 1 });
    const secondPage = call(ids[0], 'list_checkpoints', { path: file, limit: 2, page: 2 });
    assert.equal(firstPage.total, count * 2); assert.equal(new Set([...firstPage.checkpoints, ...secondPage.checkpoints].map(x => x.id)).size, 4);
  }
  const legacyFile = join(dir, 'legacy.kicad_sch'); await writeFile(legacyFile, 'new');
  const key = createHash('sha256').update(process.platform === 'win32' ? legacyFile.toLowerCase() : legacyFile).digest('hex');
  const legacyDir = join(dir, 'cache', 'checkpoints', key); await mkdir(legacyDir, { recursive: true });
  const legacyId = 'legacy-id'; await writeFile(join(legacyDir, `${legacyId}.snapshot`), 'legacy bytes');
  await writeFile(join(legacyDir, 'metadata.json'), JSON.stringify({ path: legacyFile, checkpoints: [{ id: legacyId, created_at: '2020-01-01T00:00:00.000Z', description: 'old' }] }));
  const fresh = call(ids[0], 'save_checkpoint', { path: legacyFile });
  assert.deepEqual(new Set(call(ids[0], 'list_checkpoints', { path: legacyFile }).checkpoints.map(x => x.id)), new Set([legacyId, fresh]));
  assert.equal(call(ids[0], 'restore_checkpoint', { path: legacyFile, id: legacyId }), 'ok'); assert.equal(await readFile(legacyFile, 'utf8'), 'legacy bytes');
  // Incomplete publication and stale lock-shaped files must not affect visibility or future saves.
  await writeFile(join(legacyDir, '.interrupted.tmp'), '{'); await writeFile(join(legacyDir, 'active.lock'), 'stale');
  assert.ok(call(ids[0], 'save_checkpoint', { path: legacyFile }));
  passed = true; console.log('Checkpoint concurrency, restoration, pagination, legacy cache and interrupted artifacts passed');
} finally {
  for (const id of ids) { try { run(id, 'stop', '--force'); } catch {} }
  if (passed) await rm(dir, { recursive: true, force: true }); else console.error(`Artifacts: ${dir}`);
}
