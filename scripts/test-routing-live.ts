import { resolve } from 'node:path';
import { runPcbDsl } from '../src/routing/routing-operation';
import { waitOperation } from '../src/operations/control';

const [path, dslFile, timeoutArg] = process.argv.slice(2);

async function main() {
    if (!path || !dslFile) {
        throw new Error('Usage: node dist/test-routing-live.js path/to/board.kicad_pcb path/to/pcb-dsl.js [timeout-sec]');
    }
    const target = resolve(path);
    const timeoutSec = timeoutArg === undefined ? 600 : Number(timeoutArg);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new Error(`Invalid timeout: ${timeoutArg}`);
    let result = await runPcbDsl(target, resolve(dslFile), { timeoutSec }, 55_000);
    while (result && typeof result === 'object' && 'operation_id' in result) {
        result = await waitOperation(String(result.operation_id), 55_000);
    }
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
