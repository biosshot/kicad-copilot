import { saveCheckpoint } from '../checkpoints/store';
import { applyCircuitAssembly } from '../kicad/assembly';
import { getSchematic } from '../kicad/schematic-reader';
import { CircuitAssembly, CircuitMod } from '../types/circuit';
import { postJson } from '../utils/server';

type ExtractCircuitOptions = {
    onAssembly?: (assembly: CircuitAssembly) => void | Promise<void>;
};

export async function extractCircuit(
    path: string,
    circuit: CircuitMod,
    options: ExtractCircuitOptions = {},
) {
    const inputCircuit = await getSchematic(path);
    const checkpointId = await saveCheckpoint(path, 'Before extract_circuit');
    const response = await postJson('/v1/mcp-tools/extract-circuit', {
        circuit,
        inputCircuit,
    });
    const record = typeof response === 'object' && response !== null
        ? response as Record<string, unknown>
        : undefined;
    const assembly = (record?.circuit || response) as CircuitAssembly;
    await options.onAssembly?.(assembly);
    await applyCircuitAssembly(path, assembly, inputCircuit);
    const result = await getSchematic(path);

    return { checkpointId, result, assembly };
}
