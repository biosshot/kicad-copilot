# PCB stackup, rules, copper, and routing

Use `run_pcb_router_dsl({ path, file })` for one requested PCB operation. This workflow can run independently of placement. Read `dsl.d.ts` as the exact declaration source.

## Select one terminal

End every DSL file with exactly one terminal:

- `applyDrcRules()`: persist DRC rules without changing copper;
- `applyStackup()`: apply a complete declared stack without KRT;
- `runCopper()`: apply selected zone cleanup, polygons, planes, or stitching without KRT routing;
- `runRouting()`: route while retaining source DRC files;
- `runAll()`: apply requested stack/rules/copper and route.

Existing unlocked tracks, vias, and zones remain unless `clearRouting(...)` explicitly selects them. Locked copper is never removed. Never add a full clear merely because routing is requested.

For impedance-controlled work, do not guess dielectric material, thickness, or stack order. Ask for the stack/fabricator data or mark impedance verification skipped.

## Workflow

1. Resolve the exact PCB/project. For an existing design, run focused baseline `analyze_pcb` and DRC only when comparison is needed.
2. Write one DSL transaction with the smallest requested scope and exactly one terminal.
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
