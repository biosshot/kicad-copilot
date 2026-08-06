# KiCad CLI

Prefer the native `kicad-cli` whenever it already provides the required operation. Do not request a new MCP tool for checks, previews, exports, reports, manufacturing files, format upgrades, or jobsets that the installed CLI can handle.

## Locate The CLI

Call `get_project_info({ path })` first. Its `kicad_cli` field contains the discovered executable path and version:

```json
{
  "kicad_cli": {
    "path": "C:\\Program Files\\KiCad\\10.0\\bin\\kicad-cli.exe",
    "version": "10.0.0"
  }
}
```

Use the returned path exactly. Quote it when it contains spaces. In PowerShell:

```powershell
$kicadCli = 'C:\Program Files\KiCad\10.0\bin\kicad-cli.exe'
& $kicadCli --version
```

If `kicad_cli` is `null`, try `kicad-cli` from `PATH` or ask the user to install KiCad or set `KICAD_CLI_PATH` for the MCP process.

Always inspect help from the installed version when using an unfamiliar command:

```powershell
& $kicadCli --help
& $kicadCli pcb --help
& $kicadCli pcb render --help
& $kicadCli pcb export --help
& $kicadCli sch --help
```

## DRC And ERC

Run PCB DRC as JSON:

```powershell
& $kicadCli pcb drc --format json --severity-all `
  --output 'board-drc.json' 'board.kicad_pcb'
```

Inspect `violations` and `unconnected_items`. Treat any `shorting_items` as a failed result. After generated routing, the number of unconnected items must not increase.

Run schematic ERC as JSON:

```powershell
& $kicadCli sch erc --format json --severity-all `
  --output 'schematic-erc.json' 'schematic.kicad_sch'
```

Add `--exit-code-violations` when a CI command must fail on reported violations.

`--refill-zones` recalculates zones for DRC. Do not add `--save-board` to the user's board unless the requested operation permits changing it. MCP routing and pour operations already validate a temporary candidate before atomically replacing the target file.

## PCB Preview

Render a 3D PNG from the top:

```powershell
& $kicadCli pcb render 'board.kicad_pcb' `
  --output 'board-top.png' `
  --side top `
  --quality high `
  --background opaque
```

Use `--side bottom` for the back. Use `--rotate`, `--zoom`, `--pan`, `--width`, and `--height` when another view is needed.

Export a single 2D SVG of selected front layers:

```powershell
& $kicadCli pcb export svg 'board.kicad_pcb' `
  --mode-single `
  --output 'board-front.svg' `
  --layers 'F.Cu,F.SilkS,Edge.Cuts' `
  --fit-page-to-board `
  --exclude-drawing-sheet
```

For the back, use `--layers 'B.Cu,B.SilkS,Edge.Cuts' --mirror`. Add `--check-zones` when the preview must include current zone fills.

The native preview cannot highlight one net or component. Use PCB parsing or a purpose-built MCP feature only when highlighting is essential to the task.

## Other Native Operations

Use CLI subcommands instead of MCP wrappers where possible:

- `pcb export stats --format json` for board statistics;
- `pcb export gerbers` and `pcb export drill` for manufacturing outputs;
- `pcb export pos` for placement files;
- `pcb export step`, `stl`, `glb`, `vrml`, or `3dpdf` for mechanical exchange;
- `pcb export pdf`, `svg`, or `dxf` for drawings;
- `sch export bom`, `netlist`, `pdf`, `svg`, or `dxf` for schematic outputs;
- `fp` and `sym` for footprint and symbol library operations;
- `jobset run` for a project-defined KiCad jobset;
- `pcb upgrade` and `sch upgrade` only when an explicit format upgrade is required.

Checks and exports are normally read-only. Commands containing `upgrade`, `--save-board`, imports, or a jobset may modify files or create many outputs. Resolve exact targets first, preserve checkpoints where appropriate, and do not overwrite user files accidentally.
