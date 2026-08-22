import { resolve } from 'node:path';
import { clearPcbRouting } from '../src/pcb/clear-routing';
import { autoRoutePcb } from '../src/routing/routing-operation';
import { waitOperation } from '../src/operations/control';
import { pourPcbLayers } from '../src/pcb/pour';

const [mode, path, dslFile, timeoutArg] = process.argv.slice(2);

async function main() {
    if (!path || !['route', 'pour', 'clear'].includes(mode || '')) {
        throw new Error('Usage: node dist/test-routing-live.js route|pour|clear path/to/board.kicad_pcb path/to/routing.js [timeout-sec]');
    }
    const target = resolve(path);
    if (mode === 'pour') {
        console.log(await pourPcbLayers(target, {
            net: 'GND', layers: ['F.Cu', 'B.Cu'], stitchVias: true,
        }));
        return;
    }
    if (mode === 'clear') {
        const onlyNets = dslFile
            ? dslFile.split(',').map(net => net.trim()).filter(Boolean)
            : undefined;
        console.log(await clearPcbRouting(target, onlyNets?.length ? { onlyNets } : {}));
        return;
    }
    if (!dslFile) throw new Error('Routing DSL file is required.');
    const timeoutSec = timeoutArg === undefined ? 600 : Number(timeoutArg);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`Invalid timeout: ${timeoutArg}`);
    let result = await autoRoutePcb(target, resolve(dslFile), { timeoutSec }, 55_000);
    while (result && typeof result === 'object' && 'operation_id' in result) {
        result = await waitOperation(String(result.operation_id), 55_000);
    }
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
