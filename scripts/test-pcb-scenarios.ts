import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyBoardAssemble } from '../src/kicad/board-assemble';
import { createDocument } from '../src/kicad/create-document';
import { getSupportedKicadCli, preferredSupportedKicadCli } from '../src/kicad/cli';
import { setPcbStackLayers } from '../src/kicad/pcb-stack';
import { footprintAt, footprintIsGenerated, footprintLayer, footprintReference, listChildren, pcbFootprints, readPcb } from '../src/kicad/pcb-reader';
import { footprintGeometryIsNormalized, normalizeEasyEdaFootprintGeometry } from '../src/kicad/footprint-normalization';
import { atomicWritePcb, parsePcbSource } from '../src/kicad/pcb-writer';
import { pcbTemplate } from '../src/kicad/pcb-template';
import { atom, findChild, isSExpressionList, listHead, parseSExpression, printSExpression, SExpression, token } from '../src/kicad/sexpr/ast';
import { importPcbChanges } from '../src/pcb/import';
import { pcbLayoutWithoutPlacementResult } from '../src/pcb/layout-operation';
import { routeDrcChanges } from '../src/pcb/routing-operation';
import { buildRouterInput } from '../src/pcb/router-adapter';
import { netClassFor, readPcbRoutingRules } from '../src/pcb/router-rules';
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
    assert.equal(preferredSupportedKicadCli([
        { path: 'path-kicad-8', version: '8.0.9', major: 8 },
        { path: 'installed-kicad-9', version: '9.0.7', major: 9 },
        { path: 'installed-kicad-10', version: '10.0.1', major: 10 },
    ])?.path, 'installed-kicad-10', 'CLI discovery must skip KiCad 8 and prefer KiCad 10');

    const routeDrc = routeDrcChanges(
        { shorts: 0, unconnected: 0, errorViolations: [] },
        { shorts: 1, unconnected: 0, errorViolations: [{ key: 'shorting_items:a|b', type: 'shorting_items' }] },
    );
    assert.equal(routeDrc.introducedShortCircuits, 1);
    assert.equal(routeDrc.introducedUnconnected, 0);
    assert.equal(routeDrc.newErrors.length, 1, 'DRC errors must be available for the non-blocking report');

    const generalDrc = routeDrcChanges(
        { shorts: 0, unconnected: 1, errorViolations: [] },
        { shorts: 0, unconnected: 3, errorViolations: [{ key: 'clearance:a|b', type: 'clearance' }] },
    );
    assert.equal(generalDrc.introducedUnconnected, 2);
    assert.deepEqual(generalDrc.newErrors, [{ key: 'clearance:a|b', type: 'clearance' }]);

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
        ['-1', '0', '210'], 'placement must preserve the normalized local pad geometry');
    const firstRotationResult = printSExpression(rotatedBoard);
    applyBoardAssemble(rotatedBoard, 20250114, {
        components: [{ designator: 'U1', x: 5, y: 6, rotate: 270, layer: 'top' }],
    });
    assert.equal(printSExpression(rotatedBoard), firstRotationResult,
        'reapplying the same placement must not rotate footprint children again');

    for (const item of [
        { preview: 0, assemble: 180, kicad: 0 },
        { preview: 90, assemble: 90, kicad: 270 },
        { preview: 180, assemble: 0, kicad: 180 },
        { preview: 270, assemble: 270, kicad: 90 },
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
            ['-1', '0', '180'],
            `server preview rotation ${item.preview} must not change local pad geometry`);
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
        ['1', '0', '30'], 'native KiCad placement must preserve local pad geometry');

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
        const preliminaryRouter = buildRouterInput(assembled.root, {
            routeLayers: ['F.Cu', 'B.Cu'], ignoreNets: ['GND'], speedFirst: true,
        });
        const classifiedNet = preliminaryRouter.routedNets[0];
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
                netclass_patterns: [{ netclass: 'Fine', pattern: 'UART_*' }],
            },
        }), 'utf8');
        const designRules = await readPcbRoutingRules(targetPcb);
        assert.equal(netClassFor(designRules, classifiedNet), 'Fine');
        assert.equal(netClassFor(designRules, 'UART_RX'), 'Fine');
        const router = buildRouterInput(assembled.root, {
            routeLayers: ['F.Cu', 'B.Cu'], ignoreNets: ['GND'], speedFirst: true, designRules,
        });
        const classifiedRouterNet = router.input.nets.find((item) => item.net === classifiedNet)!;
        const ruleId = classifiedRouterNet.safeClearance as string;
        const safeRule = (router.input.rules.safeClearances as Record<string, Array<Record<string, number>>>)[ruleId][0];
        assert.equal(safeRule.trackToTrack, 0.18, 'netclass clearance must respect the board minimum');
        assert.equal(safeRule.trackToBoardOutline, 0.5, 'router must use copper edge clearance');
        const trackRule = (router.input.rules.trackWidths as Record<string, Array<{ trackWidth: number[] }>>)[ruleId][0];
        assert.deepEqual(trackRule.trackWidth.slice(0, 2), [0.2, 0.2],
            'netclass track width must respect the board minimum');
        assert.deepEqual((router.input.rules.viaSizes as Record<string, number[]>)[`via_${ruleId}`], [0.55, 0.25],
            'via size must respect diameter, drill and annular-width minimums');
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
