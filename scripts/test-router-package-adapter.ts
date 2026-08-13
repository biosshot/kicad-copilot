import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run, type RoutingResult } from '@easyeda-copilot/router';
import { listChildren, readPcb } from '../src/kicad/pcb-reader';
import { sourceHash } from '../src/kicad/pcb-writer';
import {
    applyKiCadRoutingResult,
    importKiCadRoutingBoard,
} from '../src/routing/router-package-adapter';

const sourcePath = resolve(process.env.POWERBANK_PCB
    ?? 'D:\\MyProject\\kicad\\Powerbank\\Powerbank.kicad_pcb');
const sourceBefore = await readFile(sourcePath);
const safe = await importKiCadRoutingBoard(sourcePath);
assert.ok(safe.board && safe.context, JSON.stringify(safe.diagnostics));
assert.equal(safe.diagnostics.filter(item => item.severity === 'error').length, 0);
assert.equal(safe.board.components.length, 34);
assert.equal(safe.board.nets.length, 28);
assert.equal(safe.board.layers.length, 2);
assert.equal(safe.board.copper.editable.tracks.length, 0);
assert.ok(safe.board.copper.fixed.tracks.length > 250);
assert.ok(safe.board.copper.fixed.vias.length > 40);
assert.ok(safe.board.copper.fixed.zones.length >= 10);

const temporary = await mkdtemp(join(tmpdir(), 'kicad-router-package-'));
try {
    const fixedOutput = join(temporary, 'fixed.kicad_pcb');
    const noOp: RoutingResult = {
        status: 'complete', operation: 'route',
        rules: { effective: safe.board.rules, applyRequested: false, overriddenFields: [] },
        copper: { tracks: [], vias: [], zones: [] },
        diagnostics: [], metrics: { elapsedMs: 0 }, requiresNativeVerification: true,
    };
    const fixedApplied = await applyKiCadRoutingResult(safe.context, noOp, fixedOutput, { nativeVerify: false });
    assert.equal(fixedApplied.outputPath, fixedOutput);
    assert.equal(fixedApplied.nativeVerification, 'not-run');
    assert.equal(fixedApplied.diagnostics.filter(item => item.severity === 'error').length, 0);
    const [sourceBoard, fixedBoard] = await Promise.all([readPcb(sourcePath), readPcb(fixedOutput)]);
    for (const head of ['footprint', 'segment', 'arc', 'via', 'zone', 'gr_line', 'gr_arc']) {
        assert.equal(listChildren(fixedBoard.root, head).length, listChildren(sourceBoard.root, head).length, head);
    }

    const verifiedOutput = join(temporary, 'verified.kicad_pcb');
    const verified = await applyKiCadRoutingResult(safe.context, noOp, verifiedOutput, { nativeVerify: true });
    assert.equal(verified.outputPath, verifiedOutput);
    assert.notEqual(verified.nativeVerification, 'not-run');
    assert.ok(verified.report, 'native KiCad report is required');
    assert.ok((await readFile(verifiedOutput)).length > 0);

    const editable = await importKiCadRoutingBoard(sourcePath, { existingCopper: 'editable' });
    assert.ok(editable.board && editable.context, JSON.stringify(editable.diagnostics));
    assert.ok(editable.board.copper.editable.tracks.length > 250);
    assert.equal(editable.board.copper.fixed.tracks.length, 0);
    const rerouteOutput = join(temporary, 'editable.kicad_pcb');
    const roundTrip: RoutingResult = {
        ...noOp,
        rules: { effective: editable.board.rules, applyRequested: false, overriddenFields: [] },
        copper: editable.board.copper.editable,
    };
    const rerouted = await applyKiCadRoutingResult(editable.context, roundTrip, rerouteOutput, { nativeVerify: false });
    assert.equal(rerouted.diagnostics.filter(item => item.severity === 'error').length, 0);
    const reroutedBoard = await readPcb(rerouteOutput);
    assert.equal(listChildren(reroutedBoard.root, 'footprint').length, 34);
    assert.equal(listChildren(reroutedBoard.root, 'segment').length, editable.board.copper.editable.tracks.reduce(
        (sum, track) => sum + track.points.length - 1, 0,
    ));
    assert.equal(listChildren(reroutedBoard.root, 'via').length, editable.board.copper.editable.vias.length);

    const dslRules = await run({
        board: safe.board,
        dsl: `signalNet("USB_CC1", { trackWidthMm: 0.22 }); applyDrcRules()`,
    });
    assert.equal(dslRules.status, 'complete', JSON.stringify(dslRules.diagnostics));
    assert.equal(dslRules.operation, 'apply-drc');
    assert.equal(dslRules.rules.applyRequested, true);
    assert.equal(dslRules.copper, undefined);
    assert.equal(
        dslRules.rules.effective.nets.find(item => item.net === 'USB_CC1')?.values.preferredTrackWidthMm,
        0.22,
    );
    const rulesOutput = join(temporary, 'rules.kicad_pcb');
    const appliedRules = await applyKiCadRoutingResult(safe.context, dslRules, rulesOutput, { nativeVerify: false });
    assert.equal(appliedRules.diagnostics.filter(item => item.severity === 'error').length, 0);
    const project = JSON.parse(await readFile(rulesOutput.replace(/\.kicad_pcb$/, '.kicad_pro'), 'utf8'));
    assert.ok(project.net_settings.classes.every((item: { name: string }) => item.name.startsWith('Router_')));
    const dru = await readFile(rulesOutput.replace(/\.kicad_pcb$/, '.kicad_dru'), 'utf8');
    assert.match(dru, /copilot-router 1:/);
    assert.match(dru, /USB_CC1/);
    assert.match(dru, /0\.22mm/);
    assert.doesNotMatch(dru, /USB port A1 pair clearance/);

    assert.equal(sourceHash(await readFile(sourcePath)), sourceHash(sourceBefore), 'source PCB changed');
} finally {
    await rm(temporary, { recursive: true, force: true });
}

process.stdout.write('KiCad router package adapter: ok\n');
