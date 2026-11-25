import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const cli = resolve(process.argv[2] ?? 'dist/cli.js');
const output = resolve('.test-output');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'analysis-v2-'));
const env = { ...process.env, KICAD_COPILOT_CLI_HOME: join(directory, 'sessions') };
if (process.platform === 'win32') Object.assign(env, { TEMP: directory, TMP: directory });
const run = (...args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, result.error?.message ?? (result.stderr || result.stdout));
    return result.stdout.trim();
};
const readJson = async path => JSON.parse(await readFile(path, 'utf8'));

const session = run('start');
try {
    const call = (tool, args) => {
        const reply = JSON.parse(run(session, 'call', tool, JSON.stringify(args)));
        assert.equal(reply.isError, undefined, JSON.stringify(reply));
        return JSON.parse(reply.content[0].text);
    };
    async function settled(result) {
        while (result.status === 'running' || result.status === 'cancel_requested') {
            result = call('wait_operation', { operation_id: result.operation_id, wait_ms: 5000 });
        }
        return result;
    }
    const path = resolve('examples/dcdc-hierarchical/DCDC_Acceptance.kicad_pcb');
    const original = await readFile(path);
    const exported = call('export_pcb_routing_board', { path });
    assert.equal(exported.format, 'RoutingBoardV2');
    const snapshot = await readJson(exported.path);
    const { board } = snapshot;
    assert.equal(board.components.length, 28);
    assert.equal(board.holes.length, 4);
    assert.equal(board.copper.fixed.vias.length, 71);
    assert.equal(board.copper.fixed.tracks.length, 196);
    assert.equal(board.copper.fixed.zones.length, 2);
    assert(board.copper.fixed.zones.every(zone =>
        zone.kind === 'pour' && zone.filledPolygons.every(fill => fill.status === 'available' && fill.freshness === 'unknown')));
    assert(board.copper.fixed.zones.some(zone =>
        zone.filledPolygons.some(fill => fill.polygons.some(polygon => polygon.holes?.length))));
    assert.deepEqual(board.stackup.layers.map(layer => layer.kind === 'copper' ? layer.layer : layer.material),
        ['TOP', 'FR-4', 'BOTTOM']);
    assert(board.pads.some(pad => pad.component === 'U2' && pad.number === '5' && Math.abs(pad.rotationDeg) === 90));
    const sandboxPath = join(directory, 'unfilled.kicad_pcb');
    await writeFile(sandboxPath, original.toString('utf8').replaceAll('(filled_polygon ', '(ignored_polygon '));
    const unfilled = await readJson(call('export_pcb_routing_board', { path: sandboxPath }).path);
    assert(unfilled.board.copper.fixed.zones.every(zone => zone.filledPolygons.every(fill => fill.status === 'missing')));

    const geometry = await settled(call('run_pcb_analysis', {
        path, file: resolve('docs/pcb-analysis/examples/connectivity.js'), wait_ms: 1000,
    }));
    assert.equal(geometry.status, 'complete', JSON.stringify(geometry));
    assert.equal(geometry.calculations[0].analysis, 'geometry');
    assert.equal(geometry.calculations[0].status, 'partial');
    assert(geometry.diagnostic_codes.includes('fill_freshness'));
    assert.deepEqual(await readJson(geometry.board_path), snapshot);
    assert.deepEqual(await readFile(path), original);

    const coupon = join(directory, 'coupon.kicad_pcb');
    await writeFile(coupon, `(kicad_pcb (version 20260206) (generator pcbnew)
      (general (thickness 1.6))
      (layers (0 "F.Cu" signal) (2 "B.Cu" signal) (25 "Edge.Cuts" user))
      (gr_rect (start 0 0) (end 14 11) (stroke (width 0.05) (type default)) (fill no) (layer "Edge.Cuts"))
      (footprint "Coupon:Contact" (layer "F.Cu") (at 2.5 3)
        (property "Reference" "J1")
        (pad "1" smd rect (at 0 0) (size 1 2) (layers "F.Cu") (net "VCC"))
        (pad "2" smd rect (at 0 5) (size 1 2) (layers "F.Cu") (net "GND")))
      (footprint "Coupon:Contact" (layer "F.Cu") (at 11.5 3)
        (property "Reference" "J2")
        (pad "1" smd rect (at 0 0) (size 1 2) (layers "F.Cu") (net "VCC"))
        (pad "2" smd rect (at 0 5) (size 1 2) (layers "F.Cu") (net "GND")))
      (segment (start 2.5 3) (end 11.5 3) (width 2) (layer "F.Cu") (net "VCC"))
      (segment (start 2.5 8) (end 11.5 8) (width 2) (layer "F.Cu") (net "GND")))`);
    const dcFile = join(directory, 'dc.js');
    await writeFile(dcFile, `
        const a = analysis({ board });
        const source = a.port({ positive: pad('J1', '1'), negative: pad('J1', '2') });
        const load = a.port({ positive: pad('J2', '1'), negative: pad('J2', '2') });
        const dc = await a.dc().stackup(stackup({ layers: [
            { kind: 'copper', name: 'TOP', thicknessMm: 0.035, material: 'cu' },
            { kind: 'dielectric', name: 'core', thicknessMm: 1.53, material: 'core' },
            { kind: 'copper', name: 'BOTTOM', thicknessMm: 0.035, material: 'cu' },
        ] })).materials({ cu: { conductivitySM: 58e6, state: 'test coupon, 20 C' }, core: { state: 'insulating' } })
            .sources([{ port: source, voltageV: 1, model: 'ideal' }])
            .loads([{ port: load, currentA: 1 }]).run();
        a.check({ name: 'Expected load voltage', actual: dc.voltage(load), min: 0.99, max: 0.999, unit: 'V' });
        a.plot({ title: 'Voltage', data: dc.voltageMap });
        const thermal = await a.thermal().losses(dc.lossMap).materials({
            cu: { thermalConductivityWPerMK: 390, source: 'test coupon', state: 'constant' },
            core: { thermalConductivityWPerMK: 0.3, source: 'test coupon', state: 'constant' },
        }).stackup(stackup({ layers: [
            { kind: 'copper', name: 'TOP', thicknessMm: 0.035, material: 'cu', backgroundMaterial: 'core' },
            { kind: 'dielectric', name: 'core', thicknessMm: 1.53, material: 'core' },
            { kind: 'copper', name: 'BOTTOM', thicknessMm: 0.035, material: 'cu', backgroundMaterial: 'core' },
        ] })).mesh({ maxEdgeMm: 2, maxNodes: 20_000 }).environment({ name: 'room', ambientC: 25 })
            .cooling({ boardSurfaces: a.model({ kind: 'cooling', resistanceKPerW: 35 }) }).domain('steady').run();
        a.check({ name: 'Temperature above ambient', actual: thermal.temperatureMap.max(), min: 25, unit: 'degC' });
    `);
    const dc = await settled(call('run_pcb_analysis', { path: coupon, file: dcFile, wait_ms: 1000 }));
    assert.equal(dc.status, 'complete', JSON.stringify(dc));
    assert.equal(dc.calculations[0].status, 'complete', JSON.stringify(dc));
    assert.equal(dc.calculations[1].status, 'complete', JSON.stringify(dc));
    assert.equal(dc.checks.pass, 2, JSON.stringify(dc));
    assert(dc.images.some(image => image.name.includes('voltage')), JSON.stringify(dc));
    assert(dc.images.some(image => image.name.includes('temperature')), JSON.stringify(dc));
    for (const image of dc.images) {
        assert.equal((await readFile(image.image_path)).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    }

    const slow = join(directory, 'slow.js');
    await writeFile(slow, 'while (true) {}');
    const pending = call('run_pcb_analysis', { path: coupon, file: slow, wait_ms: 1000 });
    assert.match(pending.operation_id, /^pcb-analysis:[a-f0-9]{8}$/);
    assert.equal(pending.status, 'running');
    const cancelled = await settled(call('cancel_operation', { operation_id: pending.operation_id }));
    assert.equal(cancelled.status, 'cancelled');
    const rerun = await settled(call('run_pcb_analysis', { path: coupon, file: dcFile, wait_ms: 1000 }));
    assert.equal(rerun.status, 'complete');
    console.log(`Board V2, native DC and thermal, PNG reports and cancellation passed. Artifacts in ${directory}`);
} finally {
    run(session, 'stop');
}
