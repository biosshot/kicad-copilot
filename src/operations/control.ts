import { cancelLifecycle, waitLifecycle } from '../analysis/lifecycle-operation';
import { cancelPcbLayout, waitPcbLayout } from '../pcb/layout-operation';
import { cancelPcbDsl, waitPcbDsl } from '../routing/routing-operation';
import { parseOperationId } from './id';

export async function waitOperation(operationId: string, waitMs = 30_000) {
    const { kind } = parseOperationId(operationId);
    if (kind === 'pcb-layout') return waitPcbLayout(operationId, waitMs);
    if (kind === 'pcb-dsl') return waitPcbDsl(operationId, waitMs);
    return waitLifecycle(operationId, waitMs);
}

export async function cancelOperation(operationId: string) {
    const { kind } = parseOperationId(operationId);
    if (kind === 'pcb-layout') return cancelPcbLayout(operationId);
    if (kind === 'pcb-dsl') return cancelPcbDsl(operationId);
    return cancelLifecycle(operationId);
}
