import { cancelLifecycle, waitLifecycle } from '../analysis/lifecycle-operation';
import { cancelPcbLayout, waitPcbLayout } from '../pcb/layout-operation';
import { cancelAutoRoute, waitAutoRoute } from '../routing/routing-operation';
import { parseOperationId } from './id';

export async function waitOperation(operationId: string, waitMs = 30_000) {
    const { kind } = parseOperationId(operationId);
    if (kind === 'pcb-layout') return waitPcbLayout(operationId, waitMs);
    if (kind === 'pcb-route') return waitAutoRoute(operationId, waitMs);
    return waitLifecycle(operationId, waitMs);
}

export async function cancelOperation(operationId: string) {
    const { kind } = parseOperationId(operationId);
    if (kind === 'pcb-layout') return cancelPcbLayout(operationId);
    if (kind === 'pcb-route') return cancelAutoRoute(operationId);
    return cancelLifecycle(operationId);
}

