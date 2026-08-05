# Checkpoints

A checkpoint is an exact snapshot of one file. It does not implicitly include
the whole KiCad project or sibling sheets.

## Tools

- `list_checkpoints({ path })`: list compact checkpoint metadata for one file.
- `save_checkpoint({ path, description? })`: save a snapshot and return its id.
- `restore_checkpoint({ path, id })`: restore one snapshot.

Descriptions are limited to 100 characters. Use a short description of the
state before the intended change.

`extract_circuit` automatically saves `Before extract_circuit`. Restoring a
checkpoint first saves the current file as `Before restore_checkpoint`.

Checkpoint data lives in the KiCad Copilot cache rather than the project.
