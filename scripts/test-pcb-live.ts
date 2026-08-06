import { resolve } from 'node:path';
import { makePcbLayout } from '../src/pcb/layout-operation';

const [pcbPath, dslPath] = process.argv.slice(2);

if (!pcbPath || !dslPath) {
    console.error('Usage: npm run test:pcb-live -- path/to/board.kicad_pcb path/to/layout.js');
    process.exitCode = 1;
} else {
    makePcbLayout(resolve(pcbPath), resolve(dslPath), 180_000)
        .then((result) => console.log(JSON.stringify(result, null, 2)))
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        });
}
