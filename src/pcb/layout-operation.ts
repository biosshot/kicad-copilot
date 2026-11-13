import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BoardAssemble } from '../types/board-assemble';
import { fileHash } from '../kicad/pcb-writer';
import { makePcbLayout as generatePcbLayout, disposeBackend, type PcbLayoutProgress } from 'eda-copilot-backend/pcb';
import { associatedSchematicPath } from './paths';
import { importPcbChanges } from './import';
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

type LayoutResult = Awaited<ReturnType<typeof finishResponse>>;
type LocalOperation = {
    active: ActivePcbLayout;
    controller: AbortController;
    progress?: PcbLayoutProgress;
    running: boolean;
    done: Promise<void>;
    result?: LayoutResult;
    error?: Error;
};
const operations = new Map<string, LocalOperation>();
let starting = false;

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

function resultStatus(response: MakePcbLayoutResponse) {
    const status = record(response.toolReport)?.status;
    return status === 'error' ? 'failed_with_layout' as const : 'ok' as const;
}

async function saveDebugArtifact(response: MakePcbLayoutResponse, layoutId: string) {
    const first = response.placement_debug_artifacts?.items?.find((item) => item.svg_url || item.svg);
    return saveDataUrl(first?.svg_url || first?.svg, `${layoutId}-debug`);
}

async function finishResponse(active: ActivePcbLayout, response: MakePcbLayoutResponse, signal: AbortSignal) {
    signal.throwIfAborted();
    if (!response.pcb) return pcbLayoutWithoutPlacementResult(active.operation_id, response);
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
    await enqueueMutation(() => {
        signal.throwIfAborted();
        return assemblePcbLayout(active.pcb_path, layoutId);
    });
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

async function wait(operation: LocalOperation, waitMs: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([operation.done, new Promise<void>(resolve => { timer = setTimeout(resolve, Math.max(0, waitMs)); })]);
    } finally {
        if (timer) clearTimeout(timer);
    }
    if (operation.error) throw operation.error;
    if (operation.result) return operation.result;
    return { status: 'running' as const, operation_id: operation.active.operation_id, progress: operation.progress };
}

export async function makePcbLayout(pcbPath: string, file: string, waitMs = 30_000) {
    if (starting || [...operations.values()].some(operation => operation.running)) {
        throw new Error('make_pcb_layout is already running');
    }
    starting = true;
    let operation: LocalOperation;
    try {
        const stale = await readActiveLayout();
        if (stale?.pid && stale.pid !== process.pid) {
            let alive = true;
            try { process.kill(stale.pid, 0); } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
            }
            if (alive) throw new Error(`make_pcb_layout is already running: ${stale.operation_id}`);
        }
        if (stale) await clearActiveLayout(stale.operation_id);
        const schematicPath = await associatedSchematicPath(pcbPath);
        await enqueueMutation(() => importPcbChanges(pcbPath, schematicPath));
        const [code, input, pcbHash, schematicHash] = await Promise.all([
            readFile(file, 'utf8'), createPcbLayoutInput(pcbPath, schematicPath, true),
            fileHash(pcbPath), fileHash(schematicPath),
        ]);
        const active: ActivePcbLayout = {
            operation_id: createOperationId('pcb-layout'), pcb_path: pcbPath,
            schematic_path: schematicPath, pcb_hash: pcbHash, schematic_hash: schematicHash,
            started_at: Date.now(), pid: process.pid,
        };
        await writeActiveLayout(active);
        operation = { active, controller: new AbortController(), done: Promise.resolve(), running: true };
        operations.set(active.operation_id, operation);
        const current = operation;
        current.done = (async () => {
            try {
                const response = await generatePcbLayout({ code, ...input }, {
                    signal: current.controller.signal,
                    onProgress: (progress: PcbLayoutProgress) => { current.progress = progress; },
                });
                current.result = await finishResponse(active, response as MakePcbLayoutResponse, current.controller.signal);
            } catch (error) {
                current.error = error instanceof Error ? error : new Error(String(error));
            } finally {
                try { await clearActiveLayout(active.operation_id); }
                catch (error) { current.error ??= error instanceof Error ? error : new Error(String(error)); }
                current.running = false;
            }
        })();
    } finally {
        starting = false;
    }
    return wait(operation, waitMs);
}

export async function waitPcbLayout(operationId: string, waitMs = 30_000) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`PCB layout operation not found or interrupted: ${operationId}`);
    return wait(operation, waitMs);
}

export async function cancelPcbLayout(operationId: string) {
    const operation = operations.get(operationId);
    if (!operation) throw new Error(`PCB layout operation not found or interrupted: ${operationId}`);
    if (operation.running) operation.controller.abort();
    return { status: 'cancel_requested' as const, operation_id: operationId };
}

export async function disposePcbLayoutBackend() {
    for (const operation of operations.values()) {
        if (operation.running) operation.controller.abort();
    }
    await Promise.all([...operations.values()].map(operation => operation.done));
    await disposeBackend();
}
