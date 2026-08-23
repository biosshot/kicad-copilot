# PCB placement

`make_pcb_layout` changes placement and board mechanics only. It does not authorize copper or routing work.

Read `dsl.ts` as the exact syntax source. Do not invent helpers or stale options. Use exact schematic designators, pins, nets, `part_uuid`, and `footprint_uuid`.

## Start

1. Resolve the exact `.kicad_pcb` and associated root schematic. Placement requires the associated schematic.
2. Call `import_pcb_changes` only when the schematic changed or the PCB is not synchronized.
3. Call `get_pcb_component_sizes` once for the required components or the full board.
4. For an existing board, run focused baseline analysis only when a before/after comparison is useful.
5. Select one placement mode before writing DSL.

| Intent | DSL |
|---|---|
| New board or full re-placement | do not call `preserve` |
| Keep current outline; re-place components | `preserve({ board: true })` |
| Add/place new components; keep existing placement | `preserve({ board: true, components: "all" })` |
| Move selected existing components | preserve the explicit complement: every component that must not move |

`components: "all"` preserves current components whose centers are inside `Edge.Cuts`. Explicitly list any outside-board component that must stay fixed. Do not use `"all"` when an existing component must move.

## Run

1. Define board, holes, blocks, components, and only justified constraints.
2. If mechanics changed, read `mechanical-validation.md` and run a mechanical preview DSL first with `solver({ preview: true, placeOnlyComponents: [...] })`.
3. Call `make_pcb_layout({ path, file })`. If it returns `status: "running"`, call `wait_operation({ operation_id })` until terminal.
4. Every returned PCB is already applied after a checkpoint, including preview and issue-bearing results. There is no assembly follow-up call.
5. Inspect solver diagnostics. Run focused `analyze_pcb` with `placement` and any relevant fields.
6. Create a native KiCad preview only for the triggers in `mechanical-validation.md` or when visual validation is useful.
7. Fix an obvious in-scope mechanical error. For subjective results or unresolved findings, stop and ask `KEEP`, `FIX`, or `RESTORE`.
8. If the accepted result was mechanical preview and full placement was requested, remove preview filters, run `make_pcb_layout` again, wait when needed, and repeat focused placement analysis.
9. After final or incremental placement, run native DRC. For a mechanical-only preview, defer DRC unless existing routed copper may have been affected.
10. Stop after placement unless the user explicitly requested routing.

## Placement structure

- Every real component belongs to exactly one block.
- A block is one physical island and normally shares a non-GND net. Use `allowDisconnected: true` only for intentional mechanical or same-role groups.
- Keep blocks small enough to express one local function; split MCU power, clock, flash, feedback, and interfaces when useful.
- Do not mix top and bottom components in one block.
- Use modules as soft macro groups; do not group distant edge connectors into one sparse module.
- Use a few hard `criticalPair` constraints only for dominant electrical paths.
- Use `capCluster` for two or more capacitors sharing supply and return; use `bypass`, `veryNear`, or `criticalPair` for a single capacitor.
- Use `fixed` only for true mechanical locks.
- Use `constraintRegion` for placement exclusion; it is not a copper keepout.

## Starting values

Use `board.auto(...)` unless dimensions are mechanically fixed. For an ordinary compact board, reasonable starting values are density `0.4`, component clearance `0.25-0.5 mm`, and grid `0.5` or `1 mm`. These are starting points, not requirements; footprint geometry and mechanics take priority.

`clearance` uses placement footprint bounds including body/silkscreen geometry. Avoid a blanket `1.3 mm` clearance. For `capCluster`, `0.25-0.4 mm` is a useful starting gap. Use `compactness: "high"` only when area is genuinely constrained.

## Accept result

Do not chase zero warnings. A warning matters when it violates an explicit requirement or visibly harms mechanics, a critical path, or block shape. Never restore automatically; present the applied state, checks, checkpoint, and user choices.
