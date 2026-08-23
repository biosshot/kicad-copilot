# Checkpoints

A checkpoint is an exact snapshot of one file. It does not implicitly include
the whole KiCad project or sibling sheets.

## Tools

- `list_checkpoints({ path, limit?, page? })`: list compact checkpoint metadata,
  20 items per page by default.
- `save_checkpoint({ path, description? })`: save a snapshot and return its id.
- `restore_checkpoint({ path, id })`: restore one snapshot.

Descriptions are limited to 100 characters. Use a short description of the
state before the intended change.

`extract_circuit` automatically saves `Before extract_circuit`. Restoring a
checkpoint first saves the current file as `Before restore_checkpoint`.

`beautify_schematic`, `import_pcb_changes`, `make_pcb_layout`, and
`run_pcb_router_dsl` also checkpoint the target file before applying changes.
Checkpoints are file-local: a PCB checkpoint does not include sibling
`.kicad_pro`, `.kicad_dru`, or schematic sheets.

Do not restore a successfully applied result merely because an analyzer reports
a warning or failure. Show the evidence and checkpoint, then restore only after
the user chooses `RESTORE`.

Checkpoint data lives in the KiCad Copilot cache rather than the project.
