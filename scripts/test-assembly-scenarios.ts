#!/usr/bin/env node

import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { beautifySchematic } from '../src/circuit/beautify';
import { targetCircuitAssembly } from '../src/circuit/target-assembly';
import {
    applyCircuitAssembly,
    emptySheetPlacement,
    portDirectionAngles,
    portOffsetCandidates,
    routedSectionPoints,
    serverRect,
} from '../src/kicad/assembly';
import { listCheckpoints, saveCheckpoint } from '../src/checkpoints/store';
import { extractCircuit } from '../src/circuit/extract';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { createDocument } from '../src/kicad/create-document';
import { getProjectInfo } from '../src/kicad/project-tree';
import { getSchematic, getSchematicContext } from '../src/kicad/schematic-reader';
import { parseSExpression, printSExpression } from '../src/kicad/sexpr/ast';
import { findLists } from '../src/kicad/sexpr/scan';
import { normalizedComponentSymbol } from '../src/kicad/symbol';
import {
    planWireRemoval,
    redundantJunctionRanges,
    wireRangesToDisconnect,
} from '../src/kicad/wire-removal';
import { CircuitAssembly, CircuitMod, CircuitModStruct, ExplainCircuit } from '../src/types/circuit';
import { runProcessChecked } from '../src/utils/process';
import {
    createDiagnosticCollector,
    diagnosticToolResult,
    MAX_TOOL_DIAGNOSTICS,
} from '../src/utils/diagnostics';

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
    const output = resolve('.test-output');
    await mkdir(output, { recursive: true });
    const root = await mkdtemp(join(output, 'assembly-'));
    let completed = false;
    try {
        await runScenario('pin-to-server-route grid correction', async () => {
            const points = routedSectionPoints({
                id: 'grid-correction',
                startPoint: { x: 0, y: 0 },
                endPoint: { x: 0, y: 80 },
            }, { x: 1.27, y: 0 }, { x: 0, y: 20.32 }, {
                offset: { x: 0, y: 0 },
            });
            expect(points.length === 3,
                `grid correction: expected a short pin stub and server trunk, got ${points.length} points`);
            expect(points[0].x === 1.27 && points[1].x === 0 && points[1].y === 0,
                'grid correction: pin mismatch was propagated along the full server route');
            expect(points[2].x === 0 && points[2].y === 20.32,
                'grid correction: server route endpoint changed');
        });

        await runScenario('wire compensation follows EasyEDA bend choice', async () => {
            const points = routedSectionPoints({
                id: 'easyeda-bend-choice',
                startPoint: { x: 0, y: 0 },
                endPoint: { x: 40, y: 10 },
            }, { x: 0, y: 0 }, { x: 10.16, y: 2.54 }, {
                offset: { x: 0, y: 0 },
            });
            expect(points.length === 3,
                `wire compensation: expected one bend, got ${points.length - 2}`);
            expect(points[1].x === 0 && points[1].y === 2.54,
                `wire compensation: expected EasyEDA vertical-first bend, got ${JSON.stringify(points[1])}`);
        });

        await runScenario('port direction order', async () => {
            expect(portDirectionAngles().join(',') === '90,270,0,180',
                'port directions: expected up, down, right, left');
            expect(portOffsetCandidates(90).join(',') === '0',
                'port offset: vertical ports must remain on their wire');
            const horizontalOffsets = portOffsetCandidates(0);
            expect(horizontalOffsets[0] === -2.54 && horizontalOffsets[1] === 2.54,
                `port offset: expected perpendicular offsets, got ${horizontalOffsets.slice(0, 2)}`);
        });

        await runScenario('placement bounds use rendered geometry', async () => {
            const assembly = {
                metadata: { project_name: 'test', description: 'test' },
                components: [{
                    ...resistor('VCC|1', 'VCC', 'VCC'),
                    pos: { x: 0, y: 0, center: { x: 500, y: 500 }, width: 1000, height: 1000 },
                }],
                edges: [{
                    sources: [], targets: [], container: 'test',
                    sections: [{
                        id: 'route', startPoint: { x: 0, y: 0 }, endPoint: { x: 100, y: 50 },
                    }],
                }],
                blocks: [],
                blocks_rect: [{ name: 'hidden', description: '', x: 0, y: 0, width: 2000, height: 2000 }],
            } as CircuitAssembly;
            const hiddenBlockBounds = serverRect(assembly);
            expect(hiddenBlockBounds.right === 127 && hiddenBlockBounds.bottom === 127,
                `placement bounds: hidden geometry inflated bounds: ${JSON.stringify(hiddenBlockBounds)}`);
            assembly.assembly_options = { draw_blocks: true };
            const drawnBlockBounds = serverRect(assembly);
            expect(drawnBlockBounds.right === 508 && drawnBlockBounds.bottom === 508,
                'placement bounds: visible block was excluded');
        });

        await runScenario('oversized assembly uses unrotated best-effort placement', async () => {
            const component = {
                ...resistor('R1'),
                pos: { x: 0, y: 0, center: { x: 250, y: 450 }, width: 500, height: 900 },
            };
            const assembly = {
                metadata: { project_name: 'test', description: 'test' },
                components: [component], edges: [], blocks: [],
            } as CircuitAssembly;
            const fallback = emptySheetPlacement('(kicad_sch (paper "A4"))', assembly);
            expect(/no free area on schematic sheet/i.test(fallback.warning || ''),
                `placement fallback: missing warning ${fallback.warning}`);
            expect(!('rotation' in fallback), 'placement fallback: global rotation leaked into placement');
            const custom = emptySheetPlacement('(kicad_sch (paper "User" 500 300))', assembly);
            expect(!('rotation' in custom), 'custom paper: global rotation leaked into placement');
            expect(!custom.warning, `custom paper: unexpected placement warning ${custom.warning}`);
        });

        await runScenario('near-fit assembly ignores only unavailable page padding', async () => {
            const width = 271.145 / 0.254;
            const height = 205.359 / 0.254;
            const assembly = {
                metadata: { project_name: 'test', description: 'test' },
                components: [{
                    ...resistor('R1'),
                    pos: {
                        x: 0,
                        y: 0,
                        center: { x: width / 2, y: height / 2 },
                        width,
                        height,
                    },
                }],
                edges: [],
                blocks: [],
            } as CircuitAssembly;
            const placement = emptySheetPlacement('(kicad_sch (paper "A4"))', assembly);
            const bounds = serverRect(assembly);
            expect(Boolean(placement.warning), 'near-fit placement: missing fallback warning');
            expect(bounds.left + placement.offset.x >= 0
                && bounds.top + placement.offset.y >= 0
                && bounds.right + placement.offset.x <= 297
                && bounds.bottom + placement.offset.y <= 210,
            `near-fit placement: assembly left the sheet ${JSON.stringify(placement)}`);
        });

        await runScenario('tight assembly placement uses KiCad grid', async () => {
            const component = {
                ...resistor('R1'),
                pos: {
                    x: 0, y: 0,
                    center: { x: 466.875, y: 388.75 },
                    width: 933.75,
                    height: 777.5,
                },
            };
            const assembly = {
                metadata: { project_name: 'test', description: 'test' },
                components: [component], edges: [], blocks: [],
            } as CircuitAssembly;
            const placement = emptySheetPlacement(
                '(kicad_sch (paper "A4"))',
                assembly,
                { x: 100, y: 20 },
            );
            expect(!('rotation' in placement), 'tight placement: global rotation leaked into placement');
        });

        await runScenario('redundant junction cleanup', async () => {
            const source = `(kicad_sch
                (wire (pts (xy 0 0) (xy 10 0)))
                (wire (pts (xy 10 0) (xy 20 0)))
                (wire (pts (xy 10 0) (xy 10 10)))
                (junction (at 5 0))
                (junction (at 10 0))
                (junction (at 10 0)))`;
            const redundant = redundantJunctionRanges(source);
            expect(redundant.length === 2,
                `junction cleanup: expected orphan and duplicate, got ${redundant.length}`);
            expect(redundant.some((range) => range.text.includes('(at 5 0)')),
                'junction cleanup: straight-line junction remains');
        });

        await runScenario('cross-sheet assembly isolation', async () => {
            const local = resistor('R1');
            const foreign = resistor('R2');
            const assembly = targetCircuitAssembly({
                metadata: { project_name: 'test', description: 'test' },
                components: [
                    { ...local, pos: { x: 0, y: 0, center: { x: 0, y: 0 }, width: 10, height: 10 } },
                    { ...foreign, pos: { x: 20, y: 0, center: { x: 0, y: 0 }, width: 10, height: 10 } },
                ],
                reused_blocks: [],
                edges: [{
                    sources: ['R1_pin_1'], targets: ['R1_pin_2', 'R2_pin_1'], container: 'test',
                    sections: [
                        {
                            id: 'local-edge', startPoint: { x: 0, y: 0 }, endPoint: { x: 10, y: 0 },
                            incomingShape: 'R1_pin_1', outgoingShape: 'R1_pin_2',
                        },
                        {
                            id: 'foreign-edge', startPoint: { x: 0, y: 0 }, endPoint: { x: 20, y: 0 },
                            incomingShape: 'R1_pin_1', outgoingShape: 'R2_pin_1',
                        },
                    ],
                }],
                blocks: [],
                added_net: [
                    { designator: 'R1', pin_number: '1', net: 'LOCAL' },
                    { designator: 'R2', pin_number: '1', net: 'FOREIGN' },
                ],
                rm_net: [{ designator: 'R2', pin_number: '2', net: 'FOREIGN' }],
                rm_components: ['R2'],
            }, { components: [local] }, { components: [local, foreign] });
            expect(assembly.components.every((component) => component.designator !== 'R2'),
                'cross-sheet isolation: foreign component remains');
            expect(assembly.edges.length === 1
                && assembly.edges[0].sections.length === 1
                && assembly.edges[0].sections[0].id === 'local-edge',
            'cross-sheet isolation: local edge was removed with foreign section');
            expect(assembly.added_net?.length === 1 && assembly.added_net[0].designator === 'R1',
                'cross-sheet isolation: added_net was not scoped to target');
            expect(assembly.rm_net?.length === 0,
                'cross-sheet isolation: foreign rm_net remains');
            expect(assembly.rm_components?.length === 0,
                'cross-sheet isolation: foreign removal remains');
        });

        await runScenario('LLM diagnostic limit', async () => {
            const diagnostics = createDiagnosticCollector(MAX_TOOL_DIAGNOSTICS, () => undefined);
            for (let index = 0; index < 40; index += 1) diagnostics.report(`error ${index + 1}`);
            for (let index = 0; index < 40; index += 1) diagnostics.warn(`warning ${index + 1}`);
            const summary = diagnostics.summary();
            const toolResult = diagnosticToolResult(summary);
            expect(summary.errors.length === 36, `diagnostics: expected 36 errors, got ${summary.errors.length}`);
            expect(summary.error_count === 40 && summary.omitted_errors === 4,
                `diagnostics: invalid totals ${JSON.stringify(summary)}`);
            expect(summary.warnings.length === 36, `diagnostics: expected 36 warnings, got ${summary.warnings.length}`);
            expect(summary.warning_count === 40 && summary.omitted_warnings === 4,
                `diagnostics: invalid warning totals ${JSON.stringify(summary)}`);
            expect(typeof toolResult === 'object' && toolResult.errors.length === 36,
                'diagnostics: tool result exceeds the LLM limit');
            expect(typeof toolResult === 'object' && toolResult.warnings.length === 36,
                'diagnostics: warning result exceeds the LLM limit');
        });

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
        await runScenario('best-effort missing edge pin', async () => {
            const path = await copySchematic(blank, join(root, 'best-effort-edge'));
            const source = resistor('R90');
            source.pins[0].signal_name = 'EDGE_A';
            source.pins[1].signal_name = 'EDGE_B';
            const invalid = resistor('R91');
            const assembly: CircuitAssembly = {
                metadata: { project_name: 'test', description: 'best effort' },
                components: [
                    {
                        ...source,
                        pos: { x: 0, y: 0, center: { x: 5, y: 5 }, width: 10, height: 10, rotate: 0 },
                    },
                    {
                        ...invalid,
                        part_uuid: null,
                        pos: { x: 20, y: 0, center: { x: 5, y: 5 }, width: 10, height: 10, rotate: 0 },
                    },
                ],
                reused_blocks: [],
                edges: [{
                    sources: ['R90_pin_99'],
                    targets: ['R90_pin_1', 'R90_pin_2'],
                    container: 'test',
                    sections: [
                        {
                            id: 'missing-local-pin',
                            startPoint: { x: 0, y: 5 },
                            endPoint: { x: 10, y: 5 },
                            incomingShape: 'R90_pin_99',
                            outgoingShape: 'R90_pin_1',
                        },
                        {
                            id: 'conflicting-signals',
                            startPoint: { x: 10, y: 5 },
                            endPoint: { x: 20, y: 5 },
                            incomingShape: 'R90_pin_1',
                            outgoingShape: 'R90_pin_2',
                        },
                    ],
                }],
                blocks: [],
                added_net: [{ designator: 'R90', pin_number: '99', net: 'MISSING_PIN' }],
            };
            const diagnostics = createDiagnosticCollector();
            const status = await applyCircuitAssembly(path, assembly, { components: [] }, diagnostics.report);
            expect(status === 'ok', `best effort edge: unexpected status ${status}`);
            expect(diagnostics.summary().errors.some((error) => error.includes('R90_pin_99')),
                'best effort edge: missing pin was not reported');
            expect(diagnostics.summary().errors.some((error) => error.includes('R91')),
                'best effort component: failed component was not reported');
            expect(diagnostics.summary().errors.some((error) => error.includes('uses its first endpoint signal')),
                'best effort edge: conflicting server edge was not reported');
            expectComponent(await getSchematic(path), 'R90', { partUuid: RESISTOR_A });
            expect(!component(await getSchematic(path), 'R91'),
                'best effort component: invalid component was unexpectedly placed');
            const assembledSource = await readFile(path, 'utf8');
            expect(!assembledSource.includes('(lib_id "kicad-copilot:EDGE_B")'),
                'best-effort edge: conflicting server edge was replaced with a client port');
            expect(assembledSource.includes('(global_label "EDGE_A"'),
                'best-effort edge: bare signal name was not materialized as a global label');
        });
        await runScenario('component fields preserve converted symbol positions', async () => {
            const path = await copySchematic(blank, join(root, 'component-fields'));
            const source = resistor('R95');
            const assembly: CircuitAssembly = {
                metadata: { project_name: 'test', description: 'component fields' },
                components: [{
                    ...source,
                    pos: { x: 0, y: 0, center: { x: 5, y: 5 }, width: 10, height: 10, rotate: 90 },
                }],
                reused_blocks: [],
                edges: [],
                blocks: [],
            };
            await applyCircuitAssembly(path, assembly, { components: [] });
            const result = await readFile(path, 'utf8');
            const instance = findLists(result, 'symbol').find((range) => (
                range.text.includes('(lib_id "kicad-copilot:')
                && range.text.includes('(property "Reference" "R95"')
            ));
            expect(instance, 'component fields: R95 instance missing');
            const anchorMatch = instance.text.match(
                /\(lib_id\s+"[^"]+"\)\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/,
            );
            const referenceMatch = instance.text.match(
                /\(property\s+"Reference"\s+"R95"\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/,
            );
            const valueMatch = instance.text.match(
                /\(property\s+"Value"\s+"10k"\s+\(at\s+(-?[\d.]+)\s+(-?[\d.]+)/,
            );
            expect(anchorMatch && referenceMatch && valueMatch,
                'component fields: instance coordinates missing');
            const anchor = { x: Number(anchorMatch[1]), y: Number(anchorMatch[2]) };
            const reference = { x: Number(referenceMatch[1]), y: Number(referenceMatch[2]) };
            const value = { x: Number(valueMatch[1]), y: Number(valueMatch[2]) };
            const distance = (point: { x: number; y: number }) => Math.hypot(
                point.x - anchor.x,
                point.y - anchor.y,
            );
            expect(distance(reference) <= 6.35 && distance(value) <= 6.35,
                `component fields: converted offsets were inflated: ${JSON.stringify({ anchor, reference, value })}`);
            const dot = (reference.x - anchor.x) * (value.x - anchor.x)
                + (reference.y - anchor.y) * (value.y - anchor.y);
            expect(dot < 0, 'component fields: Reference and Value were forced onto the same side');
        });
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

        await runScenario('replacement failure follows EasyEDA remove-and-place fallback', async () => {
            const path = await copySchematic(fixture, join(root, 'replacement-failure'));
            const input = await getSchematic(path);
            const invalid = resistor('R2');
            const assembly: CircuitAssembly = {
                metadata: { project_name: 'test', description: 'replacement fallback' },
                components: [{
                    ...invalid,
                    part_uuid: null,
                    pos: { x: 0, y: 0, center: { x: 5, y: 5 }, width: 10, height: 10, rotate: 0 },
                }],
                reused_blocks: [],
                edges: [],
                blocks: [],
                rm_components: ['R2'],
                replace_components: ['R2'],
            };
            const diagnostics = createDiagnosticCollector();
            await applyCircuitAssembly(path, assembly, input, diagnostics.report);
            expect(!component(await getSchematic(path), 'R2'),
                'replacement fallback: old component survived a failed normal placement');
            expect(diagnostics.summary().errors.some((error) => error.includes('R2')),
                'replacement fallback: failed normal placement was not reported');
        });

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

        await runScenario('KiCad-created project accepts a hierarchical page', async () => {
            const directory = join(root, 'native-kicad-project');
            const projectPath = join(directory, 'native.kicad_pro');
            const rootPath = join(directory, 'native.kicad_sch');
            const childPath = join(directory, 'child.kicad_sch');
            await mkdir(directory, { recursive: true });
            await writeFile(projectPath, '{}\n', 'utf8');
            await writeFile(rootPath, `(kicad_sch
\t(version 20260306)
\t(generator "eeschema")
\t(generator_version "10.0")
\t(uuid 4790c18b-5150-45f7-8af2-f5917717030e)
\t(paper "A4")
\t(lib_symbols)
\t(sheet_instances
\t\t(path "/"
\t\t\t(page "1")
\t\t)
\t)
\t(embedded_fonts no)
)
`, 'utf8');

            await createDocument({
                doc_type: 'schematic_page',
                path: childPath,
                parent_path: rootPath,
            });

            const updatedRoot = await readFile(rootPath, 'utf8');
            expect(findLists(updatedRoot, 'sheet').length === 1,
                'native KiCad project: hierarchical sheet was not inserted');
            expect(updatedRoot.includes('(property "Sheetfile" "child.kicad_sch"'),
                'native KiCad project: child path was not recorded');
            expect((await readFile(childPath, 'utf8')).includes('(kicad_sch'),
                'native KiCad project: child schematic was not created');
        });

        await runScenario('page context keeps sheet boundaries', async () => {
            const directory = join(root, 'project-circuit-context');
            const projectPath = join(directory, 'main.kicad_pro');
            const rootPath = join(directory, 'main.kicad_sch');
            const childPath = join(directory, 'child.kicad_sch');
            await createDocument({ doc_type: 'project', path: projectPath });
            await createDocument({ doc_type: 'schematic_page', path: childPath, parent_path: rootPath });
            await extractCircuit(rootPath, modification({ add_components: [resistor('R100')] }));
            await extractCircuit(childPath, modification({ add_components: [resistor('R200')] }));

            const context = await getSchematicContext(childPath);
            expectComponent(context.target, 'R200');
            expect(!component(context.target, 'R100'),
                'project context: target sheet contains a root-sheet component');
            expect(!component(context.project, 'R100'), 'layout must not receive parent contents');
            expectComponent(context.project, 'R200');
            expect(context.projectPath === rootPath,
                `project context: expected ${rootPath}, got ${context.projectPath}`);

            const rootContext = await getSchematicContext(rootPath);
            expectComponent(rootContext.target, 'R100');
            expect(!component(rootContext.target, 'R200'),
                'project context: root target contains a child-sheet component');
            expectComponent(rootContext.project, 'R100');
            expect(!component(rootContext.project, 'R200'), 'layout must not receive child contents');
            expectComponent(rootContext.target, 'child');
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
            expect(initialSource.includes('(global_label "MID"'),
                'a bare signal must be global even when connected by a local wire');
            expect(initialSource.includes('(lib_id "power:VCC")') && initialSource.includes('(property "Value" "VCC_5V"'),
                'power-like signals must keep their requested net name');
            expect(initialSource.includes('(lib_id "power:GNDREF")') && !initialSource.includes('(global_label "GND"'),
                'global ground must use the three-bar power symbol');
            const initialErc = await ercReport(path);
            expect(!/\[(lib_symbol_issues|footprint_link_issues)\]/.test(initialErc),
                'project library: ERC still reports missing symbol or footprint libraries');
            const oldObjects = placedObjectUuids(await readFile(path, 'utf8'));
            expect(oldObjects.size > 2, 'beautify topology: connected fixture has no physical topology');

            await beautifySchematic(path, { Divider: ['R10', 'R11'] });
            const beautifiedSource = await readFile(path, 'utf8');
            const currentObjects = placedObjectUuids(beautifiedSource);
            const leftovers = [...oldObjects].filter((uuid) => currentObjects.has(uuid));
            expect(leftovers.length === 0,
                `beautify topology: ${leftovers.length} old physical objects remain`);
            expectSignal(await getSchematic(path), 'R10', '2', 'MID');
            expectSignal(await getSchematic(path), 'R11', '1', 'MID');

            const realSymbols = findLists(beautifiedSource, 'symbol').filter((range) => (
                range.text.includes('(lib_id "kicad-copilot:')
                && range.text.includes('(property "Reference" "R')
            ));
            const anchors = realSymbols.map((range) => {
                const match = range.text.match(/\(at\s+([-\d.]+)\s+([-\d.]+)\s+/);
                return match ? { x: Number(match[1]), y: Number(match[2]) } : undefined;
            }).filter((point): point is { x: number; y: number } => Boolean(point));
            expect(anchors.length === 2, `beautify centering: expected 2 anchors, got ${anchors.length}`);
            const center = {
                x: anchors.reduce((sum, point) => sum + point.x, 0) / anchors.length,
                y: anchors.reduce((sum, point) => sum + point.y, 0) / anchors.length,
            };
            expect(Math.abs(center.x - 148.5) < 40 && Math.abs(center.y - 105) < 40,
                `beautify centering: assembly remained near page edge: ${JSON.stringify(center)}`);

            const repeated = await beautifySchematic(path, { Divider: ['R10', 'R11'] });
            expectComponent(repeated.result, 'R10', { blockName: 'Divider' });
            expectComponent(repeated.result, 'R11', { blockName: 'Divider' });
            const repeatedSource = await readFile(path, 'utf8');
            expectSignal(repeated.result, 'R10', '1', 'VCC_5V');
            expectSignal(repeated.result, 'R11', '2', 'GND');
            expect(redundantJunctionRanges(repeatedSource).length === 0,
                'beautify topology: redundant junctions remain');
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

        await runScenario('connection removes no-connect marker', async () => {
            const path = await copySchematic(blank, join(root, 'connect-no-connect'));
            const unused = resistor('R30');
            unused.pins[0].signal_name = 'NC';
            await extractScenario(path, modification({ add_components: [unused] }));
            const before = await readFile(path, 'utf8');
            expect(findLists(before, 'no_connect').length === 1,
                'no-connect replacement: marker was not created');

            const { result } = await extractScenario(path, modification({
                external_connect: [{ designator: 'R30', pin_number: '1', signal_name: 'NEW_NET' }],
            }));
            expectSignal(result, 'R30', '1', 'NEW_NET');
            const after = await readFile(path, 'utf8');
            expect(findLists(after, 'no_connect').length === 0,
                'no-connect replacement: marker remains on connected pin');
        });

        await runScenario('named connection uses one native global label', async () => {
            const path = await copySchematic(fixture, join(root, 'signal-port'));
            const { result } = await extractScenario(path, modification({
                external_connect: [{ designator: 'R1', pin_number: '1', signal_name: 'UART_RX' }],
            }));
            expectSignal(result, 'R1', '1', 'UART_RX');
            const source = await readFile(path, 'utf8');
            const labels = findLists(source, 'global_label').filter(range => range.text.startsWith('(global_label "UART_RX"'));
            expect(labels.length === 1, 'expected one native label for the named connection');
            expect(!source.includes('UART_RX__global'), 'unexpected hidden global helper');
            expect(!source.includes('(lib_id "kicad-copilot:UART_RX")'), 'unexpected duplicate service symbol');
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
        if (!resolve(root).startsWith(`${output}${process.platform === 'win32' ? '\\' : '/'}assembly-`)) throw new Error('invalid test artifact directory');
        if (completed) await rm(root, { recursive: true, force: true });
        else console.error(`failed test artifacts: ${root}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
