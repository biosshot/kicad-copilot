import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BoardAssemble } from '../types/board-assemble';
import { fileHash } from '../kicad/pcb-writer';
import {
    AsyncOperationResponse,
    asyncProgress,
    cancelAsyncTask,
    getAsyncTaskStatus,
    startAsyncTask,
    waitForAsyncTask,
} from '../utils/server';
import { associatedSchematicPath } from './paths';
import { createPcbLayoutInput } from './layout-input';
import {
    ActivePcbLayout,
    clearActiveLayout,
    readActiveLayout,
    saveDataUrl,
    savePreviewImageFiles,
    storeLayout,
    writeActiveLayout,
} from './layout-cache';
import { createOperationId } from '../operations/id';
import { enqueueMutation } from '../utils/mutation-queue';
import { assemblePcbLayout } from './assemble';

const TASK_PATH = '/v1/mcp-tools/make-pcb-layout';

type MakePcbLayoutResponse = {
    content?: string;
    toolReport?: unknown;
    pcb?: BoardAssemble;
    preview_image_url?: string;
    placement_debug_artifacts?: { items?: Array<{ svg_url?: string; svg?: string }> };
    error?: string;
};

export function pcbLayoutWithoutPlacementResult(
    operationId: string,
    response: MakePcbLayoutResponse | undefined,
) {
    return {
        status: 'error' as const,
        operation_id: operationId,
        message: response?.content || response?.error || 'PCB layout operation completed without result.',
        ...(response?.toolReport !== undefined ? { report: response.toolReport } : {}),
    };
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

async function ensureNoActiveOperation() {
    const active = await readActiveLayout();
    if (!active) return;
    const status = await getAsyncTaskStatus<MakePcbLayoutResponse>(
        TASK_PATH,
        active.remote_operation_id,
    ).catch(() => undefined);
    if (status?.status === 'pending') {
        throw new Error(`make_pcb_layout is already running: ${active.operation_id}`);
    }
    await clearActiveLayout(active.operation_id);
}

function resultStatus(response: MakePcbLayoutResponse) {
    const status = record(response.toolReport)?.status;
    return status === 'error' ? 'failed_with_layout' as const : 'ok' as const;
}

async function saveDebugArtifact(response: MakePcbLayoutResponse, layoutId: string) {
    const first = response.placement_debug_artifacts?.items?.find((item) => item.svg_url || item.svg);
    return saveDataUrl(first?.svg_url || first?.svg, `${layoutId}-debug`);
}

async function finishOperation(active: ActivePcbLayout, operation: AsyncOperationResponse<MakePcbLayoutResponse>) {
    if (operation.status === 'pending') {
        return {
            status: 'running',
            operation_id: active.operation_id,
            progress: asyncProgress(operation.intermediateResult),
        };
    }
    if (operation.status === 'failed' || operation.status === 'cancelled') {
        await clearActiveLayout(active.operation_id);
        throw new Error(operation.error || `PCB layout ${operation.status}`);
    }
    const response = operation.result;
    if (!response?.pcb) {
        await clearActiveLayout(active.operation_id);
        return pcbLayoutWithoutPlacementResult(active.operation_id, response);
    }
    const layoutId = randomUUID();
    const [preview, debugPath] = await Promise.all([
        savePreviewImageFiles(response.preview_image_url, layoutId),
        saveDebugArtifact(response, layoutId),
    ]);
    const { previewPath, previewSvgPath } = preview;
    const status = resultStatus(response);
    await storeLayout({
        layout_id: layoutId,
        pcb: response.pcb,
        pcb_path: active.pcb_path,
        schematic_path: active.schematic_path,
        pcb_hash: active.pcb_hash,
        schematic_hash: active.schematic_hash,
        status,
        message: response.content || response.error,
        preview_path: previewPath,
        preview_svg_path: previewSvgPath,
        debug_path: debugPath,
        created_at: Date.now(),
    });
    await clearActiveLayout(active.operation_id);
    await enqueueMutation(() => assemblePcbLayout(active.pcb_path, layoutId));
    return {
        status,
        applied: true,
        layout_id: layoutId,
        ...(status === 'failed_with_layout' && response.content ? { message: response.content } : {}),
        ...(previewPath ? { preview_path: previewPath } : {}),
        ...(previewSvgPath ? { preview_svg_path: previewSvgPath } : {}),
        ...(debugPath ? { debug_path: debugPath } : {}),
    };
}

export async function makePcbLayout(pcbPath: string, file: string, waitMs = 30_000) {
    await ensureNoActiveOperation();
    const schematicPath = await associatedSchematicPath(pcbPath);
    const [code, input, pcbHash, schematicHash] = await Promise.all([
        readFile(file, 'utf8'),
        createPcbLayoutInput(pcbPath, schematicPath, true),
        fileHash(pcbPath),
        fileHash(schematicPath),
    ]);
    const remoteOperationId = await startAsyncTask(TASK_PATH, { code, ...input });
    const operationId = createOperationId('pcb-layout');
    const active: ActivePcbLayout = {
        operation_id: operationId,
        remote_operation_id: remoteOperationId,
        pcb_path: pcbPath,
        schematic_path: schematicPath,
        pcb_hash: pcbHash,
        schematic_hash: schematicHash,
        started_at: Date.now(),
    };
    await writeActiveLayout(active);
    return finishOperation(active, await waitForAsyncTask<MakePcbLayoutResponse>(
        TASK_PATH,
        remoteOperationId,
        waitMs,
    ));
}

export async function waitPcbLayout(operationId: string, waitMs = 30_000) {
    const active = await readActiveLayout();
    if (!active || active.operation_id !== operationId) throw new Error(`PCB layout operation not found: ${operationId}`);
    return finishOperation(active, await waitForAsyncTask<MakePcbLayoutResponse>(
        TASK_PATH,
        active.remote_operation_id,
        waitMs,
    ));
}

export async function cancelPcbLayout(operationId: string) {
    const active = await readActiveLayout();
    if (!active || active.operation_id !== operationId) throw new Error(`PCB layout operation not found: ${operationId}`);
    await cancelAsyncTask(TASK_PATH, active.remote_operation_id);
    const status = await getAsyncTaskStatus<MakePcbLayoutResponse>(
        TASK_PATH,
        active.remote_operation_id,
    ).catch(() => undefined);
    if (status && status.status !== 'pending') await clearActiveLayout(operationId);
    return { status: 'cancel_requested', operation_id: operationId };
}
