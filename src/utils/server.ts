const DEFAULT_SERVER_URL = 'https://circuit.tech.ru.net';
const SERVER_AUTHORIZATION = 'Basic Y2lyY3VpdDp4eU9BTE5INHBmb05HNjB2VmtBNTg0MTg=';

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
