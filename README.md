# KiCad Copilot

File-oriented MCP server for creating and modifying KiCad projects and
schematics with AI agents.

KiCad Copilot works with saved KiCad files directly. It does not require a
KiCad IPC connection and does not modify the EasyEDA Copilot repository.

## Status

Early working version focused on schematics. It can:

- search EasyEDA components and reusable circuit blocks;
- inspect KiCad project trees and read schematics as compact JSON;
- create projects, standalone schematics, and hierarchical sheets;
- assemble real EasyEDA components into KiCad schematics;
- save, list, and restore local checkpoints.

PCB tools and live synchronization with an open KiCad editor are not included.
Save or close the target schematic in KiCad before an MCP mutation, then reopen
or revert it in the editor afterward.

## Run from source

```bash
npm install
npm run build
node dist/index.js
```

Inspect the MCP server locally:

```bash
npm run inspect
```

## npm usage

```bash
npx -y kicad-copilot-mcp
```

The package includes local AI-agent instructions in `docs/SKILL.md`. Workflow
tool descriptions expose its absolute installed path.

## Requirements

- Node.js 20 or newer
- KiCad 9 or 10 for KiCad file operations
- Python 3 only when EasyEDA2KiCad is not already installed

KiCad Copilot looks for `kicad-cli` in `PATH` and standard installation
locations. `KICAD_CLI_PATH` may point to a non-standard executable. The first
real-component conversion automatically installs EasyEDA2KiCad into a managed
local virtual environment if no existing command is found.

## License

MIT
