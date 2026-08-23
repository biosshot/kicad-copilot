# Projects and hierarchical sheets

KiCad Copilot is file-oriented. Tools have no implicit current project or selected sheet.

## Required hierarchy

New or substantially expanded projects must use hierarchical sheets.

- Keep the root sheet as a readable project overview with child-sheet symbols.
- Put one coherent subsystem on each child sheet, for example `power`, `mcu`, `usb`, `sensors`, or `motor-driver`.
- Keep an IC with its local decoupling and closely related support parts; do not create one sheet per small IC.
- Split a sheet when it contains independent functions or is no longer understandable as one block.
- Use stable descriptive filenames and net names.

`create_doc({ doc: { doc_type: "schematic_page", path, parent_path } })` creates a child file and adds its sheet symbol to the parent. It does not create hierarchical pins. For cross-sheet circuits created through the current MCP, use intentional globally named nets. Do not create future or ambiguous nets.

Do not silently reorganize a flat user schematic during a small unrelated edit. Propose the required sheet plan first and migrate only after user approval.

## Tools

- `get_project_info({ path })` returns projects, files, the schematic tree, and discovered `kicad-cli`.
- `create_doc({ doc: { doc_type: "project", path } })` creates matching `.kicad_pro` and root `.kicad_sch` files.
- `create_doc({ doc: { doc_type: "schematic_page", path, parent_path } })` creates one child sheet.
- `create_doc` never overwrites an existing destination.

Each `.kicad_sch` is read and modified separately. Resolve returned relative paths against the project directory and pass the exact physical sheet path to schematic tools.

## Sheet size

Prefer another functional sheet over making one page extremely large. If one coherent block still does not fit, save a checkpoint and enlarge that sheet's top-level `(paper ...)` entry, for example from `A4` to `A3`, while preserving valid S-expression syntax.
