# PCB Placement Instructions

`make_pcb_layout` is placement-only. Routing and simple full-board copper pours are separate local MCP operations.

## Source Of Truth

- `dsl.ts` defines the available DSL. Do not invent helpers or use hidden/stale options.
- Keep the schematic immutable: never rename its nets, pins, designators, `part_uuid`, or `footprint_uuid`.
- Coordinates are millimeters from board center; positive X is right and positive Y is down.
- `examples/` contains complete references. Copy the structure, then recheck every designator, pin, and net against the current schematic.

## Workflow

1. Read `dsl.ts`, this file, and the closest complete example.
2. If needed, apply the complete physical stack with `stack(...); applyStackup()` through `run_pcb_router_dsl` before placement or routing.
3. Make a **mechanical preview** first: board outline, holes, constraint regions, board pads, connectors, buttons, displays, LEDs, and other edge-facing parts. Use `solver({ preview: true, placeOnlyComponents: [...] })`. Every returned PCB is checkpointed and applied.
4. Open the PNG at `preview_path` and show it to the user. Use `preview_svg_path` when vector output is useful. Ask for explicit confirmation of the mechanics; roll back the checkpoint when the applied preview is rejected.
5. After confirmation, remove preview filters and write the complete block/module/component layout.
6. Run full placement, inspect `preview_path`, and fix fatal errors only.
7. Show the applied final placement to the user for approval and roll back if it is rejected.
8. Read `../pcb-routing/instructions.md` and its `dsl.d.ts`, then use `run_pcb_router_dsl({ path, file })` only after the applied final placement is approved.
9. Inspect the routed PCB and run final DRC with `kicad-cli`; see `../kicad-cli.md`.

`run_pcb_router_dsl` owns stackup, copper cleanup, planes, stitching, DRC rules, and routing. Use its focused `applyStackup()` or `runCopper()` terminals when KRT routing is unnecessary.

If `make_pcb_layout` returns `status: "running"`, call `wait_operation({ operation_id })`. Otherwise use its completed result directly. Use `cancel_operation` for obsolete work.

## Errors And Warnings

Fix before assembly:

- invalid DSL, invalid target references, or missing footprint;
- `fatal_overlap` and `outside_board`;
- disconnected physical blocks, unless the block intentionally has `allowDisconnected: true`.

Warnings are review context, not an optimization backlog. Fix one only when it visibly harms the requested result or violates an explicit requirement: e.g. a USB connector faces inward, a crystal/USB/RF/switch-loop critical path is obviously too long, or a block is visibly malformed. Make at most one focused revision. Do not chase zero warnings.

## Placement Defaults

Use `board.auto(...)` unless the board has fixed mechanical dimensions. For normal compact boards start with:

- `density: 0.4`;
- component `clearance: 0.35` mm, normally within `0.25-0.5` mm;
- board `edge: 2` mm unless mechanics require another value;
- `grid: 0.5` or `1` mm.

`clearance` is evaluated against placement footprint bounds, which include silkscreen/body geometry. Do not use old `1.3` mm placement clearance by default: it makes normal boards artificially sparse. Increase it only for intentional mechanical/routing space around large connectors or dense ICs.

For `capCluster`, start with `gap: 0.3` mm; use `0.25-0.4` mm unless an electrical or mechanical reason requires more. The footprint bounds already supply additional visible separation.

Use `compactness: "high"` only when board area is genuinely constrained.

## Structure

- Every real component belongs to exactly one block.
- A block is one physical island and normally shares at least one non-GND net. Set `allowDisconnected: true` only for intentional mechanical/same-role arrays.
- Keep blocks below roughly 12 components. Split by IC pin group, rail, side, or function.
- Do not mix top and bottom components in one block.
- Use a main block for an IC/core and small satellite blocks for clock, flash, decoupling, feedback, and similar local functions.
- Modules are soft macro groups. Do not create a giant sparse module containing connectors on distant board edges.

## Constraints

- Use `coreIsland` and a small number of hard `criticalPair` constraints for dominant paths only.
- Use `capCluster` for two or more capacitors sharing a power and return net. Use `bypass`, `veryNear`, or `criticalPair` for a single capacitor.
- Use `edgeMount` only for a part that must physically overhang the board. Use `edgePlace` for buttons, LEDs, and controls that remain inside the outline.
- Use `fixed` only for actual mechanical locks. Never fix normal ICs, passives, crystals, or inductors merely to improve a preview.
- Use `componentGrid` for existing header/test/indicator arrays and `boardPad` for new synthetic board pads.
- Use `constraintRegion` for placement-only antenna, display, USB-tongue, or mechanical exclusion areas. It is not a copper keepout.

## Avoid

- Full placement before the user confirms mechanical preview.
- Assembly before the user confirms final placement.
- One giant power/MCU block containing all support parts.
- Normal components without block ownership or mixed layers in one block.
- Manual coordinates to compensate for a bad electrical block structure.
- Routing, copper, polygon, via, width, differential-pair, or length-matching rules in the placement DSL.

## Local Routing

- `run_pcb_router_dsl({ path, file })` passes the PCB DSL to `eda-copilot-router`; KRT is used only by `runRouting()` and `runAll()`.
- The router owns power polygons, special differential/equal-length routing, remaining routing, and optional GND plane/stitching declared in the DSL.
- Existing unlocked copper is preserved and editable. Add explicit `clearRouting(...)` intent for a full or scoped reroute; locked copper is never removed.
- If the result is running, call `wait_operation({ operation_id })`; use `cancel_operation` for obsolete work.
- KiCad refills zones and runs native DRC before the candidate is applied. Diagnostics do not crash the workflow.
- Routing success is not final sign-off: inspect the board and run `kicad-cli pcb drc` after routing.
