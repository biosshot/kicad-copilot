# Troubleshooting

## `kicad-cli not found`

Install KiCad 9 or 10, add `kicad-cli` to `PATH`, or set
`KICAD_CLI_PATH` to its executable.

## `unsupported KiCad version`

The first version supports KiCad 9 and 10. Use a supported `kicad-cli` for
creating and validating files.

## EasyEDA2KiCad installation failed

Real component conversion requires Python. KiCad Copilot tries to create an
isolated converter environment automatically. Confirm that Python and network
access are available; global Python packages do not need to be modified.

## File changed during operation

Another process saved the target after KiCad Copilot read it. Reload the file,
inspect the newer content, and repeat the requested change.

## KiCad still shows the old circuit

Reload or reopen the schematic. MCP modifies the disk file and does not force
an open KiCad editor buffer to reload.

## KiCad overwrote MCP changes

An older unsaved editor buffer was probably saved after the MCP operation.
Use `list_checkpoints` and `restore_checkpoint` when available, then reopen the
restored file in KiCad.

## `no free area on schematic sheet`

The assembled block does not fit the target sheet or overlaps retained
content. Increase the top-level `(paper ...)` size in the target `.kicad_sch`
file, for example from `(paper "A4")` to `(paper "A3")`, then retry.
