import { randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { run, type RoutingDiagnostic, type RoutingResult } from 'eda-copilot-router';
import { applyKiCadRoutingResult, importKiCadRoutingBoard } from 'eda-copilot-router/adapters/kicad';
import { createKrtBackend } from 'eda-copilot-router/backends/krt';
import { saveCheckpoint } from '../checkpoints/store';
import { readPcb } from '../kicad/pcb-reader';
import { inspectPcbCandidate, pcbDrcMetrics } from '../kicad/pcb-validation';
import { atomicWritePcb } from '../kicad/pcb-writer';
import { TEMP_DIR } from '../utils/dirs';
import { enqueueMutation } from '../utils/mutation-queue';
import { createOperationId } from '../operations/id';

export type AutoRouteOptions = Readonly<{
    timeoutSec?: number;
}>;

type PublicRouteResult = Readonly<{
    status: RoutingResult['status'];
    operation: RoutingResult['operation'];
    tracks: number;
    vias: number;
    zones: number;
    native_verification: 'passed' | 'failed' | 'not-run';
    diagnostics: RoutingResult['diagnostics'];
    metrics: RoutingResult['metrics'];
    artifacts_directory: string;
}>;

type RouteOperation = {
    id: string;
    path: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stage: string;
    controller: AbortController;
    result?: PublicRouteResult;
    error?: string;
    done: Promise<void>;
};

const operations = new Map<string, RouteOperation>();

function projectPath(boardPath: string, suffix: '.kicad_pro' | '.kicad_dru') {
    return `${boardPath.slice(0, -extname(boardPath).length)}${suffix}`;
}

async function replaceFile(source: string, target: string) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    await copyFile(source, temporary);
    try {
        await rename(temporary, target);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function replaceFileIfPresent(source: string, target: string) {
    if (!await access(source).then(() => true, () => false)) return false;
    await replaceFile(source, target);
    return true;
}

async function restoreSourceRulesForRoutingOnly(sourceBoard: string, candidateBoard: string) {
    for (const suffix of ['.kicad_pro', '.kicad_dru'] as const) {
        await replaceFileIfPresent(projectPath(sourceBoard, suffix), projectPath(candidateBoard, suffix));
    }
}

function nativeVerificationDiagnostics(report: unknown): RoutingDiagnostic[] {
    const errors = pcbDrcMetrics(report).errorViolations.length;
    return errors ? [{
        code: 'KICAD_NATIVE_DRC_ERRORS',
        severity: 'error',
        message: `KiCad reports ${errors} DRC error violation(s).`,
    }] : [];
}

function publicStatus(operation: RouteOperation) {
    if (operation.status === 'completed') return operation.result;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
        throw new Error(operation.error || `auto route ${operation.status}`);
    }
    return { status: 'running', operation_id: operation.id, stage: operation.stage };
}

async function wait(operation: RouteOperation, waitMs: number) {
    if (operation.status !== 'running') return publicStatus(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation.done,
            new Promise<void>(done => { timer = setTimeout(done, waitMs); }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    return publicStatus(operation);
}

function trimOperations() {
    const finished = [...operations.values()].filter(operation => operation.status !== 'running');
    while (operations.size > 20 && finished.length) operations.delete(finished.shift()!.id);
}

async function runOperation(operation: RouteOperation, dslPath: string, options: AutoRouteOptions) {
    const artifactsDirectory = join(TEMP_DIR, 'copilot-router', operation.id.replace(':', '-'));
    const timeoutMs = (options.timeoutSec ?? 600) * 1000;
    try {
        await mkdir(artifactsDirectory, { recursive: true });
        operation.stage = 'importing';
        const imported = await importKiCadRoutingBoard(operation.path, { existingCopper: 'fixed' });
        if (!imported.board || !imported.context) throw new Error(imported.diagnostics.map(item => item.message).join('\n'));
        const dsl = await readFile(resolve(dslPath), 'utf8');
        operation.controller.signal.throwIfAborted();

        operation.stage = 'routing';
        const backend = createKrtBackend({
            artifactsDirectory: join(artifactsDirectory, 'krt'),
            keepArtifacts: true,
        });
        const signal = AbortSignal.any([
            operation.controller.signal,
            AbortSignal.timeout(timeoutMs),
        ]);
        const result = await run({
            board: imported.board,
            dsl,
            backend,
            policy: { profile: 'completion-first' },
            signal,
        });
        await writeFile(join(artifactsDirectory, 'routing-result.json'), `${JSON.stringify(result, null, 2)}\n`);
        signal.throwIfAborted();

        operation.stage = 'verifying';
        const candidatePath = join(artifactsDirectory, 'candidate.kicad_pcb');
        const applied = await applyKiCadRoutingResult(imported.context, result, candidatePath);
        if (!applied.outputPath) throw new Error(applied.diagnostics.map(item => item.message).join('\n'));
        signal.throwIfAborted();
        if (!result.rules.applyRequested) {
            await restoreSourceRulesForRoutingOnly(operation.path, applied.outputPath);
        }
        const candidate = await readPcb(applied.outputPath);
        const inspected = await inspectPcbCandidate(
            applied.outputPath,
            candidate.root,
            Boolean(result.copper?.zones.length),
        );
        const verificationDiagnostics = nativeVerificationDiagnostics(inspected.report);
        const nativeVerification = verificationDiagnostics.length ? 'failed' as const : 'passed' as const;
        const diagnostics = [...applied.diagnostics, ...verificationDiagnostics];
        signal.throwIfAborted();

        operation.stage = 'applying';
        await enqueueMutation(async () => {
            const current = await readPcb(operation.path);
            signal.throwIfAborted();
            await saveCheckpoint(current.path, 'Before copilot-router auto route');
            await atomicWritePcb(current.path, current.source, inspected.root);
            if (result.rules.applyRequested) {
                await replaceFileIfPresent(projectPath(applied.outputPath!, '.kicad_pro'), projectPath(current.path, '.kicad_pro'));
                await replaceFileIfPresent(projectPath(applied.outputPath!, '.kicad_dru'), projectPath(current.path, '.kicad_dru'));
            }
        });

        operation.result = {
            status: result.status,
            operation: result.operation,
            tracks: result.copper?.tracks.length ?? 0,
            vias: result.copper?.vias.length ?? 0,
            zones: result.copper?.zones.length ?? 0,
            native_verification: nativeVerification,
            diagnostics,
            metrics: result.metrics,
            artifacts_directory: artifactsDirectory,
        };
        operation.stage = 'completed';
        operation.status = 'completed';
    } catch (error) {
        const cancelled = operation.controller.signal.aborted;
        operation.status = cancelled ? 'cancelled' : 'failed';
        operation.stage = operation.status;
        operation.error = error instanceof Error ? error.message : String(error);
        console.error(error);
    } finally {
        trimOperations();
    }
}

export async function autoRoutePcb(
    path: string,
    dslFile: string,
    options: AutoRouteOptions = {},
    waitMs = 30_000,
) {
    const active = [...operations.values()].find(operation => operation.status === 'running');
    if (active) throw new Error(`auto route is already running: ${active.id}`);
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise; });
    let operationId: string;
    do operationId = createOperationId('pcb-route'); while (operations.has(operationId));
    const operation: RouteOperation = {
        id: operationId,
        path: resolve(path),
        status: 'running',
        stage: 'starting',
        controller,
        done,
    };
    operations.set(operation.id, operation);
    void runOperation(operation, dslFile, options).finally(resolveDone);
    return wait(operation, waitMs);
}

export async function waitAutoRoute(operationId: string, waitMs = 30_000) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`auto route operation not found: ${operationId}`);
    return wait(operation, waitMs);
}

export function cancelAutoRoute(operationId: string) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`auto route operation not found: ${operationId}`);
    if (operation.status === 'running') operation.controller.abort();
    return { status: 'cancel_requested' as const, operation_id: operationId };
}
