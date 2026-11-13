# Local bundled skill audit — 2026-11-13

## Scope and baseline

This is an audit, not a production fix. KiCad baseline: `cb22544462749b69ff6b7f05ec9b126d1e1c38f0`; isolated backend: `b4d66045969288ae8d1bd38cf484d2b2f6baef97`. The other backend checkout was not modified. Runtime acceptance targets `skill/scripts/kicad-copilot-cli.js`, not merely imports of source functions. Windows x64, KiCad 10.0.0, ngspice 47. Tests use scratch copies and isolated caches.

Evidence lives under `.test-output/full-audit/` (ignored generated files). Build and relocated-package evidence lives in sibling `../artifacts/kicad-full-audit/`. Diagnostic scripts are specific to this local environment; they are not portable CI tests. Use fresh output directories, configure the installed KiCad path, and review their fixture paths before rerunning. Concurrent checkpoint stress is probabilistic.

The exploratory `scripts/audit-*` files cited below and in detailed reports were archived unchanged under `.test-output/full-audit/harness/scripts/` after execution; restore them to their original `scripts/` paths to retain relative imports before replaying. Only the reusable package smoke check remains in versioned `scripts/audit-package.mjs`. Existing output fixtures are required by some exploratory scripts; their commands alone are not a fresh-checkout reproduction package.

## Confirmed defects and capability gaps

### P1: PCB import leaves copper on obsolete net names

`import_pcb_changes` succeeds after changing pad assignments but does not reconcile existing copper. On the real RP2350 example, four tracks retain `VREG_LX` after the relevant pads become `Net-(U2-VREG_LX)`. The subsequent router rejects `copper.editable.tracks[84..87] references unknown net VREG_LX`.

Independent minimal reproduction: two resistors, one track on `OLD`, schematic renamed to `NEW`. Import succeeds, pads change, track remains `OLD`; routing fails at track zero. This is not dependent on the large board or its pre-existing DRC violations. Source: `src/pcb/import.ts:106` (`assignPadNets`) and its use by `updateFootprintMetadata`; copper is not included in that update. Evidence: `pcb/minimal/` and `pcb/rp2350_debug/`; harnesses `scripts/audit-pcb-minimal.py` and `.ps1`.

Fix direction: reconcile copper identity safely when nets are renamed, and explicitly handle ambiguous splits/merges. Do not blindly rename every old-net item when topology changes. Regression must include both simple rename and split/merge cases.

### P1: concurrent checkpoint saves silently lose successful checkpoint IDs

Two persistent sessions save the same file concurrently. In 3 of 10 fresh targets both calls succeeded, but listing omitted one returned ID and restoring it failed with `checkpoint not found`. Eight concurrent sessions returned eight successes but listed only five. Snapshot files still existed; the metadata lost entries.

`src/checkpoints/store.ts:72` reads metadata before an unlocked read-modify-write. Atomic file replacement does not serialize that transaction. Evidence: `recovery-race-two/report.json` (rounds 0, 3, 6), `recovery-race/report.json`; harness: `scripts/audit-recovery-race-two.mjs`. Concurrent restore also produced explicit `EPERM` metadata-rename failures in 3/10 pairs; no silent incorrect restored bytes were observed in that sample. Treat these as related concurrency evidence, not proof of safety.

Fix direction: cross-process serialization for checkpoint metadata transactions and carefully defined restore/mutation coordination; preserve successfully acknowledged IDs.

### Retracted P2: isolated parent-page label after hierarchical rewiring

