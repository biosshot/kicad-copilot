import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { getProjectInfo } from '../src/kicad/project-tree';
import { getSchematic, getSchematicContext, getPcbSchematic } from '../src/kicad/schematic-reader';
import { extractCircuit } from '../src/circuit/extract';
import { beautifySchematic } from '../src/circuit/beautify';
import { prepareSchematicInput } from '../src/circuit/schematic-input';
import { projectConnections } from '../src/kicad/schematic-connectivity';
import { filePartUuid, nativeInstances, children, scalar, nativeProperty, sheetSymbolData, position, SheetAsset } from '../src/kicad/schematic-assets';
import { atom, parseSExpression } from '../src/kicad/sexpr/ast';
import { placeLocalSymbol } from '../src/kicad/local-symbol-writer';
import { HIERARCHICAL_DIRECTIONS, globalSignal, parseSignal } from '../src/kicad/scoped-signals';
import { schematicTemplate } from '../src/kicad/schematic-template';
import { createDocument } from '../src/kicad/create-document';
import type { CircuitAssembly, CircuitMod } from '../src/types/circuit';

const output = resolve('.test-output/hierarchy');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'run-'));
const main = join(directory, 'main.kicad_sch');
const adc = join(directory, 'adc.kicad_sch');
const rootUuid = randomUUID(), childUuid = randomUUID();
const ports = [{ name: 'IN', direction: 'input' }, { name: 'OUT', direction: 'output' }];
const sheetAsset: SheetAsset = { kind: 'sheet', partUuid: childUuid.replaceAll('-', ''), path: adc, source: '',
    ports, symbol: sheetSymbolData(ports) };
