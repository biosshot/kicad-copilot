import { saveCheckpoint } from '../checkpoints/store';
import { readPcb } from '../kicad/pcb-reader';
import { normalizePcbCandidate } from '../kicad/pcb-validation';
import { atomicWritePcb } from '../kicad/pcb-writer';
import { atom, findChild, isSExpressionList, listHead, type SExpression } from '../kicad/sexpr/ast';
import { childText, listChildren } from '../kicad/pcb-reader';

function nodeNetName(root: SExpression[], node: SExpression[]) {
    const net = findChild(node, 'net');
    if (!net) return '';
    if (net.length >= 3) return atom(net[2]) ?? '';
    const value = atom(net[1]) ?? '';
    if (!/^\d+$/.test(value)) return value;
    return atom(listChildren(root, 'net').find(item => atom(item[1]) === value)?.[2]) ?? '';
}

function clearRouting(root: SExpression[], options: { onlyNets?: string[]; ignoreNets?: string[] } = {}) {
    const only = new Set(options.onlyNets ?? []);
    const ignored = new Set(options.ignoreNets ?? []);
    const removedIds = new Set<string>();
    let removed = 0;
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const node = root[index];
        if (!isSExpressionList(node) || !['segment', 'arc', 'via'].includes(listHead(node) ?? '')) continue;
        const net = nodeNetName(root, node);
        if (ignored.has(net) || (only.size && !only.has(net))) continue;
        const id = childText(node, 'uuid') ?? childText(node, 'tstamp');
        if (id) removedIds.add(id);
        root.splice(index, 1);
        removed += 1;
    }
    for (let index = root.length - 1; index >= 0; index -= 1) {
        const group = root[index];
        if (!isSExpressionList(group) || listHead(group) !== 'group') continue;
        const members = findChild(group, 'members');
        if (!members) continue;
        for (let memberIndex = members.length - 1; memberIndex >= 1; memberIndex -= 1) {
            if (removedIds.has(atom(members[memberIndex]) ?? '')) members.splice(memberIndex, 1);
        }
        if (members.length === 1 && (atom(group[1]) ?? '').startsWith('kicad-copilot:stitch:')) root.splice(index, 1);
    }
    return removed;
}

export async function clearPcbRouting(
    path: string,
    options: { onlyNets?: string[]; ignoreNets?: string[] } = {},
) {
    const pcb = await readPcb(path);
    const removed = clearRouting(pcb.root, options);
    if (!removed) return 'ok';
    const normalized = await normalizePcbCandidate(pcb.path, pcb.root, false);
    await saveCheckpoint(pcb.path, 'Before clear PCB routing');
    await atomicWritePcb(pcb.path, pcb.source, normalized);
    return 'ok';
}
