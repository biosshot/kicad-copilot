import { atom, findChild, isSExpressionList, listHead, parseSExpression, SExpression } from './sexpr/ast';
import { findLists, SExpressionRange } from './sexpr/scan';

type Point = { x: number; y: number };

type Wire = {
    range: SExpressionRange;
    start: Point;
    end: Point;
};

export type WireRemovalPlan = {
    removed: Wire[];
    retained: Wire[];
};

function rounded(value: number) {
    return Number(value.toFixed(4));
}

function pointKey(point: Point) {
    return `${rounded(point.x)},${rounded(point.y)}`;
}

function atPoint(value: SExpression[] | undefined): Point | undefined {
    if (!value) return undefined;
    const x = Number(atom(value[1]));
    const y = Number(atom(value[2]));
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

function xyPoints(range: SExpressionRange) {
    const value = parseSExpression(range.text);
    const pts = findChild(value, 'pts');
    if (!pts) return [];
    return pts.filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === 'xy')
        .map(atPoint)
        .filter((point): point is Point => Boolean(point));
}

function rangeAtPoint(range: SExpressionRange) {
    const value = parseSExpression(range.text);
    return atPoint(findChild(value, 'at'));
}

function pointOnSegment(point: Point, start: Point, end: Point) {
    const cross = (point.x - start.x) * (end.y - start.y)
        - (point.y - start.y) * (end.x - start.x);
    if (Math.abs(cross) > 0.0001) return false;
    return point.x >= Math.min(start.x, end.x) - 0.0001
        && point.x <= Math.max(start.x, end.x) + 0.0001
        && point.y >= Math.min(start.y, end.y) - 0.0001
        && point.y <= Math.max(start.y, end.y) + 0.0001;
}

function parsedWires(source: string): Wire[] {
    return findLists(source, 'wire').flatMap((range) => {
        const points = xyPoints(range);
        if (points.length < 2) return [];
        return [{ range, start: points[0], end: points[points.length - 1] }];
    });
}

function endpointIndex(wires: Wire[]) {
    const byEndpoint = new Map<string, number[]>();
    const add = (point: Point, index: number) => {
        const key = pointKey(point);
        const indexes = byEndpoint.get(key) || [];
        indexes.push(index);
        byEndpoint.set(key, indexes);
    };
    wires.forEach((wire, index) => {
        add(wire.start, index);
        add(wire.end, index);
    });
    return byEndpoint;
}

function wireComponents(
    wires: Wire[],
    byEndpoint: Map<string, number[]>,
    junctionPoints: Point[],
) {
    const adjacent = wires.map(() => new Set<number>());
    const connect = (indexes: number[]) => {
        for (const left of indexes) {
            for (const right of indexes) {
                if (left !== right) adjacent[left].add(right);
            }
        }
    };
    for (const indexes of byEndpoint.values()) connect(indexes);
    for (const point of junctionPoints) {
        connect(wires.flatMap((wire, index) => pointOnSegment(point, wire.start, wire.end) ? [index] : []));
    }

    const componentByWire = new Map<number, number>();
    const components: number[][] = [];
    for (let first = 0; first < wires.length; first += 1) {
        if (componentByWire.has(first)) continue;
        const component = components.length;
        const indexes: number[] = [];
        const queue = [first];
        componentByWire.set(first, component);
        while (queue.length) {
            const index = queue.shift()!;
            indexes.push(index);
            for (const next of adjacent[index]) {
                if (componentByWire.has(next)) continue;
                componentByWire.set(next, component);
                queue.push(next);
            }
        }
        components.push(indexes);
    }
    return { componentByWire, components };
}

function componentsAtPoint(point: Point, wires: Wire[], componentByWire: Map<number, number>) {
    const output = new Set<number>();
    wires.forEach((wire, index) => {
        if (pointOnSegment(point, wire.start, wire.end)) {
            output.add(componentByWire.get(index)!);
        }
    });
    return output;
}

/**
 * Plans physical wire deletion. A complete wire island is removed when deleting
 * components leaves no retained real component pin on that island. Shared nets
 * are trimmed only up to their first junction or retained pin.
 */