for (const rotate of [0, 90, 180, 270]) for (const mirror of [false, true]) {
    const component: CircuitAssembly['components'][number] = {
        designator: 'SHEET', part_uuid: sheetAsset.partUuid, block_name: '', value: '', search_query: '',
        pins: ports.map(p => ({ pin_number: p.name, name: p.name, signal_name: p.name })),
        pos: { x: 0, y: 0, ...sheetAsset.symbol, rotate, mirror },
    };
    const placed = placeLocalSymbol(sheetAsset, component, { x: 100, y: 100 }, main, main, [`/${rootUuid}`]);
    const sheet = parseSExpression(placed.text), at = position(sheet), size = position(sheet, 'size');
    assert.ok(Math.abs(at.x + size.x / 2 - 100) < 0.001 && Math.abs(at.y + size.y / 2 - 100) < 0.001,
        'rotating or mirroring a sheet must not move its center');
    for (const lead of placed.leads) {
        const port = children(sheet, 'pin').find(p => atom(p[1]) === lead.number)!;
        assert.equal(atom(port[2]), ports.find(p => p.name === lead.number)!.direction);
        assert.ok(Math.abs(Math.hypot(lead.end.x - lead.start.x, lead.end.y - lead.start.y) - 2.54) < 0.001);
        assert.ok(lead.end.x < at.x || lead.end.x > at.x + size.x || lead.end.y < at.y || lead.end.y > at.y + size.y,
            'routing terminals must be outside the visible sheet body');
    }
    component.pins.forEach(p => { p.signal_name = 'NC'; });
    assert.equal(placeLocalSymbol(sheetAsset, component, { x: 100, y: 100 }, main, main, [`/${rootUuid}`]).leads.length, 0,
        'no-connect markers must stay on physical pins, without wire stubs');
}
const empty = (uuid: string) => schematicTemplate({ uuid, major: 9 });
const resistor = `(symbol "Device:R" (pin_names (offset 0)) (in_bom yes) (on_board yes)
    (property "Reference" "R" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
    (property "Value" "R" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
    (symbol "R_0_1" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))
    (symbol "R_1_1"
        (pin passive line (at -2.54 0 0) (length 1.27) (name "1" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
        (pin passive line (at 2.54 0 180) (length 1.27) (name "2" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
const body = `(symbol (lib_id "Device:R") (at 50.8 50.8 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${randomUUID()}")
    (property "Reference" "R1" (at 50.8 48.26 0) (effects (font (size 1.27 1.27))))
    (property "Value" "10k" (at 50.8 53.34 0) (effects (font (size 1.27 1.27))))
    (property "Footprint" "User:KeepThis" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (hide yes)))
    (property "Custom" "preserve me" (at 50.8 50.8 0) (effects (font (size 1.27 1.27)) (hide yes))))
    (hierarchical_label "AIN" (shape input) (at 48.26 50.8 0) (effects (font (size 1.27 1.27))) (uuid "${randomUUID()}"))
    (label "FB" (at 53.34 50.8 0) (effects (font (size 1.27 1.27))) (uuid "${randomUUID()}"))`;
await writeFile(join(directory, 'main.kicad_pro'), '{}');
await writeFile(main, empty(rootUuid));
await writeFile(adc, empty(childUuid).replace('(lib_symbols)', `(lib_symbols ${resistor})`).replace(/\)\s*$/, `${body})`));
const mod = (add_components: CircuitMod['add_components'] = [], rm_components: string[] | null = null): CircuitMod => ({
    add_components, rm_components, add_reused_blocks: [], external_connect: null, external_rm_connect: null,
});
const part = (designator: string, uuid: string, pin: string, net: string) => ({ designator, part_uuid: uuid, value: 'adc',
    block_name: 'ADC', search_query: '', pins: [{ pin_number: pin, name: pin, signal_name: net }] });
const realFetch = globalThis.fetch;
try {
    const project = await getProjectInfo(join(directory, 'main.kicad_pro'));
    const adcInfo = project.projects[0].schematics.find(s => s.path === 'adc.kicad_sch')!;
    assert.equal(adcInfo.part_uuid, childUuid.replaceAll('-', ''));
    const native = (await getSchematic(adc)).components[0];
    assert.ok(native.part_uuid);
    // Only the known project-local assets miss the catalogue; layout still runs in the real backend.
    const localIds = new Set([adcInfo.part_uuid!, native.part_uuid]);
    let localCatalogueMisses = 0;
    globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
        const match = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
        if (match && localIds.has(decodeURIComponent(match[1]))) {
            localCatalogueMisses++;
            return Response.json({ success: false, result: null, msg: 'fixture asset is local' });
        }
        return realFetch(input, init);
    };
    assert.equal(native.footprint_name, 'User:KeepThis');
    await extractCircuit(main, mod([
        part('ADC_A', adcInfo.part_uuid!, 'AIN', 'local:ROOT:INPUT_A'),
        part('ADC_B', adcInfo.part_uuid!, 'AIN', 'local:ROOT:INPUT_B'),
        { ...part('R10', native.part_uuid!, '1', 'local:ROOT:INPUT_A'), value: '10k', pins: [
            { pin_number: '1', name: '1', signal_name: 'local:ROOT:INPUT_A' },
            { pin_number: '2', name: '2', signal_name: 'GND' },
        ] },
    ]));
    const first = await getSchematicContext(main);
    assert.equal(first.target.components.length, 3);
    assert.equal(first.target.components.find(c => c.designator === 'ADC_A')!.part_uuid, adcInfo.part_uuid);
    assert.equal(first.target.components.find(c => c.designator === 'ADC_B')!.part_uuid, adcInfo.part_uuid);
    const graph = projectConnections(main, first.files, first.assets);
    const a = graph.endpoints.get(`${filePartUuid(first.files.get(main)!)}/ADC_A.AIN`)!;
    const b = graph.endpoints.get(`${filePartUuid(first.files.get(main)!)}/ADC_B.AIN`)!;
    assert.notEqual(graph.graph.find(a), graph.graph.find(b));
    const nativeAfter = nativeInstances(first.files.get(main)!).find(n => n.reference === 'R10')!;
    assert.equal(nativeProperty(nativeAfter.instance, 'Custom'), 'preserve me');
    const nativeUuid = scalar(nativeAfter.instance, 'uuid');
    const sheetUuids = children(parseSExpression(first.files.get(main)!), 'sheet').map(s => scalar(s, 'uuid')).sort();
    const sheetPages = children(parseSExpression(first.files.get(main)!), 'sheet').flatMap(s =>
        children(s, 'instances').flatMap(i => children(i, 'project').flatMap(p => children(p, 'path').map(record => scalar(record, 'page')))));
    assert.equal(new Set(['1', ...sheetPages]).size, 3, 'repeated sheet instances need distinct page numbers');
    await beautifySchematic(main, { ADC: ['ADC_A', 'ADC_B', 'R10'] });
    const pretty = await getSchematicContext(main);
    assert.deepEqual(children(parseSExpression(pretty.files.get(main)!), 'sheet').map(s => scalar(s, 'uuid')).sort(), sheetUuids);
    assert.equal(scalar(nativeInstances(pretty.files.get(main)!).find(n => n.reference === 'R10')!.instance, 'uuid'), nativeUuid);
    assert.equal(nativeInstances(pretty.files.get(main)!).find(n => n.reference === 'R10')!.asset.partUuid, native.part_uuid);
    const exported = await getPcbSchematic(main);
    const pinNet = (reference: string, number: string) => exported.components.find(c => c.designator === reference)?.pins.find(p => String(p.pin_number) === number)?.signal_name;
    assert.ok(pinNet('R10', '1'));
    assert.equal(pinNet('R10', '1'), pinNet('R1', '1'), 'KiCad must connect ADC_A to R10');
    assert.notEqual(pinNet('R1', '1'), pinNet('R2', '1'), 'KiCad must separate the two inputs');
    assert.notEqual(pinNet('R1', '2'), pinNet('R2', '2'), 'KiCad must separate the two internal local nets');
    await assert.rejects(prepareSchematicInput(main, mod([part('BAD', native.part_uuid!, '1', 'local:adc:FB')])), /another sheet/);
    await assert.rejects(prepareSchematicInput(adc, mod([part('LOOP', adcInfo.part_uuid!, 'AIN', 'GND')])), /descendant/);
    await assert.rejects(prepareSchematicInput(main, mod([part('BAD', adcInfo.part_uuid!, 'UNKNOWN', 'GND')])), /unknown pin/);
    const childBefore = await readFile(adc, 'utf8');
    await extractCircuit(main, mod([], ['ADC_A']));
    assert.ok(!(await getSchematic(main)).components.some(c => c.designator === 'ADC_A'));
    assert.equal(filePartUuid(await readFile(adc, 'utf8')), filePartUuid(childBefore));
    assert.ok((await getSchematic(main)).components.some(c => c.designator === 'ADC_B'));
    const nested = join(directory, 'nested.kicad_sch');
    await createDocument({ doc_type: 'schematic_page', path: nested, parent_path: main });
    await extractCircuit(nested, mod([part('ADC_C', adcInfo.part_uuid!, 'AIN', 'GND')]));
    assert.ok((await getSchematic(nested)).components.some(c => c.designator === 'ADC_C'));
    const expose = mod();
    expose.external_rm_connect = [{ designator: 'R1', pin_number: '2' }];
    expose.external_connect = [{ designator: 'R1', pin_number: '2', signal_name: 'hier_output:adc:OUT/SENSE:A~B' }];
    await extractCircuit(adc, expose);
    assert.ok((await getSchematic(main)).components.find(c => c.designator === 'ADC_B')!.pins.some(p => p.name === 'OUT/SENSE:A~B'));
    assert.ok((await getSchematic(nested)).components.find(c => c.designator === 'ADC_C')!.pins.some(p => p.name === 'OUT/SENSE:A~B'));
    await extractCircuit(main, mod([{ ...part('R20', native.part_uuid!, '1', 'hier:ADC_B:OUT/SENSE:A~B'), pins: [
        { pin_number: '1', name: '1', signal_name: 'hier:ADC_B:OUT/SENSE:A~B' },
        { pin_number: '2', name: '2', signal_name: 'GND' },
    ] }]));
    const connectedParent = await getSchematic(main);
    const outputSignal = connectedParent.components.find(c => c.designator === 'ADC_B')!.pins.find(p => p.name === 'OUT/SENSE:A~B')!.signal_name;
    assert.ok(outputSignal);
    assert.equal(connectedParent.components.find(c => c.designator === 'R20')!.pins.find(p => String(p.pin_number) === '1')!.signal_name, outputSignal);
    for (const direction of HIERARCHICAL_DIRECTIONS) {
        const signal = `hier_${direction}:adc:OUT/SENSE:A~B`;
        assert.deepEqual(parseSignal(signal), { kind: 'hier', sheet: 'adc', name: 'OUT/SENSE:A~B', direction });
        const change = mod();
        change.external_connect = [{ designator: 'R1', pin_number: '2', signal_name: signal }];
        await extractCircuit(adc, change);
        assert.equal((await getSchematic(adc)).components.find(c => c.designator === 'R1')!.pins.find(p => p.pin_number === '2')!.signal_name, signal);
        for (const parent of [main, nested]) {
            const root = parseSExpression(await readFile(parent, 'utf8'));
            for (const sheet of children(root, 'sheet').filter(s => nativeProperty(s, 'Sheetfile') === 'adc.kicad_sch')) {
                assert.equal(atom(children(sheet, 'pin').find(p => atom(p[1]) === 'OUT/SENSE:A~B')![2]), direction);
            }
        }
        const prepared = await prepareSchematicInput(adc, change);
        assert.equal(prepared.circuit.external_connect![0].signal_name, 'hier:adc:OUT/SENSE:A~B');
    }
    const preserveType = mod();
    preserveType.external_connect = [{ designator: 'R1', pin_number: '2', signal_name: 'hier:adc:OUT/SENSE:A~B' }];
    await extractCircuit(adc, preserveType);
    assert.equal((await getSchematic(adc)).components.find(c => c.designator === 'R1')!.pins.find(p => p.pin_number === '2')!.signal_name,
        'hier_passive:adc:OUT/SENSE:A~B');
    const beforeTypeErrors = await Promise.all([main, adc, nested].map(p => readFile(p, 'utf8')));
    await assert.rejects(extractCircuit(main, mod([part('BAD_TYPE', native.part_uuid!, '1', 'hier_input:ADC_B:OUT/SENSE:A~B')])), /direction mismatch/);
    const conflictingTypes = mod();
    conflictingTypes.external_connect = [
        { designator: 'R1', pin_number: '1', signal_name: 'hier_input:adc:OUT/SENSE:A~B' },
        { designator: 'R1', pin_number: '2', signal_name: 'hier_output:adc:OUT/SENSE:A~B' },
    ];
    await assert.rejects(extractCircuit(adc, conflictingTypes), /conflicting hierarchical directions/);
    assert.deepEqual(await Promise.all([main, adc, nested].map(p => readFile(p, 'utf8'))), beforeTypeErrors);
    assert.throws(() => parseSignal('hier_unknown:adc:AIN'), /invalid hierarchical direction/);
    assert.equal(globalSignal('hier_input:adc:AIN'), 'global:hier_input:adc:AIN');
    assert.deepEqual(parseSignal('local:ROOT:VIN/SENSE:A~B'), { kind: 'local', sheet: 'ROOT', name: 'VIN/SENSE:A~B' });
    assert.deepEqual(parseSignal('global:NC'), { kind: 'global', name: 'NC' });
    assert.equal(parseSignal('NC').kind, 'nc');
    await extractCircuit(main, mod([{ ...part('R99', native.part_uuid!, '1', 'NC'), pins: [
        { pin_number: '1', name: '1', signal_name: 'NC' },
        { pin_number: '2', name: '2', signal_name: 'global:NC' },
    ] }]));
    const ncComponent = (await getSchematic(main)).components.find(c => c.designator === 'R99')!;
    assert.equal(ncComponent.pins[0].signal_name, 'NC');
    assert.equal(ncComponent.pins[1].signal_name, 'global:NC');
    const multi = join(directory, 'multi.kicad_sch');
    const dualLibrary = `(symbol "Test:Dual" (in_bom yes) (on_board yes)
        (property "Reference" "U" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
        (property "Value" "Dual" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
        (symbol "Dual_0_1" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))
        (symbol "Dual_1_1" (pin passive line (at -2.54 0 0) (length 1.27) (name "A" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27))))))
        (symbol "Dual_2_1" (pin passive line (at 2.54 0 180) (length 1.27) (name "B" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
    const units = [1, 2].map(unit => `(symbol (lib_id "Test:Dual") (at ${unit * 25.4} 50.8 90) (mirror y) (unit ${unit})
        (in_bom yes) (on_board yes) (dnp yes) (uuid "${randomUUID()}")
        (property "Reference" "U1" (at ${unit * 25.4} 48.26 0) (effects (font (size 1.27 1.27))))
        (property "Value" "Dual" (at ${unit * 25.4} 53.34 0) (effects (font (size 1.27 1.27)))))
        (global_label "UNIT_${unit}" (shape bidirectional) (at ${unit * 25.4} ${unit === 1 ? 48.26 : 53.34} 0)
            (effects (font (size 1.27 1.27))) (uuid "${randomUUID()}"))`).join('\n');
    await writeFile(multi, empty(randomUUID()).replace('(lib_symbols)', `(lib_symbols ${dualLibrary})`).replace(/\)\s*$/, `${units})`));
    const multiBefore = await getSchematic(multi);
    for (const component of multiBefore.components) if (component.part_uuid) localIds.add(component.part_uuid);
    assert.deepEqual(multiBefore.components.map(c => c.designator), ['U1.1', 'U1.2']);
    assert.deepEqual(multiBefore.components.map(c => c.pins.map(p => p.pin_number)), [['1'], ['2']]);
    await beautifySchematic(multi, { Units: ['U1'] });
    const multiAfter = await getPcbSchematic(multi);
    const allUnitPins = multiAfter.components.flatMap(c => c.pins);
    assert.equal(allUnitPins.find(p => String(p.pin_number) === '1')?.signal_name, 'UNIT_1');
    assert.equal(allUnitPins.find(p => String(p.pin_number) === '2')?.signal_name, 'UNIT_2');
    assert.ok(nativeInstances(await readFile(multi, 'utf8')).every(n => scalar(n.instance, 'dnp') === 'yes'));
    await extractCircuit(multi, mod([], ['U1.2']));
    assert.deepEqual((await getSchematic(multi)).components.map(c => c.designator), ['U1.1']);
    assert.equal((await getPcbSchematic(multi)).components.flatMap(c => c.pins).find(p => String(p.pin_number) === '1')?.signal_name, 'UNIT_1');
    const saved = await readFile(main, 'utf8');
    const savedChild = await readFile(adc, 'utf8');
    await assert.rejects(extractCircuit(main, mod([part('FAIL', native.part_uuid!, '1', 'GND')]), {
        onAssembly: assembly => { assembly.components = []; assembly.edges = []; assembly.rm_components = ['ADC_B']; },
    }));
    assert.equal(await readFile(main, 'utf8'), saved, 'a failed operation must restore the parent');
    assert.equal(await readFile(adc, 'utf8'), savedChild, 'a failed operation must restore child instance annotations');
    const source = await readFile(main, 'utf8');
    assert.ok(!/\((?:label|global_label|hierarchical_label)\s+"(?:local|global|hier):/.test(source));
    assert.ok(localCatalogueMisses > 0, 'local fixtures must exercise catalogue fallback');
    console.log(`Hierarchy integration passed with the local backend. Fixtures: ${directory}`);
} finally {
    globalThis.fetch = realFetch;
}
