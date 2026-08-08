# KiCad Copilot

AI-powered MCP server for KiCad. Create and modify schematics from natural language, search real components, work with hierarchical projects, generate PCB placement, route boards locally, and create simple copper pours directly through an AI agent.

<p align="center">
  <a href="https://github.com/biosshot/kicad-copilot/releases/latest">
    <img src="https://img.shields.io/github/v/release/biosshot/kicad-copilot?label=release" alt="Latest release">
  </a>
  <a href="https://www.npmjs.com/package/kicad-copilot-mcp">
    <img src="https://img.shields.io/npm/v/kicad-copilot-mcp" alt="npm package">
  </a>
  <a href="https://github.com/biosshot/kicad-copilot/blob/main/LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  </a>
  <a href="https://discord.gg/AXCGjTDYkq">
    <img src="https://img.shields.io/badge/Discord-7289DA?logo=discord&logoColor=white" alt="Discord">
  </a>
</p>

## What it does

KiCad Copilot gives AI agents a high-level, file-oriented interface to KiCad:

- **Generate and modify schematics**: add, remove, replace, and connect real components without editing every KiCad object individually.
- **Rebuild schematic blocks**: reorganize selected components while preserving their electrical connections.
- **Search components and reusable blocks**: resolve components by MPN or part UUID and insert proven functional circuits.
- **Work with KiCad projects**: inspect project trees and create projects, standalone schematics, hierarchical sheets, and PCB files.
- **Preserve recoverable checkpoints**: save, list, and restore exact versions of individual KiCad files.
- **Synchronize schematic and PCB**: explicitly import schematic changes into the associated board.
- **Generate PCB placement**: describe board constraints in a compact JavaScript DSL, review PNG/SVG previews, and apply the approved result.
- **Route locally**: use the bundled WASM router without sending routing work to an external service.
- **Create copper pours**: add simple full-board zones with optional stitching vias.
- **Use native KiCad tooling**: discover `kicad-cli` for ERC, DRC, previews, exports, manufacturing files, and other native operations.

KiCad Copilot works directly with saved `.kicad_pro`, `.kicad_sch`, and `.kicad_pcb` files. It does not require KiCad IPC or a plugin installed inside KiCad.

## Installation

Add the MCP server to your AI agent.

Codex:

```bash
codex mcp add kicad-copilot -- npx -y kicad-copilot-mcp
```

Claude Code:

```bash
claude mcp add kicad-copilot -- npx -y kicad-copilot-mcp
```

Generic MCP configuration:

```json
{
  "mcpServers": {
    "kicad-copilot": {
      "command": "npx",
      "args": ["-y", "kicad-copilot-mcp"]
    }
  }
}
```

Restart the MCP client after adding the server. KiCad Copilot includes local workflow documentation for the agent; tool descriptions expose its installed path automatically.

## Requirements

- Node.js 20 or newer
- KiCad 9 or 10
- Python 3 only if EasyEDA2KiCad is not already available

KiCad Copilot searches for `kicad-cli` in `PATH` and standard KiCad installation locations, preferring KiCad 10 when multiple supported versions are installed. Set `KICAD_CLI_PATH` when the executable is stored elsewhere.

The first real-component conversion uses an existing EasyEDA2KiCad installation or installs it automatically into a managed local virtual environment.

## Schematic workflow

Ask the agent to inspect a KiCad project or give it the path to a target `.kicad_sch` file. A typical request can be as simple as:

```text
Open D:\Projects\sensor\sensor.kicad_pro and add a 3.3 V regulator block to the Power sheet.
```

The agent can inspect the project tree, read the target sheet as compact component/net JSON, find exact components, assemble the requested change, and validate the saved result through KiCad.

Hierarchical projects remain file-oriented: each physical schematic sheet is modified through its own `.kicad_sch` path, while project-wide context is used where the operation requires the complete signal map.

### File synchronization

KiCad Copilot changes files on disk. KiCad does not reliably merge those changes with newer unsaved edits in an already open editor.

Before a write:

1. Save intentional changes in KiCad.
2. Avoid keeping the only copy of newer work in the editor buffer.

After a write:

1. Reload, revert, or reopen the document in KiCad.
2. Do not overwrite the updated file with an older editor buffer.

## PCB workflow

PCB placement and routing use an explicit review flow:

1. Import schematic changes into the target `.kicad_pcb` file.
2. Describe the outline, holes, constraints, regions, and important components in the placement DSL.
3. Generate a mechanical preview without modifying the PCB.
4. Review the returned PNG or SVG preview.
5. Generate and approve the complete placement.
6. Apply the stored placement to the PCB.
7. Route the remaining connections locally.
8. Inspect the result and run final KiCad DRC.

Placement previews are never applied automatically. The agent receives a `layout_id` only for an explicitly generated result and uses it to assemble the intended board after review.

Routing, pours, and placement are separate operations. This keeps schematic-to-PCB synchronization explicit and makes it possible to clear or rebuild routing without deleting placed components.

## KiCad CLI

`get_project_info` reports the discovered `kicad-cli` path and version. Agents should use the native CLI whenever KiCad already provides the operation, including:

- schematic ERC and PCB DRC;
- schematic and PCB PDF/SVG exports;
- 3D PCB renders;
- Gerber and drill generation;
- BOM, position, STEP, STL, GLB, and VRML exports;
- project jobsets and format upgrades.

See [KiCad CLI workflow](docs/kicad-cli.md) for ready-to-use commands.

## Compatibility

| KiCad version | Status    |
| ------------- | --------- |
| KiCad 10      | Supported |
| KiCad 9       | Supported |

Other major versions are rejected because their file formats and CLI behavior are not covered by the current implementation.

## Documentation

- [AI agent instructions](docs/SKILL.md)
- [Circuit creation and modification](docs/circuit-maker/instructions.md)
- [Projects and hierarchical sheets](docs/schematic/project-and-sheets.md)
- [Checkpoints](docs/schematic/checkpoints.md)
- [PCB workflow](docs/pcb-layout/mcp-workflow.md)
- [PCB placement rules](docs/pcb-layout/instructions.md)
- [Placement DSL](docs/pcb-layout/dsl.ts)
- [KiCad CLI](docs/kicad-cli.md)
- [Troubleshooting](docs/troubleshooting.md)

## Development

```bash
git clone https://github.com/biosshot/kicad-copilot.git
cd kicad-copilot
npm install
npm run check
npm start
```

Run the MCP Inspector with:

```bash
npm run inspect
```

The repository also contains focused schematic, PCB, and routing test scripts for development against disposable files.

## License

MIT
