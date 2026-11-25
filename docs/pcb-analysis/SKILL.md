---
name: pcb-analysis
description: Export Board V2 from saved KiCad boards and run electrical or thermal analysis with the local KiCad Copilot PCB analysis DSL.
---

# PCB analysis in KiCad

1. Identify the saved `.kicad_pcb` and linked schematic. Use `analyze_pcb` or native KiCad inspection to locate the actual nets, component pins, and return paths. If the design relies on pours, save the intended filled board in KiCad before capture.
2. Call `export_pcb_routing_board({path})` when the captured geometry needs review. Open the returned JSON, which contains `board` and `diagnostics`. Use its canonical layer names (`TOP`, `BOTTOM`, and any inner layers), exact net names, and pad numbers in selectors.
3. Read the [analysis DSL declarations](dsl.ts) and use the [connectivity example](examples/connectivity.js) for a first run. For a physical calculation, write a trusted local JavaScript scenario using `analysis({board})`. Specify the actual source and load ports, reference layers, materials, stackup, conditions and calculation budget.
4. In a persistent CLI session, call `run_pcb_analysis({path, file, wait_ms: 1000})`. If it returns `running`, poll `wait_operation` in the same session. Use `cancel_operation` and wait for the terminal result to stop a run. The operation accepts one analysis per process and uses a 75-minute scenario deadline. An interactive shell invocation of node without a session is suitable only when the operation finishes during the initial wait.
5. Inspect the overview PNG, then read `summary.json` for each calculation's status, validity, and capture diagnostics. Consult the relevant plots and values in `result.json`. The `board_path` holds the input snapshot used for the report.

## Inputs and validity

- Capture reads the saved board and uses its associated project rules where available. It records stored layer fills and marks freshness unknown. Use `cadFill: "snapshot"` only when the saved fill is the intended input. Missing fill and incomplete or approximated geometry are reported separately.
- Use the fabricator's actual stackup, copper and via plating thickness, conductivity, permittivity and loss tangent. Use the schematic, datasheets, measurements or operating conditions for source and load models, heat loss, ambient temperature and cooling. State any material assumptions.
- Report each calculation's status and validity. A completed scenario can contain partial or unavailable calculations. Gray copper and excluded regions have unknown coverage. Physical accuracy is unverified.
- Use native KiCad DRC for rule signoff. The analyzer's geometry checks cover the supplied snapshot and scenario only.
