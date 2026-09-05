# Schematic workflow

Use this workflow to create, modify, or beautify schematics without continuing to PCB work.

## Create or modify

1. Use `get_project_info` once if the root and target sheet paths are unknown.
2. For a new project, plan functional sheets and create them before adding circuits. See `project-and-sheets.md`.
3. Read each affected physical sheet with `get_schematic`.
4. Search only unknown parts. Prefer a suitable proven `search_reused_block` result for a standard function.
5. Apply related known changes with `extract_circuit`. Prefer one call per coherent change or sheet; multiple calls are allowed when staged verification is safer.
6. Run `beautify_schematic` once for all affected blocks on that sheet:
   - required after component removal, replacement, or pin/net reassignment;
   - recommended after completing an AI-generated sheet or a visibly disordered generated block;
   - do not include an untouched manually arranged user block without approval.
7. Re-read only when exact component/net readback is needed.
8. Run one project-level `analyze_schematic` with only relevant fields, then native ERC from the root schematic.
9. Stop. Do not create, synchronize, place, or route a PCB unless requested.

`beautify_schematic` uses the same extraction path for selected symbols and sheet inclusions. Their positions can change; native UUIDs, symbol properties, footprints, and sheet interfaces are retained. Unselected objects stay in place. A checkpoint is created before the operation. Connectivity is checked after writing, including an independent root KiCad netlist export; a failed mutation rolls back all schematic files changed by that operation.

## Beautify only

1. Read the exact sheet.
2. Group only the requested components into functional blocks.
3. Call `beautify_schematic` once for that sheet.
4. Run focused connectivity analysis and ERC.
5. If the user dislikes the layout, offer `KEEP`, `FIX`, or `RESTORE`; never restore automatically.

## Done when

- requested components and nets exist on the intended sheets;
- no new unexplained connectivity or ERC errors remain;
- hierarchy and affected sheet paths are reported;
- the workflow stops at the schematic boundary.

## Open-editor warning

MCP writes the disk file. Save intentional editor changes before an MCP write, then reload the document in KiCad. Do not save an older editor buffer over the new disk state.
