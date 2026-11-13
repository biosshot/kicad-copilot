import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { openMcpClient } from '../src/mcp-client';
import { getProjectNetlist } from '../src/kicad/schematic-reader';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { runProcess } from '../src/utils/process';
import { children, nativeProperty, position, scalar } from '../src/kicad/schematic-assets';
import { atom, parseSExpression } from '../src/kicad/sexpr/ast';
import type { CircuitMod, ExplainCircuit } from '../src/types/circuit';

const output = resolve('.test-output/mcp-ldo');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'run-'));
console.log(`Fixtures: ${directory}`);
const main = join(directory, 'main.kicad_sch');
const child = join(directory, 'ldo.kicad_sch');
const client = await openMcpClient();
const requests: { name: string; arguments: Record<string, unknown> }[] = [];
async function call(name: string, args: Record<string, unknown>): Promise<any> {
    requests.push({ name, arguments: args });
    await writeFile(join(directory, 'calls.json'), JSON.stringify(requests, null, 2));
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
    await writeFile(join(directory, `${requests.length}-${name}.json`), JSON.stringify(response, null, 2));
    const text = (response.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (response.isError) throw new Error(`${name}: ${text}`);
    console.log(`ok ${requests.length} ${name}`);
    try { return JSON.parse(text); } catch { return text; }
}
const pins = (nets: Record<string, string>) => Object.entries(nets).map(([pin_number, signal_name]) => ({ pin_number, name: pin_number, signal_name }));
const part = (designator: string, part_uuid: string, nets: Record<string, string>, value: string, block_name = 'LDO'): CircuitMod['add_components'][number] => ({
    designator, part_uuid, pins: pins(nets), value, block_name, search_query: value,
});
const modify = (path: string, add_components: CircuitMod['add_components'] = [], rest: Partial<CircuitMod> = {}) => call('extract_circuit', {
    path, add_components, add_reused_blocks: [], rm_components: null, external_connect: null, external_rm_connect: null, ...rest,
});
try {
    await call('create_doc', { doc: { doc_type: 'project', path: join(directory, 'main.kicad_pro') } });
    await call('create_doc', { doc: { doc_type: 'schematic_page', path: child, parent_path: main } });
    const regulator = await call('component_search', { part_uuid: '8c72fdff8032447e8704660d377171f6' });
    const capacitor = await call('component_search', { part_uuid: 'e10bc30d72324129a5b7daae4e75f56f' });
    const connector = await call('component_search', { part_uuid: '9cdd746789df4eb5b83f56551b6edd1b' });
    const connectorId = connector.bestComponent?.part_uuid;
    assert.ok(connectorId, 'connector lookup must return an exact part_uuid');
    assert.equal(regulator.bestComponent.part_uuid, '8c72fdff8032447e8704660d377171f6');
    assert.equal(connectorId, '9cdd746789df4eb5b83f56551b6edd1b');
    await modify(child, [
        part('U1', regulator.bestComponent.part_uuid, { '1': 'hier:ldo:VIN', '2': 'GND', '3': 'hier:ldo:VIN', '4': 'NC', '5': 'hier:ldo:3.3V' }, 'AP2112K-3.3TRG1'),
        part('C1', capacitor.bestComponent.part_uuid, { '1': 'hier:ldo:VIN', '2': 'GND' }, '10uF'),
        part('C2', capacitor.bestComponent.part_uuid, { '1': 'hier:ldo:3.3V', '2': 'GND' }, '10uF'),
    ]);
    await call('beautify_schematic', { path: child, blocks: { LDO: ['U1', 'C1', 'C2'] } });
    const project = await call('get_project_info', { path: join(directory, 'main.kicad_pro') });
    const root = project.projects[0].schematics.find((s: any) => s.path === 'main.kicad_sch');
    const sheetId = root.sheets.find((s: any) => s.path === 'ldo.kicad_sch').part_uuid;
    const sheetInfo = await call('component_search', { part_uuid: sheetId });
    assert.deepEqual(sheetInfo.bestComponent.pins.map((p: any) => p.pin_number).sort(), ['3.3V', 'VIN']);
    const restarted = await openMcpClient();
    try {
        const local = await restarted.callTool({ name: 'component_search', arguments: { part_uuid: sheetId } });
        assert.ok(!local.isError, 'sheet lookup after restart must resolve the local project');
        const result = JSON.parse((local.content as { text: string }[])[0].text);
        assert.equal(result.bestComponent.part_uuid, sheetId);
        assert.deepEqual(result.bestComponent.pins, sheetInfo.bestComponent.pins);
        console.log('ok local component_search after MCP restart');
    } finally { await restarted.close(); }
    await modify(main, [
        part('LDO_DIG', sheetId, { VIN: 'local:ROOT:VIN_5V', '3.3V': 'local:ROOT:3.3DIG' }, 'LDO_3V3', 'Digital'),
        part('LDO_ANALOG', sheetId, { VIN: 'local:ROOT:VIN_5V', '3.3V': 'local:ROOT:3.3ANALOG' }, 'LDO_3V3', 'Analog'),
        part('J1', connectorId, { '1': 'local:ROOT:VIN_5V', '2': 'GND' }, 'VIN_5V', 'Input'),
        part('J2', connectorId, { '1': 'hier:LDO_DIG:3.3V', '2': 'GND' }, '3.3DIG', 'Digital'),
        part('J3', connectorId, { '1': 'hier:LDO_ANALOG:3.3V', '2': 'GND' }, '3.3ANALOG', 'Analog'),
    ], { rm_components: ['ldo'] });
    const before: ExplainCircuit = await call('get_schematic', { path: main });
    assert.equal(before.components.length, 5);
    const pin = (c: ExplainCircuit, ref: string, number: string) => c.components.find(c => c.designator === ref)!.pins.find(p => String(p.pin_number) === number)!.signal_name;
    assert.equal(pin(before, 'J2', '1'), pin(before, 'LDO_DIG', '3.3V'));
    assert.equal(pin(before, 'J3', '1'), pin(before, 'LDO_ANALOG', '3.3V'));
    assert.notEqual(pin(before, 'J2', '1'), pin(before, 'J3', '1'));
    await call('beautify_schematic', { path: main, blocks: { Input: ['J1'], Digital: ['LDO_DIG', 'J2'], Analog: ['LDO_ANALOG', 'J3'] } });
    const after: ExplainCircuit = await call('get_schematic', { path: main });
    for (const c of before.components) for (const p of c.pins) assert.equal(pin(after, c.designator, String(p.pin_number)), p.signal_name);
    const netlist = (await getProjectNetlist(main)).circuit;
    assert.equal(netlist.components.length, 9);
    const regulators = netlist.components.filter(c => c.value === 'AP2112K-3.3TRG1');
    assert.equal(regulators.length, 2);
    const outputs = regulators.map(c => pin(netlist, c.designator, '5'));
    assert.notEqual(outputs[0], outputs[1]);
    assert.deepEqual(new Set(outputs), new Set([pin(netlist, 'J2', '1'), pin(netlist, 'J3', '1')]));
    for (const c of regulators) assert.equal(pin(netlist, c.designator, '1'), pin(netlist, 'J1', '1'));
    for (const c of regulators) assert.equal(pin(netlist, c.designator, '2'), 'GND');
    for (const [path, expectedGrounds] of [[main, 3], [child, 1]] as const) {
        const source = parseSExpression(await readFile(path, 'utf8'));
        const grounds = children(source, 'symbol').filter(s => scalar(s, 'lib_id') === 'power:GNDREF');
        assert.equal(grounds.length, expectedGrounds, 'one three-bar ground per connected wire group');
        assert.ok(grounds.every(s => nativeProperty(s, 'Value') === 'GND'));
        assert.ok(!children(source, 'global_label').some(s => atom(s[1]) === 'GND'));
        for (const sheet of children(source, 'sheet')) {
            const size = position(sheet, 'size');
            assert.ok(Math.max(size.x, size.y) <= 15.24 && Math.min(size.x, size.y) <= 10.16,
                'two short ports must produce a compact sheet body');
            const wires = children(source, 'wire').flatMap(w => children(w, 'pts').map(pts => children(pts, 'xy')
                .map(p => ({ x: Number(atom(p[1])), y: Number(atom(p[2])) }))));
            for (const port of children(sheet, 'pin')) {
                const p = position(port);
                const lead = wires.find(w => w.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 0.001));
                assert.ok(lead && Math.hypot(lead[0].x - lead[1].x, lead[0].y - lead[1].y) >= 2.54 - 0.001,
                    'each connected sheet port needs a wire lead outside the body');
            }
        }
    }
    await writeFile(join(directory, 'netlist.json'), JSON.stringify(netlist, null, 2));
    const cli = await getSupportedKicadCli();
    const preview = await runProcess(cli.path, ['sch', 'export', 'svg', '-o', join(directory, 'preview'), main]);
    assert.equal(preview.exitCode, 0, preview.stderr);
    console.log('MCP LDO integration passed: two reusable LDOs, three catalogue connectors, beautification, native KiCad connectivity.');
} finally { await client.close(); }
