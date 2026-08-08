const DEFAULT_SERVER_URL = 'https://circuit.tech.ru.net' // 'http://localhost:5120/';
const SERVER_AUTHORIZATION = 'Basic Y2lyY3VpdDp4eU9BTE5INHBmb05HNjB2VmtBNTg0MTg=';

export type AsyncOperationResponse<T = unknown> = {
    status: 'pending' | 'completed' | 'failed' | 'cancelled';
    result?: T;
    intermediateResult?: unknown;
    error?: string;
    createdAt: string;
    completedAt?: string;
};

export const COPILOT_SERVER_URL = (
    process.env.KICAD_COPILOT_SERVER_URL || DEFAULT_SERVER_URL
).replace(/\/$/, '');

async function parseJsonResponse(response: Response) {
    const text = await response.text();
    if (!text) return null;

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new Error(`Circuit server returned invalid JSON (HTTP ${response.status})`);
    }
}

export async function postJson(path: string, payload: unknown) {
    const response = await fetch(`${COPILOT_SERVER_URL}${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: SERVER_AUTHORIZATION,
        },
        body: JSON.stringify(payload),
    });

    const data = await parseJsonResponse(response);

    if (!response.ok) {
        const message = typeof data === 'object' && data && 'error' in data
            ? String(data.error)
            : `Circuit server HTTP ${response.status}`;
        throw new Error(message);
    }

    return data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function asyncProgress(intermediate: unknown) {
    if (!isRecord(intermediate)) return undefined;
    return typeof intermediate.progress === 'number'
        ? Math.max(0, Math.min(100, Math.round(intermediate.progress)))
        : undefined;
}

async function authorizedJson(url: string, init?: RequestInit) {
    const response = await fetch(url, {
        ...init,
        headers: {
            Authorization: SERVER_AUTHORIZATION,
            ...(init?.headers || {}),
        },
    });
    const data = await parseJsonResponse(response);
    if (!response.ok) throw new Error(`Circuit server HTTP ${response.status}: ${JSON.stringify(data)}`);
    return data;
}

export async function startAsyncTask(path: string, payload: unknown) {
    const data = await authorizedJson(`${COPILOT_SERVER_URL}${path}/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const operationId = isRecord(data) && typeof data.operationId === 'string' ? data.operationId : undefined;
    if (!operationId) throw new Error('missing operation_id');
    return operationId;
}

export async function getAsyncTaskStatus<T>(path: string, operationId: string) {
    return await authorizedJson(
        `${COPILOT_SERVER_URL}${path}/status/${encodeURIComponent(operationId)}`,
    ) as AsyncOperationResponse<T>;
}

export async function cancelAsyncTask(path: string, operationId: string) {
    return authorizedJson(`${COPILOT_SERVER_URL}${path}/cancel/${encodeURIComponent(operationId)}`);
}

export async function waitForAsyncTask<T>(path: string, operationId: string, waitMs: number) {
    const startedAt = Date.now();
    while (true) {
        const operation = await getAsyncTaskStatus<T>(path, operationId);
        if (operation.status !== 'pending' || Date.now() - startedAt >= waitMs) return operation;
        const progress = asyncProgress(operation.intermediateResult);
        if (progress !== undefined) console.error(`[make_pcb_layout] ${progress}%`);
        await sleep(Math.min(2000, Math.max(0, waitMs - (Date.now() - startedAt))));
    }
}
