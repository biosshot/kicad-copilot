# Projects and hierarchical sheets

## File-oriented model

KiCad Copilot has no selected or current project state. Tools receive a path
to the file or directory relevant to that operation.

`get_project_info` resolves `.kicad_pro` projects and returns KiCad files plus
the schematic hierarchy. Returned paths are relative to the directory holding
the root `.kicad_pro` file.

## Creating documents

`create_doc` supports:

- `project`: create `<name>.kicad_pro` and matching `<name>.kicad_sch`;
- `schematic`: create one standalone `.kicad_sch`;
- `schematic_page`: create a child `.kicad_sch` and add its sheet symbol to a
  specified parent schematic.

Existing destination files are never overwritten. A child sheet name is
derived from its filename, and its `Sheetfile` reference is relative to the
parent schematic.

## Hierarchy

Each physical `.kicad_sch` file is read and modified separately. A sheet file
can appear in a hierarchy through a parent sheet reference. Use the physical
file path supplied by the project tree when targeting a child sheet.
