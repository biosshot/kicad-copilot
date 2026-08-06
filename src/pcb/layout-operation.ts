import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { BoardAssemble } from '../types/board-assemble';
import { fileHash } from '../kicad/pcb-writer';
import { footprintIsBoardOnly, footprintPath, footprintReference, pcbFootprints, readPcb } from '../kicad/pcb-reader';
import { getPcbSchematic } from '../kicad/schematic-reader';
import {
    AsyncOperationResponse,
    asyncProgress,
    cancelAsyncTask,
    getAsyncTaskStatus,
    startAsyncTask,
    waitForAsyncTask,
} from '../utils/server';
import { associatedSchematicPath } from './paths';
import {
    ActivePcbLayout,
    clearActiveLayout,
    readActiveLayout,
    saveDataUrl,
    storeLayout,
    writeActiveLayout,
} from './layout-cache';

const TASK_PATH = '/v1/mcp-tools/make-pcb-layout';

type MakePcbLayoutResponse = {
    content?: string;
    toolReport?: unknown;
    pcb?: BoardAssemble;
    preview_image_url?: string;
    placement_debug_artifacts?: { items?: Array<{ svg_url?: string; svg?: string }> };
    error?: string;
};

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

async function assertSynchronized(pcbPath: string, schematicPath: string) {
    const [pcb, schematic] = await Promise.all([readPcb(pcbPath), getPcbSchematic(schematicPath)]);
    const expected = schematic.components.filter((component) => component.on_board && component.footprint_name);
    const actual = new Map(pcbFootprints(pcb.root)
        .filter((footprint) => !footprintIsBoardOnly(footprint))
        .flatMap((footprint) => {
            const reference = footprintReference(footprint);
            return reference ? [[reference.toUpperCase(), footprint] as const] : [];
        }));
    const missing = expected.filter((component) => !actual.has(component.designator.toUpperCase()));
    const expectedRefs = new Set(expected.map((component) => component.designator.toUpperCase()));
    const removed = [...actual].filter(([reference, footprint]) => footprintPath(footprint) && !expectedRefs.has(reference));
    if (missing.length || removed.length) {
        throw new Error(`PCB is not synchronized; run import_pcb_changes (${[
            ...missing.map((item) => `missing ${item.designator}`),
            ...removed.map(([reference]) => `removed ${reference}`),
        ].slice(0, 12).join(', ')})`);
    }
    const incompatible = expected.filter((component) => {
        const part = component.part_uuid || '';
        const footprint = component.footprint_uuid || '';
        return !/^[a-f0-9]{32}$/i.test(part) && !/^[a-f0-9]{32}$/i.test(footprint);
    });
    if (incompatible.length) {
        throw new Error(`components have no EasyEDA footprint identity: ${incompatible.map((item) => item.designator).join(', ')}`);
    }
    return schematic.circuit;
}

async function ensureNoActiveOperation() {
    const active = await readActiveLayout();
    if (!active) return;
    const status = await getAsyncTaskStatus<MakePcbLayoutResponse>(TASK_PATH, active.operation_id).catch(() => undefined);
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
        throw new Error(response?.error || 'PCB layout completed without placement');
    }
    const layoutId = randomUUID();
    const [previewPath, debugPath] = await Promise.all([
        saveDataUrl(response.preview_image_url, layoutId),
        saveDebugArtifact(response, layoutId),
    ]);
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
        debug_path: debugPath,
        created_at: Date.now(),
    });
    await clearActiveLayout(active.operation_id);
    return {
        status,
        layout_id: layoutId,
        ...(status === 'failed_with_layout' && response.content ? { message: response.content } : {}),
        ...(previewPath ? { preview_path: previewPath } : {}),
        ...(debugPath ? { debug_path: debugPath } : {}),
    };
}

export async function makePcbLayout(pcbPath: string, file: string, waitMs = 60_000) {
    await ensureNoActiveOperation();
    const schematicPath = await associatedSchematicPath(pcbPath);
    const [code, circuit, pcbHash, schematicHash] = await Promise.all([
        readFile(file, 'utf8'),
        assertSynchronized(pcbPath, schematicPath),
        fileHash(pcbPath),
        fileHash(schematicPath),
    ]);
    const operationId = await startAsyncTask(TASK_PATH, { code, circuit });
    const active: ActivePcbLayout = {
        operation_id: operationId,
        pcb_path: pcbPath,
        schematic_path: schematicPath,
        pcb_hash: pcbHash,
        schematic_hash: schematicHash,
        started_at: Date.now(),
    };
    await writeActiveLayout(active);
    return finishOperation(active, await waitForAsyncTask<MakePcbLayoutResponse>(TASK_PATH, operationId, waitMs));
}

export async function waitPcbLayout(operationId: string, waitMs = 60_000) {
    const active = await readActiveLayout();
    if (!active || active.operation_id !== operationId) throw new Error(`PCB layout operation not found: ${operationId}`);
    return finishOperation(active, await waitForAsyncTask<MakePcbLayoutResponse>(TASK_PATH, operationId, waitMs));
}

export async function cancelPcbLayout(operationId: string) {
    const active = await readActiveLayout();
    if (!active || active.operation_id !== operationId) throw new Error(`PCB layout operation not found: ${operationId}`);
    await cancelAsyncTask(TASK_PATH, operationId);
    const status = await getAsyncTaskStatus<MakePcbLayoutResponse>(TASK_PATH, operationId).catch(() => undefined);
    if (status && status.status !== 'pending') await clearActiveLayout(operationId);
    return { status: 'cancel_requested', operation_id: operationId };
}
