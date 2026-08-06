import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    parseSExpression,
    SExpression,
} from './sexpr/ast';

export type PcbDocument = {
    path: string;
    source: string;
    root: SExpression[];
    version: number;
};

export function listChildren(root: SExpression[], head: string) {
    return root.filter((item): item is SExpression[] => isSExpressionList(item) && listHead(item) === head);
}

export function childText(node: SExpression[], head: string) {
    return atom(findChild(node, head)?.[1]);
}

export function propertyValue(node: SExpression[], name: string) {
    for (const child of node) {
        if (!isSExpressionList(child) || listHead(child) !== 'property') continue;
        if (atom(child[1]) === name) return atom(child[2]);
    }
    return undefined;
}

export function footprintReference(node: SExpression[]) {
    const property = propertyValue(node, 'Reference');
    if (property) return property;
    for (const child of node) {
        if (!isSExpressionList(child) || listHead(child) !== 'fp_text') continue;
        if (atom(child[1]) === 'reference') return atom(child[2]);
    }
    return undefined;
}

export function footprintPath(node: SExpression[]) {
    return childText(node, 'path');
}

export function footprintLayer(node: SExpression[]) {
    return childText(node, 'layer') || 'F.Cu';
}

export function footprintAt(node: SExpression[]) {
    const at = findChild(node, 'at');
    return {
        x: Number(atom(at?.[1]) || 0),
        y: Number(atom(at?.[2]) || 0),
        rotate: Number(atom(at?.[3]) || 0),
    };
}

export function footprintIsBoardOnly(node: SExpression[]) {
    const attr = findChild(node, 'attr');
    return Boolean(attr?.some((item) => atom(item) === 'board_only'));
}

export function footprintIsGenerated(node: SExpression[]) {
    return propertyValue(node, 'kicad_copilot:generated') === 'yes';
}

export function padNumber(node: SExpression[]) {
    return listHead(node) === 'pad' ? atom(node[1]) : undefined;
}

export function padNet(node: SExpression[]) {
    const net = findChild(node, 'net');
    if (!net) return '';
    return atom(net.length >= 3 ? net[2] : net[1]) || '';
}

export async function readPcb(path: string): Promise<PcbDocument> {
    const target = resolve(path);
    const info = await stat(target).catch(() => undefined);
    if (!info?.isFile()) throw new Error(`path not found: ${target}`);
    const source = await readFile(target, 'utf8');
    const root = parseSExpression(source);
    if (listHead(root) !== 'kicad_pcb') throw new Error('invalid KiCad PCB');
    const version = Number(childText(root, 'version'));
    if (!Number.isFinite(version)) throw new Error('invalid KiCad PCB version');
    return { path: target, source, root, version };
}

export function pcbFootprints(root: SExpression[]) {
    return listChildren(root, 'footprint');
}

export function pcbNetNames(root: SExpression[]) {
    const result = new Set<string>();
    for (const footprint of pcbFootprints(root)) {
        for (const pad of listChildren(footprint, 'pad')) {
            const net = padNet(pad);
            if (net) result.add(net);
        }
    }
    return result;
}
