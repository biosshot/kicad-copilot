# Design analysis

`analyze_schematic` and `analyze_pcb` run pinned `kicad-happy` v2.2.0 checks without modifying the project. Use them for design reasoning; use native KiCad ERC/DRC for release verification.

## Context rule

- Keep `findings: true` for compact actionable findings.
- Add only fields needed for the current decision.
- Use `findings: false` for one focused report-only query.
- Do not use `all: true` by default. It returns many fields and PCB `all` also runs thermal and EMC. Use it only for an explicitly requested deep audit when focused reports are insufficient.

Results contain `status: pass | warn | fail`, a compact `summary`, `skipped`, optional `findings`, and requested top-level report fields. Report skipped checks; never treat them as passes.

## Schematic selection

| Need | Fields |
|---|---|
| New hierarchy or sheet split | `hierarchy`, `overview` |
| Circuit edit or beautify | `connectivity`, `blocks` |
| Rails or power stage | `power`, `connectivity` |
| Interfaces or differential signals | `buses`, `connectivity` |
| BOM or assembly review | `bom`, `assembly` |
| Verification planning | `verification` |

Run once at project level after all related sheet changes. The tool accepts a `.kicad_sch`, `.kicad_pro`, or project directory. It does not run native ERC.

## PCB selection

`analyze_pcb` works after placement, stackup/rule, copper, and routing operations. It automatically discovers an associated schematic and runs cross-domain checks when one exists.

| PCB operation | Focused fields |
|---|---|
| Placement or mechanics | `overview`, `placement`, optionally `assembly` |
| Stackup or DRC rules | `overview`, `dfm` |
| Zones, planes, or stitching | `connectivity`, `power`, `dfm` |
| Routing | `routing`, `connectivity`, `power` |
| Buses or differential pairs | previous fields plus `buses` |
| Assembly/production review | `assembly`, `dfm` |
| Detailed project consistency | `cross` |

Enable `proximity: true` only after routing exists and crosstalk/proximity matters. Enable `thermal` or `emc` only when the design or user requires those analyses.

`placement` can detect density, courtyard, edge, keepout, and decoupling issues. It cannot reliably determine whether a connector opening is accessible or faces outward; follow `pcb-layout/mechanical-validation.md`.

`analyze_pcb` does not run native DRC. After a PCB mutation, run the relevant focused analysis and `kicad-cli pcb drc`. For an existing design, collect a focused baseline first only when a before/after comparison is needed.

## Lifecycle

`audit_lifecycle` is network-backed and may return `status: "running"`. Wait with `wait_operation({ operation_id })`; cancel obsolete work with `cancel_operation`. Use lifecycle audit for sourcing or release work, not ordinary drawing/layout iteration.

## Decision

An analyzer finding does not authorize rollback. Separate pre-existing findings from new ones, stop further dependent work, and ask the user to choose `KEEP`, `FIX`, or `RESTORE`.
