import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { disposeBackend, getPcbComponentSizes, makePcbLayout } from 'eda-copilot-backend/pcb';
import { applyBoardAssemble } from '../src/kicad/board-assemble';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { pcbTemplate } from '../src/kicad/pcb-template';
import { kicadFootprintToSpec } from '../src/kicad/footprint-spec';
import { parsePcbSource, serializePcb } from '../src/kicad/pcb-writer';
import { pcbFootprints, footprintAt, footprintReference, listChildren } from '../src/kicad/pcb-reader';
import { atom, findChild, parseSExpression } from '../src/kicad/sexpr/ast';
import { boardOutline } from '../src/pcb/board-geometry';
import { runProcessChecked } from '../src/utils/process';

const footprintId = '33333333-3333-4333-8333-333333333333';
function nativeFootprint(ref: string) {
    return parseSExpression(`(footprint "Test:R_0603"
        (layer "F.Cu") (at 0 0) (property "Reference" "${ref}" (at 0 -2) (layer "F.SilkS"))
        (property "Value" "1k" (at 0 2) (layer "F.Fab"))
        (pad "1" smd rect (at -0.7 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
        (pad "2" smd rect (at 0.7 0) (size 0.6 0.8) (layers "F.Cu" "F.Paste" "F.Mask")))`);
}
const footprint = kicadFootprintToSpec(nativeFootprint('R1'));
const input = {
    code: 'board.rect(20, 12); block("divider", ["R1", "R2"], "generic");',
    circuit: { components: [
        { designator: 'R1', value: '1k', part_uuid: null, footprint_uuid: footprintId, pins: [
            { pin_number: '1', name: '1', signal_name: 'VIN' }, { pin_number: '2', name: '2', signal_name: 'MID' },
        ] },
        { designator: 'R2', value: '1k', part_uuid: null, footprint_uuid: footprintId, pins: [
            { pin_number: '1', name: '1', signal_name: 'MID' }, { pin_number: '2', name: '2', signal_name: 'GND' },
        ] },
    ] },
    footprints: { [footprintId]: footprint },
};

async function main() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => { throw new Error('Unexpected network access'); };
    const directory = await mkdtemp(join(tmpdir(), 'kicad-local-backend-'));
    let passed = false;
    try {
        const sizes = await getPcbComponentSizes({ ...input, includeAll: true });
        assert.equal(sizes.report?.selected, 2, JSON.stringify(sizes));
        const progress: string[] = [];
        const result = await makePcbLayout(input, { onProgress: item => progress.push(item.stage) });
        assert.ok(result.pcb, result.content);
        assert.equal(result.toolReport?.status, 'ok', result.content);
        assert.equal(progress.at(-1), 'done');
        const root = parsePcbSource(pcbTemplate(10));
        for (const ref of ['R1', 'R2']) root.push(nativeFootprint(ref));
        applyBoardAssemble(root, 20260206, result.pcb);
        assert.equal(boardOutline(root).points.length, 4);
        for (const ref of ['R1', 'R2']) {
            const item = pcbFootprints(root).find(fp => footprintReference(fp) === ref);
            assert.ok(item);
            assert.ok(Number.isFinite(footprintAt(item).x));
            const pads = listChildren(item, 'pad');
            assert.equal(pads.length, 2);
            for (const [index, pad] of pads.entries()) {
                assert.equal(atom(pad[1]), String(index + 1));
                assert.deepEqual(findChild(pad, 'at')?.slice(1, 3).map(atom), [index ? '0.7' : '-0.7', '0']);
                assert.deepEqual(findChild(pad, 'size')?.slice(1).map(atom), ['0.6', '0.8']);
            }
        }
        const path = join(directory, 'local.kicad_pcb');
        await writeFile(path, serializePcb(root));
        const cli = await getSupportedKicadCli();
        await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', path], { timeoutMs: 30_000 });
        passed = true;
        console.log('Local PCB backend smoke passed: 2 sizes, native placement, KiCad CLI upgrade');
    } finally {
        globalThis.fetch = originalFetch;
        await disposeBackend();
        if (passed) await rm(directory, { recursive: true, force: true });
        else console.error(`Failed PCB artifacts: ${directory}`);
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
