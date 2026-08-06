import { saveCheckpoint } from '../checkpoints/store';
import { readPcb } from './pcb-reader';
import { normalizePcbCandidate } from './pcb-validation';
import { atomicWritePcb } from './pcb-writer';
import {
    atom,
    findChild,
    isSExpressionList,
    listHead,
    SExpression,
    token,
} from './sexpr/ast';

const COPPER_LAYER_NAME = /^(?:F|B|In\d+)\.Cu$/;

function layerName(entry: SExpression) {
    return isSExpressionList(entry) ? atom(entry[1]) : undefined;
}

function isCopperLayer(entry: SExpression) {
    const name = layerName(entry);
    return Boolean(name && COPPER_LAYER_NAME.test(name));
}

function innerLayerEntry(index: number, version: number): SExpression[] {
    const id = version >= 20250000 ? (index + 1) * 2 : index;
    return [token(String(id)), token(`In${index}.Cu`, true), token('signal')];
}

function findExplicitStackup(root: SExpression[]) {
    const setup = findChild(root, 'setup');
    return setup ? findChild(setup, 'stackup') : undefined;
}

function collectLayerReferences(value: SExpression, names: Set<string>, output: Set<string>) {
    if (!isSExpressionList(value)) {
        if (names.has(value.value)) output.add(value.value);
        return;
    }
    for (const child of value) collectLayerReferences(child, names, output);
}

function usedRemovedLayers(root: SExpression[], layersNode: SExpression[], names: string[]) {
    const targets = new Set(names);
    const found = new Set<string>();
    for (const child of root) {
        if (child !== layersNode) collectLayerReferences(child, targets, found);
    }
    return [...found].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

function replaceCopperLayers(root: SExpression[], version: number, copperLayerCount: number) {
    const layers = findChild(root, 'layers');
    if (!layers) throw new Error('PCB layers table not found');

    const entries = layers.slice(1);
    const front = entries.find((entry) => layerName(entry) === 'F.Cu');
    const back = entries.find((entry) => layerName(entry) === 'B.Cu');
    if (!front || !back) throw new Error('PCB must contain F.Cu and B.Cu');

    const innerCount = copperLayerCount - 2;
    const desiredNames = new Set(Array.from(
        { length: innerCount },
        (_, index) => `In${index + 1}.Cu`,
    ));
    const existingInner = new Map(
        entries
            .filter((entry) => {
                const name = layerName(entry);
                return Boolean(name?.startsWith('In') && name.endsWith('.Cu'));
            })
            .map((entry) => [layerName(entry)!, entry]),
    );
    const removed = [...existingInner.keys()].filter((name) => !desiredNames.has(name));
    const used = usedRemovedLayers(root, layers, removed);
    if (used.length > 0) {
        throw new Error(`cannot remove used copper layers: ${used.join(', ')}`);
    }

    const inner = Array.from({ length: innerCount }, (_, index) => {
        const number = index + 1;
        return existingInner.get(`In${number}.Cu`) || innerLayerEntry(number, version);
    });
    const nonCopper = entries.filter((entry) => !isCopperLayer(entry));
    layers.splice(1, entries.length, front, ...inner, back, ...nonCopper);
}

export async function setPcbStackLayers(path: string, copperLayerCount: number) {
    const pcb = await readPcb(path);
    const layers = findChild(pcb.root, 'layers');
    if (!layers) throw new Error('PCB layers table not found');
    const currentCount = layers.slice(1).filter(isCopperLayer).length;
    if (currentCount === copperLayerCount) return 'ok';

    if (findExplicitStackup(pcb.root)) {
        throw new Error('PCB has an explicit physical stackup; change it in KiCad before using this tool');
    }

    replaceCopperLayers(pcb.root, pcb.version, copperLayerCount);
    const normalized = await normalizePcbCandidate(pcb.path, pcb.root, false);
    await saveCheckpoint(pcb.path, 'Before PCB copper layer change');
    await atomicWritePcb(pcb.path, pcb.source, normalized);
    return 'ok';
}

