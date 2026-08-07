#!/usr/bin/env node

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beautifySchematic } from '../src/circuit/beautify';
import { listCheckpoints, saveCheckpoint } from '../src/checkpoints/store';
import { extractCircuit } from '../src/circuit/extract';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { createDocument } from '../src/kicad/create-document';
import { getProjectInfo } from '../src/kicad/project-tree';
import { getSchematic } from '../src/kicad/schematic-reader';
import { parseSExpression, printSExpression } from '../src/kicad/sexpr/ast';
import { findLists } from '../src/kicad/sexpr/scan';
import { normalizedComponentSymbol } from '../src/kicad/symbol';
import { planWireRemoval, wireRangesToDisconnect } from '../src/kicad/wire-removal';
import { CircuitMod, CircuitModStruct, ExplainCircuit } from '../src/types/circuit';
import { runProcessChecked } from '../src/utils/process';

const RESISTOR_A = 'fa459f1466df4014badd43e0b80fd058';
const RESISTOR_B = '37d3a2df709e430798d37c76a1425062';

function resistor(designator: string, partUuid = RESISTOR_A, value = '10k') {
    return {
        designator,
        value,
        block_name: 'assembly_test',
        search_query: '10k 1% 0603 resistor',
        part_uuid: partUuid,
        pins: [
            { pin_number: '1', name: '1', signal_name: '' },
            { pin_number: '2', name: '2', signal_name: '' },
        ],
    };
}

function modification(overrides: Partial<CircuitMod> = {}): CircuitMod {
    return {
        add_components: [],
        add_reused_blocks: [],
        rm_components: null,
        external_connect: null,
        external_rm_connect: null,
        ...overrides,
    };
}

function component(circuit: ExplainCircuit, designator: string) {
    return circuit.components.find((item) => item.designator === designator);
}

function expect(condition: unknown, message: string): asserts condition {
    if (!condition) throw new Error(message);
}

function expectComponent(
    circuit: ExplainCircuit,
    designator: string,
    expected: { partUuid?: string; value?: string; blockName?: string } = {},
) {
    const actual = component(circuit, designator);
    expect(actual, `${designator}: component missing`);
    if (expected.partUuid) {
        expect(actual.part_uuid === expected.partUuid,
            `${designator}: expected part_uuid ${expected.partUuid}, got ${actual.part_uuid}`);
    }
    if (expected.value) {
        expect(actual.value === expected.value,
            `${designator}: expected value ${expected.value}, got ${actual.value}`);
    }
    if (expected.blockName) {
        expect(actual.block_name === expected.blockName,
            `${designator}: expected block_name ${expected.blockName}, got ${actual.block_name || '<empty>'}`);
    }
    return actual;
}

function placedObjectUuids(source: string) {
    const output = new Set<string>();
    for (const head of ['symbol', 'wire', 'junction', 'label', 'global_label', 'hierarchical_label', 'no_connect']) {
        for (const range of findLists(source, head)) {
            if (head === 'symbol' && !range.text.includes('(lib_id ')) continue;
            const uuid = range.text.match(/\(uuid\s+"([^"]+)"\)/)?.[1];
            if (uuid) output.add(uuid);
        }
    }
    return output;
}

function expectSignal(circuit: ExplainCircuit, designator: string, pin: string, signal: string) {
    const actual = expectComponent(circuit, designator);
    const actualPin = actual.pins.find((item) => String(item.pin_number) === pin);
    expect(actualPin, `${designator}.${pin}: pin missing`);
    expect(actualPin.signal_name === signal,
        `${designator}.${pin}: expected ${signal}, got ${actualPin.signal_name || '<empty>'}`);
}

async function createSchematic(directory: string) {
    const path = join(directory, 'test.kicad_sch');
    await mkdir(directory, { recursive: true });
    await createDocument({ doc_type: 'project', path: join(directory, 'test.kicad_pro') });
    return path;
}

async function copySchematic(source: string, directory: string) {
    const path = join(directory, 'test.kicad_sch');
    await mkdir(directory, { recursive: true });
    await copyFile(source, path);
    const sourceProject = join(dirname(source), 'test.kicad_pro');
    await copyFile(sourceProject, join(directory, 'test.kicad_pro')).catch(() => undefined);
    return path;
}

async function runScenario(name: string, test: () => Promise<void>) {
    const started = Date.now();
    await test();
    console.log(`ok ${name} (${Date.now() - started} ms)`);
}

async function extractScenario(path: string, circuit: CircuitMod) {
    return extractCircuit(path, circuit, {
        onAssembly: (assembly) => writeFile(
            join(dirname(path), 'server-assembly.json'),
            `${JSON.stringify(assembly, null, 2)}\n`,
            'utf8',
        ),
    });
}

