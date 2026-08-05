import { readCacheJson, validatePartUuid, writeCacheJson } from './cache';

export type ResolvedDevice = {
    part_uuid: string;
    product_code: string;
    title?: string;
};

const inflight = new Map<string, Promise<ResolvedDevice>>();

async function requestDevice(partUuid: string): Promise<ResolvedDevice> {
    const cached = await readCacheJson<ResolvedDevice>(partUuid, 'device.json');
    if (cached?.product_code) return cached;

    const url = `https://pro.easyeda.com/api/devices/${encodeURIComponent(partUuid)}`
        + `?uuid=${encodeURIComponent(partUuid)}&path=lcsc`;
    const response = await fetch(url);
    const data = await response.json().catch(() => undefined) as {
        success?: boolean;
        result?: { product_code?: string; title?: string };
    } | undefined;
    const productCode = data?.result?.product_code;
    if (!response.ok || !data?.success || !productCode) {
        throw new Error(`LCSC code not found for part_uuid: ${partUuid}`);
    }

    const device = {
        part_uuid: partUuid,
        product_code: productCode,
        title: data.result?.title,
    } satisfies ResolvedDevice;
    await writeCacheJson(partUuid, 'device.json', device);
    return device;
}

export function resolvePartUuid(partUuidInput: string) {
    const partUuid = validatePartUuid(partUuidInput);
    let pending = inflight.get(partUuid);
    if (!pending) {
        pending = requestDevice(partUuid).finally(() => {
            inflight.delete(partUuid);
        });
        inflight.set(partUuid, pending);
    }
    return pending;
}
