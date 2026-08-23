# Verification gates

Read this file for a release, fabrication, or full-project review. For an ordinary stage task, use only that stage's checks.

Do not trust a generator's success status as verification. Combine independent evidence:

1. compact structural/design analysis;
2. native KiCad ERC or DRC;
3. visual evidence only where geometry or mechanics requires it;
4. explicit `SKIPPED` reasons for checks that could not run.

## Gates

| Gate | Required evidence |
|---|---|
| Schematic | intended hierarchy; focused connectivity/power/interface analysis; native ERC |
| PCB synchronization | expected schematic footprints/nets present; cross-domain findings reviewed |
| Placement | no unexplained outside/overlap issue; preserved components did not move; focused placement analysis |
| Mechanics | mechanical checklist complete; relevant native view reviewed; user decision recorded |
| Rules/stackup | requested settings present; focused DFM analysis; assumptions documented |
| Copper/routing | focused connectivity/routing/power analysis; native DRC; no unexplained new shorts or unconnected items |
| Release | relevant assembly/DFM plus requested lifecycle, thermal, EMC, BOM, and manufacturing outputs |

Not every warning blocks work. Classify results:

```text
PASS: required evidence is present and no blocking issue remains
WARN: known limitation or accepted risk; state owner/reason
FAIL: requested requirement or native gate is not satisfied
SKIPPED: check did not run; state why
```

If the user accepts a warning, record it; do not erase or repeatedly "fix" it. If an applied mutation fails a gate, stop dependent stages and ask `KEEP`, `FIX`, or `RESTORE`.
