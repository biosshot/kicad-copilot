import { randomUUID } from 'node:crypto';
import type { AnalysisResult } from './kicad-happy';

type AnalysisOperation = {
    id: string;
    status: 'running' | 'completed' | 'failed';
    stage: string;
    result?: AnalysisResult;
    error?: string;
    done: Promise<void>;
};

const operations = new Map<string, AnalysisOperation>();

function publicStatus(operation: AnalysisOperation) {
    if (operation.status === 'completed') return operation.result!;
    if (operation.status === 'failed') {
        throw new Error(operation.error || 'analysis failed');
    }
    return {
        status: 'running' as const,
        operation_id: operation.id,
        stage: operation.stage,
    };
}

async function wait(operation: AnalysisOperation, waitMs: number) {
    if (operation.status !== 'running') return publicStatus(operation);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            operation.done,
            new Promise<void>((done) => { timer = setTimeout(done, waitMs); }),
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

export async function startAnalysisOperation(
    kind: 'schematic' | 'pcb',
    run: (onStage: (stage: string) => void) => Promise<AnalysisResult>,
    waitMs = 5_000,
) {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const operation: AnalysisOperation = {
        id: randomUUID(),
        status: 'running',
        stage: `preparing_${kind}`,
        done,
    };
    operations.set(operation.id, operation);
    void run((stage) => { operation.stage = stage; })
        .then((result) => {
            operation.result = result;
            operation.status = 'completed';
            operation.stage = 'completed';
        })
        .catch((error) => {
            operation.status = 'failed';
            operation.stage = 'failed';
            operation.error = error instanceof Error ? error.message : String(error);
            console.error(error);
        })
        .finally(() => {
            trimOperations();
            resolveDone();
        });
    return wait(operation, waitMs);
}

export async function waitAnalysis(operationId: string, waitMs = 30_000) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`analysis operation not found: ${operationId}`);
    return wait(operation, waitMs);
}
