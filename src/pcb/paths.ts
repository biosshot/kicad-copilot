import { access } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';

async function exists(path: string) {
    return access(path).then(() => true, () => false);
}

export async function associatedSchematicPath(pcbPathInput: string, override?: string | null) {
    const pcbPath = resolve(pcbPathInput);
    if (extname(pcbPath).toLowerCase() !== '.kicad_pcb') throw new Error('expected .kicad_pcb path');
    if (override) {
        const target = resolve(override);
        if (extname(target).toLowerCase() !== '.kicad_sch') throw new Error('expected .kicad_sch path');
        if (!(await exists(target))) throw new Error(`path not found: ${target}`);
        return target;
    }
    const target = resolve(dirname(pcbPath), `${basename(pcbPath, '.kicad_pcb')}.kicad_sch`);
    if (!(await exists(target))) throw new Error(`associated schematic not found: ${target}`);
    return target;
}
