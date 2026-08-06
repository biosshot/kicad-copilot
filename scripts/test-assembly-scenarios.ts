#!/usr/bin/env node

import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beautifySchematic } from '../src/circuit/beautify';
import { extractCircuit } from '../src/circuit/extract';
import { createDocument } from '../src/kicad/create-document';
import { getSchematic } from '../src/kicad/schematic-reader';
import { wireRangesToDisconnect } from '../src/kicad/wire-removal';
import { CircuitMod, ExplainCircuit } from '../src/types/circuit';

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
    await createDocument({ doc_type: 'schematic', path });
    return path;
}

async function copySchematic(source: string, directory: string) {
    const path = join(directory, 'test.kicad_sch');
    await mkdir(directory, { recursive: true });
    await copyFile(source, path);
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
