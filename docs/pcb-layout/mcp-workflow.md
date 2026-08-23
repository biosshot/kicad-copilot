# PCB Layout MCP Workflow

Read `dsl.ts` for placement syntax and `instructions.md` for placement and local routing rules.

## Tools

- `import_pcb_changes({ path })` explicitly synchronizes the target PCB from its associated schematic.
- `make_pcb_layout({ path, file })` reads the local DSL and associated schematic, runs placement, checkpoints and atomically applies every returned PCB, and returns preview paths.
- `wait_operation({ operation_id })` is needed only when a long operation returns `status: "running"` after its synchronous wait.
- `cancel_operation({ operation_id })` stops obsolete placement, routing, or lifecycle work.
- `run_pcb_router_dsl({ path, file })` applies stackup, DRC, copper-only, or routing intent, performs native refill/DRC, and commits the candidate atomically.
- PCB layout IDs use `pcb-layout:<8 hex>`; PCB DSL IDs use `pcb-dsl:<8 hex>`.

`preview_path` is the primary PNG review image. `preview_svg_path` is the same preview as SVG. `debug_path` is an optional local SVG for a visibly bad block, family, or module.

## Required Approval Flow

1. Call `import_pcb_changes({ path })` for the target PCB.
2. If the physical stack must change, use `stack(...); applyStackup()` through `run_pcb_router_dsl` before placement or routing.
3. Write a small mechanical preview DSL: outline, holes, regions, pads, and mechanical/user-facing components.
4. Add `solver({ preview: true, placeOnlyComponents: [...] })` and call `make_pcb_layout`.
5. If the tool returns running, wait. When it completes, the returned PCB has already been applied after a checkpoint; open `preview_path` and present it for mechanical approval.
6. Do not run full placement before mechanical approval.
7. After approval, write the complete placement DSL without preview filters and run `make_pcb_layout`; the completed result is applied automatically.
8. Fix hard errors only. Warnings are not a requirement to reach an ideal score; change one only if it visibly harms an explicit requirement.
9. Open the final `preview_path` and request final placement approval.
10. Read `../pcb-routing/dsl.d.ts`, write one routing DSL file, and call `run_pcb_router_dsl({ path, file })`. For a complete reroute, include `clearRouting({ nets: "all" })` in that same DSL transaction.
11. Wait when needed, then inspect the routed board and run final DRC with `kicad-cli` as documented in `../kicad-cli.md`.

## Result Handling

Every response containing a PCB is applied, including preview or issue-bearing results. A checkpoint is created first, so inspect the preview/analyzers and roll back when needed. The board payload remains internal to MCP and is intentionally not shown to the agent. `layout_id` remains an internal compatibility artifact and requires no follow-up tool call.

Typical completed result:

```txt
{
  "status": "ok",
  "applied": true,
  "layout_id": "...",
  "preview_path": "C:\\Users\\...\\pcb-layout\\....png",
  "preview_svg_path": "C:\\Users\\...\\pcb-layout\\....svg"
}
```
