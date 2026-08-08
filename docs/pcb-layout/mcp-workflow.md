# PCB Layout MCP Workflow

Read `dsl.ts` for placement syntax and `instructions.md` for placement and local routing rules.

## Tools

- `import_pcb_changes({ path })` explicitly synchronizes the target PCB from its associated schematic.
- `set_pcb_stack_layers({ path, copper_layer_count })` sets 2-32 even copper layers before placement or routing.
- `make_pcb_layout({ path, file })` reads the local DSL and associated schematic, runs placement, stores the BoardAssemble payload locally, and returns `layout_id` plus preview paths.
- `wait_pcb_layout({ operation_id })` is needed only when `make_pcb_layout` returns `status: "running"` after its synchronous wait.
- `cancel_pcb_layout({ operation_id })` stops an obsolete pending placement.
- `assemble_pcb_layout({ path, layout_id })` applies a previously completed final placement to the target PCB file.
- `auto_route_pcb({ path })` locally routes remaining connections and directly applies the completed result.
- `wait_auto_route({ operation_id })` waits for a long local routing operation.
- `cancel_auto_route({ operation_id })` stops a running local routing operation before application.
- `clear_pcb_routing({ path })` removes tracks, track arcs, and vias but preserves footprints, zones, and outline.
- `pour_pcb_layers({ path, net, layers })` rebuilds managed full-board zones and optional stitching vias.

`preview_path` is the primary PNG review image. `preview_svg_path` is the same preview as SVG. `debug_path` is an optional local SVG for a visibly bad block, family, or module.

## Required Approval Flow

1. Call `import_pcb_changes({ path })` for the target PCB.
2. If needed, call `set_pcb_stack_layers` before placement or routing.
3. Write a small mechanical preview DSL: outline, holes, regions, pads, and mechanical/user-facing components.
4. Add `solver({ preview: true, placeOnlyComponents: [...] })` and call `make_pcb_layout`.
5. If the tool returns running, wait. When it completes, open `preview_path` and present the image to the user for mechanical approval.
6. Do not assemble or run full placement before approval.
7. After approval, write the complete placement DSL without preview filters and run `make_pcb_layout`.
8. Fix hard errors only. Warnings are not a requirement to reach an ideal score; change one only if it visibly harms an explicit requirement.
9. Open the final `preview_path` and request final placement approval.
10. Assemble the intended PCB file using `layout_id`.
11. Call `auto_route_pcb`. For a complete reroute, call `clear_pcb_routing` first.
12. Wait when needed, then inspect the routed board and run final DRC with `kicad-cli` as documented in `../kicad-cli.md`.

## Result Handling

Use a completed `layout_id` only for assembly. A preview result is never assembled. The board payload remains internal to MCP and is intentionally not shown to the agent.

Typical completed result:

```txt
{
  "status": "ok",
  "layout_id": "...",
  "preview_path": "C:\\Users\\...\\pcb-layout\\....png",
  "preview_svg_path": "C:\\Users\\...\\pcb-layout\\....svg"
}
```
