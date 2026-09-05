import { randomUUID } from 'node:crypto';
import { basename, dirname, relative } from 'node:path';
import { CircuitAssembly } from '../types/circuit';
import { atom, findChild, parseSExpression, printSExpression, SExpression, token } from './sexpr/ast';
import { children, nativeProperty, Point, position, scalar, SchematicAsset, SYMBOL_UNIT_MM } from './schematic-assets';
import { quoteSExpression as q } from './sexpr/scan';

function set(node: SExpression[], head: string, values: string[], quoted = false) {
    const field = findChild(node, head);
    const replacement: SExpression[] = [token(head), ...values.map(v => token(v, quoted))];
    if (field) node[node.indexOf(field)] = replacement;
    else node.push(replacement);
}
function setProperty(node: SExpression[], name: string, value: string, anchor: Point, hidden = true) {
    const property = children(node, 'property').find(p => atom(p[1]) === name);
    if (property) property[2] = token(value, true);
    else node.push(parseSExpression(`(property ${q(name)} ${q(value)} (at ${anchor.x} ${anchor.y} 0) (effects (font (size 1.27 1.27)) ${hidden ? '(hide yes)' : ''}))`));
}
const rounded = (value: number) => Number(value.toFixed(5));
function transform(p: Point, anchor: Point, rotation: number, mirror: boolean) {
    const r = rotation * Math.PI / 180;
    const y = mirror ? -p.y : p.y;
    return { x: rounded(anchor.x + p.x * Math.cos(r) - y * Math.sin(r)),
        y: rounded(anchor.y - p.x * Math.sin(r) - y * Math.cos(r)) };
}
export function placeLocalSymbol(
    asset: SchematicAsset, component: CircuitAssembly['components'][number], anchor: Point,
    parentPath: string, rootPath: string, parentInstancePaths: string[], original?: SExpression[],
) {
    const pins = new Map<string, Point>();
    const pinLabelAngles = new Map<string, number>();
    const rotation = component.pos.rotate ?? 0;
    const mirror = Boolean(component.pos.mirror);
    const reference = asset.kind === 'native' ? component.designator.replace(/\.\d+$/, '') : component.designator;
    const projectName = basename(rootPath, '.kicad_sch');
    if (asset.kind === 'sheet') {
        const transformed = asset.symbol.pins.map(p => ({ p, point: transform({ x: p.x * SYMBOL_UNIT_MM, y: -p.y * SYMBOL_UNIT_MM }, anchor, rotation, mirror) }));
        const corners = [
            transform({ x: 0, y: 0 }, anchor, rotation, mirror),
            transform({ x: asset.symbol.width * SYMBOL_UNIT_MM, y: -asset.symbol.height * SYMBOL_UNIT_MM }, anchor, rotation, mirror),
        ];
        const x = Math.min(...corners.map(p => p.x)), y = Math.min(...corners.map(p => p.y));
        const w = Math.abs(corners[1].x - corners[0].x), h = Math.abs(corners[1].y - corners[0].y);
        const node = original ? structuredClone(original) : parseSExpression(`(sheet (uuid ${q(randomUUID())})
            (stroke (width 0) (type solid)) (fill (color 0 0 0 0)))`);
        set(node, 'at', [String(x), String(y)]);
        set(node, 'size', [String(rounded(w)), String(rounded(h))]);
        setProperty(node, 'Sheetname', reference, { x, y: y - 1.27 }, false);
        setProperty(node, 'Sheetfile', relative(dirname(parentPath), asset.path).replaceAll('\\', '/'), { x, y: y + h + 1.27 }, false);
        setProperty(node, 'Block Name', component.block_name, { x, y });
        for (const property of children(node, 'property')) {
            const name = atom(property[1]);
            set(property, 'at', [String(x), String(name === 'Sheetname' ? y - 1.27 : y + h + 1.27), '0']);
        }
        const oldPins = new Map(children(node, 'pin').map(p => [atom(p[1]), p]));
        for (const pin of children(node, 'pin')) node.splice(node.indexOf(pin), 1);
        for (const { p, point } of transformed) {
            const port = asset.ports.find(port => port.name === p.num)!;
            const angle = Math.abs(point.x - x) < 0.0001 ? 180 : Math.abs(point.x - x - w) < 0.0001 ? 0
                : Math.abs(point.y - y) < 0.0001 ? 90 : 270;
            const pin = oldPins.get(p.num) ?? parseSExpression(`(pin ${q(p.num)} ${port.direction}
                (uuid ${q(randomUUID())}) (effects (font (size 1.27 1.27))))`);
            set(pin, 'at', [String(point.x), String(point.y), String(angle)]);
            node.push(pin);
            pins.set(p.num, point);
            pinLabelAngles.set(p.num, angle);
        }
        const existingInstances = findChild(node, 'instances');
        if (!existingInstances) node.push(parseSExpression(`(instances (project ${q(projectName)} ${parentInstancePaths.map(p => `(path ${q(p)} (page "1"))`).join(' ')}))`));
        return { text: printSExpression(node), pins, pinLabelAngles };
    }
    const instance = structuredClone(original ?? asset.instance);
    const originalProperties = children(instance, 'property');
    const oldAnchor = position(instance);
    const oldRotation = Number(atom(findChild(instance, 'at')?.[3]) ?? 0);
    if (!original) {
        set(instance, 'uuid', [randomUUID()], true);
        for (const pin of children(instance, 'pin')) set(pin, 'uuid', [randomUUID()], true);
        const instances = findChild(instance, 'instances');
        if (instances) instance.splice(instance.indexOf(instances), 1);
    }
    let nativeRotation = rotation;
    let nativeMirror = asset.mirror;
    if (mirror) {
        if (nativeMirror === 'x') nativeMirror = '';
        else if (nativeMirror === 'y') { nativeMirror = ''; nativeRotation += 180; }
        else nativeMirror = 'x';
    }
    const mirrorField = findChild(instance, 'mirror');
    if (mirrorField) instance.splice(instance.indexOf(mirrorField), 1);
    if (nativeMirror) set(instance, 'mirror', [nativeMirror]);
    set(instance, 'at', [String(anchor.x), String(anchor.y), String((nativeRotation + 360) % 360)]);
    set(instance, 'unit', [String(asset.unit)]);
    setProperty(instance, 'Reference', reference, anchor);
    setProperty(instance, 'Value', component.value, anchor);
    setProperty(instance, 'Block Name', component.block_name, anchor);
    for (const property of originalProperties) {
        const p = position(property);
        const oldR = oldRotation * Math.PI / 180;
        const dx = p.x - oldAnchor.x, dy = p.y - oldAnchor.y;
        const local = { x: dx * Math.cos(oldR) - dy * Math.sin(oldR), y: -dx * Math.sin(oldR) - dy * Math.cos(oldR) };
        const next = transform(local, anchor, rotation, mirror);
        set(property, 'at', [String(next.x), String(next.y), '0']);
    }
    if (!findChild(instance, 'instances')) instance.push(parseSExpression(`(instances (project ${q(projectName)} ${parentInstancePaths.map(p =>
        `(path ${q(p)} (reference ${q(reference)}) (unit ${asset.unit}))`).join(' ')}))`));
    for (const pin of asset.pins) {
        pins.set(pin.number, transform(pin, anchor, rotation, mirror));
        pinLabelAngles.set(pin.number, (rotation + 180 + (mirror ? -pin.angle : pin.angle) + 360) % 360);
    }
    return { text: printSExpression(instance), pins, pinLabelAngles, library: asset.library };
}
