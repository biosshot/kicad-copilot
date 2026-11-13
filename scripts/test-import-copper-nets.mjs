import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// Compact KiCad fixture: two pads on OLD, connected by an OLD segment;
// the associated schematic labels the same connected pins NEW.
const board = "(kicad_pcb (version 20260206) (generator \"kicad-copilot\") (generator_version \"10.0\") (general (thickness 1.6)) (paper \"A4\") (layers (0 \"F.Cu\" signal) (2 \"B.Cu\" signal) (9 \"F.Adhes\" user \"F.Adhesive\") (11 \"B.Adhes\" user \"B.Adhesive\") (13 \"F.Paste\" user) (15 \"B.Paste\" user) (5 \"F.SilkS\" user \"F.Silkscreen\") (7 \"B.SilkS\" user \"B.Silkscreen\") (1 \"F.Mask\" user) (3 \"B.Mask\" user) (17 \"Dwgs.User\" user \"User.Drawings\") (19 \"Cmts.User\" user \"User.Comments\") (21 \"Eco1.User\" user \"User.Eco1\") (23 \"Eco2.User\" user \"User.Eco2\") (25 \"Edge.Cuts\" user) (27 \"Margin\" user) (31 \"F.CrtYd\" user \"F.Courtyard\") (29 \"B.CrtYd\" user \"B.Courtyard\") (35 \"F.Fab\" user) (33 \"B.Fab\" user)) (setup (pad_to_mask_clearance 0)) (footprint \"Test:R_0603\" (version 20240108) (generator \"pcbnew\") (layer \"F.Cu\") (property \"Reference\" \"R1\" (at 0 -2) (layer \"F.SilkS\") (effects (font (size 1 1) (thickness 0.15)))) (property \"Value\" \"1k\" (at 0 2) (layer \"F.Fab\") (effects (font (size 1 1) (thickness 0.15))) (hide yes)) (pad \"1\" smd rect (at -0.7 0) (size 0.6 0.8) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\")) (pad \"2\" smd rect (at 0.7 0) (size 0.6 0.8) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (net \"OLD\")) (at 20 20 0) (property \"EasyEDA part_uuid\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"d1fd7bff-175e-4cde-a277-fce021cf5b0f\") (effects (font (size 1 1)))) (property \"EasyEDA footprint_uuid\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"270b7783-40c2-44c9-bc88-c5a06cf4bbdd\") (effects (font (size 1 1)))) (property \"Block Name\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"affa95e1-95da-4884-8acb-4d631645db69\") (effects (font (size 1 1)))) (path \"/41ba87b4-b391-4994-b9f8-e99b096744f9\") (sheetname \"/\") (sheetfile \"main.kicad_sch\") (attr)) (footprint \"Test:R_0603\" (version 20240108) (generator \"pcbnew\") (layer \"F.Cu\") (property \"Reference\" \"R2\" (at 0 -2) (layer \"F.SilkS\") (effects (font (size 1 1) (thickness 0.15)))) (property \"Value\" \"1k\" (at 0 2) (layer \"F.Fab\") (effects (font (size 1 1) (thickness 0.15))) (hide yes)) (pad \"1\" smd rect (at -0.7 0) (size 0.6 0.8) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\") (net \"OLD\")) (pad \"2\" smd rect (at 0.7 0) (size 0.6 0.8) (layers \"F.Cu\" \"F.Paste\" \"F.Mask\")) (at 25 20 0) (property \"EasyEDA part_uuid\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"351e5c1d-3b1c-4386-a4cd-5a60faa7b5bf\") (effects (font (size 1 1)))) (property \"EasyEDA footprint_uuid\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"c6ba9394-6055-490c-bfde-5dabd73ef75b\") (effects (font (size 1 1)))) (property \"Block Name\" \"\" (at 0 0 0) (layer \"F.Fab\") (hide yes) (uuid \"2e40def6-5afb-46f9-8357-91d6ebe52591\") (effects (font (size 1 1)))) (path \"/5779bd31-5f14-4c27-941e-f5a57461dd9c\") (sheetname \"/\") (sheetfile \"main.kicad_sch\") (attr)) (segment (start 20.7 20) (end 24.3 20) (width 0.25) (layer \"F.Cu\") (net \"OLD\") (uuid \"33333333-3333-4333-8333-333333333333\")) (gr_rect (start 15 15) (end 30 25) (stroke (width 0.05) (type default)) (fill none) (layer \"Edge.Cuts\") (uuid \"44444444-4444-4444-8444-444444444444\")))";
const schematic = "(kicad_sch (version 20250114) (generator \"eeschema\") (uuid \"989add5f-4f26-4355-9277-26baf9d718ff\") (paper \"A4\") (lib_symbols (symbol \"Device:R\" (pin_names (offset 0)) (in_bom yes) (on_board yes)\n      (property \"Reference\" \"R\" (at 0 2.54 0) (effects (font (size 1.27 1.27))))\n      (property \"Value\" \"R\" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))\n      (symbol \"R_0_1\" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))\n      (symbol \"R_1_1\" (pin passive line (at -2.54 0 0) (length 1.27) (name \"1\" (effects (font (size 1.27 1.27)))) (number \"1\" (effects (font (size 1.27 1.27)))))\n      (pin passive line (at 2.54 0 180) (length 1.27) (name \"2\" (effects (font (size 1.27 1.27)))) (number \"2\" (effects (font (size 1.27 1.27)))))))) (symbol (lib_id \"Device:R\") (at 50 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid \"41ba87b4-b391-4994-b9f8-e99b096744f9\")\n      (property \"Reference\" \"R1\" (at 50 48 0) (effects (font (size 1.27 1.27))))\n      (property \"Value\" \"1k\" (at 50 52 0) (effects (font (size 1.27 1.27))))\n      (property \"Footprint\" \"Test:R_0603\" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n      (instances (project \"main\" (path \"/989add5f-4f26-4355-9277-26baf9d718ff\" (reference \"R1\") (unit 1)))))\n(symbol (lib_id \"Device:R\") (at 65 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp no) (uuid \"5779bd31-5f14-4c27-941e-f5a57461dd9c\")\n      (property \"Reference\" \"R2\" (at 65 48 0) (effects (font (size 1.27 1.27))))\n      (property \"Value\" \"1k\" (at 65 52 0) (effects (font (size 1.27 1.27))))\n      (property \"Footprint\" \"Test:R_0603\" (at 0 0 0) (effects (font (size 1.27 1.27)) (hide yes)))\n      (instances (project \"main\" (path \"/989add5f-4f26-4355-9277-26baf9d718ff\" (reference \"R2\") (unit 1))))) (sheet_instances (path \"/\" (page \"1\"))) (wire (pts (xy 52.54 50) (xy 62.46 50)) (stroke (width 0) (type default)) (uuid \"11111111-1111-4111-8111-111111111111\")) (label \"NEW\" (at 52.54 50 0) (effects (font (size 1.27 1.27)) (justify left bottom)) (uuid \"22222222-2222-4222-8222-222222222222\")))";
await mkdir(resolve('.test-output'), {recursive:true});
const dir = await mkdtemp(resolve('.test-output/kicad-import-copper-'));
process.env.KICAD_COPILOT_CACHE_DIR = join(dir, 'cache');
try {
  const bundle = join(dir, 'import.mjs');
  await build({entryPoints:[resolve('src/pcb/import.ts')], outfile:bundle, bundle:true, platform:'node', format:'esm', banner:{js:"import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);"}, logLevel:'silent'});
  const {importPcbChanges} = await import(pathToFileURL(bundle));
  async function run(name, pcb, sch, shouldReject) {
    const folder = join(dir,name); await mkdir(folder);
    const path = join(folder,'main.kicad_pcb');
    await writeFile(path,pcb); await writeFile(join(folder,'main.kicad_sch'),sch);
    if (shouldReject) {
      await assert.rejects(importPcbChanges(path), /PCB_IMPORT_AMBIGUOUS_COPPER_NET/);
      assert.equal(await readFile(path,'utf8'),pcb,`${name} must not write on ambiguity`);
    } else {
      await importPcbChanges(path);
      const after = await readFile(path,'utf8');
      assert.match(after, /\(segment[^]*?\(net "NEW"\)/);
      assert.doesNotMatch(after, /\(net "OLD"\)/);
      if (name === 'rename') {
        for (const kind of ['segment', 'via', 'arc', 'zone']) {
          assert.match(after, new RegExp(`\\(${kind}[^]*?\\(net "NEW"\\)`), kind);
        }
        assert.match(after, /\(net_name "NEW"\)/);
      }
      await importPcbChanges(path);
      assert.equal(await readFile(path,'utf8'),after,'repeat import should be idempotent');
    }
  }
  const extended = board.slice(0,-1)
    + ' (via (at 22 20) (size 0.6) (drill 0.3) (layers "F.Cu" "B.Cu") (net "OLD"))'
    + ' (arc (start 21 20) (mid 21.5 19.5) (end 22 20) (width 0.25) (layer "F.Cu") (net "OLD"))'
    + ' (zone (net "OLD") (net_name "OLD") (layer "B.Cu") (hatch edge 0.5) (polygon (pts (xy 16 16) (xy 19 16) (xy 19 19) (xy 16 19)))))';
  await run('rename',extended,schematic,false);
  const wire = /\(wire \(pts \(xy 52\.54 50\) \(xy 62\.46 50\)\) \(stroke \(width 0\) \(type default\)\) \(uuid "11111111-1111-4111-8111-111111111111"\)\)/;
  assert.match(schematic,wire);
  await run('split',board,schematic.replace(wire,''),true);
  let legacyCount=0;
  let legacy=board.replace('(version 20260206)','(version 20240108)')
    .replace('(paper "A4")','(paper "A4") (net 1 "OLD")')
    .replace(/\(net "OLD"\)/g, () => ++legacyCount <= 2 ? '(net 1 "OLD")' : '(net 1)');
  legacy=legacy.slice(0,-1)+' (zone (net 1) (net_name "OLD") (layer "B.Cu") (hatch edge 0.5) (polygon (pts (xy 16 16) (xy 19 16) (xy 19 19) (xy 16 19)))))';
  const legacyFolder=join(dir,'legacy'); await mkdir(legacyFolder);
  const legacyPath=join(legacyFolder,'main.kicad_pcb');
  await writeFile(legacyPath,legacy); await writeFile(join(legacyFolder,'main.kicad_sch'),schematic);
  await importPcbChanges(legacyPath);
  const legacyAfter=await readFile(legacyPath,'utf8');
  assert.match(legacyAfter,/\(net 2 "NEW"\)/);
  assert.match(legacyAfter,/\(segment[^]*?\(net 2\)/);
  assert.match(legacyAfter,/\(zone \(net 2\) \(net_name "NEW"\)/);
  let count=0;
  const merged=board.replace(/\(net "OLD"\)/g, x => ++count === 2 ? '(net "OTHER")' : x);
  assert.equal(count,3);
  await run('merge',merged,schematic,true);
  console.log('PASS import copper rename, split, merge, atomic refusal and repeat');
} finally { await rm(dir,{recursive:true,force:true}); }







