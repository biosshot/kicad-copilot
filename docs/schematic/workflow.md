# Schematic workflow

## Standard sequence

1. Use `get_project_info` when the relevant project or sheet is not yet known.
2. Use `create_doc` only when the required project or schematic file does not
   exist.
3. Read exactly the target sheet with `get_schematic`.
4. Find every real component with `component_search` and retain its exact
   `part_uuid`.
5. Use `search_reused_block` only when an existing functional block is useful.
6. Call `extract_circuit` with the target `.kicad_sch` path and the requested
   circuit modification.
7. Read the target again when the resulting circuit must be inspected.

Use only tools currently advertised by the connected server.

## File synchronization warning

KiCad Copilot modifies the saved file on disk. An already open KiCad editor
does not provide reliable two-way synchronization with these changes.

Before an MCP write:

- save intentional editor changes;
- avoid keeping newer unsaved work only in the editor.

After an MCP write:

- reload or reopen the document in KiCad;
- do not save an older editor buffer over the modified file.

## Scope

`get_schematic` reads one `.kicad_sch` file. It does not automatically combine
child sheets. Modify each hierarchical sheet by its own path.

Successful mutating tools normally return only `ok` to conserve context.
