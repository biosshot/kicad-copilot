import { readFileSync } from 'node:fs';
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const match = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    const ids = JSON.parse(readFileSync(process.env.KICAD_MATRIX_LOCAL_IDS, 'utf8'));
    if (match && ids.includes(decodeURIComponent(match[1])))
        return Response.json({ success: false, result: null, msg: 'local native fixture' });
    return original(input, init);
};
