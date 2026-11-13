#!/usr/bin/env node

import assert from 'node:assert/strict';
import { kicadFootprintToSpec } from '../src/kicad/footprint-spec';
import { parseSExpression, printSExpression } from '../src/kicad/sexpr/ast';
import { createPcbLayoutPayload } from '../src/pcb/layout-input';
import type { PcbSchematicComponent } from '../src/kicad/schematic-reader';
import type { ExplainCircuit } from '../src/types/circuit';

function component(overrides: Partial<PcbSchematicComponent> = {}): PcbSchematicComponent {
    return {
        designator: 'U1',
        value: 'TEST',
        pins: [{ pin_number: '1', name: '1', signal_name: 'GND' }],
        part_uuid: null,
        footprint_name: 'Custom:TEST',
        footprint_uuid: null,
        block_name: null,
        identity: '/sheet/symbol-1',
        on_board: true,
        in_bom: true,
        dnp: false,
        ...overrides,
    };
}

function circuit(source: PcbSchematicComponent): ExplainCircuit {
    return {
        components: [{
            designator: source.designator,
            value: source.value,
            pins: source.pins,
            part_uuid: source.part_uuid,
            footprint_name: source.footprint_name,
            footprint_uuid: source.footprint_uuid,
            block_name: source.block_name,
        }],
    };
}

const convertedEasyEda = parseSExpression(`(footprint "easyeda2kicad:LED-SMD_L1.6-W0.8-R-RD"
    (layer "F.Cu")
    (fp_line (start -0.20 0.70) (end -1.47 0.70) (layer "F.SilkS") (width 0.25))
    (fp_line (start -1.47 0.70) (end -1.47 -0.70) (layer "F.SilkS") (width 0.25))
    (fp_line (start 0.30 0.70) (end 1.40 0.70) (layer "F.SilkS") (width 0.25))
    (fp_line (start 1.70 0.40) (end 1.70 -0.40) (layer "F.SilkS") (width 0.25))
    (pad "2" smd rect (at 0.75 0 180) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "1" smd rect (at -0.75 0 180) (size 0.8 0.8) (layers "F.Cu" "F.Paste" "F.Mask")))`);
const convertedSpec = kicadFootprintToSpec(convertedEasyEda);
assert.equal(convertedSpec.name, 'LED-SMD_L1.6-W0.8-R-RD');
assert.deepEqual([convertedSpec.width, convertedSpec.height], [3.17, 1.4]);
assert.deepEqual(convertedSpec.sourceOriginOffset, { x: -0.115, y: 0 });
assert.deepEqual(convertedSpec.pads.map((pad) => [pad.pin_number, pad.x, pad.y, pad.width, pad.height]), [
    ['2', 0.635, 0, 0.8, 0.8],
    ['1', -0.865, 0, 0.8, 0.8],
]);

const nativeFootprint = parseSExpression(`(footprint "Custom:ASYMMETRIC"
    (layer "F.Cu")
    (at 105 55 90)
    (uuid "native-footprint-uuid")
    (path "/sheet/symbol-1")
    (property "Reference" "U1")
    (fp_rect (start -2 -1) (end 3 1) (stroke (width 0.1) (type solid)) (fill none) (layer "F.Fab"))
    (pad "1" smd oval (at 2 0 90) (size 2 1) (layers "F.Cu" "F.Paste" "F.Mask"))
    (pad "" np_thru_hole circle (at -1 0) (size 1.2 1.2) (drill 0.8) (layers "*.Cu" "*.Mask")))`);
const nativeSpec = kicadFootprintToSpec(nativeFootprint);
assert.deepEqual([nativeSpec.width, nativeSpec.height], [5, 2.508]);
assert.deepEqual(nativeSpec.sourceOriginOffset, { x: -0.5, y: 0 });
assert.deepEqual(nativeSpec.pads.map((pad) => [pad.pin_number, pad.width, pad.height, pad.mount, pad.drillDiameter]), [
    ['1', 1, 2, 'smd', undefined],
    ['MH1', 1.2, 1.2, 'through_hole', 0.8],
]);

const customPad = parseSExpression(`(footprint "Custom:CUSTOM_PAD"
    (pad "EP" smd custom (at 1 2 90) (size 0.005 0.005) (layers "F.Cu")
        (primitives (gr_poly (pts (xy -1 -0.5) (xy 1 -0.5) (xy 1 0.5) (xy -1 0.5)) (width 0)))))`);
