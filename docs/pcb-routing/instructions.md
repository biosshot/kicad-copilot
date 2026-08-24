# PCB stackup, rules, copper, and routing

Use `run_pcb_router_dsl({ path, file })` for stackup, rules, copper, or routing.
This workflow can run independently of placement. Read `dsl.d.ts` as the exact
declaration source. This directory's routing references are only
`instructions.md` and `dsl.d.ts`; do not infer additional files or example
directories.

## Default: one complete routing transaction

For new or full-board routing, write one DSL file and call the tool once. Put
all known board intent before one terminal:

- the verified physical stack;
- fabrication/DRC limits;
- power-net currents;
- controlled impedances and length/skew requirements;
- planes, polygons, fanout, and required via stitching;
- routing scope and an optional quality policy.

Normally end this complete transaction with `runAll()`. Do not route net groups
in separate calls merely to create stages. On a dense board, copper committed
by an earlier call becomes an obstacle and can block a better global solution.
The router already performs its own internal stages from one complete intent.

Multiple PCB transactions are allowed, but they are less efficient and may be
less stable. Use them only when the user requests a partial operation, an
isolated rules/copper change is the actual task, or a checked full attempt needs
a focused repair. For selected-net rerouting, use `onlyNets(...)` and clear only
the copper that must be replaced; never add a full clear by habit.

## Describe electrical intent, not calculated geometry

Let the router derive physical geometry from the effective stack and DRC:

- Use `powerNet("VBUS", { maxCurrentA: 2 })`. The router calculates the
  preferred trunk width from copper thickness and temperature-rise constraints
  and still permits legal neck-down at pads. Add `maxTempRiseC`, `powerPads`, or
  tap constraints only when the design provides that information.
- Use `signalNet(..., { impedance: ... })` or `diffPair(..., { impedance: ... })`
  for controlled impedance. State target ohms, tolerance, and a known or `auto`
  reference net; the router derives topology and width.
- Use `matchedGroup`, differential skew/uncoupled-length limits, `plane`,
  `polygon`, `fanout`, and the appropriate `viaStitch` mode when the electrical
  or return-path requirement calls for them.
- Use `drc(...)` and `netClass(...)` for real fabrication limits or explicit
  physical constraints, not for widths guessed by the LLM.

Do not manually calculate `trackWidthMm`, via diameter/drill, or impedance
geometry when semantic intent can derive it. Set explicit geometry only when
the user, fabricator, connector/pad geometry, or a verified design requirement
requires an exact value; document that source.

## Quality policy

Normally omit `quality(...)`; the router defaults to `balanced`. If the profile
must be explicit, prefer `quality({ profile: "balanced" })` and omit
`maxCandidates` unless a measured routing problem justifies a bounded search.
Do not use `completion-first` or `maxCandidates: 16` as a default template. Use
another profile only for a stated tradeoff or a deliberate retry.

## Stackup is part of routing intent

For new or full routing, explicitly declare `stack(...)` in almost every DSL
transaction. First read the target board, then use the selected fabricator
stack, user specification, or complete existing KiCad stack. Restate those
verified values so current and impedance calculations use explicit physical
assumptions. The user not mentioning stackup is not a request to omit it.

Do not invent dielectric material, thickness, permittivity, copper thickness,
or layer order. If the required stack data is missing, ask for it or select a
real fabricator stack with user approval. Controlled impedance is not verified
without a complete relevant stack and actual reference copper. Omit or preserve
stackup only when the user explicitly requests that, or when an intentionally
isolated non-routing operation must inherit the existing board unchanged.

## Select one terminal

End every DSL file with exactly one terminal. Use the narrower terminals only
when that narrower operation is intentionally the complete task:

- `applyDrcRules()`: persist DRC rules without changing copper;
- `applyStackup()`: apply a complete declared stack without KRT;
- `runCopper()`: apply selected zone cleanup, polygons, planes, or stitching without KRT routing;
- `runRouting()`: route while retaining source DRC files;
- `runAll()`: apply requested stack/rules/copper and route.

Existing unlocked tracks, vias, and zones remain unless `clearRouting(...)`
explicitly selects them. Locked copper is never removed.

## Workflow

1. Resolve the exact PCB/project. For an existing design, run focused baseline `analyze_pcb` and DRC only when comparison is needed.
2. Resolve the stack source and write one complete intent-driven DSL transaction with exactly one terminal.
3. Call `run_pcb_router_dsl`. If it returns `status: "running"`, wait with `wait_operation` until terminal.
4. The candidate is applied after a PCB checkpoint even when `native_verification` is `failed`; inspect diagnostics.
5. Run one focused `analyze_pcb`:
   - stack/rules: `overview`, `dfm`;
   - zones/planes/stitching: `connectivity`, `power`, `dfm`;
   - routing: `routing`, `connectivity`, `power`, plus `buses` when relevant;
   - enable `proximity` only for routed crosstalk/proximity work.
6. Run native `kicad-cli pcb drc`. Do not render by default; create a 2D copper view only when it materially helps validation.
7. Stop at the requested operation. Report diagnostics and ask `KEEP`, `FIX`, or `RESTORE` when the applied result has unresolved problems.

## Project-file recovery

The automatic checkpoint covers the `.kicad_pcb` only. A rules/stack transaction may also replace sibling `.kicad_pro` or `.kicad_dru` files. Save explicit backups/checkpoints for those files before a risky rules transaction and describe every changed file in the result.

KRT is managed by `eda-copilot-router`: the first routing use downloads and verifies the pinned official backend, then reuses the local cache. Development overrides are optional, not normal user setup.
