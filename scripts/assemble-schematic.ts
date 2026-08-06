#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as z from 'zod/v4';
import { extractCircuit } from '../src/circuit/extract';
import { CircuitModStruct } from '../src/types/circuit';

const requestSchema = CircuitModStruct().extend({
    path: z.string().min(1),
});

async function readRequest(path: string) {
    const source = await readFile(path, 'utf8');
    return requestSchema.parse(JSON.parse(source));
}

function baseDesignator(value: string) {
    return value.replace(/\.\d+$/, '');
}

function validateRequestedSignals(
    request: z.infer<typeof requestSchema>,
    result: Awaited<ReturnType<typeof extractCircuit>>['result'],
) {
    const mismatches: string[] = [];
    for (const expected of request.add_components) {
        const candidates = result.components.filter(
            (component) => baseDesignator(component.designator) === baseDesignator(expected.designator),
        );
        if (!candidates.length) {
            mismatches.push(`${expected.designator}: component missing`);
            continue;
        }
        for (const expectedPin of expected.pins) {
            if (!expectedPin.signal_name) continue;
            const actualPin = candidates
                .flatMap((component) => component.pins)
                .find((pin) => String(pin.pin_number) === String(expectedPin.pin_number));
            const actualSignal = actualPin?.signal_name || '';
            if (actualSignal !== expectedPin.signal_name) {
                mismatches.push(
                    `${expected.designator}.${expectedPin.pin_number}: expected `
                    + `${expectedPin.signal_name}, got ${actualSignal || '<empty>'}`,
                );
            }
        }
    }
    return mismatches;
}

async function main() {
    const requestPath = process.argv[2];
    if (!requestPath) {
        throw new Error('usage: npm run test:assemble -- <request.json> [server-response.json]');
    }

    const absoluteRequestPath = resolve(requestPath);
    const responsePath = process.argv[3] ? resolve(process.argv[3]) : undefined;
    console.error(`request: ${absoluteRequestPath}`);
    const request = await readRequest(absoluteRequestPath);
    const { path, ...circuit } = request;
    const schematicPath = resolve(path);
    console.error(`schematic: ${schematicPath}`);
    console.error('reading schematic and requesting assembly...');

    const { checkpointId, result } = await extractCircuit(schematicPath, circuit, {
        onAssembly: responsePath
            ? async (assembly) => {
                await writeFile(responsePath, `${JSON.stringify(assembly, null, 2)}\n`, 'utf8');
                console.error(`server response: ${responsePath}`);
            }
            : undefined,
    });
    console.error(`checkpoint: ${checkpointId}`);
    const mismatches = validateRequestedSignals(request, result);
    console.log(JSON.stringify({
        status: mismatches.length ? 'mismatch' : 'ok',
        path: schematicPath,
        checkpointId,
        mismatches,
        components: result.components,
    }, null, 2));
    if (mismatches.length) {
        throw new Error(`assembled schematic differs from request:\n${mismatches.join('\n')}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
