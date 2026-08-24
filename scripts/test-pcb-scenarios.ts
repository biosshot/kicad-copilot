import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importKiCadRoutingBoard } from 'eda-copilot-router/adapters/kicad';
import { applyBoardAssemble } from '../src/kicad/board-assemble';
import { createDocument } from '../src/kicad/create-document';
import { getSupportedKicadCli, preferredSupportedKicadCli } from '../src/kicad/cli';
import { footprintAt, footprintIsGenerated, footprintLayer, footprintReference, listChildren, pcbFootprints, readPcb } from '../src/kicad/pcb-reader';
import { footprintGeometryIsNormalized, normalizeEasyEdaFootprintGeometry } from '../src/kicad/footprint-normalization';
import { atomicWritePcb, parsePcbSource } from '../src/kicad/pcb-writer';
import { pcbTemplate } from '../src/kicad/pcb-template';
import { atom, findChild, isSExpressionList, listHead, parseSExpression, printSExpression, SExpression, token } from '../src/kicad/sexpr/ast';
import { importPcbChanges } from '../src/pcb/import';
import { pcbLayoutWithoutPlacementResult } from '../src/pcb/layout-operation';
import { boardOutline } from '../src/pcb/board-geometry';
import { runProcessChecked } from '../src/utils/process';

async function verifyWithCli(path: string) {
    const cli = await getSupportedKicadCli();
    await runProcessChecked(cli.path, ['pcb', 'upgrade', '--force', path], { timeoutMs: 30_000 });
}

