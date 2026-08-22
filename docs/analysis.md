# Design analysis

Use the analysis tools after meaningful schematic or PCB changes. They run the pinned
`kicad-happy` v2.2.0 analyzers and return compact LLM-facing results. No analysis tool
modifies the KiCad project. Schematic and PCB analysis are offline; lifecycle audit uses
distributor networks.

## Shared result behavior

Every completed analysis returns `status`, `summary`, and `skipped`. `findings` is enabled
by default and can be disabled with `findings: false`. Optional report fields are selected
with individual booleans and appear at the top level. `all: true` enables all optional
report fields but never overrides `findings: false`.

```ts
type AnalysisResult = {
  status: "pass" | "warn" | "fail";
  summary: string;
  skipped: string[];
  findings?: Array<{
    severity: "error" | "warning" | "info";
    message: string;
    refs?: string[];
    fix?: string;
  }>;
  report?: string;
  // Requested domain fields such as power, routing, assembly, thermal, or emc.
};
```

Repeated findings are grouped, synthetic references are removed, and coordinate-level
copper is never returned inline. `report` points to raw analyzer output when compacting or
disabling findings hides details.

## `analyze_schematic`

Accepts a `.kicad_sch`, `.kicad_pro`, or project directory. There is no `mode`; the
analyzer always performs its core offline analysis. Use the optional booleans only for
context needed by the current task:

- `overview`: project size, sheets, components, nets, and versions.
- `hierarchy`: sheets, hierarchical/global labels, and discovery warnings.
- `blocks`: detected regulators, crystals, filters, IC neighborhoods, and interfaces.
- `connectivity`: unconnected pins, single-pin/multi-driver nets, labels, and no-connects.
- `power`: rails, voltage estimates, domains, sequencing, budget, sleep current, PDN, inrush.
- `buses`: interfaces, bus topology, differential pairs, and cross-domain signals.
- `bom`: compact BOM groups, MPN/footprint coverage, sourcing, and optimization.
- `assembly`: package mix and estimated hand/professional assembly complexity.
- `verification`: test coverage, simulation readiness, protocol checks, and trust coverage.
- `all`: every optional schematic field.

Run after changing a functional schematic block and before PCB synchronization. The adapter
suppresses the upstream warning that only requests downloaded PDFs. Missing MPN coverage
remains actionable. Structured datasheet extraction is not performed.

## `analyze_pcb`

Accepts a `.kicad_pcb`, `.kicad_pro`, or project directory. The adapter automatically finds
the associated schematic, runs schematic analysis once, passes its JSON to
`analyze_pcb.py --schematic`, enables `--full`, and runs `cross_analysis.py`. Use
`schematic` only to override automatic discovery.

- `overview`: board size, layers, footprints, tracks, vias, zones, and routing completion.
- `placement`: density, groups, courtyard/edge issues, and decoupling distances.
- `routing`: track/via distributions, net lengths, layer transitions, and proximity results.
- `connectivity`: copper islands, disconnected pads, plane splits, and zone continuity.
- `power`: power routing, ground domains, decoupling, current risks, and switching loops.
- `buses`: schematic-enriched bus/differential-pair routing and cross findings.
- `assembly`: fiducials, orientation, test points, silkscreen, tombstoning, via-in-pad, and complexity.
- `dfm`: process tier, project-rule compliance, manufacturing metrics, and violations.
- `cross`: detailed schematic/PCB sync, ESD, decoupling, current, return-path, plane, and diff-pair checks.
- `thermal`: run and return `analyze_thermal.py` results. Missing power evidence is reported in `skipped`.
- `emc`: run and return analytical `analyze_emc.py` results without SPICE.
- `proximity`: enable slower trace-proximity/crosstalk analysis after routing exists.
- `all`: return every optional PCB field and run thermal plus EMC; it does not enable proximity.

Run after placement and again after routing. EMC is most meaningful after routing and ground
zones exist. These checks complement but do not replace native KiCad DRC.

## `audit_lifecycle` and `wait_analysis`

`audit_lifecycle` analyzes schematic MPNs using LCSC and any configured DigiKey, Mouser, or
element14 credentials. It can also validate commercial/industrial/extended/automotive/military
temperature grades and optionally search for alternatives.

The audit starts asynchronously and waits briefly. If it returns `status: "running"`, call:

```ts
wait_analysis({ operation_id, wait_ms: 30000 })
```

Repeat while the status remains `running`. The completed result uses the shared compact
contract. LCSC does not expose authoritative lifecycle state; an LCSC-only audit reports
that capability gap instead of claiming that an unknown part is active.

## Native verification gap

`skipped` always states that native KiCad ERC or DRC was not run. Run those checks through
`kicad-cli` before treating an analysis result as release-ready.
