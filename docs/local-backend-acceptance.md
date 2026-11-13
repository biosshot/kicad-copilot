# Local backend migration: acceptance record

Verified on Windows x64, Node 26.5.0, KiCad CLI 10.0.0, 2026-11-13.

## Delivered

- Removed the Copilot HTTP client, server URL configuration and embedded authorization.
  Search, schematic extraction, PCB sizes and placement call the backend package.
- KiCad supplies native symbol/footprint geometry by UUID. Catalog resolution has
  priority; supplied geometry is used on a catalog miss, as requested.
- Added persistent CLI sessions, local placement progress/wait/cancel, protection
  against duplicate application and concurrent placement processes, and shutdown cleanup.
- Updated routing to router 0.3.2 Hybrid; retained KiCad candidate checks and checkpoints.
- Added portable skill packaging, SPICE and datasheet helpers, package provenance checks,
  release gates and fast regression tests in `npm run check`.
- Fixed ground glyph/value overlap with wires and missing UUIDs on imported native
  footprint instances; repeated import preserves assigned identities.

## Evidence

| Check | Result and scope |
| --- | --- |
| `npm run check` | PASS: typecheck, build, footprint geometry, analysis normalization, CLI sessions, placement operation/lock tests |
| `test-schematic-hierarchy` | PASS with actual backend and KiCad netlist checks; native assets, repeated sheets, multiple units and nested interfaces. Only catalog misses for known local fixture IDs are mocked |
| `test-mcp-ldo` | PASS: MCP edits, KiCad connectivity and native rendering; live catalog component path exercised |
| `test-schematic-matrix` | PASS: all 16 scenarios on final source, with deterministic local KiCad assets. Includes 32 repeated blocks (129 components, 354 pins, 33 sheet instances), four-level hierarchy (30 components, 75 pins, 12 instances), aliases, ports, removal and reconnection |
| `test-ground-layout` | PASS: saved KiCad fixture reproduces overlap; actual beautification removes it and preserves the KiCad netlist. Native rendered output inspected |
| `test-pcb-scenarios` | PASS: bundled RP2350 project, 38 imported footprints, native KiCad checks. This is import/adapter acceptance, not full routing of RP2350 |
| RP2350 layout input and sizes | PASS: 38 component entries / 38 native geometry entries; all 38 sizes resolve with network disabled |
| `test-local-backend` | PASS: synthetic two-resistor fixture, native solver placement, KiCad-derived geometry, preserved pad IDs/positions/sizes, KiCad CLI upgrade |
| `test-cli-pcb-live` | PASS: synthetic connected two-resistor project through separate CLI invocations: import, stable UUIDs on reimport, sizes, placement, wait, exactly one assembly checkpoint, native KiCad readback |
| `test-routing-integration` | PASS: small cap-chain fixture, routing, stackup, scoped copper removal and copper operations through native KiCad verification |
| Hybrid routing smoke | PASS: cap-chain fixture, complete result, four tracks, no open nets |
| Bundled skill | PASS: launcher/help/list, project read, real documentation paths, native binary hash and load; no runtime dependency on the source checkout |
| SPICE | PASS: ngspice 47 console executable, RC AC/OP/transient; gain 0.70859 at 1584.89 Hz near expected 0.7071 cutoff gain; four plots produced and AC plot inspected |
| Release gate | Expected rejection while backend dependency uses `file:`; prevents publishing an unusable npm package |

The schematic matrix uses native KiCad fixture assets and deterministic catalog
misses for their UUIDs; layout, MCP transport, file writes and KiCad checks remain
real. Live catalog runs encountered timeouts, so network availability is kept
separate from local regression acceptance. Per-run results and renderings are
written under `.test-output/schematic-matrix/`.

## Backend and distribution

The companion backend is isolated in `../eda-copilot-backend-kicad`, branch
`feat/kicad-local-geometry`; other backend working trees were not edited.
`backend-source.json` pins its source revision. Backend changes are limited to
optional symbol geometry, validated input, catalog-first footprint fallback and
focused tests. Solver source was not changed.

The native solver was built from that checkout, rather than mixing a newer main
with the older npm binary. SHA-256:
`36c5f456b669556cd94b540bb3479ffddf4c638cd3b810a788a58ad38ef5ac34`.
Its contracts are `f32-rte-ftz-v1`, score 13 and refiner 3. Backend typecheck/build,
local geometry tests, symbol-padding tests and 15 existing-placement tests passed.

The usable artifact is `skill/` (Windows x64 bundled runtime). KiCad, Python and
simulation engines remain external system prerequisites. Cache paths for restricted
agent environments are documented in `install-guide.md`.

No push or publication was performed. The companion commit must be pushed before
the two-repository CI can fetch it; the backend must be released and the local
dependency replaced before npm/lightweight-skill publication. Cross-platform native
acceptance and KiCad 9 were not run. Existing kicad-happy analysis is retained;
this change does not claim parity with experimental backend physics branches.
