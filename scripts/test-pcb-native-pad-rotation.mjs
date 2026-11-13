import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const cli=process.env.KICAD_CLI_PATH;
assert.ok(cli,'set KICAD_CLI_PATH to the native KiCad CLI');
await mkdir(resolve('.test-output'),{recursive:true});
const dir=await mkdtemp(resolve('.test-output/pcb-pad-rotation-'));
try {
  const bundle=join(dir,'assemble.mjs');
  await build({stdin:{contents:`export {applyBoardAssemble,setFootprintAt} from './src/kicad/board-assemble'; export {parseSExpression,printSExpression} from './src/kicad/sexpr/ast';`,resolveDir:resolve('.'),loader:'ts'},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'});
  const {applyBoardAssemble,setFootprintAt,parseSExpression,printSExpression}=await import(pathToFileURL(bundle));
  for (const version of [20240108,20260206]) {
    const legacy=version<20250000;
    const net=(n)=>legacy?`(net ${n} "N${n}")`:`(net "N${n}")`;
    const rootNets=legacy?Array.from({length:8},(_,i)=>`(net ${i+1} "N${i+1}")`).join(' '):'';
    const footprints=Array.from({length:4},(_,i)=>`(footprint "kicad-copilot:QFN" (layer "F.Cu")
      (property "Reference" "U${i+1}" (at 0 -3 0) (layer "F.SilkS") (effects (font (size 1 1) (thickness 0.15))))
      (property "EasyEDA part_uuid" "fixture" (at 0 0 0) (layer "F.Fab") (effects (font (size 1 1))))
      (pad "1" smd rect (at -1.5 -0.25 0) (size 0.8 0.28) (layers "F.Cu" "F.Paste" "F.Mask") ${net(i*2+1)})
      (pad "2" smd rect (at -1.5 0.25 0) (size 0.8 0.28) (layers "F.Cu" "F.Paste" "F.Mask") ${net(i*2+2)})
      (at ${20+i*8} 30 0))`).join(' ');
    const board=parseSExpression(`(kicad_pcb (version ${version}) (generator "pcbnew") (general (thickness 1.6)) (paper "A4") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (37 "F.SilkS" user) (39 "F.Mask" user) (35 "F.Paste" user) (49 "F.Fab" user)) (setup (pad_to_mask_clearance 0)) ${rootNets} ${footprints} (gr_rect (start 10 20) (end 60 40) (stroke (width 0.05) (type default)) (fill none) (layer "Edge.Cuts")))`);
    const placement={components:[0,90,180,270].map((rotate,i)=>({designator:`U${i+1}`,x:20+i*8,y:-30,rotate,layer:'top'}))};
    applyBoardAssemble(board,version,placement);
    const text=printSExpression(board);
    const parts=text.split('(footprint ').slice(1);
    assert.equal(parts.length,4);
    for(const part of parts) assert.ok(part.indexOf('(at ') < part.indexOf('(pad '),'parent transform precedes pads');
    applyBoardAssemble(board,version,placement);
    assert.equal(printSExpression(board),text,'reapplying placement must be idempotent');
    const filename=join(dir,`board-${version}.kicad_pcb`),report=join(dir,`drc-${version}.json`);
    await writeFile(filename,text);
    const run=spawnSync(cli,['pcb','drc','--format','json','-o',report,filename],{encoding:'utf8',timeout:60000});
    assert.equal(run.status,0,run.stderr);
    const result=JSON.parse(await readFile(report,'utf8'));
    const shorts=result.violations.filter(v=>v.type==='shorting_items');
    assert.deepEqual(shorts,[],`KiCad ${version} detected pad shorts`);
    // Reproduce the former ordering: changing only the order of the parent
    // transform must make native KiCad detect the overlapping QFN pads.
    const broken=parseSExpression(text);
    for (const footprint of broken.filter(x=>Array.isArray(x) && x[0]?.value==='footprint')) {
      const index=footprint.findIndex(x=>Array.isArray(x) && x[0]?.value==='at');
      footprint.push(footprint.splice(index,1)[0]);
    }
    const brokenFile=join(dir,`broken-${version}.kicad_pcb`), brokenReport=join(dir,`broken-${version}.json`);
    await writeFile(brokenFile,printSExpression(broken));
    const brokenRun=spawnSync(cli,['pcb','drc','--format','json','-o',brokenReport,brokenFile],{encoding:'utf8',timeout:60000});
    assert.equal(brokenRun.status,0,brokenRun.stderr);
    const brokenDrc=JSON.parse(await readFile(brokenReport,'utf8'));
    assert.ok(brokenDrc.violations.some(v=>v.type==='shorting_items'),`negative control ${version} must reproduce shorts`);
  }
  const library=parseSExpression('(footprint "Test:Pad" (layer "F.Cu") (pad "1" smd rect (at 0 0) (size 1 0.5) (layers "F.Cu" "F.Mask")))');
  setFootprintAt(library,10,20,90);
  const saved=printSExpression(library);
  assert.ok(saved.indexOf('(at 10 20 90)')<saved.indexOf('(pad '),'imported library footprint must have its transform before pads');
  console.log('PASS KiCad native DRC for cardinal QFN placements in legacy and KiCad 10 boards; import and idempotence');
} finally {await rm(dir,{recursive:true,force:true});}
