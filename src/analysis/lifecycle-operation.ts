import {
    runLifecycleAudit,
    type AnalysisResult,
    type LifecycleAuditOptions,
} from './kicad-happy';
import { createOperationId } from '../operations/id';

type LifecycleOperation = {
    id: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    stage: string;
    result?: AnalysisResult;
    error?: string;
    controller: AbortController;
    done: Promise<void>;
};

const operations = new Map<string, LifecycleOperation>();

function publicStatus(operation: LifecycleOperation) {
    if (operation.status === 'completed') return operation.result!;
    if (operation.status === 'failed' || operation.status === 'cancelled') {
        throw new Error(operation.error || `Lifecycle audit ${operation.status}.`);
    }
    return {
        status: 'running' as const,
        operation_id: operation.id,
        stage: operation.stage,
    };
}

async function wait(operation: LifecycleOperation, waitMs: number) {
    if (operation.status !== 'running') return publicStatus(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation.done,
            new Promise<void>(resolvePromise => {
                timer = setTimeout(resolvePromise, waitMs);
            }),
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

async function execute(operation: LifecycleOperation, path: string, options: LifecycleAuditOptions) {
    try {
        operation.stage = 'querying_distributors';
        operation.result = await runLifecycleAudit(path, options, operation.controller.signal);
        operation.status = 'completed';
        operation.stage = 'completed';
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

export async function auditLifecycle(
    path: string,
    options: LifecycleAuditOptions,
    waitMs = 30_000,
) {
    let id: string;
    do id = createOperationId('lifecycle'); while (operations.has(id));
    const controller = new AbortController();
    let resolveDone!: () => void;
    const done = new Promise<void>(resolvePromise => { resolveDone = resolvePromise; });
    const operation: LifecycleOperation = {
        id,
        status: 'running',
        stage: 'starting',
        controller,
        done,
    };
    operations.set(id, operation);
    void execute(operation, path, options).finally(resolveDone);
    return wait(operation, waitMs);
}

export async function waitLifecycle(operationId: string, waitMs = 30_000) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Lifecycle operation not found: ${operationId}`);
    return wait(operation, waitMs);
}

export function cancelLifecycle(operationId: string) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`Lifecycle operation not found: ${operationId}`);
    if (operation.status === 'running') operation.controller.abort();
    return { status: 'cancel_requested' as const, operation_id: operationId };
}
