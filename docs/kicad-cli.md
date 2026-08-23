# KiCad CLI

Use native `kicad-cli` for ERC, DRC, conditional previews, and exports. Call `get_project_info` once and use its exact `kicad_cli.path`. Inspect `--help` for the installed KiCad version before using unfamiliar flags.

## ERC and DRC

```powershell
& $kicadCli sch erc --format json --severity-all `
  --output 'schematic-erc.json' 'root.kicad_sch'

& $kicadCli pcb drc --format json --severity-all `
  --output 'board-drc.json' 'board.kicad_pcb'
```

Inspect violations and unconnected items. Treat shorts as failures. After generated routing, unconnected items must not increase without an explained reason.

Use `--refill-zones` when DRC must validate current fills. Do not add `--save-board` unless changing the user's board is explicitly allowed. Add `--exit-code-violations` when CI must fail on violations.

## Conditional PCB preview

Do not render after every PCB operation.

Render the applied board when:

- a connector, switch, button, display, antenna, card slot, mounting feature, or other mechanical component was added, moved, rotated, or changed side;
- the outline, cutout, or mounting holes changed;
- mechanics need LLM or user approval;
- the user requests visual validation.

Normally skip preview for analyze-only, stackup/rules-only, and routing/copper-only work. Export a 2D copper view only when it helps validate that operation.

The `make_pcb_layout` preview is solver diagnostic output. A native render is the authoritative visual check of the applied `.kicad_pcb`.

Render only required views:

```powershell
& $kicadCli pcb render 'board.kicad_pcb' `
  --output 'board-top.png' --side top --quality high --background opaque
```

Render the bottom only when bottom-side mechanics changed. Use `--zoom`, `--pan`, and `--rotate` for a closer connector view.

For reliable 2D geometry or copper:

```powershell
& $kicadCli pcb export svg 'board.kicad_pcb' `
  --mode-single --output 'board-front.svg' `
  --layers 'F.Cu,F.SilkS,Edge.Cuts' `
  --fit-page-to-board --exclude-drawing-sheet
```

Use `B.Cu,B.SilkS,Edge.Cuts` with `--mirror` for the back. Add `--check-zones` when filled zones must appear. Native CLI cannot highlight one component or net.

## Other native operations

Prefer CLI support for BOM/netlist, statistics, manufacturing files, drawings, position files, STEP/STL/GLB/VRML/3DPDF, jobsets, and library operations. Commands containing `upgrade`, `--save-board`, imports, or a jobset may modify files or create many outputs; resolve targets and permission first.
