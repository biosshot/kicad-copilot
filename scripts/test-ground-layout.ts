import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { beautifySchematic } from '../src/circuit/beautify';
import { getPcbSchematic, getSchematicContext } from '../src/kicad/schematic-reader';
import { children, position, scalar } from '../src/kicad/schematic-assets';
import { parseSExpression } from '../src/kicad/sexpr/ast';
import { planWireRemoval } from '../src/kicad/wire-removal';

const output = resolve('.test-output/ground-layout');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(output, 'run-'));
await cp(resolve('tests/fixtures/ground-layout'), directory, { recursive: true });
const path = join(directory, 'main.kicad_sch');
const connectivity = async () => (await getPcbSchematic(path)).components.flatMap(c => c.pins.map(p =>
    `${c.designator}.${p.pin_number}=${p.signal_name}`)).sort();
const crossings = async () => {
    const source = await readFile(path, 'utf8'), root = parseSExpression(source);
    const wires = planWireRemoval(source, [], []).retained;
    return children(root, 'symbol').filter(s => scalar(s, 'lib_id') === 'power:GNDREF').flatMap(ground => {
        const p = position(ground);
        return wires.filter(w => Math.max(w.start.x, w.end.x) > p.x - 2 && Math.min(w.start.x, w.end.x) < p.x + 2
            && Math.max(w.start.y, w.end.y) > p.y + .5 && Math.min(w.start.y, w.end.y) < p.y + 5);
    });
};
const before = await connectivity();
assert.ok((await crossings()).length, 'fixture must reproduce a wire crossing a ground symbol');
const context = await getSchematicContext(path);
const ids = new Set(context.assets.keys());
const realFetch = globalThis.fetch;
let misses = 0;
globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const match = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (match && ids.has(decodeURIComponent(match[1]))) {
        misses++;
        return Response.json({ success: false, result: null, msg: 'local fixture' });
    }
    return realFetch(input, init);
};
try {
    await beautifySchematic(path, { Circuit: context.target.components.map(c => c.designator) });
} finally { globalThis.fetch = realFetch; }
assert.ok(misses, 'local assets must use catalogue fallback');
assert.deepEqual(await connectivity(), before, 'KiCad connectivity changed');
assert.deepEqual(await crossings(), [], 'wire crosses a ground glyph or value');
console.log(`Ground layout regression passed: ${directory}`);
