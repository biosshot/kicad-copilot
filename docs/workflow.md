# Workflow

Every stage can start and finish independently. Before acting, set the requested end stage and do not continue beyond it.

## Shared loop

```text
SCOPE -> LOCATE -> INSPECT -> MUTATE -> WAIT -> ANALYZE -> NATIVE CHECK -> DECIDE -> STOP
```

- Reuse known project paths and evidence; do not repeat unchanged discovery calls.
- Prefer coherent batched mutations, but use multiple calls when staged verification is safer.
- Compare against a baseline only when editing an existing design and the comparison affects a decision.
- Report `PASS`, `WARN`, `FAIL`, and `SKIPPED` explicitly.
- Never restore an applied result without user instruction.

## Full project

Run this composition only when the user requests a complete schematic-to-PCB workflow:

1. Resolve the project and create a functional hierarchical sheet plan.
2. Create or modify each requested sheet.
3. Beautify affected blocks and run project schematic analysis plus native ERC.
4. Create/synchronize the PCB only after the schematic stage is accepted.
5. Select new or preserved placement mode.
6. If mechanics are affected, place and validate mechanical components first; obtain user approval.
7. Complete placement, run focused PCB analysis, and stop for placement approval when requested.
8. Apply only the requested stackup, rules, copper, and routing operations.
9. Run focused post-operation PCB analysis and native DRC.
10. For release work, add relevant assembly/DFM, lifecycle, thermal, EMC, and manufacturing checks; do not enable every expensive report automatically.

At any user-requested boundary, finish and report the current artifacts and checks instead of starting the next stage.