async function ercReport(path: string) {
    const cli = await getSupportedKicadCli();
    const report = join(dirname(path), 'erc.rpt');
    await runProcessChecked(cli.path, ['sch', 'erc', '--output', report, path], { timeoutMs: 60_000 });
    return readFile(report, 'utf8');
}

async function main() {
    const root = await mkdtemp(join(tmpdir(), 'kicad-copilot-assembly-'));
    let completed = false;
    try {
        await runScenario('wire removal to junction', async () => {
            const source = `(kicad_sch
                (wire (pts (xy 0 0) (xy 10 0)))
                (wire (pts (xy 10 0) (xy 10 10)))
                (wire (pts (xy 10 10) (xy 20 10)))
                (junction (at 20 10))
                (wire (pts (xy 20 10) (xy 30 10)))
                (wire (pts (xy 20 10) (xy 20 20))))`;
            const removed = wireRangesToDisconnect(source, [{ x: 0, y: 0 }], []);
            expect(removed.length === 3,
                `wire removal: expected 3 segments before junction, got ${removed.length}`);
            expect(removed.some((range) => range.text.includes('(xy 10 10) (xy 20 10)')),
                'wire removal: segment after the bend was not removed');
            expect(!removed.some((range) => range.text.includes('(xy 20 10) (xy 30 10)')),
                'wire removal: traversal continued beyond the junction');
        });

        await runScenario('complete deleted wire island cleanup', async () => {
            const source = `(kicad_sch
                (wire (pts (xy 0 0) (xy 10 0)))
                (wire (pts (xy 10 0) (xy 20 0)))
                (junction (at 10 0))
                (wire (pts (xy 10 0) (xy 10 10))))`;
            const plan = planWireRemoval(source, [{ x: 0, y: 0 }], []);
            expect(plan.removed.length === 3,
                `wire island cleanup: expected all 3 segments, got ${plan.removed.length}`);
            expect(plan.retained.length === 0,
                'wire island cleanup: dangling segments were retained');
        });

        await runScenario('shared wire branch cleanup', async () => {
            const source = `(kicad_sch
                (wire (pts (xy 0 0) (xy 20 0)))
                (junction (at 10 0))
                (wire (pts (xy 10 0) (xy 10 10))))`;
            const plan = planWireRemoval(
                source,
                [{ x: 10, y: 10 }],
                [{ x: 20, y: 0 }],
            );
            expect(plan.removed.length === 1,
                `shared branch cleanup: expected one branch, got ${plan.removed.length}`);
            expect(plan.removed[0].range.text.includes('(xy 10 0) (xy 10 10)'),
                'shared branch cleanup: wrong branch removed');
            expect(plan.retained.length === 1,
                'shared branch cleanup: retained net was damaged');
        });

        await runScenario('electrical pin type normalization', async () => {
            const source = parseSExpression(`(symbol "TEST"
                (property "Footprint" "component:TEST")
                (symbol "TEST_0_1"
                    (pin unspecified line (at 0 0 0) (length 2.54)
                        (name "VCC") (number "1"))
                    (pin unspecified line (at 0 0 0) (length 2.54)
                        (name "OUT") (number "2"))
                    (pin unspecified line (at 0 0 0) (length 2.54)
                        (name "TRIG") (number "3"))))`);
            const ic = printSExpression(normalizedComponentSymbol(source, 'U1'));
            expect(ic.includes('(pin power_in line'), 'pin types: VCC is not Power input');
            expect(ic.includes('(pin output line'), 'pin types: OUT is not Output');
            expect(ic.includes('(pin input line'), 'pin types: TRIG is not Input');
            const passive = printSExpression(normalizedComponentSymbol(source, 'R1'));
            expect((passive.match(/\(pin passive line/g) || []).length === 3,
                'pin types: passive component pins are not Passive');
        });

        await runScenario('unknown circuit fields rejected', async () => {
            const parsed = CircuitModStruct().safeParse({
                ...modification(),
                add_nets: [{ designator: 'J2', pin_number: 1, signal_name: 'RX' }],
            });
            expect(!parsed.success, 'unknown circuit field add_nets was silently ignored');
        });

        const blank = await createSchematic(join(root, 'blank'));
        const fixture = await copySchematic(blank, join(root, 'fixture'));
        await extractCircuit(fixture, modification({
            add_components: [resistor('R1'), resistor('R2')],
        }));
        expectComponent(await getSchematic(fixture), 'R1', {
            partUuid: RESISTOR_A,
            blockName: 'assembly_test',
        });
        expectComponent(await getSchematic(fixture), 'R2', { partUuid: RESISTOR_A });
        const fixtureSource = await readFile(fixture, 'utf8');
        expect(fixtureSource.includes('(pin passive line'),
            'pin types: resistor pins are not passive');
        expect(fixtureSource.includes('kicad-copilot:C98220_R0603'),
            'project library: footprint link was not normalized');
        expect((await readFile(join(dirname(fixture), 'sym-lib-table'), 'utf8')).includes('kicad-copilot'),
            'project library: symbol table entry missing');
        expect((await readFile(join(dirname(fixture), 'fp-lib-table'), 'utf8')).includes('kicad-copilot'),
            'project library: footprint table entry missing');
        await readFile(join(dirname(fixture), 'kicad-copilot.pretty', 'C98220_R0603.kicad_mod'));

        await runScenario('checkpoint pagination', async () => {
            await saveCheckpoint(fixture, 'Pagination test 1');
            await saveCheckpoint(fixture, 'Pagination test 2');
            const firstPage = await listCheckpoints(fixture, 1, 1);
            const secondPage = await listCheckpoints(fixture, 1, 2);
            expect(firstPage.checkpoints.length === 1 && secondPage.checkpoints.length === 1,
                'checkpoint pagination: invalid page size');
            expect(firstPage.checkpoints[0].id !== secondPage.checkpoints[0].id,
                'checkpoint pagination: pages contain the same checkpoint');
            expect(firstPage.total >= 3 && firstPage.total_pages === firstPage.total,
                'checkpoint pagination: invalid totals');
        });

        await runScenario('project history exclusion', async () => {
            const directory = join(root, 'project-info');
            const projectPath = join(directory, 'main.kicad_pro');
            await createDocument({ doc_type: 'project', path: projectPath });
            const historyDirectory = join(directory, '.history');
            await mkdir(historyDirectory, { recursive: true });
            await copyFile(join(directory, 'main.kicad_sch'), join(historyDirectory, 'main.kicad_sch'));
            const info = await getProjectInfo(projectPath);
            expect(!JSON.stringify(info).includes('.history'),
                'project info: .history schematic was included');
        });

        await runScenario('beautify schematic', async () => {
            const path = await copySchematic(fixture, join(root, 'beautify'));
            const { result, assembly } = await beautifySchematic(path, {
                Feedback: ['R1', 'R2'],
            });
            expect(assembly.components.some((item) => item.designator === 'R1'),
                'beautify: server assembly does not contain R1');
            expect(assembly.components.some((item) => item.designator === 'R2'),
                'beautify: server assembly does not contain R2');
            expectComponent(result, 'R1', { partUuid: RESISTOR_A, blockName: 'Feedback' });
            expectComponent(result, 'R2', { partUuid: RESISTOR_A, blockName: 'Feedback' });
        });

        await runScenario('beautify removes old physical topology', async () => {
            const path = await copySchematic(blank, join(root, 'beautify-connected'));
            const first = resistor('R10');
            first.pins[0].signal_name = 'VCC_5V';
            first.pins[1].signal_name = 'MID';
            const second = resistor('R11');
            second.pins[0].signal_name = 'MID';
            second.pins[1].signal_name = 'GND';
            await extractCircuit(path, modification({ add_components: [first, second] }));
            const initialSource = await readFile(path, 'utf8');
            expect(findLists(initialSource, 'global_label').length === 0,
                'global labels: physically connected internal net received a global label');
            expect(findLists(initialSource, 'label').length === 0,
                'global labels: assembly created a local label');
            expect(initialSource.includes('(lib_id "kicad-copilot:VCC_5V")'),
                'project library: generated power port uses an unregistered library');
            const initialErc = await ercReport(path);
            expect(!/\[(lib_symbol_issues|footprint_link_issues)\]/.test(initialErc),
                'project library: ERC still reports missing symbol or footprint libraries');
            const oldObjects = placedObjectUuids(await readFile(path, 'utf8'));
            expect(oldObjects.size > 2, 'beautify topology: connected fixture has no physical topology');

            await beautifySchematic(path, { Divider: ['R10', 'R11'] });
            const currentObjects = placedObjectUuids(await readFile(path, 'utf8'));
            const leftovers = [...oldObjects].filter((uuid) => currentObjects.has(uuid));
            expect(leftovers.length === 0,
                `beautify topology: ${leftovers.length} old physical objects remain`);
        });

        await runScenario('addition', async () => {
            const path = await copySchematic(blank, join(root, 'addition'));
            const { result, assembly } = await extractScenario(path, modification({
                add_components: [resistor('R3')],
            }));
            expect(assembly.components.some((item) => item.designator === 'R3'),
                'addition: server assembly does not contain R3');
            expectComponent(result, 'R3', { partUuid: RESISTOR_A, value: '10k' });
        });

        await runScenario('removal', async () => {
            const path = await copySchematic(fixture, join(root, 'removal'));
            const { result, assembly } = await extractScenario(path, modification({
                rm_components: ['R2'],
            }));
            expect(assembly.rm_components?.some((item) => item.replace(/\.\d+$/, '') === 'R2'),
                'removal: server assembly does not request R2 removal');
            expect(!component(result, 'R2'), 'removal: R2 still exists');
            expectComponent(result, 'R1', { partUuid: RESISTOR_A });
        });

        await runScenario('net connection', async () => {
            const path = await copySchematic(fixture, join(root, 'connection'));
            const { result, assembly } = await extractScenario(path, modification({
                external_connect: [
                    { designator: 'R1', pin_number: '1', signal_name: 'TEST_NET' },
                    { designator: 'R2', pin_number: '1', signal_name: 'TEST_NET' },
                ],
            }));
            expect(assembly.added_net?.length === 2,
                `net connection: expected 2 added_net entries, got ${assembly.added_net?.length || 0}`);
            expectSignal(result, 'R1', '1', 'TEST_NET');
            expectSignal(result, 'R2', '1', 'TEST_NET');
        });

        await runScenario('signal port is not a power symbol', async () => {
            const path = await copySchematic(fixture, join(root, 'signal-port'));
            const { result } = await extractScenario(path, modification({
                external_connect: [
                    { designator: 'R1', pin_number: '1', signal_name: 'UART_RX' },
                ],
            }));
            expectSignal(result, 'R1', '1', 'UART_RX');
            const source = await readFile(path, 'utf8');
            expect(source.includes('(property "Reference" "#PORT'),
                'signal port: instance does not use a #PORT reference');
            const definition = findLists(source, 'symbol').find((range) => (
                range.text.startsWith('(symbol "kicad-copilot:UART_RX"')
            ));
            expect(definition, 'signal port: embedded symbol definition missing');
            expect(!definition.text.includes('(power global)'),
                'signal port: embedded symbol is still marked as global power');
            expect(definition.text.includes('(pin passive line'),
                'signal port: embedded symbol pin is not passive');
            const label = findLists(source, 'global_label').find((range) => (
                range.text.startsWith('(global_label "UART_RX"')
            ));
            expect(label?.text.includes('(hide yes)'),
                'signal port: hidden global connectivity label missing');
            await ercReport(path);
        });

        await runScenario('net disconnection', async () => {
            const path = await copySchematic(fixture, join(root, 'disconnection'));
            await extractScenario(path, modification({
                external_connect: [
                    { designator: 'R1', pin_number: '1', signal_name: 'TEST_NET' },
                    { designator: 'R2', pin_number: '1', signal_name: 'TEST_NET' },
                ],
            }));
            const { result, assembly } = await extractScenario(path, modification({
                external_rm_connect: [
                    { designator: 'R1', pin_number: '1' },
                ],
            }));
            expect(assembly.rm_net?.some((item) => item.designator === 'R1'
                && String(item.pin_number) === '1'),
            'net disconnection: server assembly does not contain R1.1 rm_net');
            expectSignal(result, 'R1', '1', '');
            expectSignal(result, 'R2', '1', 'TEST_NET');
        });

        await runScenario('replacement', async () => {
            const path = await copySchematic(fixture, join(root, 'replacement'));
            const { result, assembly } = await extractScenario(path, modification({
                add_components: [resistor('R1', RESISTOR_B, '10k_ALT')],
                rm_components: ['R1'],
            }));
            const replacementTargets = [
                ...(assembly.replace_components || []),
                ...(assembly.rm_components || []),
            ].map((item) => item.replace(/\.\d+$/, ''));
            expect(replacementTargets.includes('R1'),
                'replacement: server assembly does not remove the old R1');
            expect(assembly.components.some((item) => item.designator.replace(/\.\d+$/, '') === 'R1'
                && item.part_uuid === RESISTOR_B),
                'replacement: server assembly does not contain the new R1');
            expectComponent(result, 'R1', { partUuid: RESISTOR_B, value: '10k_ALT' });
            expect(result.components.filter((item) => item.designator === 'R1').length === 1,
                'replacement: expected exactly one R1');
            expectComponent(result, 'R2', { partUuid: RESISTOR_A });
        });
        completed = true;
    } finally {
        if (completed) await rm(root, { recursive: true, force: true });
        else console.error(`failed test artifacts: ${root}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
