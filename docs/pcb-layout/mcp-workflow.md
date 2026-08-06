# PCB Layout MCP Workflow

Read `dsl.ts` for syntax and `instructions.md` for placement rules. `make_pcb_layout` is placement-only.

## Tools

- `import_pcb_changes({ path })` explicitly synchronizes the target PCB from its associated schematic.
- `make_pcb_layout({ path, file })` reads the local DSL and associated schematic, runs placement, stores the BoardAssemble payload locally, and returns `layout_id` plus preview paths.
- `wait_pcb_layout({ operation_id })` is needed only when `make_pcb_layout` returns `status: "running"` after its synchronous wait.
- `cancel_pcb_layout({ operation_id })` stops an obsolete pending placement.
- `assemble_pcb_layout({ path, layout_id })` applies a previously completed final placement to the target PCB file.

`preview_path` is the primary review image. `debug_path` is an optional local SVG for a visibly bad block, family, or module.

## Required Approval Flow

1. Call `import_pcb_changes({ path })` for the target PCB.
2. Write a small mechanical preview DSL: outline, holes, regions, pads, and mechanical/user-facing components.
3. Add `solver({ preview: true, placeOnlyComponents: [...] })` and call `make_pcb_layout`.
4. If the tool returns running, wait. When it completes, open `preview_path` and present the image to the user for mechanical approval.
5. Do not assemble or run full placement before approval.
6. After approval, write the complete placement DSL without preview filters and run `make_pcb_layout`.
7. Fix hard errors only. Warnings are not a requirement to reach an ideal score; change one only if it visibly harms an explicit requirement.
8. Open the final `preview_path` and request final placement approval.
9. Assemble the intended PCB file using `layout_id`.
10. Route, configure DRC, and run checks in KiCad.

## Result Handling

Use a completed `layout_id` only for assembly. A preview result is never assembled. The board payload remains internal to MCP and is intentionally not shown to the agent.

Typical completed result:

```txt
{
  "status": "ok",
  "layout_id": "...",
  "preview_path": "C:\\Users\\...\\pcb-layout\\....svg"
}
```
