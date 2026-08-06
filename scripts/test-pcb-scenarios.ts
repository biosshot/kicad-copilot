import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBoardAssemble } from '../src/kicad/board-assemble';
import { createDocument } from '../src/kicad/create-document';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { setPcbStackLayers } from '../src/kicad/pcb-stack';
import { footprintAt, footprintLayer, footprintReference, listChildren, pcbFootprints, readPcb } from '../src/kicad/pcb-reader';
import { atomicWritePcb, parsePcbSource } from '../src/kicad/pcb-writer';
import { pcbTemplate } from '../src/kicad/pcb-template';
import { atom, findChild, isSExpressionList, token } from '../src/kicad/sexpr/ast';
import { importPcbChanges } from '../src/pcb/import';
import { buildRouterInput } from '../src/pcb/router-adapter';
import { runProcessChecked } from '../src/utils/process';

async function verifyWithCli(path: string) {
    const cli = await getSupportedKicadCli();
    await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', path], { timeoutMs: 30_000 });
}

async function copperLayerNames(path: string) {
    const pcb = await readPcb(path);
    const layers = findChild(pcb.root, 'layers');
    assert.ok(layers, 'PCB must contain a layers table');
    return layers.slice(1)
        .filter(isSExpressionList)
        .map((entry) => atom(entry[1]))
        .filter((name): name is string => Boolean(name && /^(?:F|B|In\d+)\.Cu$/.test(name)));
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
        await setPcbStackLayers(emptyPath, 4);
        assert.deepEqual(await copperLayerNames(emptyPath), ['F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu']);
        await verifyWithCli(emptyPath);

        const usedLayerBoard = await readPcb(emptyPath);
        usedLayerBoard.root.push([
            token('gr_line'),
            [token('start'), token('0'), token('0')],
            [token('end'), token('1'), token('0')],
            [token('stroke'), [token('width'), token('0.2')], [token('type'), token('default')]],
            [token('layer'), token('In2.Cu', true)],
        ]);
        await atomicWritePcb(emptyPath, usedLayerBoard.source, usedLayerBoard.root);
        await assert.rejects(
            () => setPcbStackLayers(emptyPath, 2),
            /cannot remove used copper layers: In2\.Cu/,
        );

        const reduciblePath = join(directory, 'reducible.kicad_pcb');
        await createDocument({ doc_type: 'pcb', path: reduciblePath });
        await setPcbStackLayers(reduciblePath, 6);
        await setPcbStackLayers(reduciblePath, 2);
        assert.deepEqual(await copperLayerNames(reduciblePath), ['F.Cu', 'B.Cu']);
        await verifyWithCli(reduciblePath);

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
        const router = buildRouterInput(assembled.root, {
            routeLayers: ['F.Cu', 'B.Cu'], ignoreNets: ['GND'], speedFirst: true,
        });
        const routerTop = router.input.components[refs[0]] as { footprint: string; rotation: number };
        const routerBottom = router.input.components[refs[1]] as { footprint: string; rotation: number };
        assert.equal(routerTop.rotation, footprintAt(top).rotate, 'router rotation must match KiCad rotation');
        assert.equal(routerBottom.rotation, footprintAt(bottom).rotate, 'router rotation must match KiCad rotation');
        assert.ok(Array.isArray((router.input.footprints[routerTop.footprint] as { bbox?: unknown }).bbox));
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
