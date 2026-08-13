import { resolve } from 'node:path';
import { clearPcbRouting } from '../src/pcb/clear-routing';
import { autoRoutePcb, waitAutoRoute } from '../src/routing/routing-operation';
import { pourPcbLayers } from '../src/pcb/pour';

const [mode, path, dslFile] = process.argv.slice(2);

async function main() {
    if (!path || !['route', 'pour', 'clear'].includes(mode || '')) {
        throw new Error('Usage: node dist/test-routing-live.js route|pour|clear path/to/board.kicad_pcb path/to/routing.js');
    }
    const target = resolve(path);
    if (mode === 'pour') {
        console.log(await pourPcbLayers(target, {
            net: 'GND', layers: ['F.Cu', 'B.Cu'], stitchVias: true,
        }));
        return;
    }
    if (mode === 'clear') {
        console.log(await clearPcbRouting(target));
        return;
    }
    if (!dslFile) throw new Error('Routing DSL file is required.');
    let result = await autoRoutePcb(target, resolve(dslFile), { timeoutSec: 600 }, 180_000);
    while (result && typeof result === 'object' && 'operation_id' in result) {
        result = await waitAutoRoute(String(result.operation_id), 180_000);
    }
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
