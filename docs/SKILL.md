---
name: kicad-copilot-mcp
description: Use when KiCad Copilot MCP tools are available for file-oriented KiCad project and schematic work.
---

# KiCad Copilot MCP

Use this skill when a KiCad Copilot MCP server provides project, schematic,
component-search, assembly, or checkpoint tools.

The files in this directory are the authoritative local agent instructions.
Read only the smallest document needed for the task. Always use the tools the
connected server actually advertises; a document may describe workflow planned
for a newer server version.

## References

- `schematic/workflow.md`: standard file-oriented schematic workflow and the
  KiCad editor synchronization warning.
- `schematic/circuit-mod.md`: component, net, reused-block, and extraction
  request rules.
- `schematic/project-and-sheets.md`: project paths and hierarchical sheets.
- `schematic/checkpoints.md`: checkpoint behavior and recovery.
- `troubleshooting.md`: dependency, file, converter, and synchronization errors.

## Core rules

- KiCad Copilot operates on saved files, not an editor selection.
- Pass the exact target path requested by each tool.
- Read a schematic before modifying it.
- Every added real component must have a valid EasyEDA `part_uuid` obtained
  through `component_search`.
- Use checkpoints before risky manual changes.
- PCB mutation is not part of the first version.
