# PCB routing DSL

Create one local JavaScript DSL file, then call `auto_route_pcb({ path, file })`.
The complete declaration reference is in `dsl.d.ts` in this directory.

The router uses native KiCad rules by default. DSL values may define the
effective routing rules for this run. `runRouting()` routes without persisting
those overrides; `applyDrcRules()` writes rules only; `runAll()` does both.

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

No KRT installation is required. On first routing use, `eda-copilot-router`
downloads the pinned official KRT release, verifies its SHA-256, prepares the
platform module and Python dependencies in the user cache, then reuses it
offline. `COPILOT_ROUTER_KRT_DIR` and `COPILOT_ROUTER_PYTHON` are optional
development or air-gapped overrides, not user setup steps.
