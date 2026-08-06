import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { ROOT_DIR } from '../utils/dirs';

export type RouterResult = {
    progress?: number;
    routabitity?: number;
    traces?: Array<{
        id?: number | string;
        layer: number;
        net: string;
        path: number[][];
        width: number;
    }>;
    vias?: Array<{
        id?: number | string;
        location: number[];
        net: string;
        size: number[];
    }>;
    [key: string]: unknown;
};

type RouterRunOptions = {
    timeoutMs: number;
    signal?: AbortSignal;
    onProgress?: (progress: number) => void;
};

function messageText(value: unknown) {
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

const ROUTER_WORKER_WRAPPER = String.raw`
const fs = require("fs");
const { parentPort, workerData } = require("worker_threads");

globalThis.self = globalThis;
self.location = {
  href: "file:///" + workerData.workerPath.replace(/\\/g, "/"),
  origin: "file://",
};

self.postMessage = (message) => parentPort.postMessage(message);
parentPort.on("message", (message) => {
  if (typeof self.onmessage === "function") self.onmessage({ data: message });
});

const nativeFetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
const wasmBytes = fs.readFileSync(workerData.wasmPath);
globalThis.fetch = async (url, options) => {
  const href = String(url);
  if (href.includes("PCBRouter-YFDILLBW-YFDILLBW.wasm")) {
    return new Response(wasmBytes, {
      status: 200,
      headers: { "content-type": "application/wasm" },
    });
  }
  if (!nativeFetch) throw new Error("No fetch implementation for " + href);
  return nativeFetch(url, options);
};

require(workerData.workerPath);
`;

function routerFiles() {
    const directory = join(ROOT_DIR, 'dist', 'autorouter');
    return {
        workerPath: join(directory, 'pcbRouterWorker.js'),
        wasmPath: join(directory, 'PCBRouter-YFDILLBW-YFDILLBW.wasm'),
    };
}

export function runLocalRouter(input: unknown, options: RouterRunOptions): Promise<RouterResult> {
    if (options.signal?.aborted) return Promise.reject(new Error('auto route cancelled'));
    const files = routerFiles();

    return new Promise((resolve, reject) => {
        const worker = new Worker(ROUTER_WORKER_WRAPPER, {
            eval: true,
            workerData: files,
        });
        let settled = false;
        let lastResult: RouterResult | undefined;

        const finish = (error?: Error, result?: RouterResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            void worker.terminate().catch(() => undefined);
            if (error) reject(error);
            else resolve(result ?? {});
        };
        const abort = () => finish(new Error('auto route cancelled'));
        options.signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(
            () => finish(new Error(`auto router timeout after ${options.timeoutMs}ms`)),
            options.timeoutMs,
        );

        worker.on('message', (message) => {
            if (message?.topic === 'pcb/routerProgress') {
                const progress = Number(message.message?.progress ?? 0);
                if (Number.isFinite(progress)) options.onProgress?.(progress);
                return;
            }
            if (message?.topic === 'pcb/routerResult') {
                lastResult = message.message as RouterResult;
                const progress = Number(lastResult?.progress ?? 0);
                if (Number.isFinite(progress)) options.onProgress?.(progress);
                if (progress >= 1) finish(undefined, lastResult);
                return;
            }
            if (message?.topic === 'pcb/routerInterrupt') {
                finish(new Error(messageText(message.message?.message ?? message.message ?? 'router interrupted')));
            }
        });
        worker.on('error', (error) => finish(error instanceof Error ? error : new Error(String(error))));
        worker.on('exit', (code) => {
            if (settled) return;
            if (lastResult) finish(undefined, lastResult);
            else finish(new Error(`auto router exited without result${code ? ` (${code})` : ''}`));
        });
        worker.postMessage({
            topic: 'pangolin/autoRouting_wasm',
            type: 'publish',
            message: { json: input, options: {} },
        });
    });
}
