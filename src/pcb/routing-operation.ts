import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { saveCheckpoint } from '../checkpoints/store';
import { readPcb } from '../kicad/pcb-reader';
import { inspectPcbCandidate, normalizePcbCandidate, pcbDrcMetrics } from '../kicad/pcb-validation';
import { atomicWritePcb, serializePcb, sourceHash } from '../kicad/pcb-writer';
import { TEMP_DIR } from '../utils/dirs';
import { enqueueMutation } from '../utils/mutation-queue';
import { applyRouterResult, buildRouterInput, clearRouting } from './router-adapter';
import { applySimplePour, finalizeSimplePourCandidate } from './pour';
import { runLocalRouter } from './router-runtime';

export type AutoRouteOptions = {
    ignoreNets?: string[];
    routeLayers?: string[];
    routingEffectPriority?: 'SPEED_FIRST' | 'COMPLETION_FIRST';
    timeoutSec?: number;
    pourGnd?: boolean;
    stitchGnd?: boolean;
};

type RouteResult = {
    status: 'ok';
    traces: number;
    segments: number;
    vias: number;
    routability?: number;
};

type RouteOperation = {
    id: string;
    path: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    progress: number;
    stage: string;
    controller: AbortController;
    result?: RouteResult;
    error?: string;
    done: Promise<void>;
};

const operations = new Map<string, RouteOperation>();

function publicStatus(operation: RouteOperation) {
    if (operation.status === 'completed') return operation.result;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
        throw new Error(operation.error || `auto route ${operation.status}`);
    }
    return {
        status: 'running',
        operation_id: operation.id,
        stage: operation.stage,
        progress: Math.round(operation.progress * 100),
    };
}

async function wait(operation: RouteOperation, waitMs: number) {
    if (operation.status !== 'running') return publicStatus(operation);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation.done,
            new Promise<void>((done) => {
                timeout = setTimeout(done, waitMs);
            }),
        ]);
    } finally {
        if (timeout) clearTimeout(timeout);
    }
    return publicStatus(operation);
}

function trimOperations() {
    const finished = [...operations.values()].filter((operation) => operation.status !== 'running');
    while (operations.size > 20 && finished.length) operations.delete(finished.shift()!.id);
}

