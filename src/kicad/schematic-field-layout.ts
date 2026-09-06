import { children, nativeInstances, nativeProperty, position, scalar } from './schematic-assets';
import { atom, findChild, parseSExpression, printSExpression, SExpression, token } from './sexpr/ast';
import { findLists } from './sexpr/scan';
import { applySourceEdits } from './schematic-writer';

type Rect = { left: number; right: number; top: number; bottom: number };
const intersects = (a: Rect, b: Rect) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/** Move only colliding reference/value fields of placed symbols. Wires and pins stay fixed. */
export function layoutSymbolFields(source: string, designators: Set<string>, labels: Rect[], paper: { x: number; y: number }) {
    const instances = nativeInstances(source);
    const sheets = children(parseSExpression(source), 'sheet');
    const bodies = instances.map(({ instance, asset }) => {
        const at = position(instance), angle = Number(atom(findChild(instance, 'at')?.[3]) ?? 0) * Math.PI / 180;
        const { center, width, height } = asset.symbol;
        const points = [10, width - 10].flatMap(x => [10, height - 10].map(y => {
            const dx = (x - center.x) * .254, dy = (y - center.y) * .254;
            return { x: at.x + dx * Math.cos(angle) + dy * Math.sin(angle), y: at.y - dx * Math.sin(angle) + dy * Math.cos(angle) };
        }));
        return { left: Math.min(...points.map(p => p.x)) - .3, right: Math.max(...points.map(p => p.x)) + .3,
            top: Math.min(...points.map(p => p.y)) - .3, bottom: Math.max(...points.map(p => p.y)) + .3 };
    });
    bodies.push(...sheets.map(sheet => {
        const at = position(sheet), size = position(sheet, 'size');
        return { left: at.x - .3, right: at.x + size.x + .3, top: at.y - .3, bottom: at.y + size.y + .3 };
    }));
    const items = [...instances.map(i => ({ ...i, sheet: false })),
        ...sheets.map(instance => ({ instance, designator: nativeProperty(instance, 'Sheetname'), sheet: true }))];
    const fields = items.flatMap(item => children(item.instance, 'property').flatMap(property => {
        const effects = findChild(property, 'effects');
        if (!effects || scalar(property, 'hide') === 'yes' || scalar(effects, 'hide') === 'yes' || effects.some(e => atom(e) === 'hide')) return [];
        const font = findChild(effects, 'font'), size = font ? position(font, 'size') : { x: 1.27, y: 1.27 };
        const width = [...(atom(property[2]) ?? '')].length * size.x * .85 + .5, height = size.y * 1.5;
        const rectAt = (point: { x: number; y: number }, vertical = false): Rect => ({ left: point.x - (vertical ? height : width) / 2,
            right: point.x + (vertical ? height : width) / 2, top: point.y - (vertical ? width : height) / 2, bottom: point.y + (vertical ? width : height) / 2 });
        // KiCad swaps horizontal/vertical field orientation for a rotated symbol.
        const horizontalAngle = item.sheet ? 0 : Math.abs(Number(atom(findChild(item.instance, 'at')?.[3]) ?? 0)) % 180;
        const fieldAngle = Number(atom(findChild(property, 'at')?.[3]) ?? 0);
        const vertical = (Math.abs(fieldAngle) % 180 === 90) !== (horizontalAngle === 90);
        return [{ ...item, property, effects, width, height, horizontalAngle, fieldAngle, rectAt, rect: rectAt(position(property), vertical) }];
    }));
    const wires = findLists(source, 'wire').map(range => {
        const points = children(findChild(parseSExpression(range.text), 'pts')!, 'xy').map(p => ({ x: Number(atom(p[1])), y: Number(atom(p[2])) }));
        return { left: Math.min(...points.map(p => p.x)) - .2, right: Math.max(...points.map(p => p.x)) + .2,
            top: Math.min(...points.map(p => p.y)) - .2, bottom: Math.max(...points.map(p => p.y)) + .2 };
    });
    const changed = new Set<SExpression[]>();
    for (const [index, item] of items.entries()) {
        if (!designators.has(item.designator)) continue;
        const group = fields.filter(f => f.instance === item.instance && ['Reference', 'Value', 'Sheetname'].includes(atom(f.property[1]) ?? ''));
        if (!group.length) continue;
        const collisions = (rect: Rect) => bodies.filter(b => intersects(rect, b)).length * 1000
            + [...labels, ...fields.filter(f => !group.includes(f)).map(f => f.rect)].filter(b => intersects(rect, b)).length * 100
            + wires.filter(w => intersects(rect, w)).length * 10;
        const upsideDown = group.some(f => f.fieldAngle === 180 || f.fieldAngle === 270);
        const oldScore = group.reduce((n, f) => n + collisions(f.rect), 0)
            + (group.length === 2 && intersects(group[0].rect, group[1].rect) ? 100 : 0);
        if (!oldScore && !upsideDown) continue;
        const body = bodies[index], width = Math.max(...group.map(f => f.width));
        const pitch = Math.max(...group.map(f => f.height)) + .635;
        const height = pitch * group.length, center = { x: (body.left + body.right) / 2, y: (body.top + body.bottom) / 2 };
        const stack = (x: number, y: number) => group.map((_, i) => ({ x, y: y + (i - (group.length - 1) / 2) * pitch }));
        const candidates = [group.map(f => position(f.property))];
        for (let step = 1; step <= 12; step++) {
            const gap = step * .635;
            candidates.push(stack(body.left - width / 2 - gap, center.y), stack(body.right + width / 2 + gap, center.y),
                stack(center.x, body.top - height / 2 - gap), stack(center.x, body.bottom + height / 2 + gap));
        }
        const score = (points: { x: number; y: number }[]) => points.reduce((n, p, i) => n + collisions(group[i].rectAt(p))
            + Math.hypot(p.x - (item.sheet ? center.x : position(group[i].property).x),
                p.y - (item.sheet ? center.y : position(group[i].property).y)) * .001, 0)
            + (group.length === 2 && intersects(group[0].rectAt(points[0]), group[1].rectAt(points[1])) ? 100 : 0);
        const best = candidates.filter(points => points.every((p, i) => p.x > group[i].width / 2 + 5 && p.y > group[i].height / 2 + 5
            && p.x + group[i].width / 2 < paper.x - 5 && p.y + group[i].height / 2 < paper.y - 5)).sort((a, b) => score(a) - score(b))[0];
        if (!best || (!upsideDown && score(best) >= oldScore)) continue;
        for (const [i, field] of group.entries()) {
            const positionNode = findChild(field.property, 'at')!;
            positionNode.splice(1, 3, token(String(Number(best[i].x.toFixed(4)))), token(String(Number(best[i].y.toFixed(4)))), token(String(field.horizontalAngle)));
            const justify = findChild(field.effects, 'justify');
            if (justify) field.effects.splice(field.effects.indexOf(justify), 1);
            field.rect = field.rectAt(best[i]);
            changed.add(field.instance);
        }
    }
    const replacements = new Map([...changed].map(instance => [scalar(instance, 'uuid'), printSExpression(instance)]));
    return applySourceEdits(source, [...findLists(source, 'symbol'), ...findLists(source, 'sheet')].flatMap(range => {
        const text = replacements.get(scalar(parseSExpression(range.text), 'uuid'));
        return text ? [{ start: range.start, end: range.end, text }] : [];
    }));
}
