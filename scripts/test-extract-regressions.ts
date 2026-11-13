#!/usr/bin/env node

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { extractCircuit } from '../src/circuit/extract';
import { createDocument } from '../src/kicad/create-document';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    parseSExpression,
} from '../src/kicad/sexpr/ast';
import { findLists, findQuotedProperty } from '../src/kicad/sexpr/scan';
import { CircuitMod, ExplainCircuit } from '../src/types/circuit';

type RegressionEnvelope = {
    arguments: CircuitMod & { path: string };
};

function baseDesignator(value: string) {
    return value.replace(/\.\d+$/, '');
}

function pointKey(x: number, y: number) {
    return `${Number(x.toFixed(4))},${Number(y.toFixed(4))}`;
}

function labelWireEndpoints(source: string) {
    const labels = new Map<string, Set<string>>();
    for (const range of findLists(source, 'global_label')) {
        const value = parseSExpression(range.text);
        const name = atom(value[1]) || '';
        const at = findChild(value, 'at');
        const x = Number(atom(at?.[1]));
        const y = Number(atom(at?.[2]));
        if (!name || !Number.isFinite(x) || !Number.isFinite(y)) continue;
        const points = labels.get(name) || new Set<string>();
        points.add(pointKey(x, y));
        labels.set(name, points);
    }
    const wireEndpoints = new Set<string>();
    for (const range of findLists(source, 'wire')) {
        const value = parseSExpression(range.text);
        const pts = findChild(value, 'pts');
        if (!pts) continue;
        for (const item of pts) {
            if (!isSExpressionList(item) || listHead(item) !== 'xy') continue;
            const x = Number(atom(item[1]));
            const y = Number(atom(item[2]));
            if (Number.isFinite(x) && Number.isFinite(y)) wireEndpoints.add(pointKey(x, y));
        }
    }
    return { labels, wireEndpoints };
}

function signalMismatches(circuit: CircuitMod, result: ExplainCircuit) {
    const output: string[] = [];
    for (const expected of circuit.add_components) {
        const actual = result.components.filter((component) => (
            baseDesignator(component.designator) === baseDesignator(expected.designator)
        ));
        if (!actual.length) {
            output.push(`${expected.designator}: component missing`);
            continue;
        }
        for (const pin of expected.pins) {
            if (!pin.signal_name) continue;
            const actualPin = actual.flatMap((component) => component.pins)
                .find((candidate) => String(candidate.pin_number) === String(pin.pin_number));
            if (actualPin?.signal_name !== pin.signal_name) {
                output.push(
                    `${expected.designator}.${pin.pin_number}: expected ${pin.signal_name}, `
                    + `got ${actualPin?.signal_name || '<empty>'}`,
                );
            }
        }
    }
    return output;
}

function densePortMismatches(circuit: CircuitMod, assembly: Awaited<ReturnType<typeof extractCircuit>>['assembly'], source: string) {
    const output: string[] = [];
    const { labels, wireEndpoints } = labelWireEndpoints(source);
    const localLabels = new Set(findLists(source, 'label').map((range) => (
        atom(parseSExpression(range.text)[1]) || ''
    )));
    const serviceValues = new Set(findLists(source, 'symbol')
        .filter((range) => range.text.includes('(lib_id ')
            && /^#(?:PWR|PORT)/.test(findQuotedProperty(range.text, 'Reference') || ''))
        .map((range) => findQuotedProperty(range.text, 'Value') || ''));
    const usedShapes = new Set(assembly.edges.flatMap((edge) => edge.sections.flatMap((section) => [
        section.incomingShape,
        section.outgoingShape,
    ].filter((shape): shape is string => Boolean(shape)))));

    for (const component of circuit.add_components) {
        const namedPins = component.pins.filter((pin) => pin.signal_name.trim());
        if (namedPins.length < 5) continue;
        for (const pin of namedPins) {
            const shape = `${component.designator}_pin_${pin.pin_number}`;
            if (usedShapes.has(shape)) continue;
            const labelPoints = labels.get(pin.signal_name);
            if (!labelPoints?.size) {
                output.push(`${shape}: dense fallback must use a global label for ${pin.signal_name}`);
            } else if (![...labelPoints].some((point) => wireEndpoints.has(point))) {
                output.push(`${shape}: dense fallback label ${pin.signal_name} must end a wire stub`);
            }
            if (localLabels.has(pin.signal_name)) {
                output.push(`${shape}: dense fallback created a local label for ${pin.signal_name}`);
            }
            if (serviceValues.has(pin.signal_name)) {
                output.push(`${shape}: dense fallback created a short symbol for ${pin.signal_name}`);
            }
        }
    }
    return output;
}

async function main() {
    const fixtureDirectory = resolve(
        process.env.KICAD_COPILOT_EXTRACT_REGRESSIONS
        || 'D:\\MyProject\\kicad\\extract-circuit-regressions',
    );
    const files = (await readdir(fixtureDirectory))
        .filter((name) => /^0[1-6]-.*\.json$/i.test(name))
        .sort();
    if (!files.length) throw new Error(`no regression payloads found: ${fixtureDirectory}`);

    const outputRoot = resolve('.test-output/extract-regressions');
    await mkdir(outputRoot, { recursive: true });
    const outputDirectory = await mkdtemp(join(outputRoot, 'run-'));
    const keepArtifacts = process.env.KICAD_COPILOT_KEEP_TEST_ARTIFACTS === '1';
    let passed = false;
    try {
        for (const filename of files) {
            const envelope = JSON.parse(
                await readFile(join(fixtureDirectory, filename), 'utf8'),
            ) as RegressionEnvelope;
            const caseDirectory = join(outputDirectory, basename(filename, '.json'));
            const projectPath = join(caseDirectory, 'test.kicad_pro');
            await createDocument({ doc_type: 'project', path: projectPath });
            const { path: _placeholder, ...circuit } = envelope.arguments;
            const schematicPath = join(caseDirectory, 'test.kicad_sch');
            if (filename.startsWith('06-')) {
                let failure = '';
                try {
                    await extractCircuit(schematicPath, circuit, {
                        onAssembly: (value) => writeFile(
                            join(caseDirectory, 'backend-assembly.json'),
                            `${JSON.stringify(value, null, 2)}\n`,
                            'utf8',
                        ),
                    });
                } catch (error) {
                    failure = error instanceof Error ? error.message : String(error);
                }
                if (!/no free area on schematic sheet/i.test(failure)) {
                    throw new Error(`${filename}: expected safe no-free-area rejection, got ${failure || 'ok'}`);
                }
                const source = await readFile(schematicPath, 'utf8');
                if (source.includes('(lib_id ')) {
                    throw new Error(`${filename}: schematic changed after rejected placement`);
                }
                console.log(`ok ${filename}: safely rejected without changing the schematic`);
                continue;
            }
            const { assembly, result } = await extractCircuit(schematicPath, circuit, {
                onAssembly: (value) => writeFile(
                    join(caseDirectory, 'backend-assembly.json'),
                    `${JSON.stringify(value, null, 2)}\n`,
                    'utf8',
                ),
            });
            const mismatches = signalMismatches(circuit, result);
            const source = await readFile(schematicPath, 'utf8');
            mismatches.push(...densePortMismatches(circuit, assembly, source));
            if (mismatches.length) throw new Error(`${filename}:\n${mismatches.join('\n')}`);
            console.log(`ok ${filename}: ${assembly.components.length} assembly components`);
        }
        passed = true;
    } finally {
        if (passed && !keepArtifacts) await rm(outputDirectory, { recursive: true, force: true });
        else console.error(`Regression artifacts: ${outputDirectory}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
