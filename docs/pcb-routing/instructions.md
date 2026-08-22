# PCB routing DSL

Create one local JavaScript DSL file, then call `run_pcb_dsl({ path, file })`.
The complete declaration reference is in `dsl.d.ts` in this directory.

The router uses native KiCad rules by default. DSL values may define the
effective routing rules and physical stack. End the file with exactly one terminal:

- `applyDrcRules()` persists DRC rules without changing copper;
- `applyStackup()` applies `stack(...)` without running KRT;
- `runCopper()` applies polygons, planes, zone cleanup, and grid/around stitching without KRT;
- `runRouting()` routes without persisting DRC overrides;
- `runAll()` applies stackup/rules and performs complete routing.

Existing unlocked tracks, vias, and zones are preserved unless an explicit
`clearRouting(...)` selects them. Locked copper is always preserved.

KRT is the default backend. `eda-copilot-router` owns polygon planning, special
differential/equal-length routing, remaining routing, ground plane/stitching,
error collection, and final `RoutingResult`. KiCad imports the board once,
materializes the result in a candidate, performs refill/DRC, then commits it.

Example:

```js
powerNet("VBUS", { maxCurrentA: 2, maxTempRiseC: 16 })
polygon("VBUS")
  .connect(pad("U1", 8), pad("Q1", 1))
  .on(topLayer())
  .compact()

diffPair("usb", {
  positive: "USB_DP",
  negative: "USB_DM",
  maxSkewMm: 0.1,
})

plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  stitching: { gridMm: 5, maxPadViaDistanceMm: 10, via: "drc-min" },
})

runAll()
```

Use focused DSL operations instead of separate stack, clear, or pour tools:

```js
// Clear unlocked routing without rerouting.
clearRouting({ nets: "all", items: ["tracks", "vias"] })
runCopper()
```

```js
// Rebuild a GND plane without running KRT.
clearRouting({ nets: ["GND"], items: ["zones"] })
plane({
  net: "GND",
  layers: outerLayers(),
  region: board(),
  stitching: { gridMm: 5, via: "drc-min" },
})
runCopper()
```

For a layer-count or physical-stack change, declare the complete ordered
copper/dielectric stack and finish with `applyStackup()`. Do not guess dielectric
thickness or material when impedance-controlled routing depends on it.

No KRT installation is required. On first routing use, `eda-copilot-router`
downloads the pinned official KRT release, verifies its SHA-256, prepares the
platform module and Python dependencies in the user cache, then reuses it
offline. `COPILOT_ROUTER_KRT_DIR` and `COPILOT_ROUTER_PYTHON` are optional
development or air-gapped overrides, not user setup steps.
