import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { BoardAssemble, BoardAssembleSchema } from '../types/board-assemble';
import { CACHE_DIR } from '../utils/dirs';
import { createOperationId } from '../operations/id';

export type ActivePcbLayout = {
    operation_id: string;
    remote_operation_id: string;
    pcb_path: string;
    schematic_path: string;
    pcb_hash: string;
    schematic_hash: string;
    started_at: number;
};

export type StoredPcbLayout = Omit<ActivePcbLayout, 'operation_id' | 'remote_operation_id' | 'started_at'> & {
    layout_id: string;
    pcb: BoardAssemble;
    status: 'ok' | 'failed_with_layout';
    message?: string;
    preview_path?: string;
    preview_svg_path?: string;
    debug_path?: string;
    created_at: number;
};

const directory = join(CACHE_DIR, 'pcb-layout');
const activePath = join(directory, 'active.json');

async function writeJsonAtomic(path: string, value: unknown) {
    await mkdir(directory, { recursive: true });
    const temporary = join(directory, `.${randomUUID()}.json`);
    try {
        await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

async function readJson(path: string) {
    const source = await readFile(path, 'utf8').catch(() => undefined);
    return source ? JSON.parse(source) as unknown : undefined;
}

export async function readActiveLayout() {
    const value = await readJson(activePath) as ActivePcbLayout | undefined;
    if (!value || value.remote_operation_id) return value;

    const migrated = {
        ...value,
        operation_id: createOperationId('pcb-layout'),
        remote_operation_id: value.operation_id,
    };
    await writeActiveLayout(migrated);
    return migrated;
}

export async function writeActiveLayout(active: ActivePcbLayout) {
    await writeJsonAtomic(activePath, active);
}

export async function clearActiveLayout(operationId?: string) {
    const active = await readActiveLayout();
    if (!active || (operationId && active.operation_id !== operationId)) return;
    await rm(activePath, { force: true });
}

export async function storeLayout(layout: StoredPcbLayout) {
    BoardAssembleSchema().parse(layout.pcb);
    await writeJsonAtomic(join(directory, `${layout.layout_id}.json`), layout);
}

export async function readStoredLayout(layoutId: string) {
    const value = await readJson(join(directory, `${layoutId}.json`)) as StoredPcbLayout | undefined;
    if (!value) return undefined;
    value.pcb = BoardAssembleSchema().parse(value.pcb);
    return value;
}

export async function saveDataUrl(value: string | undefined, name: string) {
    if (!value) return undefined;
    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    const bytes = match
        ? match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
        : Buffer.from(value, value.trimStart().startsWith('<svg') ? 'utf8' : 'base64');
    const extension = match?.[1] === 'image/png' ? '.png' : '.svg';
    const path = join(directory, `${name}${extension}`);
    await mkdir(directory, { recursive: true });
    await writeFile(path, bytes);
    return path;
}

export async function savePreviewImageFiles(value: string | undefined, name: string) {
    if (!value) return {};

    const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(value);
    const mimeType = match?.[1];
    const bytes = match
        ? match[2] ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
        : Buffer.from(value, value.trimStart().startsWith('<svg') ? 'utf8' : 'base64');
    const isSvg = mimeType === 'image/svg+xml'
        || bytes.subarray(0, 512).toString('utf8').trimStart().startsWith('<svg');

    await mkdir(directory, { recursive: true });

    const previewSvgPath = isSvg ? join(directory, `${name}.svg`) : undefined;
    const previewPath = join(directory, `${name}.png`);
    await Promise.all([
        ...(previewSvgPath ? [writeFile(previewSvgPath, bytes)] : []),
        sharp(bytes).png().toFile(previewPath),
    ]);

    return {
        previewPath,
        previewSvgPath,
    };
}
