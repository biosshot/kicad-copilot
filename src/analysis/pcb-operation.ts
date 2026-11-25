import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { renderAnalysisReport, runAnalysisDsl, type AnalysisImage } from 'eda-copilot-backend/analyze';
import sharp from 'sharp';
import { createOperationId } from '../operations/id';
import { captureBoardV2 } from '../pcb/board-v2';
import { TEMP_DIR } from '../utils/dirs';

async function analyze(path: string, file: string, operation: PcbAnalysisOperation) {
    const { id, controller: { signal } } = operation;
    const code = await readFile(file, { encoding: 'utf8', signal });
    if (!code.trim()) throw new Error('The PCB analysis DSL file is empty.');
    const snapshot = await captureBoardV2(path);
    signal.throwIfAborted();
    operation.stage = 'analyzing';
    const result = await runAnalysisDsl({ code, board: snapshot.board }, {
        signal, filename: basename(file), timeoutMs: 75 * 60_000, maxOutputBytes: 128 * 1024 * 1024,
    });
    signal.throwIfAborted();
    operation.stage = 'rendering';
    const report = renderAnalysisReport(result, snapshot.board);
    await mkdir(TEMP_DIR, { recursive: true });
    const directory = await mkdtemp(join(TEMP_DIR, 'pcb-analysis-'));
    try {
        const resultPath = join(directory, 'result.json');
        const summaryPath = join(directory, 'summary.json');
        const boardPath = join(directory, 'routing-board-v2.json');
        await writeFile(resultPath, JSON.stringify(result), { signal });
        await writeFile(boardPath, JSON.stringify(snapshot), { signal });
        const images: (Omit<AnalysisImage, 'svg'> & { image_path: string })[] = [];
        const renderErrors: { name: string; message: string }[] = [];
        for (const { svg, ...image } of report.images) {
            signal.throwIfAborted();
            const imagePath = join(directory, image.name + '.png');
            try {
                const png = await sharp(Buffer.from(svg)).resize(1024, 1600, {
                    fit: 'inside', withoutEnlargement: true,
                }).png().toBuffer();
                await writeFile(imagePath, png, { signal });
                images.push({ ...image, image_path: imagePath });
            } catch (error) {
                signal.throwIfAborted();
                renderErrors.push({ name: image.name, message: error instanceof Error ? error.message : String(error) });
            }
        }
        await writeFile(summaryPath, JSON.stringify({
            ...report.summary, capture_diagnostics: snapshot.diagnostics, images, render_errors: renderErrors,
        }, null, 2), { signal });
        signal.throwIfAborted();
        const diagnosticCodes = new Set([
            ...snapshot.diagnostics.map(item => item.code),
            ...report.summary.diagnostics.map(item => item.code),
            ...report.summary.calculations.flatMap(item => item.diagnostics.map(diagnostic => diagnostic.code)),
            ...(result.error ? [result.error.code, ...result.error.diagnostics.map(item => item.code)] : []),
        ]);
        return {
            status: result.status, operation_id: id, physical_accuracy: report.summary.physicalAccuracy,
            calculations: report.summary.calculations.map(({ analysis, status, validity }) => ({ analysis, status, validity })),
            checks: report.summary.checks, diagnostic_codes: [...diagnosticCodes],
            ...(result.error && { error: { code: result.error.code, message: result.error.message } }),
            artifacts_directory: directory, result_path: resultPath, summary_path: summaryPath,
            board_path: boardPath, images, ...(renderErrors.length && { render_errors: renderErrors }),
        };
    } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
    }
}

type PcbAnalysisOperation = {
    id: string;
    stage: string;
    controller: AbortController;
    result?: Awaited<ReturnType<typeof analyze>> | { status: 'cancelled' | 'failed'; operation_id: string; error?: string };
    done?: Promise<void>;
};

const operations = new Map<string, PcbAnalysisOperation>();

function getOperation(id: string) {
    const operation = operations.get(id);
    if (!operation) throw new Error(`PCB analysis operation not found: ${id}`);
    return operation;
}

export async function waitPcbAnalysis(id: string, waitMs: number) {
    const operation = getOperation(id);
    if (!operation.result) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([operation.done, new Promise<void>(done => { timer = setTimeout(done, waitMs); })]);
        } finally {
            clearTimeout(timer);
        }
    }
    return operation.result ?? { status: 'running' as const, operation_id: id, stage: operation.stage };
}

export function runPcbAnalysis(path: string, file: string, waitMs: number) {
    const active = [...operations.values()].find(operation => !operation.result);
    if (active) throw new Error(`PCB analysis already running: ${active.id}`);
    let id: string;
    do id = createOperationId('pcb-analysis'); while (operations.has(id));
    const operation: PcbAnalysisOperation = { id, stage: 'capturing', controller: new AbortController() };
    operations.set(id, operation);
    operation.done = analyze(resolve(path), resolve(file), operation).then(result => {
        operation.result = result;
    }).catch(error => {
        operation.result = operation.controller.signal.aborted
            ? { status: 'cancelled', operation_id: id }
            : { status: 'failed', operation_id: id, error: error instanceof Error ? error.message : String(error) };
    }).finally(() => {
        if (operations.size > 20) operations.delete(operations.keys().next().value!);
    });
    return waitPcbAnalysis(id, waitMs);
}

export function cancelPcbAnalysis(id: string) {
    const operation = getOperation(id);
    if (operation.result) return operation.result;
    operation.controller.abort();
    return { status: 'cancel_requested' as const, operation_id: id };
}

export async function disposePcbAnalysis() {
    const active = [...operations.values()].filter(operation => !operation.result);
    for (const operation of active) operation.controller.abort();
    await Promise.all(active.map(operation => operation.done));
}
