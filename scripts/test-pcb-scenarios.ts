import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBoardAssemble } from '../src/kicad/board-assemble';
import { createDocument } from '../src/kicad/create-document';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { footprintAt, footprintLayer, footprintReference, listChildren, pcbFootprints, readPcb } from '../src/kicad/pcb-reader';
import { atomicWritePcb, parsePcbSource } from '../src/kicad/pcb-writer';
import { pcbTemplate } from '../src/kicad/pcb-template';
import { importPcbChanges } from '../src/pcb/import';
import { runProcessChecked } from '../src/utils/process';

async function verifyWithCli(path: string) {
    const cli = await getSupportedKicadCli();
    await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', path], { timeoutMs: 30_000 });
}

async function main() {
    parsePcbSource(pcbTemplate(9));
    parsePcbSource(pcbTemplate(10));
    const directory = await mkdtemp(join(tmpdir(), 'kicad-copilot-pcb-'));
    let passed = false;
    try {
        const emptyPath = join(directory, 'empty.kicad_pcb');
        await createDocument({ doc_type: 'pcb', path: emptyPath });
        await verifyWithCli(emptyPath);

        const fixtureDirectory = process.env.KICAD_COPILOT_PCB_FIXTURE_DIR || 'D:\\MyProject\\kicad\\test';
        const sourceSch = join(fixtureDirectory, 'stm32_debug.kicad_sch');
        const targetPcb = join(directory, 'stm32_debug.kicad_pcb');
        const targetSch = join(directory, 'stm32_debug.kicad_sch');
        await cp(sourceSch, targetSch);
        await createDocument({ doc_type: 'pcb', path: targetPcb });
        await cp(join(fixtureDirectory, 'kicad-copilot.pretty'), join(directory, 'kicad-copilot.pretty'), { recursive: true });
        await cp(join(fixtureDirectory, 'fp-lib-table'), join(directory, 'fp-lib-table'));
        await importPcbChanges(targetPcb);
        await verifyWithCli(targetPcb);

        const board = await readPcb(targetPcb);
        const refs = pcbFootprints(board.root).map(footprintReference).filter((value): value is string => Boolean(value));
        assert.ok(refs.length >= 2, 'import must retain schematic footprints');
        applyBoardAssemble(board.root, board.version, {
            board: { polygon: [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }] },
            components: [
                { designator: refs[0], x: -5, y: 4, rotate: 30, layer: 'top' },
                { designator: refs[1], x: 5, y: -6, rotate: 270, layer: 'bottom' },
            ],
            vias: [{ x: 0, y: 10, diameter: 3.2, drill: 3.2 }],
        });
        await atomicWritePcb(targetPcb, board.source, board.root);
        const assembled = await readPcb(targetPcb);
        assert.equal(listChildren(assembled.root, 'gr_line').length, 4, 'outline must contain four edges');
        const top = pcbFootprints(assembled.root).find((item) => footprintReference(item) === refs[0])!;
        const bottom = pcbFootprints(assembled.root).find((item) => footprintReference(item) === refs[1])!;
        const hole = pcbFootprints(assembled.root).find((item) => footprintReference(item) === '#HOLE_1')!;
        assert.deepEqual(footprintAt(top), { x: 143.5, y: 101, rotate: 150 });
        assert.deepEqual(footprintAt(bottom), { x: 153.5, y: 111, rotate: 90 });
        assert.equal(footprintLayer(bottom), 'B.Cu');
        assert.deepEqual(footprintAt(hole), { x: 148.5, y: 95, rotate: 0 });
        assert.ok(pcbFootprints(assembled.root).some((item) => item.some((child) => Array.isArray(child) && child[0] && !Array.isArray(child[0]) && child[0].value === 'property')));
        await verifyWithCli(targetPcb);
        await writeFile(join(directory, 'result.txt'), `ok ${refs.length}\n`);
        console.log(`PCB scenarios ok: ${refs.length} footprints`);
        passed = true;
    } finally {
        if (passed) await rm(directory, { recursive: true, force: true });
        else console.error(`Failed PCB artifacts: ${directory}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
