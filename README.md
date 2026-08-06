# KiCad Copilot

File-oriented MCP server for creating and modifying KiCad projects,
schematics, and PCB placement with AI agents.

KiCad Copilot works with saved KiCad files directly. It does not require a
KiCad IPC connection and does not modify the EasyEDA Copilot repository.

## Status

The current version supports schematic editing and placement-only PCB workflow:

- search EasyEDA components and reusable circuit blocks;
- inspect KiCad project trees and read schematics as compact JSON;
- create projects, standalone schematics, and hierarchical sheets;
- assemble real EasyEDA components into KiCad schematics;
- save, list, and restore local checkpoints;
- create empty PCB documents and import schematic changes into them;
- resolve project and KiCad footprint libraries;
- request PCB auto-placement and review its preview;
- assemble board outline, component placement, board pads, and mechanical holes.

PCB routing and live synchronization with an open KiCad editor are not included.
Save or close the target file before an MCP mutation, then reopen or revert it
in KiCad afterward.

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

Run the assembly pipeline directly, without MCP Inspector:

```bash
npm run test:assemble -- path/to/request.json
```

The current local smoke payload is available at `scripts/request.json`:

```bash
npm run test:assemble -- scripts/request.json
```

Pass an optional second path to retain the raw server assembly response:

```bash
npm run test:assemble -- request.json server-response.json
```

The JSON uses the same `extract_circuit` input, including `path`. The script
reads the existing schematic, saves a checkpoint, calls the Circuit Copilot
server, applies the response, validates the result through KiCad, and prints
the resulting component/net JSON.
It exits with an error when a requested non-empty pin signal differs after
KiCad reads the assembled file back.

Run the real-server assembly scenarios for component addition, removal, net
connection, and replacement:

```bash
npm run test:assembly-scenarios
```

Each scenario uses an independent temporary schematic and validates the final
KiCad netlist. Failed scenario artifacts are retained in the printed temporary
directory; successful runs clean up automatically.

Run the file-oriented PCB import and assembly round-trip:

```bash
npm run test:pcb-scenarios
```

It imports real project footprints, applies top and bottom placement, rebuilds
`Edge.Cuts` and NPTH holes, and validates both phases through `kicad-cli`.

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
