---
name: kicad-copilot-mcp
description: Create, modify, place, route, or review KiCad schematics and PCBs with KiCad Copilot MCP tools. Supports independent schematic, placement, copper, routing, and verification tasks.
---

# KiCad Copilot MCP

Complete only the stage requested by the user. A schematic task does not authorize PCB work; placement does not authorize routing.

## Start

1. Call `get_project_info` once when exact files or hierarchy are unknown.
2. Select one task mode and read only its references.
3. Inspect the exact target before changing it.
4. Prefer a small number of well-scoped tool calls, but split work when an intermediate check reduces risk.

| Task | Read | Stop when |
|---|---|---|
| Complete schematic-to-PCB project | `workflow.md`, then each stage reference when reached | requested final stage is checked |
| Inspect or create project/sheets | `schematic/project-and-sheets.md` | hierarchy is known or created |
| Create/modify/beautify schematic | `schematic/workflow.md`, then `schematic/circuit-mod.md` | schematic checks are reported |
| Analyze only | `analysis.md` | requested report is returned; make no mutations |
| Place or update PCB components | `pcb-layout/instructions.md`, `pcb-layout/dsl.ts` | placement is checked; do not route |
| Change connectors, outline, holes, controls, displays, or antennas | `pcb-layout/mechanical-validation.md` plus placement docs | LLM and user review mechanics |
| Apply stackup, rules, zones, copper, or routing | `pcb-routing/instructions.md`, `pcb-routing/dsl.d.ts` | requested PCB operation is checked |
| Release or fabrication review | `verification.md`, then only relevant domain references | required gates and skipped checks are reported |
| Run native checks, previews, or exports | `kicad-cli.md` | requested artifact/check is complete |
| Recover a file | `schematic/checkpoints.md` | user-selected checkpoint is restored |

## Required behavior

- Use exact paths. `get_schematic` reads one physical `.kicad_sch` sheet.
- New or substantially expanded schematics must use functional hierarchical sheets.
- Run `beautify_schematic` after removal, replacement, or connection reassignment. It rebuilds and repositions only the listed components.
- Long operations are complete only after `wait_operation` returns a terminal result.
- `make_pcb_layout` and `run_pcb_router_dsl` apply returned results after creating a PCB checkpoint, including issue-bearing results.
- Use focused analysis flags. Do not use `all: true` by default.
- `analyze_schematic` does not run ERC. `analyze_pcb` does not run DRC. Use native `kicad-cli` checks when verification is required.
- Do not restore a successfully applied result automatically. Stop, report evidence, and ask the user to choose `KEEP`, `FIX`, or `RESTORE`.

## Finish

Report:

```text
CHANGED: exact files or none
CHECKS: PASS / WARN / FAIL / SKIPPED
OPEN ISSUES: concise findings
CHECKPOINT: id when relevant
NEXT: only the next stage the user requested
```
