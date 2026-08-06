import { resolve } from 'node:path';
import { autoRoutePcb, clearPcbRouting, waitAutoRoute } from '../src/pcb/routing-operation';
import { pourPcbLayers } from '../src/pcb/pour';

const [mode, path] = process.argv.slice(2);

async function main() {
    if (!path || !['route', 'route-pour', 'pour', 'clear'].includes(mode || '')) {
        throw new Error('Usage: node dist/test-routing-live.js route|route-pour|pour|clear path/to/board.kicad_pcb');
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
    let result = await autoRoutePcb(target, {
        ignoreNets: ['GND'], routeLayers: ['F.Cu', 'B.Cu'],
        routingEffectPriority: 'SPEED_FIRST',
        timeoutSec: 600,
        pourGnd: mode === 'route-pour',
        stitchGnd: mode === 'route-pour',
    }, 180_000);
    while (result && typeof result === 'object' && 'operation_id' in result) {
        result = await waitAutoRoute(String(result.operation_id), 180_000);
    }
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
