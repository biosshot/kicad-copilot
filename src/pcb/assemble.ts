import { saveCheckpoint } from '../checkpoints/store';
import { applyBoardAssemble } from '../kicad/board-assemble';
import { readPcb } from '../kicad/pcb-reader';
import { atomicWritePcb, fileHash } from '../kicad/pcb-writer';
import { readStoredLayout } from './layout-cache';
import { resolve } from 'node:path';

export async function assemblePcbLayout(pcbPath: string, layoutId: string) {
    const layout = await readStoredLayout(layoutId);
    if (!layout) throw new Error('PCB layout not found; run make_pcb_layout again');
    if (resolve(pcbPath) !== resolve(layout.pcb_path)) throw new Error('layout_id belongs to another PCB');
    const [pcbHash, schematicHash] = await Promise.all([
        fileHash(pcbPath),
        fileHash(layout.schematic_path),
    ]);
    if (pcbHash !== layout.pcb_hash || schematicHash !== layout.schematic_hash) {
        throw new Error('PCB layout is stale; run make_pcb_layout again');
    }
    const pcb = await readPcb(pcbPath);
    applyBoardAssemble(pcb.root, pcb.version, layout.pcb);
    await saveCheckpoint(pcb.path, 'Before PCB layout assembly');
    await atomicWritePcb(pcb.path, pcb.source, pcb.root);
    return 'ok';
}
