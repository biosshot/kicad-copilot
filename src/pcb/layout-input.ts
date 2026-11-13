import type { SExpression } from '../kicad/sexpr/ast';
import {
    childText,
    footprintAt,
    footprintIsBoardOnly,
    footprintLayer,
    footprintPath,
    footprintReference,
    pcbFootprints,
    propertyValue,
    readPcb,
} from '../kicad/pcb-reader';
import { getPcbSchematic, type PcbSchematicComponent } from '../kicad/schematic-reader';
import { kicadFootprintToSpec, validEasyEdaUuid } from '../kicad/footprint-spec';
import { footprintGeometryIsNormalized } from '../kicad/footprint-normalization';
import type { ExplainCircuit } from '../types/circuit';
import { boardOutline } from './board-geometry';

type Point = { x: number; y: number };

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

export async function createPcbLayoutInput(pcbPath: string, schematicPath: string, includeExistingPlacement = false) {
    const [pcb, schematic] = await Promise.all([readPcb(pcbPath), getPcbSchematic(schematicPath)]);
    const polygon = includeExistingPlacement ? existingBoardPolygon(pcb.root) : undefined;
    return createPcbLayoutPayload(schematic.circuit, schematic.components, pcbFootprints(pcb.root), polygon);
}

export function createPcbLayoutPayload(
    sourceCircuit: ExplainCircuit,
    schematicComponents: PcbSchematicComponent[],
    pcbItems: SExpression[][],
    boardPolygon?: Point[],
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
        if (easyEda.partUuid) requestComponent.part_uuid = easyEda.partUuid;
        // Always provide the actual board geometry, including converted catalog
        // parts. The backend resolves the catalog first and uses this on a miss.
        const footprintUuid = easyEda.footprintUuid || childText(footprint, 'uuid') || childText(footprint, 'tstamp');
        if (!footprintUuid) throw new Error(`KiCad footprint has no uuid: ${component.designator}`);
        const spec = kicadFootprintToSpec(footprint);
        if (!easyEda.footprintUuid && Object.hasOwn(footprints, footprintUuid)) {
            throw new Error(`duplicate KiCad footprint uuid: ${footprintUuid}`);
        }
        if (Object.hasOwn(footprints, footprintUuid) && JSON.stringify(footprints[footprintUuid]) !== JSON.stringify(spec)) {
            throw new Error(`conflicting KiCad geometry for footprint uuid: ${footprintUuid}`);
        }
        requestComponent.footprint_uuid = footprintUuid;
        footprints[footprintUuid] = spec;
    }

    return {
        circuit,
        footprints,
        ...(boardPolygon ? {
            existingPlacement: createExistingPlacement(boardPolygon, expected.map((component) => ({
                designator: component.designator,
                footprint: componentFootprint(component, paths.result, references.result)!,
            }))),
        } : {}),
    };
}

function existingBoardPolygon(root: SExpression[]) {
    try {
        return boardOutline(root).points;
    } catch {
        return undefined;
    }
}

function createExistingPlacement(
    polygon: Point[],
    components: Array<{ designator: string; footprint: SExpression[] }>,
) {
    const left = Math.min(...polygon.map((point) => point.x));
    const right = Math.max(...polygon.map((point) => point.x));
    const top = Math.min(...polygon.map((point) => point.y));
    const bottom = Math.max(...polygon.map((point) => point.y));
    const origin = { x: (left + right) / 2, y: (top + bottom) / 2 };

    return {
        board: {
            polygon: polygon.map((point) => ({ x: point.x - origin.x, y: point.y - origin.y })),
        },
        components: components.map(({ designator, footprint }) => {
            const at = footprintAt(footprint);
            const layer = footprintLayer(footprint) === 'B.Cu' ? 'bottom' as const : 'top' as const;
            const normalizedEasyEdaGeometry = footprintGeometryIsNormalized(footprint);
            const isEasyEda = normalizedEasyEdaGeometry || Object.values(easyEdaIdentity(footprint)).some(Boolean);
            const rotate = serverRotation(at.rotate, layer, isEasyEda, normalizedEasyEdaGeometry);
            const rawSourceOffset = kicadFootprintToSpec(footprint).sourceOriginOffset ?? { x: 0, y: 0 };
            const sourceOffset = isEasyEda && !normalizedEasyEdaGeometry
                ? { x: -rawSourceOffset.x, y: -rawSourceOffset.y }
                : rawSourceOffset;
            const localOffset = layer === 'bottom' ? { x: -sourceOffset.x, y: sourceOffset.y } : sourceOffset;
            const radians = rotate * Math.PI / 180;
            const rotatedOffset = {
                x: localOffset.x * Math.cos(radians) - localOffset.y * Math.sin(radians),
                y: localOffset.x * Math.sin(radians) + localOffset.y * Math.cos(radians),
            };
            return {
                designator,
                x: at.x - rotatedOffset.x - origin.x,
                y: at.y - rotatedOffset.y - origin.y,
                rotate,
                layer,
            };
        }),
    };
}

function serverRotation(
    kicadRotation: number,
    layer: 'top' | 'bottom',
    isEasyEda: boolean,
    normalizedEasyEdaGeometry: boolean,
) {
    if (!isEasyEda) return ((kicadRotation % 360) + 360) % 360;
    const rotation = normalizedEasyEdaGeometry
        ? layer === 'top' ? -kicadRotation : kicadRotation
        : layer === 'top' ? 180 - kicadRotation : kicadRotation + 180;
    return ((rotation % 360) + 360) % 360;
}