const customSpec = kicadFootprintToSpec(customPad);
assert.deepEqual(customSpec.pads.map((pad) => [pad.pin_number, pad.width, pad.height]), [['EP', 1, 2]]);

const localComponent = component();
const localPayload = createPcbLayoutPayload(circuit(localComponent), [localComponent], [nativeFootprint]);
assert.equal(localPayload.circuit.components[0].footprint_uuid, 'native-footprint-uuid');
assert.deepEqual(localPayload.footprints['native-footprint-uuid'], nativeSpec);
const secondComponent = component({ designator: 'U2', identity: '/sheet/symbol-2' });
const duplicateNative = parseSExpression(printSExpression(nativeFootprint)
    .replace('"U1"', '"U2"').replace('"/sheet/symbol-1"', '"/sheet/symbol-2"'));
assert.throws(() => createPcbLayoutPayload(
    { components: [...circuit(localComponent).components, ...circuit(secondComponent).components] },
    [localComponent, secondComponent], [nativeFootprint, duplicateNative],
), /duplicate KiCad footprint uuid/);

const placementPayload = createPcbLayoutPayload(
    circuit(localComponent),
    [localComponent],
    [nativeFootprint],
    [{ x: 90, y: 45 }, { x: 110, y: 45 }, { x: 110, y: 55 }, { x: 90, y: 55 }],
);
assert.deepEqual(placementPayload.existingPlacement?.board.polygon, [
    { x: -10, y: -5 }, { x: 10, y: -5 }, { x: 10, y: 5 }, { x: -10, y: 5 },
]);
assert.deepEqual(placementPayload.existingPlacement?.components, [{
    designator: 'U1', x: 5, y: 5.5, rotate: 90, layer: 'top',
}]);

const easyEdaPartUuid = '11111111111111111111111111111111';
const easyEdaFootprintUuid = '22222222222222222222222222222222';
const easyEdaComponent = component();
const identifiedFootprint = parseSExpression(`(footprint "kicad-copilot:REMOTE"
    (layer "F.Cu")
    (at 102 53 90)
    (uuid "native-uuid-that-must-not-be-used")
    (path "/sheet/symbol-1")
    (property "Reference" "U1")
    (property "EasyEDA part_uuid" "${easyEdaPartUuid}")
    (property "EasyEDA footprint_uuid" "${easyEdaFootprintUuid}")
    (property "kicad_copilot:easyeda_geometry_rotation" "180")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")))`);
const remotePayload = createPcbLayoutPayload(circuit(easyEdaComponent), [easyEdaComponent], [identifiedFootprint]);
assert.deepEqual(remotePayload.footprints[easyEdaFootprintUuid], kicadFootprintToSpec(identifiedFootprint));
assert.equal(remotePayload.circuit.components[0].part_uuid, easyEdaPartUuid);
assert.equal(remotePayload.circuit.components[0].footprint_uuid, easyEdaFootprintUuid);

const remotePlacementPayload = createPcbLayoutPayload(
    circuit(easyEdaComponent),
    [easyEdaComponent],
    [identifiedFootprint],
    [{ x: 90, y: 45 }, { x: 110, y: 45 }, { x: 110, y: 55 }, { x: 90, y: 55 }],
);
assert.deepEqual(remotePlacementPayload.existingPlacement?.components, [{
    designator: 'U1', x: 2, y: 3, rotate: 270, layer: 'top',
}]);

const unnormalizedFootprint = parseSExpression(`(footprint "kicad-copilot:REMOTE"
    (layer "F.Cu")
    (at 102 53 0)
    (path "/sheet/symbol-1")
    (property "Reference" "U1")
    (property "EasyEDA footprint_uuid" "${easyEdaFootprintUuid}")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Mask")))`);
const unnormalizedPlacementPayload = createPcbLayoutPayload(
    circuit(easyEdaComponent),
    [easyEdaComponent],
    [unnormalizedFootprint],
    [{ x: 90, y: 45 }, { x: 110, y: 45 }, { x: 110, y: 55 }, { x: 90, y: 55 }],
);
assert.equal(unnormalizedPlacementPayload.existingPlacement?.components[0].rotate, 180);

console.log('KiCad FootprintSpec tests passed');
