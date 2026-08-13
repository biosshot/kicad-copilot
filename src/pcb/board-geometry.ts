import {
    atom,
    findChild,
    type SExpression,
} from '../kicad/sexpr/ast';
import { childText, listChildren } from '../kicad/pcb-reader';

type Point = { x: number; y: number };

function numberAt(node: SExpression[] | undefined, index: number) {
    const value = Number(atom(node?.[index]));
    return Number.isFinite(value) ? value : 0;
}

function pointAt(node: SExpression[] | undefined): Point {
    return { x: numberAt(node, 1), y: numberAt(node, 2) };
}

function samePoint(a: Point, b: Point) {
    return Math.abs(a.x - b.x) < 1e-5 && Math.abs(a.y - b.y) < 1e-5;
}

function polygonArea(points: Point[]) {
    return Math.abs(points.reduce((sum, point, index) => {
        const next = points[(index + 1) % points.length];
        return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2);
}

function arcPoints(node: SExpression[]) {
    const start = pointAt(findChild(node, 'start'));
    const mid = pointAt(findChild(node, 'mid'));
    const end = pointAt(findChild(node, 'end'));
    const determinant = 2 * (
        start.x * (mid.y - end.y)
        + mid.x * (end.y - start.y)
        + end.x * (start.y - mid.y)
    );
    if (Math.abs(determinant) < 1e-9) return [start, end];
    const start2 = start.x ** 2 + start.y ** 2;
    const mid2 = mid.x ** 2 + mid.y ** 2;
    const end2 = end.x ** 2 + end.y ** 2;
    const center = {
        x: (start2 * (mid.y - end.y) + mid2 * (end.y - start.y) + end2 * (start.y - mid.y)) / determinant,
        y: (start2 * (end.x - mid.x) + mid2 * (start.x - end.x) + end2 * (mid.x - start.x)) / determinant,
    };
    const angle = (point: Point) => Math.atan2(point.y - center.y, point.x - center.x);
    const from = angle(start);
    const through = angle(mid);
    let to = angle(end);
    const tau = Math.PI * 2;
    const normalized = (value: number) => ((value % tau) + tau) % tau;
    const ccwSpan = normalized(to - from);
    if (normalized(through - from) > ccwSpan) {
        while (to > from) to -= tau;
        if (to === from) to -= tau;
    } else {
        while (to < from) to += tau;
    }
    const radius = Math.hypot(start.x - center.x, start.y - center.y);
    const count = Math.max(2, Math.ceil(Math.abs(to - from) * radius / 0.5));
    return Array.from({ length: count + 1 }, (_, index) => {
        const current = from + (to - from) * index / count;
        return { x: center.x + Math.cos(current) * radius, y: center.y + Math.sin(current) * radius };
    });
}

function edgeCutChains(root: SExpression[]) {
    const edges: Point[][] = [];
    if (listChildren(root, 'gr_curve').some(node => childText(node, 'layer') === 'Edge.Cuts')) {
        throw new Error('Bezier Edge.Cuts are not supported by routing import');
    }
    for (const node of listChildren(root, 'gr_line')) {
        if (childText(node, 'layer') === 'Edge.Cuts') {
            edges.push([pointAt(findChild(node, 'start')), pointAt(findChild(node, 'end'))]);
        }
    }
    for (const node of listChildren(root, 'gr_arc')) {
        if (childText(node, 'layer') === 'Edge.Cuts') edges.push(arcPoints(node));
    }
    for (const node of listChildren(root, 'gr_rect')) {
        if (childText(node, 'layer') !== 'Edge.Cuts') continue;
        const start = pointAt(findChild(node, 'start'));
        const end = pointAt(findChild(node, 'end'));
        edges.push([start, { x: end.x, y: start.y }, end, { x: start.x, y: end.y }, start]);
    }
    for (const node of listChildren(root, 'gr_circle')) {
        if (childText(node, 'layer') !== 'Edge.Cuts') continue;
        const center = pointAt(findChild(node, 'center'));
        const end = pointAt(findChild(node, 'end'));
        const radius = Math.hypot(end.x - center.x, end.y - center.y);
        const count = Math.max(24, Math.ceil(Math.PI * 2 * radius / 0.5));
        edges.push(Array.from({ length: count + 1 }, (_, index) => {
            const angle = Math.PI * 2 * index / count;
            return { x: center.x + Math.cos(angle) * radius, y: center.y + Math.sin(angle) * radius };
        }));
    }
    for (const node of listChildren(root, 'gr_poly')) {
        if (childText(node, 'layer') !== 'Edge.Cuts') continue;
        const points = listChildren(findChild(node, 'pts') ?? [], 'xy').map(pointAt);
        if (points.length >= 3) edges.push([...points, points[0]]);
    }
    const remaining = [...edges];
    const chains: Point[][] = [];
    while (remaining.length) {
        const chain = [...remaining.shift()!];
        while (!samePoint(chain[0], chain.at(-1)!)) {
            const end = chain.at(-1)!;
            const index = remaining.findIndex(edge => samePoint(edge[0], end) || samePoint(edge.at(-1)!, end));
            if (index < 0) throw new Error('Edge.Cuts is not a closed outline');
            const edge = remaining.splice(index, 1)[0];
            if (samePoint(edge.at(-1)!, end)) edge.reverse();
            chain.push(...edge.slice(1));
        }
        chains.push(chain.slice(0, -1));
    }
    return chains;
}

export function boardOutline(root: SExpression[]) {
    const chains = edgeCutChains(root).filter(chain => chain.length >= 3);
    if (!chains.length) throw new Error('PCB has no closed Edge.Cuts outline');
    chains.sort((a, b) => polygonArea(b) - polygonArea(a));
    return { points: chains[0], holes: chains.slice(1) };
}

export function copperLayerId(name: string) {
    if (name === 'F.Cu') return 1;
    if (name === 'B.Cu') return 2;
    const match = /^In(\d+)\.Cu$/.exec(name);
    return match ? 14 + Number(match[1]) : undefined;
}
