import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { atom, findChild, parseSExpression, printSExpression, SExpression, token } from './sexpr/ast';
import { children, loadSchematicAssets, nativeProperty, position, scalar, sheetFilePath, sheetPorts } from './schematic-assets';
import { mutateSchematic } from './schematic-writer';
import { quoteSExpression as q } from './sexpr/scan';

// Only instance metadata and interfaces are synchronized. Shared sheet contents stay shared.
export async function synchronizeHierarchy(rootPath: string) {
    const context = await loadSchematicAssets(rootPath);
    const roots = new Map([...context.files].map(([path, source]) => [path, parseSExpression(source)]));
    const instances = new Map<string, string[]>();
    const sheetParents = new Map<SExpression[], string[]>();
    const changedInterfaces = new Map<string, string[]>();
    const walk = (path: string, instance: string) => {
        instances.set(path, [...(instances.get(path) ?? []), instance]);
        for (const sheet of children(roots.get(path)!, 'sheet')) {
            sheetParents.set(sheet, [...(sheetParents.get(sheet) ?? []), instance]);
            walk(sheetFilePath(path, sheet, context.projectDirectory), `${instance}/${scalar(sheet, 'uuid')}`);
        }
    };
    walk(context.rootPath, `/${scalar(roots.get(context.rootPath)!, 'uuid')}`);
    const projectName = basename(rootPath, '.kicad_sch');
    const projectRecords = (node: SExpression[]) => {
        let all = findChild(node, 'instances');
        if (!all) { all = [token('instances')]; node.push(all); }
        let project = children(all, 'project').find(p => atom(p[1]) === projectName);
        if (!project) { project = [token('project'), token(projectName, true)]; all.push(project); }
        return project;
    };
    const rootPage = scalar(children(findChild(roots.get(context.rootPath)!, 'sheet_instances') ?? [], 'path')[0] ?? [], 'page', '1');
    const usedPages = new Set([rootPage]);
    const reservedPages = new Set([rootPage, ...[...sheetParents.keys()].flatMap(sheet =>
        children(projectRecords(sheet), 'path').map(record => scalar(record, 'page')))]);
    let nextPage = 1;
    for (const [path, root] of roots) {
        for (const sheet of children(root, 'sheet')) {
            const childPath = sheetFilePath(path, sheet, context.projectDirectory);
            const ports = sheetPorts(context.files.get(childPath)!);
            const originalPins = children(sheet, 'pin');
            if (ports.some(port => !originalPins.some(pin => atom(pin[1]) === port.name && atom(pin[2]) === port.direction))) {
                changedInterfaces.set(path, [...changedInterfaces.get(path) ?? [], nativeProperty(sheet, 'Sheetname')]);
            }
            for (const pin of originalPins) if (!ports.some(p => p.name === atom(pin[1]))) {
                throw new Error(`sheet pin has no hierarchical label: ${nativeProperty(sheet, 'Sheetname')}.${atom(pin[1])}`);
            }
            const at = position(sheet), size = position(sheet, 'size');
            for (const port of ports) {
                const existing = originalPins.find(p => atom(p[1]) === port.name);
                if (existing) { existing[2] = token(port.direction); continue; }
                let y = at.y + 5.08;
                const x = port.direction === 'output' ? at.x + size.x : at.x;
                while (children(sheet, 'pin').some(p => Math.abs(position(p).x - x) < 0.0001 && Math.abs(position(p).y - y) < 0.0001)) y += 5.08;
                if (y >= at.y + size.y) {
                    size.y = y - at.y + 5.08;
                    const field = findChild(sheet, 'size')!;
                    field[2] = token(String(Number(size.y.toFixed(5))));
                }
                sheet.push(parseSExpression(`(pin ${q(port.name)} ${port.direction} (at ${x} ${Number(y.toFixed(5))} ${port.direction === 'output' ? 0 : 180})
                    (effects (font (size 1.27 1.27))) (uuid ${q(randomUUID())}))`));
            }
            const project = projectRecords(sheet);
            const wanted = sheetParents.get(sheet)!;
            for (const record of children(project, 'path')) if (!wanted.includes(atom(record[1]) ?? '')) project.splice(project.indexOf(record), 1);
            for (const parent of wanted) {
                const record = children(project, 'path').find(p => atom(p[1]) === parent);
                let page = record ? scalar(record, 'page') : '';
                if (!page || usedPages.has(page)) {
                    while (reservedPages.has(String(nextPage))) nextPage++;
                    page = String(nextPage++);
                    reservedPages.add(page);
                    const field = record && findChild(record, 'page');
                    if (field) field[1] = token(page, true);
                    else if (record) record.push(parseSExpression(`(page ${q(page)})`));
                    else project.push(parseSExpression(`(path ${q(parent)} (page ${q(page)}))`));
                }
                usedPages.add(page);
            }
        }
    }
    const used = new Map<string, string>();
    // Retain existing references before allocating references for new instances.
    for (const [path, root] of roots) for (const symbol of children(root, 'symbol')) {
        const project = projectRecords(symbol);
        const valid = instances.get(path) ?? [];
        for (const record of children(project, 'path')) {
            if (!valid.includes(atom(record[1]) ?? '')) { project.splice(project.indexOf(record), 1); continue; }
            const ref = scalar(record, 'reference');
            const owner = `${atom(record[1])}:${nativeProperty(symbol, 'Reference')}`;
            if (ref && (!used.has(ref) || used.get(ref) === owner)) used.set(ref, owner);
            else if (ref) project.splice(project.indexOf(record), 1);
        }
    }
    for (const [path, root] of roots) for (const symbol of children(root, 'symbol')) {
        const project = projectRecords(symbol);
        const base = nativeProperty(symbol, 'Reference');
        for (const instance of instances.get(path) ?? []) {
            if (children(project, 'path').some(p => atom(p[1]) === instance)) continue;
            const owner = `${instance}:${base}`;
            let ref = base;
            const prefix = base.replace(/[\d?]+$/, '') || 'U';
            let next = 1;
            while (!ref || ref.includes('?') || (used.has(ref) && used.get(ref) !== owner)) ref = `${prefix}${next++}`;
            used.set(ref, owner);
            project.push(parseSExpression(`(path ${q(instance)} (reference ${q(ref)}) (unit ${scalar(symbol, 'unit', '1')}))`));
        }
    }
    for (const [path, root] of roots) {
        const original = context.files.get(path)!;
        if (printSExpression(root) === printSExpression(parseSExpression(original))) continue;
        await mutateSchematic(path, current => {
            if (current !== original) throw new Error(`file changed during hierarchy update: ${path}`);
            return `${printSExpression(root)}\n`;
        });
    }
    return changedInterfaces;
}
