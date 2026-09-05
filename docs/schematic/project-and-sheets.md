# Projects and hierarchical sheets

KiCad Copilot is file-oriented. Tools have no implicit current project or selected sheet.

## Required hierarchy

New or substantially expanded projects must use hierarchical sheets.

- Keep the root sheet as a readable project overview with child-sheet symbols.
- Put one coherent subsystem on each child sheet, for example `power`, `mcu`, `usb`, `sensors`, or `motor-driver`.
- Keep an IC with its local decoupling and closely related support parts; do not create one sheet per small IC.
- Split a sheet when it contains independent functions or is no longer understandable as one block.
- Use stable descriptive filenames and net names.

`create_doc({ doc: { doc_type: "schematic_page", path, parent_path } })` creates a child file and its first sheet symbol in the parent. Its API is unchanged. Hierarchical signals added inside the child through `extract_circuit` create labels and synchronize the pins of the file's existing inclusions.

Do not silently reorganize a flat user schematic during a small unrelated edit. Propose the required sheet plan first and migrate only after user approval.

## Tools

- `get_project_info({ path })` returns projects, files, the schematic tree, and discovered `kicad-cli`. Each schematic node includes `part_uuid`: its file UUID without hyphens.
- `create_doc({ doc: { doc_type: "project", path } })` creates matching `.kicad_pro` and root `.kicad_sch` files.
- `create_doc({ doc: { doc_type: "schematic_page", path, parent_path } })` creates one child sheet.
- `create_doc` never overwrites an existing destination.

Each `.kicad_sch` is read and modified separately. Resolve returned relative paths against the project directory and pass the exact physical sheet path to schematic tools.

## Reuse a sheet as a component

1. Obtain its `part_uuid` from `get_project_info`. `component_search({ part_uuid })` resolves the local interface; pin numbers are hierarchical label names.
2. Pass that UUID to `extract_circuit.add_components` on any parent page, with a unique designator and ordinary `pins` connections. The adapter creates a native KiCad sheet referencing the existing file.
3. Repeat with the same UUID and a different designator to add another inclusion. Existing native sheet and symbol UUIDs are preserved during beautification.
4. Use `external_connect`, `external_rm_connect`, `beautify_schematic`, and `rm_components` as for other components. Removing an inclusion leaves its source file intact.

`get_schematic` returns only objects on the requested page. Child sheets appear in `components`; their contents are read separately. Native symbols without catalogue IDs receive local geometry IDs and use the same layout path.

One file means shared contents and interface. Editing that file affects all its inclusions; their local nets remain electrically separate. Independent contents require separate files. A circular inclusion, missing pin, ambiguous duplicate file UUID, or foreign local signal is an error. No `reuse_existing` flag or separate placement tool is required.

## Sheet size

Prefer another functional sheet over making one page extremely large. If one coherent block still does not fit, save a checkpoint and enlarge that sheet's top-level `(paper ...)` entry, for example from `A4` to `A3`, while preserving valid S-expression syntax.
