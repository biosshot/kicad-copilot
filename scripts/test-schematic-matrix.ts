import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import sharp from 'sharp';
import { openMcpClient } from '../src/mcp-client';
import { getSupportedKicadCli } from '../src/kicad/cli';
import { runProcessChecked } from '../src/utils/process';
import { atom, findChild, parseSExpression, printSExpression } from '../src/kicad/sexpr/ast';
import { children, nativeInstances, nativeProperty, position, scalar } from '../src/kicad/schematic-assets';
import { planWireRemoval, wireDirectionsAtPoint } from '../src/kicad/wire-removal';
import type { CircuitMod, ExplainCircuit } from '../src/types/circuit';

const base = resolve('.test-output/schematic-matrix');
await mkdir(base, { recursive: true });
const output = await mkdtemp(join(base, 'run-'));
console.log(`Fixtures: ${output}`);
const cli = await getSupportedKicadCli();
const client = await openMcpClient();
const results: { name: string; status: string; details?: string; directory: string }[] = [];
const ids = { ldo: '8c72fdff8032447e8704660d377171f6', cap: 'e10bc30d72324129a5b7daae4e75f56f', connector: '9cdd746789df4eb5b83f56551b6edd1b' };
const list = <T>(v: T | T[] | undefined): T[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
const xmlParser = new XMLParser({ ignoreAttributes: false });
const escape = (s: string) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
const add = (designator: string, part_uuid: string, nets: Record<string, string>, block_name = 'Circuit', value = designator): CircuitMod['add_components'][number] => ({
    designator, part_uuid, value, block_name, search_query: '',
    pins: Object.entries(nets).map(([pin_number, signal_name]) => ({ pin_number, name: pin_number, signal_name })),
});
type ModelPart = { ref: string; uuid: string; nets: Record<string, string>; child?: string };
type ModelPage = { uuid: string; parts: ModelPart[] };

class Project {
    readonly directory: string;
    readonly pages = new Map<string, ModelPage>();
    readonly calls: unknown[] = [];
    readonly snapshots: string[] = [];
    constructor(readonly name: string) { this.directory = join(output, name); }
    path(page = 'main') { return join(this.directory, `${page}.kicad_sch`); }
    scope(page: string) { return page === 'main' ? 'ROOT' : page; }
    async call(name: string, args: Record<string, unknown>, error?: RegExp): Promise<any> {
        const started = Date.now();
        const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
        const text = (response.content as { type: string; text?: string }[]).filter(c => c.type === 'text').map(c => c.text).join('\n');
        this.calls.push({ name, arguments: args, response, milliseconds: Date.now() - started });
        await writeFile(join(this.directory, 'calls.json'), JSON.stringify(this.calls, null, 2));
        if (error) {
            assert.ok(response.isError, `${name} must reject ${JSON.stringify(args)}`);
            assert.match(text, error);
            console.log(`expected error ${this.name}: ${text.slice(0, 180)}`);
            return;
        }
        if (response.isError) throw new Error(`${name}: ${text}`);
        try { return JSON.parse(text); } catch { return text; }
    }
    async create() {
        await mkdir(this.directory, { recursive: true });
        await this.call('create_doc', { doc: { doc_type: 'project', path: join(this.directory, 'main.kicad_pro') } });
        await this.register('main');
    }
    async register(page: string) {
        const root = parseSExpression(await readFile(this.path(page), 'utf8'));
        this.pages.set(page, { uuid: scalar(root, 'uuid').replaceAll('-', ''), parts: [] });
    }
    async child(page: string, parent: string) {
        await this.call('create_doc', { doc: { doc_type: 'schematic_page', path: this.path(page), parent_path: this.path(parent) } });
        await this.register(page);
        this.pages.get(parent)!.parts.push({ ref: basename(page), uuid: this.pages.get(page)!.uuid, nets: {}, child: page });
    }
    sheet(ref: string, child: string, nets: Record<string, string>, block = 'Circuit') {
        return add(ref, this.pages.get(child)!.uuid, nets, block);
    }
    async modify(page: string, additions: CircuitMod['add_components'] = [], extra: Partial<CircuitMod> = {}) {
        const mod: CircuitMod = { add_components: additions, add_reused_blocks: [], rm_components: null, external_connect: null, external_rm_connect: null, ...extra };
        await this.call('extract_circuit', { path: this.path(page), ...mod });
        const model = this.pages.get(page)!;
        model.parts = model.parts.filter(p => !mod.rm_components?.includes(p.ref));
        model.parts.push(...additions.map(c => ({ ref: c.designator, uuid: c.part_uuid, nets: Object.fromEntries(c.pins.map(p => [p.pin_number, p.signal_name])),
            child: [...this.pages].find(([, p]) => p.uuid === c.part_uuid)?.[0] })));
        for (const c of mod.external_rm_connect ?? []) model.parts.find(p => p.ref === c.designator)!.nets[c.pin_number] = '';
        for (const c of mod.external_connect ?? []) model.parts.find(p => p.ref === c.designator)!.nets[c.pin_number] = c.signal_name;
    }
    async ldo(page: string, parent: string) {
        await this.child(page, parent);
        await this.modify(page, [
            add('U1', ids.ldo, { '1': `hier:${page}:VIN`, '2': 'GND', '3': `hier:${page}:VIN`, '4': 'NC', '5': `hier:${page}:OUT` }, 'LDO', 'AP2112K-3.3TRG1'),
            add('C1', ids.cap, { '1': `hier:${page}:VIN`, '2': 'GND' }, 'LDO', '10uF'),
            add('C2', ids.cap, { '1': `hier:${page}:OUT`, '2': 'GND' }, 'LDO', '10uF'),
        ]);
    }
    async native(page: string) {
        await this.child(page, 'main');
        const root = parseSExpression(await readFile(this.path(page), 'utf8'));
        findChild(root, 'lib_symbols')!.push(parseSExpression(`(symbol "User:Resistor"
            (pin_names (offset 0)) (in_bom yes) (on_board yes)
            (property "Reference" "R" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
            (property "Value" "Resistor" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
            (symbol "Resistor_0_1" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))
            (symbol "Resistor_1_1"
                (pin passive line (at -2.54 0 0) (length 1.27) (name "1" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
                (pin passive line (at 2.54 0 180) (length 1.27) (name "2" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`));
        root.push(parseSExpression(`(symbol (lib_id "User:Resistor") (at 50.8 50.8 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid "${randomUUID()}")
            (property "Reference" "R1" (at 50.8 48.26 0) (effects (font (size 1.27 1.27))))
            (property "Value" "10k" (at 50.8 53.34 0) (effects (font (size 1.27 1.27))))
            (property "Custom" "preserve me" (at 50.8 50.8 0) (hide yes) (effects (font (size 1.27 1.27)))))`));
        await writeFile(this.path(page), printSExpression(root));
        const result = await this.call('get_schematic', { path: this.path(page) });
        const uuid = result.components[0].part_uuid;
        this.pages.get(page)!.parts.push({ ref: 'R1', uuid, nets: { '1': '', '2': '' } });
        const found = await this.call('component_search', { part_uuid: uuid });
        assert.equal(found.bestComponent.part_uuid, uuid);
        return uuid;
    }
    async pretty(page: string, blocks?: Record<string, string[]>) {
        const before = nativeInstances(await readFile(this.path(page), 'utf8')).filter(i => !i.reference.startsWith('#'));
        await this.call('beautify_schematic', { path: this.path(page), blocks: blocks ?? { Circuit: this.pages.get(page)!.parts.map(p => p.ref) } });
        const after = nativeInstances(await readFile(this.path(page), 'utf8'));
        for (const old of before) {
            const current = after.find(i => i.designator === old.designator)!;
            assert.equal(scalar(current.instance, 'uuid'), scalar(old.instance, 'uuid'), 'beautify changed a component UUID');
            for (const project of children(findChild(old.instance, 'instances') ?? [], 'project')) {
                const updated = children(findChild(current.instance, 'instances') ?? [], 'project').find(p => atom(p[1]) === atom(project[1]));
                for (const record of children(project, 'path')) {
                    const match = children(updated ?? [], 'path').find(p => atom(p[1]) === atom(record[1]));
                    assert.equal(scalar(match ?? [], 'reference'), scalar(record, 'reference'), 'beautify changed an instance reference');
                }
            }
        }
    }
    async files() {
        return Object.fromEntries(await Promise.all([...this.pages.keys()].map(async page => [page, await readFile(this.path(page), 'utf8')])));
    }
    async rejects(page: string, mod: Partial<CircuitMod>, error: RegExp) {
        const before = await this.files();
        await this.call('extract_circuit', { path: this.path(page), add_components: [], add_reused_blocks: [], rm_components: null,
            external_connect: null, external_rm_connect: null, ...mod }, error);
        assert.deepEqual(await this.files(), before, 'rejected operation changed schematic files');
    }
    async verify(label: string, pictures = true) {
        const directory = join(this.directory, label);
        await mkdir(directory, { recursive: true });
        const netlistPath = join(directory, 'netlist.xml');
        await runProcessChecked(cli.path, ['sch', 'export', 'netlist', '--format', 'kicadxml', '-o', netlistPath, this.path()]);
        const exported = xmlParser.parse(await readFile(netlistPath, 'utf8')).export;
        // Independent oracle: requested connections, expanded by instance, never read from generated wires/labels.
        const parents = new Map<string, string>();
        const find = (s: string): string => { const p = parents.get(s); if (!p || p === s) return s; const root = find(p); parents.set(s, root); return root; };
        const merge = (a: string, b: string) => { parents.set(find(a), find(b)); };
        const expected = new Map<string, string>();
        const symbolReferences = new Map<string, string>();
        for (const [page, source] of Object.entries(await this.files())) for (const symbol of children(parseSExpression(source), 'symbol')) {
            const ref = nativeProperty(symbol, 'Reference');
            if (!ref.startsWith('#')) symbolReferences.set(`${page}:${scalar(symbol, 'uuid')}`, ref);
        }
        const instanceFiles = new Map<string, string>();
        const signal = (page: string, instance: string, value: string) => {
            if (!value || value === 'NC') return undefined;
            if (value.startsWith('global:')) return `global:${value.slice(7)}`;
            const match = /^(local|hier(?:_[a-z_]+)?):([^:]+):(.+)$/.exec(value);
            if (!match) return `global:${value}`;
            if (match[1] === 'local') { assert.equal(match[2], this.scope(page)); return `${instance}local:${match[3]}`; }
            return match[2] === this.scope(page) ? `${instance}port:${match[3]}` : `${instance}${match[2]}/port:${match[3]}`;
        };
        const expand = (page: string, instance: string) => {
            instanceFiles.set(instance, page);
            for (const p of this.pages.get(page)!.parts) {
                if (p.child) expand(p.child, `${instance}${p.ref}/`);
                for (const [number, net] of Object.entries(p.nets)) {
                    const pin = p.child ? `${instance}${p.ref}/port:${number}` : `${instance}${p.ref}.${number}`;
                    const binding = signal(page, instance, net);
                    if (binding) merge(pin, binding);
                    if (!p.child) expected.set(pin, pin);
                }
            }
        };
        expand('main', '/');
        const actualNets = new Map<string, string>();
        for (const n of list<any>(exported.nets?.net)) for (const node of list<any>(n.node)) actualNets.set(`${node['@_ref']}.${node['@_pin']}`, String(n['@_code']));
        const forward = new Map<string, string>(), reverse = new Map<string, string>();
        const seen = new Set<string>();
        let physical = 0;
        for (const c of list<any>(exported.components?.comp)) {
            const path = c.sheetpath['@_names'];
            const page = instanceFiles.get(path);
            assert.ok(page, `unexpected KiCad sheet ${path}`);
            const local = symbolReferences.get(`${page}:${c.tstamps}`);
            assert.ok(local, `unrecognized KiCad component ${c['@_ref']} ${c.tstamps}`);
            physical++;
            for (const p of list<any>(c.units?.unit).flatMap(u => list<any>(u.pins?.pin))) {
                const key = `${path}${local}.${p['@_num']}`;
                assert.ok(expected.has(key), `unexpected placed pin ${key}`);
                const wanted = find(key), actual = actualNets.get(`${c['@_ref']}.${p['@_num']}`) ?? `isolated:${key}`;
                assert.ok(!forward.has(wanted) || forward.get(wanted) === actual, `open requested connection at ${key}`);
                assert.ok(!reverse.has(actual) || reverse.get(actual) === wanted, `unrequested short at ${key}`);
                forward.set(wanted, actual); reverse.set(actual, wanted); seen.add(key);
            }
        }
        assert.deepEqual([...seen].sort(), [...expected.keys()].sort(), 'KiCad pin set differs from commands');
        const ercPath = join(directory, 'erc.json');
        await runProcessChecked(cli.path, ['sch', 'erc', '--format', 'json', '-o', ercPath, this.path()]);
        const erc = JSON.parse(await readFile(ercPath, 'utf8'));
        const violations = erc.sheets.flatMap((sheet: any) => sheet.violations);
        assert.equal(violations.filter((v: any) => v.type === 'unconnected_wire_endpoint').length, 0, 'generated a dangling wire branch');
        // The native-symbol fixture deliberately embeds a user symbol without an external library.
        if (this.name !== 'native-and-signal-names') assert.deepEqual(violations.filter((v: any) =>
            ['lib_symbol_issues', 'footprint_link_issues'].includes(v.type)), [], 'project library links are broken');
        const layoutErrors: string[] = [];
        for (const [page, source] of Object.entries(await this.files())) {
            const root = parseSExpression(source);
            const wires = planWireRemoval(source, [], []).retained;
            const pointKey = (p: { x: number; y: number }) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`;
            // The ground glyph and value lie below the anchor.
            if (this.name === 'buck-controller-vin' && page === 'main') {
                for (const ground of children(root, 'symbol').filter(s => scalar(s, 'lib_id') === 'power:GNDREF')) {
                    const p = position(ground);
                    for (const wire of wires) {
                        const left = Math.min(wire.start.x, wire.end.x), right = Math.max(wire.start.x, wire.end.x);
                        const top = Math.min(wire.start.y, wire.end.y), bottom = Math.max(wire.start.y, wire.end.y);
                        if (right > p.x - 2 && left < p.x + 2 && bottom > p.y + .5 && top < p.y + 5)
                            layoutErrors.push(`${page}: wire crosses ground symbol/value at ${p.x},${p.y}`);
                    }
                }
            }
            const dots = new Set(children(root, 'junction').map(j => pointKey(position(j))));
            for (const [key, p] of new Map(wires.flatMap(w => [w.start, w.end]).map(p => [pointKey(p), p]))) {
                if (wireDirectionsAtPoint(p, wires) >= 3 && !dots.has(key)) layoutErrors.push(`${page}: missing junction at ${key}`);
            }
            const paper = scalar(root, 'paper', 'A4');
            const papers: Record<string, [number, number]> = { A0: [1189, 841], A1: [841, 594], A2: [594, 420], A3: [420, 297], A4: [297, 210] };
            const [width, height] = papers[paper] ?? papers.A4;
            const outside = (point: { x: number; y: number }) => point.x < 0 || point.y < 0 || point.x > width || point.y > height;
            const boxes: { ref: string; x: number; y: number; w: number; h: number; sheet: boolean }[] = [];
            for (const sheet of children(root, 'sheet')) {
                const at = position(sheet), size = position(sheet, 'size');
                boxes.push({ ref: nativeProperty(sheet, 'Sheetname'), ...at, w: size.x, h: size.y, sheet: true });
            }
            for (const { instance, asset, reference } of nativeInstances(source)) {
                const at = position(instance), rotation = Number(atom(findChild(instance, 'at')?.[3]) ?? 0) * Math.PI / 180;
                const { center, width: w, height: h } = asset.symbol;
                const points = [[2.54 - center.x * .254, 2.54 - center.y * .254], [(w - center.x) * .254 - 2.54, (h - center.y) * .254 - 2.54]]
                    .map(([x, y]) => ({ x: at.x + x * Math.cos(rotation) + y * Math.sin(rotation), y: at.y - x * Math.sin(rotation) + y * Math.cos(rotation) }));
                if (points.some(outside)) layoutErrors.push(`${page}: symbol ${reference} outside ${paper}`);
                if (!reference.startsWith('#')) boxes.push({ ref: reference, x: Math.min(...points.map(p => p.x)), y: Math.min(...points.map(p => p.y)),
                    w: Math.abs(points[1].x - points[0].x), h: Math.abs(points[1].y - points[0].y), sheet: false });
            }
            for (const box of boxes) if (outside(box) || outside({ x: box.x + box.w, y: box.y + box.h })) layoutErrors.push(`${page}: ${box.ref} outside ${paper}`);
            for (let i = 0; i < boxes.length; i++) for (const b of boxes.slice(i + 1)) {
                const a = boxes[i];
                const x = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                const y = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                if (x > .05 && y > .05) layoutErrors.push(`${page}: overlapping ${a.ref} and ${b.ref}`);
            }
            for (const wire of children(root, 'wire')) {
                const ends = children(findChild(wire, 'pts') ?? [], 'xy').map(p => ({ x: Number(atom(p[1])), y: Number(atom(p[2])) }));
                if (ends.some(outside)) layoutErrors.push(`${page}: wire outside ${paper}`);
                for (const b of boxes.filter(b => b.sheet)) {
                    const horizontal = Math.abs(ends[0].y - ends[1].y) < .001;
                    const crosses = horizontal ? ends[0].y > b.y + .01 && ends[0].y < b.y + b.h - .01
                        && Math.max(ends[0].x, ends[1].x) > b.x + .01 && Math.min(ends[0].x, ends[1].x) < b.x + b.w - .01
                        : ends[0].x > b.x + .01 && ends[0].x < b.x + b.w - .01
                        && Math.max(ends[0].y, ends[1].y) > b.y + .01 && Math.min(ends[0].y, ends[1].y) < b.y + b.h - .01;
                    if (crosses) layoutErrors.push(`${page}: wire crosses body of ${b.ref}`);
                }
            }
        }
        await writeFile(join(directory, 'oracle.json'), JSON.stringify({ physical, pins: seen.size, nets: forward.size, layoutErrors }, null, 2));
        // Query every page through the actual MCP interface, including intermediate hierarchy levels.
        for (const page of this.pages.keys()) {
            const response = await this.call('get_schematic', { path: this.path(page) });
            const circuit: ExplainCircuit = response.components ? response : JSON.parse(await readFile(response.path, 'utf8'));
            assert.deepEqual(circuit.components.map(c => c.designator).sort(), this.pages.get(page)!.parts.map(p => p.ref).sort());
        }
        if (pictures) {
            await runProcessChecked(cli.path, ['sch', 'export', 'svg', '-o', directory, this.path()]);
            const files = (await readdir(directory)).filter(f => f.endsWith('.svg')).sort();
            for (const f of files) await sharp(await readFile(join(directory, f)), { density: 120 }).resize(1800).png().toFile(join(directory, f.replace(/\.svg$/, '.png')));
            const thumbs = await Promise.all(files.map(async (f, i) => ({ input: await sharp(join(directory, f.replace(/\.svg$/, '.png'))).resize(600, 424, { fit: 'contain', background: '#ffffff' }).png().toBuffer(), left: i % 3 * 600, top: Math.floor(i / 3) * 424 })));
            await sharp({ create: { width: 1800, height: Math.ceil(files.length / 3) * 424, channels: 3, background: '#ffffff' } }).composite(thumbs).png().toFile(join(directory, 'overview.png'));
            const detail = join(directory, 'detail');
            await mkdir(detail);
            await runProcessChecked(cli.path, ['sch', 'export', 'svg', '--exclude-drawing-sheet', '-o', detail, this.path()]);
            for (const f of files) {
                const svg = await readFile(join(detail, f));
                try {
                    const raster = await sharp(svg, { density: 160 }).flatten({ background: '#F5F4EF' }).png().toBuffer();
                    const cropped = await sharp(raster).trim({ background: '#F5F4EF', threshold: 15 }).extend({ top: 20, bottom: 20, left: 20, right: 20, background: '#F5F4EF' }).png().toBuffer();
                    await sharp(cropped).resize({ width: 1800, height: 1500, fit: 'inside', withoutEnlargement: true }).png().toFile(join(detail, f.replace(/\.svg$/, '.png')));
                }
                catch { await sharp(svg).resize(600).png().toFile(join(detail, f.replace(/\.svg$/, '.png'))); }
            }
        }
        this.snapshots.push(label);
        await this.report();
        console.log(`verified ${this.name}/${label}: ${physical} components, ${seen.size} pins, ${instanceFiles.size} sheet instances`);
        assert.deepEqual(layoutErrors, [], 'invalid placement geometry');
    }
    async report() {
        await writeFile(join(this.directory, 'index.html'), `<!doctype html><meta charset="utf-8"><title>${escape(this.name)}</title><style>body{font:16px system-ui;margin:2rem}img{max-width:100%}a{display:inline-block;margin:1rem}</style><h1>${escape(this.name)}</h1><a href="main.kicad_pro">KiCad project</a>${this.snapshots.map(s => `<h2>${escape(s)}</h2><a href="${s}/netlist.xml">KiCad netlist</a><a href="${s}/oracle.json">Checks</a><a href="${s}/detail/main.png">Root close-up</a><img src="${s}/overview.png">`).join('')}`);
    }
}
async function scenario(name: string, run: (p: Project) => Promise<void>) {
    if (process.env.KICAD_MATRIX_CASE && !process.env.KICAD_MATRIX_CASE.split(',').some(filter => name.includes(filter.trim()))) return;
    const p = new Project(name);
    try { await p.create(); await run(p); results.push({ name, status: 'passed', directory: p.directory }); }
    catch (e) { const details = e instanceof Error ? e.stack ?? e.message : String(e); results.push({ name, status: 'failed', details, directory: p.directory }); console.error(`FAILED ${name}: ${details}`); }
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
    await writeFile(join(output, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Schematic matrix</title><style>body{font:16px system-ui;margin:2rem}li{margin:1rem}pre{white-space:pre-wrap}</style><h1>Schematic matrix</h1><ul>${results.map(r => `<li><a href="${r.name}/index.html">${escape(r.name)}</a>: ${r.status}${r.details ? `<pre>${escape(r.details)}</pre>` : ''}</li>`).join('')}</ul>`);
}

try {
    await scenario('buck-controller-vin', async p => {
        await p.child('buck', 'main');
        await p.modify('buck', [
            add('U1', '2e6cd0fdb8d74fc78dfca927dec3a2fb', {
                '1': 'hier_passive:buck:GND', '2': 'local:buck:SW', '3': 'hier_input:buck:VIN',
                '4': 'local:buck:FB', '5': 'hier:buck:VIN', '6': 'local:buck:BOOT',
            }, 'Controller', 'TPS54302DDCR'),
            add('C1', ids.cap, { '1': 'hier:buck:VIN', '2': 'hier:buck:GND' }, 'Input'),
            add('C2', ids.cap, { '1': 'local:buck:BOOT', '2': 'local:buck:SW' }, 'Bootstrap'),
            add('C3', ids.cap, { '1': 'local:buck:FB', '2': 'hier:buck:GND' }, 'Feedback'),
        ]);
        await p.modify('main', [p.sheet('CH1', 'buck', { VIN: 'VIN', GND: 'GND' }),
            p.sheet('CH2', 'buck', { VIN: 'VIN', GND: 'GND' })], { rm_components: ['buck'] });
        await p.verify('01-created');
        await p.pretty('buck'); await p.verify('02-full-rebuild');
        await p.pretty('buck', { Controller: ['U1'] }); await p.verify('03-controller-only-rebuild');
        const result = await p.call('get_schematic', { path: p.path('buck') });
        assert.equal(result.components.find((c: any) => c.designator === 'U1').pins.find((p: any) => p.pin_number === '3').signal_name,
            'hier_input:buck:VIN', 'controller VIN must never become an automatically named disconnected net');
    });
    await scenario('nested-ldo', async p => {
        await p.child('power', 'main');
        await p.ldo('ldo', 'power');
        await p.modify('power', [p.sheet('LDO_A', 'ldo', { VIN: 'hier:power:VIN', OUT: 'hier:power:OUT_A' }),
            p.sheet('LDO_B', 'ldo', { VIN: 'hier:power:VIN', OUT: 'hier:power:OUT_B' })], { rm_components: ['ldo'] });
        await p.modify('main', [p.sheet('PWR_A', 'power', { VIN: 'local:ROOT:VIN_A', OUT_A: 'local:ROOT:OUT_A', OUT_B: 'local:ROOT:OUT_B' }),
            p.sheet('PWR_B', 'power', { VIN: 'local:ROOT:VIN_B', OUT_A: 'local:ROOT:OUT_C', OUT_B: 'local:ROOT:OUT_D' }),
            ...['VIN_A', 'VIN_B', 'OUT_A', 'OUT_B', 'OUT_C', 'OUT_D'].map((n, i) => add(`J${i + 1}`, ids.connector, { '1': `local:ROOT:${n}`, '2': 'GND' }))], { rm_components: ['power'] });
        await p.verify('01-created');
        for (const page of ['ldo', 'power', 'main']) await p.pretty(page);
        await p.verify('02-beautified');
        await p.pretty('power', { First: ['LDO_A'] });
        await p.verify('03-partial-layout');
        await p.modify('main', [], { external_rm_connect: [{ designator: 'PWR_A', pin_number: 'OUT_B' }],
            external_connect: [{ designator: 'PWR_A', pin_number: 'OUT_B', signal_name: 'local:ROOT:REWIRED' }] });
        await p.verify('04-rewired');
        await p.modify('main', [], { rm_components: ['PWR_B'] });
        await p.verify('05-instance-removed');
        await p.modify('main', [p.sheet('PWR_C', 'power', { VIN: 'local:ROOT:VIN_B', OUT_A: 'local:ROOT:OUT_C', OUT_B: 'local:ROOT:OUT_D' })]);
        await p.verify('06-instance-restored');
        for (const [change, message] of [
            [{ add_components: [add('BAD', ids.connector, { '1': 'local:power:VIN', '2': 'GND' })] }, /another sheet/],
            [{ add_components: [p.sheet('BAD', 'power', { MISSING: 'GND' })] }, /unknown pin/],
            [{ rm_components: ['NOT_HERE'] }, /not on target page/],
            [{ external_connect: [{ designator: 'PWR_A', pin_number: 'MISSING', signal_name: 'GND' }] }, /pin not on target/],
            [{ add_components: [p.sheet('PWR_A', 'power', {})] }, /already exists/],
            [{ add_components: [p.sheet('DUP', 'power', {}), p.sheet('DUP', 'power', {})] }, /duplicate/],
            [{ add_components: [add('BAD', ids.connector, { '1': 'hier:LDO_A:VIN', '2': 'GND' })] }, /not on this page/],
        ] as [Partial<CircuitMod>, RegExp][]) await p.rejects('main', change, message);
        await p.rejects('power', { add_components: [p.sheet('SELF', 'power', {})] }, /descendant/);
        await p.rejects('ldo', { add_components: [p.sheet('CYCLE', 'main', {})] }, /descendant/);
        await p.verify('07-after-rejections');
    });
    for (const reversed of [false, true]) await scenario(`sibling-links-${reversed ? 'reverse' : 'forward'}`, async p => {
        await p.ldo('ldo', 'main');
        const sheets = [p.sheet('LDO_A', 'ldo', { VIN: 'local:ROOT:VIN', OUT: 'local:ROOT:MID' }),
            p.sheet('LDO_B', 'ldo', { VIN: 'hier:LDO_A:OUT', OUT: 'local:ROOT:OUT' })];
        await p.modify('main', [...(reversed ? sheets.reverse() : sheets), add('J1', ids.connector, { '1': 'hier:LDO_B:OUT', '2': 'GND' })], { rm_components: ['ldo'] });
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
    });
    await scenario('sibling-alias-chain', async p => {
        await p.ldo('ldo', 'main');
        await p.modify('main', [
            p.sheet('A', 'ldo', { VIN: 'VIN', OUT: 'hier:B:VIN' }),
            p.sheet('B', 'ldo', { VIN: 'hier:C:VIN', OUT: 'local:ROOT:B_OUT' }),
            p.sheet('C', 'ldo', { VIN: '', OUT: 'local:ROOT:C_OUT' }),
            add('J1', ids.connector, { '1': 'hier:A:OUT', '2': 'GND' }),
        ], { rm_components: ['ldo'] });
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
    });
    await scenario('sibling-alias-cycle', async p => {
        await p.ldo('ldo', 'main');
        await p.modify('main', [p.sheet('A', 'ldo', { VIN: 'VIN', OUT: 'hier:B:VIN' }),
            p.sheet('B', 'ldo', { VIN: 'hier:A:OUT', OUT: 'local:ROOT:OUT' }),
            add('J1', ids.connector, { '1': 'hier:A:OUT', '2': 'GND' })], { rm_components: ['ldo'] });
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
    });
    await scenario('native-and-signal-names', async p => {
        const uuid = await p.native('native');
        await p.modify('main', [
            add('R10', uuid, { '1': 'local:ROOT:VIN/SENSE:A~B', '2': 'global:NC' }),
            add('R11', uuid, { '1': 'NC', '2': 'global:global:raw:name' }),
            add('R12', uuid, { '1': 'GLOBAL_SHARED', '2': 'global:GLOBAL_SHARED' }),
            add('C1', ids.cap, { '1': 'local:ROOT:VIN/SENSE:A~B', '2': 'global:ПИТАНИЕ +5В' }),
            add('C2', ids.cap, { '1': 'my:signal:name', '2': 'global:global:raw:name' }),
        ]);
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
        const nativeSymbols = nativeInstances(await readFile(p.path(), 'utf8')).filter(n => n.reference.startsWith('R'));
        assert.ok(nativeSymbols.every(s => nativeProperty(s.instance, 'Custom') === 'preserve me'));
        await p.modify('main', [], { external_connect: [{ designator: 'C1', pin_number: '1', signal_name: 'local:ROOT:VIN/SENSE:A~B' }] });
        await p.verify('03-idempotent-connect');
        await p.modify('main', [], { external_rm_connect: [{ designator: 'R10', pin_number: '1' }] });
        await p.modify('main', [], { external_rm_connect: [{ designator: 'R10', pin_number: '1' }] });
        await p.verify('04-idempotent-disconnect');
        await p.rejects('main', { add_components: [add('BAD', uuid, { '1': 'local:native:VIN', '2': 'GND' })] }, /another sheet/);
        await p.rejects('main', { add_components: [add('BAD', uuid, { '1': 'local:ROOT:SAME', '2': 'SAME' })] }, /collision/);
        for (const name of ['local:', 'hier::IN', 'global:']) await p.rejects('main', { add_components: [add('BAD', uuid, { '1': name, '2': 'GND' })] }, /invalid|empty/);
        const duplicate = add('BAD', uuid, { '1': 'GND' }); duplicate.pins.push({ ...duplicate.pins[0] });
        await p.rejects('main', { add_components: [duplicate] }, /duplicate pin/);
        await p.verify('05-after-rejections');
    });
    await scenario('nested-folders-with-spaces', async p => {
        await p.child('sub folder/power', 'main'); await p.ldo('sub folder/ldo', 'sub folder/power');
        await p.modify('sub folder/power', [p.sheet('REGULATOR', 'sub folder/ldo', { VIN: 'hier:sub folder/power:VIN', OUT: 'hier:sub folder/power:OUT' })], { rm_components: ['ldo'] });
        await p.modify('main', [p.sheet('POWER', 'sub folder/power', { VIN: 'VIN', OUT: 'local:ROOT:OUT' }),
            add('J1', ids.connector, { '1': 'hier:POWER:OUT', '2': 'GND' })], { rm_components: ['power'] });
        await p.verify('01-created'); await p.pretty('sub folder/power'); await p.pretty('main'); await p.verify('02-beautified');
    });
    await scenario('depth-four-and-mixed-reuse', async p => {
        await p.child('subsystem', 'main'); await p.child('power', 'subsystem'); await p.ldo('ldo', 'power');
        await p.modify('power', [p.sheet('LDO', 'ldo', { VIN: 'hier:power:VIN', OUT: 'hier:power:OUT' })], { rm_components: ['ldo'] });
        await p.modify('subsystem', [p.sheet('POWER_A', 'power', { VIN: 'hier:subsystem:VIN', OUT: 'hier:subsystem:OUT_A' }),
            p.sheet('POWER_B', 'power', { VIN: 'hier:subsystem:VIN', OUT: 'hier:subsystem:OUT_B' })], { rm_components: ['power'] });
        await p.modify('main', [p.sheet('SYS_A', 'subsystem', { VIN: '+5V', OUT_A: 'local:ROOT:A1', OUT_B: 'local:ROOT:A2' }),
            p.sheet('SYS_B', 'subsystem', { VIN: 'global:+5V', OUT_A: 'local:ROOT:B1', OUT_B: 'local:ROOT:B2' }),
            p.sheet('DIRECT', 'ldo', { VIN: '+5V', OUT: 'local:ROOT:DIRECT' }),
            ...['A1', 'A2', 'B1', 'B2', 'DIRECT'].map((net, i) => add(`J${i + 1}`, ids.connector, { '1': `local:ROOT:${net}`, '2': 'GND' }))], { rm_components: ['subsystem'] });
        await p.verify('01-created');
        for (const page of ['ldo', 'power', 'subsystem', 'main']) await p.pretty(page);
        await p.verify('02-beautified');
        await p.modify('ldo', [add('C3', ids.cap, { '1': 'hier:ldo:MONITOR/SENSE:A~B', '2': 'local:ldo:MON_RETURN' })]);
        await p.verify('03-port-added-to-all-instances');
        await p.modify('power', [add('JMON', ids.connector, { '1': 'hier:LDO:MONITOR/SENSE:A~B', '2': 'GND' })]);
        await p.verify('04-new-port-connected');
        await p.modify('main', [add('JMON', ids.connector, { '1': 'hier:DIRECT:MONITOR/SENSE:A~B', '2': 'GND' })]);
        await p.verify('05-same-port-at-other-depth');
    });
    await scenario('empty-and-unconnected-ports', async p => {
        await p.child('empty', 'main'); await p.ldo('ldo', 'main');
        await p.modify('main', [p.sheet('EMPTY_A', 'empty', {}), p.sheet('EMPTY_B', 'empty', {}),
            p.sheet('FLOAT', 'ldo', {}), p.sheet('NC_SHEET', 'ldo', { VIN: 'NC', OUT: 'NC' }),
            p.sheet('REAL_NC', 'ldo', { VIN: 'global:NC', OUT: 'local:ROOT:OUT' })], { rm_components: ['empty', 'ldo'] });
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
        await p.modify('main', [], { external_connect: [{ designator: 'FLOAT', pin_number: 'VIN', signal_name: 'VIN' }] });
        p.pages.get('main')!.parts.find(c => c.ref === 'FLOAT')!.nets.VIN = 'VIN';
        await p.verify('03-floating-port-connected');
        await p.modify('main', [], { external_rm_connect: [{ designator: 'FLOAT', pin_number: 'VIN' }] });
        await p.verify('04-port-disconnected');
    });
    await scenario('remove-last-internal-components', async p => {
        await p.ldo('ldo', 'main');
        await p.modify('main', [p.sheet('REG', 'ldo', { VIN: 'VIN', OUT: 'local:ROOT:OUT' }),
            add('J1', ids.connector, { '1': 'hier:REG:OUT', '2': 'GND' })], { rm_components: ['ldo'] });
        await p.verify('01-created');
        await p.modify('ldo', [], { rm_components: ['U1', 'C1', 'C2'] });
        await p.verify('02-empty-interface-preserved');
        const parent = await p.call('get_schematic', { path: p.path() });
        assert.deepEqual(parent.components.find((c: any) => c.designator === 'REG').pins.map((pin: any) => pin.name).sort(), ['OUT', 'VIN']);
        await p.modify('ldo', [add('C3', ids.cap, { '1': 'hier:ldo:OUT', '2': 'GND' })]);
        await p.verify('03-interface-reconnected');
    });
    for (const count of [1, 16]) await scenario(`port-count-${count}`, async p => {
        await p.child('ports', 'main');
        const names = Array.from({ length: count }, (_, i) => count === 1 ? 'ONLY' : `PORT_${String(i).padStart(2, '0')}_LONG_NAME/SENSE:A~B`);
        const caps = names.map((name, i) => add(`C${i + 1}`, ids.cap, { '1': `hier:ports:${name}`, '2': 'GND' }, `Port_${i}`));
        await p.modify('ports', caps);
        // A user-authored KiCad sheet may specify all supported electrical port shapes.
        const source = await readFile(p.path('ports'), 'utf8');
        const shapes = ['input', 'output', 'bidirectional', 'tri_state', 'passive'];
        let index = 0;
        await writeFile(p.path('ports'), source.replace(/(\(hierarchical_label\s+"[^"]+"\s+\(shape\s+)bidirectional/g, (_, prefix) => `${prefix}${shapes[index++ % shapes.length]}`));
        const nets = Object.fromEntries(names.map((n, i) => [n, `local:ROOT:SIGNAL_${i}`]));
        await p.modify('main', [p.sheet('PORTS_A', 'ports', nets),
            ...names.map((n, i) => add(`J${i + 1}`, ids.connector, { '1': `hier:PORTS_A:${n}`, '2': 'GND' }, `Port_${i}`))], { rm_components: ['ports'] });
        await p.verify('01-created'); await p.pretty('main'); await p.verify('02-beautified');
    });
    for (const count of [1, 8, 32]) await scenario(`scale-${String(count).padStart(2, '0')}`, async p => {
        await p.ldo('ldo', 'main');
        if (count >= 8) await writeFile(p.path(), (await readFile(p.path(), 'utf8')).replace('(paper "A4")', `(paper "${count > 8 ? 'A2' : 'A3'}")`));
        const parts: CircuitMod['add_components'] = [add('JIN', ids.connector, { '1': 'local:ROOT:VIN', '2': 'GND' }, 'Input')];
        const blocks: Record<string, string[]> = { Input: ['JIN'] };
        for (let i = 1; i <= count; i++) {
            const block = `Channel_${i}`;
            parts.push(p.sheet(`LDO_${i}`, 'ldo', { VIN: 'local:ROOT:VIN', OUT: `local:ROOT:OUTPUT_${i}` }, block),
                add(`J${i}`, ids.connector, { '1': `hier:LDO_${i}:OUT`, '2': 'GND' }, block));
            blocks[block] = [`LDO_${i}`, `J${i}`];
        }
        await p.modify('main', parts, { rm_components: ['ldo'] });
        await p.verify('01-created'); await p.pretty('main', blocks); await p.verify('02-beautified');
    });
} finally { await client.close(); }
console.log(JSON.stringify(results.map(r => ({ name: r.name, status: r.status })), null, 2));
if (results.some(r => r.status === 'failed')) process.exitCode = 1;