The earlier P2 attributed KiCad ERC `label_dangling` on `REWIRED` to serialization. Native controls show this is expected for this test request: only the child-sheet pin was assigned the new local net; no parent-page symbol pin or other matching label was connected to it. With J4.1 also attached to `REWIRED`, KiCad 10 removes the dangling-label error and its XML netlist contains J4.1, C6.1, and U2.5. Moving the lone label directly onto the sheet pin instead of using a wire does not clear the error. No ERC suppression or electrical semantics change is warranted. The initial one-error power-driver finding remains a fixture limitation. Control evidence: `hierarchy/erc-control/erc.json`, `hierarchy/erc-control/net.xml`, `hierarchy/erc-direct/erc.json`; detailed history: `hierarchy/report.md`. The nested matrix now asserts both the isolated and connected cases using native ERC and netlist. KiCad documents the label check in its [schematic editor manual](https://docs.kicad.org/10.0/en/eeschema/eeschema.html).

### P2: packaged datasheet download requires hard-link support

The TI LM358 download fails with `EPERM` at `skill/datasheets/scripts/download.mjs:76` in the restricted Windows agent environment. The same packaged command outside that restriction succeeds: 4,150,801 bytes, SHA256 `8277dff7b89138c63b3582d37f378065a1dea3cae5ed1e2926ddc2779eb7e3a2`. Only `EEXIST` is handled; no supported fallback is available. This is an environment-triggered compatibility defect in an intended agent workflow, not an HTTP failure. Evidence: `helpers/report.md`. Missing `pdftotext` is separately reported gracefully and is not this defect.

### P2: reusable-block search is advertised but disabled

The packaged call for `3.3V power regulator` returns `[]`; backend `src/components.ts` implements `searchReusedBlock` as an unconditional empty result. Tool help, schematic workflow and circuit-modification instructions recommend it without disclosing this state. This is a known disabled capability/documentation gap, not evidence that migration introduced a regression. Users cannot distinguish unavailable search from no matching blocks. Evidence: `helpers/reused-search.json` and `helpers/report.md`.

### P3: invalid component search is not marked as a tool error

`component_search({})` returns `Fill one: part_uuid or MPN` without the MCP `isError` flag. The explanation is correct, but machine consumers must recognize prose instead of a structured failure. Positive control: `component_search({MPN:'LM358'})` returns five catalogue records. Evidence: `helpers/component-invalid.json` and helpers report.

## Verified coverage

- Clean source archive: `npm ci --install-links --ignore-scripts --no-audit --no-fund`, `npm run check`, `npm run build:skill:bundled` and `node scripts/check-skill.mjs` passed. This covers compilation, type checking, the existing quick regression suite and creation/validation of a fresh bundled distribution. The package smoke test also passed against that freshly built distribution.
- The full existing `npm run test:native` suite passed from the clean archive: hierarchy integration, ground layout, PCB scenarios (38 footprints), local backend sizes/native placement/KiCad upgrade, published router routing/stack/cleanup/copper integration, and persistent CLI placement/checkpoint. This is additional source-suite coverage, distinct from the adversarial bundled tests above. In particular it does not erase the defects missed by existing assertions.
- Relocated bundled artifact in a path containing spaces and Cyrillic: no symlinks; 19 tools; packaged documentation paths resolve within the relocated artifact; session lifecycle, project creation, invalid JSON/tool errors, batch stop-on-error and session survival passed. Twelve checks passed on both the installed Node and declared minimum Node 20.19.0. Official Node binary SHA was checked against its release manifest. Native solver also loads under Node 20.19.0. This is not a claim that every solver scenario ran on minimum Node.
- Real placement, repeat terminal wait, concurrent-operation rejection, cancellation and stale-lock reclamation passed. Killing only the audit's own CLI daemon during `solve_islands` preserved PCB bytes; a new session with the same cache could start/cancel placement. This covers that interruption point, not every possible crash window.
- Populated bundled hierarchy: nested repeated LDO (7 instances), four nested levels with repetition (11 instances, 18 components, 48 pins), 16-port sheet (32 components, 64 pins), and Cyrillic signal. Native netlist oracles passed before/after beautify; deep hierarchy also passed remove/re-add. All 11 deep pages were visually inspected before/after beautify and after re-add; the 6 remaining pages after removal were also inspected. See `hierarchy/report.md` for exact per-snapshot ERC counts and inspected pages. These are connectivity passes, not clean ERC.
- Negative hierarchy controls rejected foreign scope, nonexistent port/component/pin, duplicate designators, direct child references from another page, self-inclusion and ancestor cycles.
- Actual bundled routing on a synthetic two-resistor/two-layer control completed with one 3.6 mm track and zero vias; independent KiCad DRC unconnected count fell from 1 to 0, final violations 0. The fixture was derived from the minimal import reproduction by explicitly removing its stale track; this is a disclosed scratch adjustment, not a product fix. It does not validate routing RP2350.
- RP2350 preservation control retained all 38 footprint positions/angles, 198 pad assignments, 258 segments and 29 vias. It returned `failed_with_layout` with `applied:true` due to seven clearance findings, so it is not a successful full-placement acceptance.
- Checkpoint save/list/restore in a single workflow restores exact bytes and creates a pre-restore checkpoint. Concurrency findings above remain release blockers.
- Real ECC83 demo analysis: 15 components, 15 footprints, 53 tracks. Schematic findings correctly report missing MPNs; PCB reports warnings. Native ERC/DRC were skipped by this analysis invocation and are not counted as passing there.
- Packaged SPICE RC and diode examples ran with inspected plots and independent numerical checks. RC magnitude 0.708587 at 1584.893 Hz agrees with the expected 1591.55 Hz cutoff; diode gives 0.679071 V and 4.32093 mA at 5 V. Missing-model and malformed-netlist controls returned failure even when ngspice itself exited zero.

## Visual quality and boundaries

Hierarchy tests use native KiCad netlist/ERC and rendered pages, plus electrical connection oracles. The harness accepts selected ERC finding types: a passing harness is **not clean ERC**. Populated fixtures include undriven power-pin errors; removal/rewiring can also report isolated or dangling labels. See the detailed hierarchy report for per-snapshot findings. Catalogue resolution is stubbed only for designated native fixture UUID misses; layout and KiCad processing are real. Those tests do not establish online catalogue availability for arbitrary parts.

The 16-port case is electrically valid and labels do not overlap, but layout is excessively sparse; beautify produces long connections. Thus visual quality is not unconditionally accepted. Vertical capacitor pin text overlaps in the LDO fixture; the same overlap exists in the original native library fixture, so it is recorded as an inherited asset problem rather than a new layout regression.

This audit does not prove absence of other bugs. Platform coverage is Windows x64/KiCad 10 only. No claim is made for macOS/Linux, all KiCad versions, every crash window, arbitrary large circuits, fabrication readiness, or successful routing of the already-invalid RP2350 input. Explicitly reported failures and skipped checks must not be relabeled as passes.

Not covered by the bundled hierarchy matrix: 32 ports, multiunit devices, independent child-port rename/removal, embedded quotes/backslashes, ordinary components on every intermediate level. Bottom-side/locked-component adversarial placement was not tested through the bundled CLI. Full-board RP2350 routing is blocked by the net-import defect and its incomplete dielectric stack. The fixture's original DRC already contains 328 violations; after-import count differences alone do not prove their cause.
