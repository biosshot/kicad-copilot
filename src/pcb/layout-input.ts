import type { SExpression } from '../kicad/sexpr/ast';
import {
    childText,
    footprintIsBoardOnly,
    footprintPath,
    footprintReference,
    pcbFootprints,
    propertyValue,
    readPcb,
} from '../kicad/pcb-reader';
import { getPcbSchematic, type PcbSchematicComponent } from '../kicad/schematic-reader';
import { kicadFootprintToSpec, validEasyEdaUuid } from '../kicad/footprint-spec';
import type { ExplainCircuit } from '../types/circuit';

function uniqueIndex(footprints: SExpression[][], key: (footprint: SExpression[]) => string | undefined) {
    const result = new Map<string, SExpression[]>();
    const duplicates = new Set<string>();
    for (const footprint of footprints) {
        if (footprintIsBoardOnly(footprint)) continue;
        const value = key(footprint);
        if (!value) continue;
        if (result.has(value)) duplicates.add(value);
        else result.set(value, footprint);
    }
    for (const duplicate of duplicates) result.delete(duplicate);
    return { result, duplicates };
}

function componentFootprint(
    component: PcbSchematicComponent,
    byPath: Map<string, SExpression[]>,
    byReference: Map<string, SExpression[]>,
) {
    return byPath.get(component.identity) || byReference.get(component.designator.toUpperCase());
}

function easyEdaIdentity(footprint: SExpression[]) {
    const partUuid = propertyValue(footprint, 'EasyEDA part_uuid');
    const footprintUuid = propertyValue(footprint, 'EasyEDA footprint_uuid');
    return {
        partUuid: validEasyEdaUuid(partUuid) ? partUuid : null,
        footprintUuid: validEasyEdaUuid(footprintUuid) ? footprintUuid : null,
    };
}

export async function createPcbLayoutInput(pcbPath: string, schematicPath: string) {
    const [pcb, schematic] = await Promise.all([readPcb(pcbPath), getPcbSchematic(schematicPath)]);
    return createPcbLayoutPayload(schematic.circuit, schematic.components, pcbFootprints(pcb.root));
}

export function createPcbLayoutPayload(
    sourceCircuit: ExplainCircuit,
    schematicComponents: PcbSchematicComponent[],
    pcbItems: SExpression[][],
) {
    const expected = schematicComponents.filter((component) => component.on_board && component.footprint_name);
    const physicalFootprints = pcbItems.filter((footprint) => !footprintIsBoardOnly(footprint));
    const paths = uniqueIndex(physicalFootprints, footprintPath);
    const references = uniqueIndex(physicalFootprints, (footprint) => footprintReference(footprint)?.toUpperCase());

    for (const component of expected) {
        if (paths.duplicates.has(component.identity)) {
            throw new Error(`ambiguous PCB identity: ${component.designator}`);
        }
        if (references.duplicates.has(component.designator.toUpperCase()) && !paths.result.has(component.identity)) {
            throw new Error(`ambiguous PCB designator: ${component.designator}`);
        }
    }

    const missing = expected.filter((component) => !componentFootprint(component, paths.result, references.result));
    const expectedPaths = new Set(expected.map((component) => component.identity));
    const expectedRefs = new Set(expected.map((component) => component.designator.toUpperCase()));
    const removed = physicalFootprints.filter((footprint) => {
        const path = footprintPath(footprint);
        const reference = footprintReference(footprint)?.toUpperCase();
        return Boolean(path && !expectedPaths.has(path) && (!reference || !expectedRefs.has(reference)));
    });
    if (missing.length || removed.length) {
        throw new Error(`PCB is not synchronized; run import_pcb_changes (${[
            ...missing.map((item) => `missing ${item.designator}`),
            ...removed.map((item) => `removed ${footprintReference(item) || footprintPath(item)}`),
        ].slice(0, 12).join(', ')})`);
    }

    const circuit = structuredClone(sourceCircuit);
    const circuitByDesignator = new Map(circuit.components.map((component) => [component.designator.toUpperCase(), component]));
    const footprints: Record<string, ReturnType<typeof kicadFootprintToSpec>> = {};

    for (const component of expected) {
        const footprint = componentFootprint(component, paths.result, references.result)!;
        const requestComponent = circuitByDesignator.get(component.designator.toUpperCase());
        if (!requestComponent) throw new Error(`schematic component missing from circuit: ${component.designator}`);

        const easyEda = easyEdaIdentity(footprint);
        if (easyEda.footprintUuid || easyEda.partUuid) {
            if (easyEda.footprintUuid) requestComponent.footprint_uuid = easyEda.footprintUuid;
            if (easyEda.partUuid) requestComponent.part_uuid = easyEda.partUuid;
            continue;
        }

        const footprintUuid = childText(footprint, 'uuid') || childText(footprint, 'tstamp');
        if (!footprintUuid) throw new Error(`KiCad footprint has no uuid: ${component.designator}`);
        if (Object.hasOwn(footprints, footprintUuid)) {
            throw new Error(`duplicate KiCad footprint uuid: ${footprintUuid}`);
        }
        requestComponent.footprint_uuid = footprintUuid;
        footprints[footprintUuid] = kicadFootprintToSpec(footprint);
    }

    return { circuit, footprints };
}
