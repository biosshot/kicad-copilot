import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

await mkdir(resolve('.test-output'), {recursive:true});
const dir=await mkdtemp(resolve('.test-output/native-pcb-instances-'));
process.env.KICAD_COPILOT_CACHE_DIR=join(dir,'cache');
const root=randomUUID(), sheetA=randomUUID(), sheetB=randomUUID(), sheetC=randomUUID();
const uidA=randomUUID(), uidB=randomUUID();
const head=id=>`(kicad_sch (version 20250114) (generator "eeschema") (uuid "${id}") (paper "A4")`;
const resistor=`(symbol "Device:R" (pin_names (offset 0)) (in_bom yes) (on_board yes)
  (property "Reference" "R" (at 0 2.54 0) (effects (font (size 1.27 1.27))))
  (property "Value" "R" (at 0 -2.54 0) (effects (font (size 1.27 1.27))))
  (symbol "R_0_1" (rectangle (start -1.27 1.27) (end 1.27 -1.27) (stroke (width 0) (type default)) (fill (type none))))
  (symbol "R_1_1" (pin passive line (at -2.54 0 0) (length 1.27) (name "1" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
  (pin passive line (at 2.54 0 180) (length 1.27) (name "2" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
const effect='(effects (font (size 1.27 1.27)))';
function sheet(name,file,id,page) { return `(sheet (at 20 20) (size 20 20) (stroke (width 0) (type solid)) (fill (color 0 0 0 0)) (uuid "${id}") (property "Sheetname" "${name}" (at 20 18 0) ${effect}) (property "Sheetfile" "${file}" (at 20 42 0) ${effect}) (instances (project "main" (path "/${root}" (page "${page}")))))`; }
function leaf(id,footprint,instances,dnp) { return `${head(randomUUID())} (lib_symbols ${resistor}) (symbol (lib_id "Device:R") (at 50 50 0) (unit 1) (in_bom yes) (on_board yes) (dnp ${dnp?'yes':'no'}) (uuid "${id}") (property "Reference" "R1" (at 50 48 0) ${effect}) (property "Value" "1k" (at 50 52 0) ${effect}) (property "Footprint" "${footprint}" (at 0 0 0) ${effect}) (instances (project "main" ${instances.map(([path,ref])=>`(path "/${root}/${path}" (reference "${ref}") (unit 1))`).join(' ')}))))`; }
try {
  await writeFile(join(dir,'main.kicad_pro'),'{}');
  await writeFile(join(dir,'main.kicad_sch'),`${head(root)} (lib_symbols) ${sheet('A','a.kicad_sch',sheetA,2)} ${sheet('B','b.kicad_sch',sheetB,3)} ${sheet('C','a.kicad_sch',sheetC,4)} (sheet_instances (path "/" (page "1"))))`);
  await writeFile(join(dir,'a.kicad_sch'),leaf(uidA,'Test:One',[[sheetA,'R1'],[sheetC,'R2']],false));
  await writeFile(join(dir,'b.kicad_sch'),leaf(uidB,'Test:Two',[[sheetB,'R3']],true));
  const bundle=join(dir,'reader.mjs');
  await build({entryPoints:[resolve('src/kicad/schematic-reader.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',banner:{js:"import {createRequire} from 'node:module'; const require=createRequire(import.meta.url);"},logLevel:'silent'});
  const {getPcbSchematic}=await import(pathToFileURL(bundle));
  const result=await getPcbSchematic(join(dir,'main.kicad_sch'));
  const byRef=new Map(result.components.map(c=>[c.designator,c]));
  assert.deepEqual([...byRef.keys()].sort(),['R1','R2','R3']);
  assert.equal(byRef.get('R1').footprint_name,'Test:One');
  assert.equal(byRef.get('R2').footprint_name,'Test:One');
  assert.equal(byRef.get('R3').footprint_name,'Test:Two');
  assert.equal(byRef.get('R3').dnp,true);
  assert.equal(byRef.get('R1').dnp,false);
  assert.equal(byRef.get('R1').identity,`/${sheetA}/${uidA}`);
  assert.equal(byRef.get('R2').identity,`/${sheetC}/${uidA}`);
  assert.equal(byRef.get('R3').identity,`/${sheetB}/${uidB}`);
  // An excluded symbol is absent from KiCad's netlist but must retain its
  // project instance identity and reference for removal from an existing PCB.
  await writeFile(join(dir,'b.kicad_sch'),leaf(uidB,'Test:Two',[[sheetB,'R3']],true)
    .replace('(unit 1) (in_bom yes) (on_board yes)', '(unit 1) (in_bom yes) (on_board no)'));
  const excluded=(await getPcbSchematic(join(dir,'main.kicad_sch'))).components.find(c=>c.designator==='R3');
  assert.equal(excluded?.on_board,false);
  assert.equal(excluded?.identity,`/${sheetB}/${uidB}`);
  console.log('PASS native repeated sheet identities and distinct physical R1 references');
} finally { await rm(dir,{recursive:true,force:true}); }
