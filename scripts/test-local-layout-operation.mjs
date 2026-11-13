import assert from 'node:assert/strict';
import { build } from 'esbuild';

const state = globalThis.__layoutTest = { applied: 0, lock: false };
const mock = `
const s = globalThis.__layoutTest;
export const readFile = async () => 'board.rect(10, 10)';
export const fileHash = async () => 'hash';
export const associatedSchematicPath = async () => 'board.kicad_sch';
export const importPcbChanges = async () => {};
export const createPcbLayoutInput = async () => ({});
export const acquireLayoutLock = async () => { if (s.lock) throw Error('locked'); s.lock = true; return async () => { s.lock = false; }; };
export const readActiveLayout = async () => undefined;
export const clearActiveLayout = async () => {};
export const writeActiveLayout = async () => {};
export const storeLayout = async () => {};
export const saveDataUrl = async () => undefined;
export const savePreviewImageFiles = async () => ({});
export const createOperationId = () => 'pcb-layout:' + String(++s.id).padStart(8, '0');
export const enqueueMutation = async fn => fn();
export const assemblePcbLayout = async () => { s.applied++; };
export const makePcbLayout = async (_input, options) => { s.signal = options.signal; options.onProgress({stage:'solve_board', progress:85, content:'solving'}); return await new Promise(resolve => { s.resolve = resolve; }); };
export const disposeBackend = async () => {};
`;
state.id = 0;
const result = await build({
    entryPoints: ['src/pcb/layout-operation.ts'], bundle: true, write: false,
    platform: 'node', format: 'esm',
    plugins: [{ name: 'operation-dependencies', setup(build) {
        build.onResolve({ filter: /.*/ }, args => {
            if (args.kind === 'entry-point' || args.path === 'node:crypto') return;
            return { path: args.path, namespace: 'mock' };
        });
        build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: mock, loader: 'js' }));
    }}],
});
const api = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const first = await api.makePcbLayout('board.kicad_pcb', 'layout.js', 0);
assert.equal(first.status, 'running');
assert.equal(first.progress.stage, 'solve_board');
await assert.rejects(api.makePcbLayout('other', 'layout.js', 0), /already running/);
const waits = [api.waitPcbLayout(first.operation_id, 1000), api.waitPcbLayout(first.operation_id, 1000)];
state.resolve({ pcb: {}, toolReport: { status: 'ok' } });
const [one, two] = await Promise.all(waits);
assert.deepEqual(one, two);
assert.equal(one.operation_id, first.operation_id);
assert.equal(state.applied, 1);
assert.deepEqual(await api.waitPcbLayout(first.operation_id), one);
assert.equal(state.applied, 1);
const second = await api.makePcbLayout('board.kicad_pcb', 'layout.js', 0);
await api.cancelPcbLayout(second.operation_id);
assert.equal(state.signal.aborted, true);
state.resolve({ pcb: {} });
await assert.rejects(api.waitPcbLayout(second.operation_id, 1000), /abort/i);
assert.equal(state.applied, 1);
assert.equal(state.lock, false);
await api.disposePcbLayoutBackend();
console.log('Local PCB operation tests passed');

const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
state.cacheDir = await mkdtemp(join(tmpdir(), 'pcb-lock-test-'));
try {
    const cacheBundle = await build({
        entryPoints: ['src/pcb/layout-cache.ts'], bundle: true, write: false, platform: 'node', format: 'esm',
        plugins: [{ name: 'cache-dependencies', setup(build) {
            build.onResolve({ filter: /^(sharp|\.\.\/utils\/dirs|\.\.\/types\/board-assemble)$/ }, args => ({ path: args.path, namespace: 'mock' }));
            build.onLoad({ filter: /.*/, namespace: 'mock' }, args => ({ contents:
                args.path === 'sharp' ? 'export default () => ({})' :
                args.path.endsWith('dirs') ? 'export const CACHE_DIR = globalThis.__layoutTest.cacheDir' :
                'export const BoardAssembleSchema = () => ({ parse: x => x })', loader: 'js' }));
        }}],
    });
    const cache = await import('data:text/javascript;base64,' + Buffer.from(cacheBundle.outputFiles[0].text).toString('base64'));
    const release = await cache.acquireLayoutLock();
    await assert.rejects(cache.acquireLayoutLock(), /already running/);
    await release();
    const lockPath = join(state.cacheDir, 'pcb-layout', 'active.lock');
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, token: 'stale' }));
    const releaseAfterStale = await cache.acquireLayoutLock();
    await releaseAfterStale();
    const simultaneous = await Promise.allSettled([cache.acquireLayoutLock(), cache.acquireLayoutLock()]);
    assert.equal(simultaneous.filter(item => item.status === 'fulfilled').length, 1);
    await simultaneous.find(item => item.status === 'fulfilled').value();
    console.log('PCB lock tests passed');
} finally {
    await rm(state.cacheDir, { recursive: true, force: true });
}
