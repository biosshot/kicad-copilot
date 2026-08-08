import { CircuitAssembly, ExplainCircuit } from '../types/circuit';

function baseDesignator(value: string) {
    return value.trim().replace(/\.\d+$/, '');
}

function shapeDesignator(value: string | undefined) {
    return baseDesignator(value?.match(/^(.+)_pin_[^_]+$/)?.[1] || '');
}

export function targetCircuitAssembly(
    assembly: CircuitAssembly,
    target: ExplainCircuit,
    project: ExplainCircuit,
): CircuitAssembly {
    const targetDesignators = new Set(target.components.map((component) => component.designator));
    const foreignDesignators = new Set(project.components
        .map((component) => component.designator)
        .filter((designator) => !targetDesignators.has(designator)));
    const isForeign = (designator: string) => foreignDesignators.has(baseDesignator(designator));
    const shapeIsForeign = (shape: string | undefined) => {
        const designator = shapeDesignator(shape);
        return designator ? isForeign(designator) : false;
    };
    const edges = assembly.edges.flatMap((edge) => {
        const sections = edge.sections.filter((section) => (
            !shapeIsForeign(section.incomingShape) && !shapeIsForeign(section.outgoingShape)
        ));
        if (!sections.length) return [];
        return [{
            ...edge,
            sources: edge.sources.filter((shape) => !shapeIsForeign(shape)),
            targets: edge.targets.filter((shape) => !shapeIsForeign(shape)),
            sections,
        }];
    });

    return {
        ...assembly,
        components: assembly.components.filter((component) => !isForeign(component.designator)),
        edges,
        added_net: assembly.added_net?.filter((item) => !isForeign(item.designator)),
        rm_net: assembly.rm_net?.filter((item) => !isForeign(item.designator)),
        rm_components: assembly.rm_components?.filter((designator) => !isForeign(designator)),
        replace_components: assembly.replace_components?.filter((designator) => !isForeign(designator)),
    };
}