async function main() {
    assert.equal(preferredSupportedKicadCli([
        { path: 'path-kicad-8', version: '8.0.9', major: 8 },
        { path: 'installed-kicad-9', version: '9.0.7', major: 9 },
        { path: 'installed-kicad-10', version: '10.0.1', major: 10 },
    ])?.path, 'installed-kicad-10', 'CLI discovery must skip KiCad 8 and prefer KiCad 10');

    const layoutReport = { status: 'error', dsl: { ok: false } };
    assert.deepEqual(pcbLayoutWithoutPlacementResult('layout-op', {
        content: 'status: error\n\nDSL:\nok: false\nerrors:\n- invalid DSL',
        toolReport: layoutReport,
    }), {
        status: 'error',
        operation_id: 'layout-op',
        message: 'status: error\n\nDSL:\nok: false\nerrors:\n- invalid DSL',
        report: layoutReport,
    });
    assert.deepEqual(pcbLayoutWithoutPlacementResult('empty-op', undefined), {
        status: 'error',
        operation_id: 'empty-op',
        message: 'PCB layout operation completed without result.',
    });

    const preservedBoard = parseSExpression(`(kicad_pcb
        (version 20250114)
        (segment (start 0 0) (end 1 1) (width 0.25) (layer "F.Cu") (net 1))
        (arc (start 1 1) (mid 2 2) (end 3 1) (width 0.25) (layer "F.Cu") (net 1))
        (via (at 1 1) (size 0.8) (drill 0.4) (layers "F.Cu" "B.Cu") (net 1))
        (zone (net 1) (net_name "GND") (layer "F.Cu"))
        (gr_line (start 0 0) (end 10 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
        (group "mechanics")
        (footprint "kicad-copilot:generated"
            (layer "F.Cu")
            (property "Reference" "#PAD_1" (at 0 0 0))
            (property "kicad_copilot:generated" "yes" (at 0 0 0)))
    )`);
    const preservedBoardSource = printSExpression(preservedBoard);
    applyBoardAssemble(preservedBoard, 20250114, {});
    assert.equal(printSExpression(preservedBoard), preservedBoardSource,
        'placement must not delete existing copper, graphics, groups, or generated footprints');

    const replacedOutlineBoard = parseSExpression(`(kicad_pcb
        (version 20250114)
        (gr_line (start 0 0) (end 10 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
        (gr_line (start 10 0) (end 10 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
        (gr_line (start 10 10) (end 0 10) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
        (gr_line (start 0 10) (end 0 0) (stroke (width 0.05) (type default)) (layer "Edge.Cuts"))
        (gr_circle (center 5 5) (end 6 5) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts"))
        (gr_line (start 1 1) (end 2 2) (stroke (width 0.15) (type default)) (layer "Dwgs.User"))
    )`);
    const replacement = {
        board: { polygon: [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }] },
    };
    applyBoardAssemble(replacedOutlineBoard, 20250114, replacement);
    assert.equal(listChildren(replacedOutlineBoard, 'gr_line').filter(
        (item) => atom(findChild(item, 'layer')?.[1]) === 'Edge.Cuts',
    ).length, 4, 'returned board outline must replace existing Edge.Cuts graphics');
    assert.equal(listChildren(replacedOutlineBoard, 'gr_circle').filter(
        (item) => atom(findChild(item, 'layer')?.[1]) === 'Edge.Cuts',
    ).length, 0, 'returned board outline must remove non-line Edge.Cuts graphics');
    assert.equal(listChildren(replacedOutlineBoard, 'gr_line').filter(
        (item) => atom(findChild(item, 'layer')?.[1]) === 'Dwgs.User',
    ).length, 1, 'outline replacement must preserve graphics on other layers');
    applyBoardAssemble(replacedOutlineBoard, 20250114, replacement);
    assert.equal(listChildren(replacedOutlineBoard, 'gr_line').filter(
        (item) => atom(findChild(item, 'layer')?.[1]) === 'Edge.Cuts',
    ).length, 4, 'reapplying a returned board outline must not duplicate Edge.Cuts');

    const geometry = parseSExpression(`(footprint "kicad-copilot:part"
        (at 10 20 30)
        (property "EasyEDA part_uuid" "part" (at 1 2 15))
        (fp_line (start 1 2) (end -3 4))
        (pad "1" smd custom (at 5 -6 45) (primitives (gr_poly (pts (xy 1 2)))))
        (model "part.wrl" (offset (xyz 2 -3 4)) (rotate (xyz 10 20 270))))`);
    assert.equal(normalizeEasyEdaFootprintGeometry(geometry), true);
    assert.deepEqual(findChild(geometry, 'at')?.slice(1).map(atom), ['10', '20', '30']);
    assert.deepEqual(findChild(findChild(geometry, 'fp_line')!, 'start')?.slice(1).map(atom), ['-1', '-2']);
    assert.deepEqual(findChild(findChild(geometry, 'fp_line')!, 'end')?.slice(1).map(atom), ['3', '-4']);
    const geometryPad = listChildren(geometry, 'pad')[0];
    assert.deepEqual(findChild(geometryPad, 'at')?.slice(1).map(atom), ['-5', '6', '225']);
    assert.deepEqual(findChild(findChild(findChild(geometryPad, 'primitives')!, 'gr_poly')!, 'pts')?.[1],
        [token('xy'), token('1'), token('2')]);
    const geometryModel = findChild(geometry, 'model')!;
    assert.deepEqual(findChild(findChild(geometryModel, 'offset')!, 'xyz')?.slice(1).map(atom), ['-2', '3', '4']);
    assert.deepEqual(findChild(findChild(geometryModel, 'rotate')!, 'xyz')?.slice(1).map(atom), ['10', '20', '90']);
    const normalizedGeometry = printSExpression(geometry);
    assert.equal(normalizeEasyEdaFootprintGeometry(geometry), false);
    assert.equal(printSExpression(geometry), normalizedGeometry, 'footprint normalization must be idempotent');
    const standardGeometry = parseSExpression(`(footprint "Package_SO:SOIC-8"
        (property "EasyEDA part_uuid" "part") (pad "1" smd rect (at 1 2)))`);
    const originalStandardGeometry = printSExpression(standardGeometry);
    assert.equal(normalizeEasyEdaFootprintGeometry(standardGeometry), false);
    assert.equal(printSExpression(standardGeometry), originalStandardGeometry,
        'non-project footprints must not be normalized');

    const rotatedBoard = parseSExpression(`(kicad_pcb
        (version 20250114)
        (footprint "kicad-copilot:rotation-test"
            (layer "F.Cu")
            (at 10 20 30)
            (property "Reference" "U1" (at 0 -2 30))
            (property "EasyEDA part_uuid" "part" (at 0 0 30))
            (pad "1" smd rect (at 1 0 30) (size 2 1) (layers "F.Cu" "F.Paste" "F.Mask"))
        )
    )`);
    applyBoardAssemble(rotatedBoard, 20250114, {
        components: [{ designator: 'U1', x: 5, y: 6, rotate: 270, layer: 'top' }],
    });
    const rotatedFootprint = pcbFootprints(rotatedBoard)[0];
    assert.deepEqual(footprintAt(rotatedFootprint), { x: 5, y: -6, rotate: 90 },
        'top footprint rotation must match the server preview after KiCad Y-axis conversion');
    assert.deepEqual(findChild(listChildren(rotatedFootprint, 'pad')[0], 'at')?.slice(1).map(atom),
        ['-1', '0', '270'], 'placement must rotate the absolute pad angle with the footprint');
    const firstRotationResult = printSExpression(rotatedBoard);
    applyBoardAssemble(rotatedBoard, 20250114, {
        components: [{ designator: 'U1', x: 5, y: 6, rotate: 270, layer: 'top' }],
    });
    assert.equal(printSExpression(rotatedBoard), firstRotationResult,
        'reapplying the same placement must not rotate footprint children again');

    for (const item of [
        { preview: 0, assemble: 180, kicad: 0, pad: 180 },
        { preview: 90, assemble: 90, kicad: 270, pad: 90 },
        { preview: 180, assemble: 0, kicad: 180, pad: 0 },
        { preview: 270, assemble: 270, kicad: 90, pad: 270 },
    ]) {
        const cardinalBoard = parseSExpression(`(kicad_pcb
            (version 20250114)
            (footprint "kicad-copilot:cardinal-test"
                (layer "F.Cu")
                (at 0 0 0)
                (property "Reference" "U1" (at 0 -2 0))
                (property "EasyEDA part_uuid" "part" (at 0 0 0))
                (pad "1" smd rect (at 1 0 0) (size 2 1) (layers "F.Cu" "F.Paste" "F.Mask"))
            )
        )`);
        applyBoardAssemble(cardinalBoard, 20250114, {
            components: [{ designator: 'U1', x: 0, y: 0, rotate: item.assemble, layer: 'top' }],
        });
        const cardinalFootprint = pcbFootprints(cardinalBoard)[0];
        assert.equal(footprintAt(cardinalFootprint).rotate, item.kicad,
            `server preview rotation ${item.preview} must map to KiCad ${item.kicad}`);
        assert.deepEqual(findChild(listChildren(cardinalFootprint, 'pad')[0], 'at')?.slice(1).map(atom),
            ['-1', '0', String(item.pad)],
            `server preview rotation ${item.preview} must preserve pad orientation relative to its footprint`);
    }

    const nativeBoard = parseSExpression(`(kicad_pcb
        (version 20250114)
        (footprint "Package_Test:rotation-test"
            (layer "F.Cu")
            (at 10 20 30)
            (property "Reference" "U2" (at 0 -2 30))
            (pad "1" smd rect (at 1 0 30) (size 2 1) (layers "F.Cu" "F.Paste" "F.Mask"))
        )
    )`);
    applyBoardAssemble(nativeBoard, 20250114, {
        components: [{ designator: 'U2', x: 5, y: 6, rotate: 270, layer: 'top' }],
    });
    const nativeFootprint = pcbFootprints(nativeBoard)[0];
    assert.deepEqual(footprintAt(nativeFootprint), { x: 5, y: -6, rotate: 270 },
        'native KiCad footprint rotation must retain its original geometry convention');
    assert.deepEqual(findChild(listChildren(nativeFootprint, 'pad')[0], 'at')?.slice(1).map(atom),
        ['1', '0', '270'], 'native KiCad placement must rotate the absolute pad angle with the footprint');

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
        assert.ok(pcbFootprints(board.root)
            .filter((footprint) => !footprintIsGenerated(footprint))
            .every(footprintGeometryIsNormalized), 'imported EasyEDA footprints must use normalized geometry');
        assert.ok(pcbFootprints(board.root)
            .filter((footprint) => !footprintIsGenerated(footprint))
            .every((footprint) => {
                const value = footprint.find((item) => isSExpressionList(item)
                    && listHead(item) === 'property' && atom(item[1]) === 'Value') as SExpression[] | undefined;
                return value && atom(findChild(value, 'hide')?.[1]) === 'yes';
            }), 'footprint Value properties must stay hidden on the PCB');
        const refs = pcbFootprints(board.root).map(footprintReference).filter((value): value is string => Boolean(value));
        assert.ok(refs.length >= 2, 'import must retain schematic footprints');
        applyBoardAssemble(board.root, board.version, {
            board: { polygon: [{ x: -20, y: -15 }, { x: 20, y: -15 }, { x: 20, y: 15 }, { x: -20, y: 15 }] },
            components: [
                {
                    designator: refs[0], x: -5, y: 4, rotate: 30, layer: 'top',
                    designatorText: { x: -5, y: 7, rotate: 0, height: 0.9 },
                },
                {
                    designator: refs[1], x: 5, y: -6, rotate: 270, layer: 'bottom',
                    designatorText: { x: 8, y: -6, rotate: 90, height: 0.9 },
                },
            ],
            vias: [{ x: 0, y: 10, diameter: 3.2, drill: 3.2 }],
        });
        await atomicWritePcb(targetPcb, board.source, board.root);
        const assembled = await readPcb(targetPcb);
        assert.equal(listChildren(assembled.root, 'gr_line').length, 4, 'outline must contain four edges');
        const top = pcbFootprints(assembled.root).find((item) => footprintReference(item) === refs[0])!;
        const bottom = pcbFootprints(assembled.root).find((item) => footprintReference(item) === refs[1])!;
        const hole = pcbFootprints(assembled.root).find((item) => footprintReference(item) === '#HOLE_1')!;
        assert.deepEqual(footprintAt(top), { x: 143.5, y: 101, rotate: 210 });
        assert.deepEqual(footprintAt(bottom), { x: 153.5, y: 111, rotate: 90 });
        assert.equal(footprintLayer(bottom), 'B.Cu');
        const topReference = top.find((item) => isSExpressionList(item)
            && item[0] && !isSExpressionList(item[0]) && item[0].value === 'property'
            && atom(item[1]) === 'Reference') as SExpression[];
        const bottomReference = bottom.find((item) => isSExpressionList(item)
            && item[0] && !isSExpressionList(item[0]) && item[0].value === 'property'
            && atom(item[1]) === 'Reference') as SExpression[];
        const topReferenceAt = findChild(topReference, 'at')?.slice(1).map((item) => Number(atom(item)));
        assert.ok(topReferenceAt
            && Math.abs(topReferenceAt[0] + 1.5) < 1e-9
            && Math.abs(topReferenceAt[1] - 2.598076211353316) < 1e-9
            && topReferenceAt[2] === 0,
        'front reference text has an invalid position or rotation');
        assert.equal(atom(findChild(topReference, 'layer')?.[1]), 'F.SilkS');
        assert.ok(!printSExpression(topReference).includes('(justify mirror)'),
            'front reference text must not be mirrored');
        const bottomReferenceAt = findChild(bottomReference, 'at')?.slice(1).map((item) => Number(atom(item)));
        assert.ok(bottomReferenceAt
            && Math.abs(bottomReferenceAt[0]) < 1e-9
            && Math.abs(bottomReferenceAt[1] + 3) < 1e-9
            && bottomReferenceAt[2] === 270,
        'back reference text has an invalid position or rotation');
        assert.equal(atom(findChild(bottomReference, 'layer')?.[1]), 'B.SilkS');
        assert.ok(printSExpression(bottomReference).includes('(justify mirror)'),
            'back reference text must be mirrored');
        assert.deepEqual(footprintAt(hole), { x: 148.5, y: 95, rotate: 0 });
        const outline = boardOutline(assembled.root);
        assert.ok(outline.points.length >= 3, 'routing import requires a closed board outline');
        assert.equal(outline.holes.length, 1, 'routing import must preserve Edge.Cuts holes');
        const classifiedNet = 'VCC';
        assert.ok(classifiedNet, 'router rules test requires at least one routable net');
        await writeFile(join(directory, 'stm32_debug.kicad_pro'), JSON.stringify({
            board: { design_settings: { rules: {
                min_clearance: 0.18,
                min_copper_edge_clearance: 0.5,
                min_track_width: 0.2,
                min_via_diameter: 0.5,
                min_through_hole_diameter: 0.25,
                min_via_annular_width: 0.15,
            } } },
            net_settings: {
                classes: [
                    {
                        name: 'Default', clearance: 0.2, track_width: 0.25,
                        via_diameter: 0.6, via_drill: 0.3,
                        diff_pair_width: 0.25, diff_pair_gap: 0.2,
                    },
                    {
                        name: 'Fine', clearance: 0.12, track_width: 0.15,
                        via_diameter: 0.4, via_drill: 0.2,
                        diff_pair_width: 0.16, diff_pair_gap: 0.13,
                    },
                ],
                netclass_assignments: { [classifiedNet]: 'Fine' },
                netclass_patterns: [],
            },
        }), 'utf8');
        const routingImport = await importKiCadRoutingBoard(targetPcb);
        assert.ok(routingImport.board, routingImport.diagnostics.map(item => item.message).join('\n'));
        assert.equal(routingImport.board.rules.default.minTrackWidthMm, 0.2);
        assert.equal(routingImport.board.rules.default.via.minDiameterMm, 0.55);
        const classifiedRules = routingImport.board.rules.nets.find(item => item.net === classifiedNet)?.values;
        assert.ok(classifiedRules, `router rules missing for ${classifiedNet}`);
        assert.equal(classifiedRules.preferredTrackWidthMm, 0.2);
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
