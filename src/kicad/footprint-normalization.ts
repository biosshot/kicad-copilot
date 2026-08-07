import { randomUUID } from 'node:crypto';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    SExpression,
    token,
    visitSExpression,
} from './sexpr/ast';

const NORMALIZATION_PROPERTY = 'kicad_copilot:easyeda_geometry_rotation';
const NORMALIZATION_VALUE = '180';
const POINT_HEADS = new Set(['start', 'mid', 'end', 'center', 'xy']);

function propertyValue(node: SExpression[], name: string) {
    for (const child of node) {
        if (!isSExpressionList(child) || listHead(child) !== 'property') continue;
        if (atom(child[1]) === name) return atom(child[2]);
    }
    return undefined;
}

function numberToken(value: number) {
    return token(String(Object.is(value, -0) ? 0 : value));
}

function negatePoint(node: SExpression[]) {
    const x = Number(atom(node[1]));
    const y = Number(atom(node[2]));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    node[1] = numberToken(-x);
    node[2] = numberToken(-y);
}

function rotateAt(node: SExpression[]) {
    negatePoint(node);
    const angle = Number(atom(node[3]) || 0);
    node[3] = numberToken(((angle + 180) % 360 + 360) % 360);
}

function rotateGraphic(node: SExpression[]) {
    visitSExpression(node, (child) => {
        const head = listHead(child);
        if (head === 'at') rotateAt(child);
        else if (head && POINT_HEADS.has(head)) negatePoint(child);
    });
}

function rotateModel(node: SExpression[]) {
    const offset = findChild(findChild(node, 'offset') || [], 'xyz');
    if (offset) negatePoint(offset);
    const rotation = findChild(findChild(node, 'rotate') || [], 'xyz');
    if (!rotation) return;
    const z = Number(atom(rotation[3]) || 0);
    rotation[3] = numberToken(((z + 180) % 360 + 360) % 360);
}

function markerProperty(): SExpression[] {
    return [
        token('property'), token(NORMALIZATION_PROPERTY, true), token(NORMALIZATION_VALUE, true),
        [token('at'), token('0'), token('0'), token('0')],
        [token('layer'), token('F.Fab', true)], [token('hide'), token('yes')],
        [token('uuid'), token(randomUUID(), true)],
        [token('effects'), [token('font'), [token('size'), token('1'), token('1')]]],
    ];
}

function isEasyEdaFootprint(node: SExpression[]) {
    const identifier = atom(node[1]) || '';
    return identifier.startsWith('kicad-copilot:')
        && Boolean(propertyValue(node, 'EasyEDA part_uuid') || propertyValue(node, 'EasyEDA footprint_uuid'));
}

export function normalizeEasyEdaFootprintGeometry(node: SExpression[]) {
    if (!isEasyEdaFootprint(node) || propertyValue(node, NORMALIZATION_PROPERTY) === NORMALIZATION_VALUE) {
        return false;
    }

    for (const child of node) {
        if (!isSExpressionList(child)) continue;
        const head = listHead(child);
        if (head === 'at') continue;
        if (head === 'model') {
            rotateModel(child);
            continue;
        }
        if (head === 'pad') {
            let at = findChild(child, 'at');
            if (!at) {
                at = [token('at'), token('0'), token('0')];
                child.push(at);
            }
            rotateAt(at);
            continue;
        }
        if (head === 'property' || head === 'fp_text') {
            const at = findChild(child, 'at');
            if (at) rotateAt(at);
            continue;
        }
        rotateGraphic(child);
    }

    node.push(markerProperty());
    return true;
}

export function footprintGeometryIsNormalized(node: SExpression[]) {
    return propertyValue(node, NORMALIZATION_PROPERTY) === NORMALIZATION_VALUE;
}