export function planWireRemoval(
    source: string,
    disconnectPoints: Iterable<Point>,
    retainedRealPinPoints: Iterable<Point>,
): WireRemovalPlan {
    const disconnected = [...disconnectPoints];
    const retainedPins = [...retainedRealPinPoints];
    const wires = parsedWires(source);
    const byEndpoint = endpointIndex(wires);
    const junctionPoints = findLists(source, 'junction')
        .map(rangeAtPoint)
        .filter((point): point is Point => Boolean(point));
    const { componentByWire, components } = wireComponents(wires, byEndpoint, junctionPoints);
    const seededComponents = new Set<number>();
    const protectedComponents = new Set<number>();
    for (const point of disconnected) {
        for (const component of componentsAtPoint(point, wires, componentByWire)) {
            seededComponents.add(component);
        }
    }
    for (const point of retainedPins) {
        for (const component of componentsAtPoint(point, wires, componentByWire)) {
            protectedComponents.add(component);
        }
    }

    const removed = new Set<number>();
    for (const component of seededComponents) {
        if (protectedComponents.has(component)) continue;
        for (const index of components[component]) removed.add(index);
    }

    const boundaries = new Set(retainedPins.map(pointKey));
    for (const point of junctionPoints) boundaries.add(pointKey(point));
    for (const [key, indexes] of byEndpoint) {
        if (new Set(indexes).size >= 3) boundaries.add(key);
    }

    for (const disconnectPoint of disconnected) {
        const queue = [pointKey(disconnectPoint)];
        const visitedPoints = new Set<string>();
        while (queue.length) {
            const key = queue.shift()!;
            if (visitedPoints.has(key)) continue;
            visitedPoints.add(key);
            if (boundaries.has(key)) continue;
            for (const index of byEndpoint.get(key) || []) {
                if (removed.has(index)) continue;
                const component = componentByWire.get(index)!;
                if (!protectedComponents.has(component)) continue;
                removed.add(index);
                const wire = wires[index];
                const next = pointKey(wire.start) === key ? wire.end : wire.start;
                queue.push(pointKey(next));
            }
        }
    }

    return {
        removed: wires.filter((_, index) => removed.has(index)),
        retained: wires.filter((_, index) => !removed.has(index)),
    };
}

export function pointTouchesWire(point: Point, wire: Pick<Wire, 'start' | 'end'>) {
    return pointOnSegment(point, wire.start, wire.end);
}

export function wireDirectionsAtPoint(point: Point, wires: Array<Pick<Wire, 'start' | 'end'>>) {
    const directions = new Set<string>();
    for (const wire of wires) {
        if (!pointOnSegment(point, wire.start, wire.end)) continue;
        for (const end of [wire.start, wire.end]) {
            const dx = rounded(end.x - point.x);
            const dy = rounded(end.y - point.y);
            if (!dx && !dy) continue;
            const divisor = Math.max(Math.abs(dx), Math.abs(dy));
            directions.add(`${rounded(dx / divisor)},${rounded(dy / divisor)}`);
        }
    }
    return directions.size;
}

export function wireRangesToDisconnect(
    source: string,
    disconnectPoints: Iterable<Point>,
    stopPoints: Iterable<Point>,
) {
    const wires = parsedWires(source);
    const byEndpoint = endpointIndex(wires);

    const boundaries = new Set([...stopPoints].map(pointKey));
    for (const range of findLists(source, 'junction')) {
        const point = rangeAtPoint(range);
        if (point) boundaries.add(pointKey(point));
    }
    for (const [key, indexes] of byEndpoint) {
        if (new Set(indexes).size >= 3) boundaries.add(key);
    }

    const removed = new Set<number>();
    for (const disconnectPoint of disconnectPoints) {
        const queue = [pointKey(disconnectPoint)];
        while (queue.length) {
            const key = queue.shift()!;
            if (boundaries.has(key)) continue;
            for (const index of byEndpoint.get(key) || []) {
                if (removed.has(index)) continue;
                removed.add(index);
                const wire = wires[index];
                const next = pointKey(wire.start) === key ? wire.end : wire.start;
                queue.push(pointKey(next));
            }
        }
    }

    return [...removed].map((index) => wires[index].range);
}
