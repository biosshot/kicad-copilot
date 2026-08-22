# Design analysis

Use the analysis tools after meaningful schematic or PCB changes. They run the pinned
`kicad-happy` v2.2.0 offline analyzers and return a small action list instead of the
large upstream JSON report.

## Tools

### `analyze_schematic`

- Accepts a `.kicad_sch`, `.kicad_pro`, or project directory.
- `mode: "quick"` is offline and returns errors and warnings.
- `mode: "full"` incrementally downloads missing PDFs through the bundled LCSC sync
  workflow, reruns analysis when new evidence arrives, and also returns low-priority
  findings that have a concrete recommendation.
- Includes the audits built into `analyze_schematic.py`, such as connectivity, power
  sources, ESD, USB, decoupling, crystals, connectors, BOM, sourcing, and datasheet coverage.

Run it after creating or modifying a functional schematic block and before PCB synchronization.
Full mode writes PDFs and `manifest.json` under `<project>/datasheets/`. It first uses
datasheet URLs stored in symbols, then LCSC/jlcsearch and manufacturer fallbacks. No API
key is required. Failed or unverified downloads are returned as one compact warning;
they do not prevent the remaining schematic checks from completing.

### `analyze_pcb`

- Accepts a `.kicad_pcb`, `.kicad_pro`, or project directory.
- `full: true` includes the full copper connectivity graph.
- `proximity: true` enables slower trace-proximity and crosstalk checks; use it after routing exists.
- Includes PCB connectivity, placement, board-edge, DFM, fiducial, test-point,
  thermal-pad, decoupling-placement, and routing checks built into `analyze_pcb.py`.

Run it after placement, after routing, and before fabrication export.

## Result contract

```ts
type AnalysisResult = {
  status: "pass" | "warn" | "fail";
  summary: string;
  findings: Array<{
    severity: "error" | "warning" | "info";
    message: string;
    refs?: string[];
    fix?: string;
  }>;
  report?: string;
};
```

Repeated findings are grouped and synthetic references are removed. `report` is present
only when grouping or reference limits hide details. Read it only when the compact result
does not contain enough information to make the next correction.

Downloaded PDFs remove the evidence-coverage warning, but typed pin-level lookup still
requires structured files under `datasheets/extracted/`; that extraction step is not
automatic yet.

These tools complement, but do not replace, native KiCad ERC and DRC. Cross-domain,
thermal-budget, current-budget, lifecycle, Gerber, and fabrication-release analysis are
not part of these two tools yet.
