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
    const edgeIsForeign = (edge: CircuitAssembly['edges'][number]) => {
        const shapes = [
            ...edge.sources,
            ...edge.targets,
            ...edge.sections.flatMap((section) => [section.incomingShape, section.outgoingShape]),
        ];
        return shapes.some((shape) => {
            const designator = shapeDesignator(shape);
            return designator ? isForeign(designator) : false;
        });
    };

    return {
        ...assembly,
        components: assembly.components.filter((component) => !isForeign(component.designator)),
        edges: assembly.edges.filter((edge) => !edgeIsForeign(edge)),
        added_net: assembly.added_net?.filter((item) => !isForeign(item.designator)),
        rm_net: assembly.rm_net?.filter((item) => !isForeign(item.designator)),
        rm_components: assembly.rm_components?.filter((designator) => !isForeign(designator)),
        replace_components: assembly.replace_components?.filter((designator) => !isForeign(designator)),
    };
}