async function runOperation(operation: RouteOperation, options: AutoRouteOptions) {
    try {
        const pcb = await readPcb(operation.path);
        const initialHash = sourceHash(pcb.source);
        const routeLayers = options.routeLayers?.length ? options.routeLayers : ['F.Cu', 'B.Cu'];
        operation.stage = 'checking';
        const baselineDrc = pcbDrcMetrics((await inspectPcbCandidate(pcb.path, pcb.root)).report);
        operation.stage = 'exporting';
        const exported = buildRouterInput(pcb.root, {
            routeLayers,
            ignoreNets: options.ignoreNets?.length ? options.ignoreNets : ['GND'],
            speedFirst: options.routingEffectPriority === 'SPEED_FIRST',
        });
        operation.controller.signal.throwIfAborted();
        const artifactDirectory = join(TEMP_DIR, 'autorouter');
        await mkdir(artifactDirectory, { recursive: true });
        await writeFile(join(artifactDirectory, `${operation.id}-input.json`), JSON.stringify(exported.input, null, 2));

        operation.stage = 'routing';
        const routerResult = await runLocalRouter(exported.input, {
            timeoutMs: (options.timeoutSec ?? 600) * 1000,
            signal: operation.controller.signal,
            onProgress: (progress) => {
                operation.progress = Math.max(operation.progress, progress);
            },
        });
        operation.controller.signal.throwIfAborted();
        await writeFile(join(artifactDirectory, `${operation.id}-result.json`), JSON.stringify(routerResult, null, 2));

        operation.stage = 'applying';
        const applied = await enqueueMutation(async () => {
            operation.controller.signal.throwIfAborted();
            const current = await readPcb(operation.path);
            if (sourceHash(current.source) !== initialHash) throw new Error('PCB changed during auto route');
            const candidate = structuredClone(current.root);
            const counts = applyRouterResult(candidate, current.version, routerResult, exported.transform, routeLayers);
            const withGround = options.pourGnd !== false || options.stitchGnd !== false;
            operation.stage = 'validating';
            const inspected = withGround
                ? await finalizeSimplePourCandidate(current.path, candidate, applySimplePour(candidate, current.version, {
                    net: 'GND',
                    layers: routeLayers,
                    stitchVias: options.stitchGnd !== false,
                }))
                : await inspectPcbCandidate(current.path, candidate);
            const candidateDrc = pcbDrcMetrics(inspected.report);
            if (candidateDrc.shorts > 0 || candidateDrc.unconnected > baselineDrc.unconnected) {
                await Promise.all([
                    writeFile(
                        join(artifactDirectory, `${operation.id}-rejected.kicad_pcb`),
                        serializePcb(inspected.root),
                    ),
                    writeFile(
                        join(artifactDirectory, `${operation.id}-rejected-drc.json`),
                        JSON.stringify(inspected.report, null, 2),
                    ),
                ]);
            }
            if (candidateDrc.shorts > 0) {
                throw new Error(`auto route rejected by KiCad DRC: ${candidateDrc.shorts} short circuit(s)`);
            }
            if (candidateDrc.unconnected > baselineDrc.unconnected) {
                throw new Error(
                    `auto route rejected by KiCad DRC: unconnected items increased `
                    + `from ${baselineDrc.unconnected} to ${candidateDrc.unconnected}`,
                );
            }
            operation.controller.signal.throwIfAborted();
            await saveCheckpoint(current.path, 'Before local auto route');
            await atomicWritePcb(current.path, current.source, inspected.root);
            return counts;
        });
        operation.result = {
            status: 'ok',
            traces: routerResult.traces?.length ?? 0,
            segments: applied.segments,
            vias: applied.vias,
            ...(Number.isFinite(routerResult.routabitity) ? { routability: routerResult.routabitity } : {}),
        };
        operation.progress = 1;
        operation.stage = 'completed';
        operation.status = 'completed';
    } catch (error) {
        const cancelled = operation.controller.signal.aborted || /cancel/i.test(String(error));
        operation.status = cancelled ? 'cancelled' : 'failed';
        operation.stage = operation.status;
        operation.error = error instanceof Error ? error.message : String(error);
        console.error(error);
    } finally {
        trimOperations();
    }
}

export async function autoRoutePcb(path: string, options: AutoRouteOptions = {}, waitMs = 60_000) {
    const active = [...operations.values()].find((operation) => operation.status === 'running');
    if (active) throw new Error(`auto route is already running: ${active.id}`);
    const id = randomUUID();
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>((resolvePromise) => {
        resolveDone = resolvePromise;
    });
    const operation: RouteOperation = {
        id,
        path: resolve(path),
        status: 'running',
        progress: 0,
        stage: 'starting',
        controller,
        done,
    };
    operations.set(id, operation);
    void runOperation(operation, options).finally(resolveDone);
    return wait(operation, waitMs);
}

export async function waitAutoRoute(operationId: string, waitMs = 60_000) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`auto route operation not found: ${operationId}`);
    return wait(operation, waitMs);
}

export function cancelAutoRoute(operationId: string) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`auto route operation not found: ${operationId}`);
    if (operation.status === 'running') operation.controller.abort();
    return 'ok';
}

export async function clearPcbRouting(
    path: string,
    options: { onlyNets?: string[]; ignoreNets?: string[] } = {},
) {
    const pcb = await readPcb(path);
    const removed = clearRouting(pcb.root, options);
    if (!removed) return 'ok';
    const normalized = await normalizePcbCandidate(pcb.path, pcb.root, false);
    await saveCheckpoint(pcb.path, 'Before clear PCB routing');
    await atomicWritePcb(pcb.path, pcb.source, normalized);
    return 'ok';
}
