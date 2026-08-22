import { resolve } from 'node:path';
import { runPcbRouterDsl } from '../src/routing/routing-operation';
import { waitOperation } from '../src/operations/control';

const [path, dslFile] = process.argv.slice(2);

async function main() {
    if (!path || !dslFile) {
        throw new Error('Usage: node dist/test-routing-live.js path/to/board.kicad_pcb path/to/pcb-dsl.js');
    }
    const target = resolve(path);
    let result = await runPcbRouterDsl(target, resolve(dslFile), 55_000);
    while (result && typeof result === 'object' && 'operation_id' in result) {
        result = await waitOperation(String(result.operation_id), 55_000);
    }
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
