import { atom, findChild, isSExpressionList, listHead, parseSExpression, SExpression } from './sexpr/ast';
import { findLists, SExpressionRange } from './sexpr/scan';

type Point = { x: number; y: number };

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

export function wireRangesToDisconnect(
    source: string,
    disconnectPoints: Iterable<Point>,
    stopPoints: Iterable<Point>,
) {
    const wires = findLists(source, 'wire').flatMap((range) => {
        const points = xyPoints(range);
        if (points.length < 2) return [];
        return [{
            range,
            start: points[0],
            end: points[points.length - 1],
        }];
    });
    const byEndpoint = new Map<string, number[]>();
    const addEndpoint = (point: Point, index: number) => {
        const key = pointKey(point);
        const indexes = byEndpoint.get(key) || [];
        indexes.push(index);
        byEndpoint.set(key, indexes);
    };
    wires.forEach((wire, index) => {
        addEndpoint(wire.start, index);
        addEndpoint(wire.end, index);
    });

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
