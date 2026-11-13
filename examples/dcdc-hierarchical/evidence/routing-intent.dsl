// Provisional test-board assumption: JLCPCB 2-layer FR-4, 1.6 mm, 1 oz finished outer copper, Dk 4.5.
// Dielectric thickness is the nominal remainder after 35 um top and bottom copper (1.53 mm).
// This board has no controlled-impedance nets; this approximation is only for routing/current modelling.
// Current assumptions: 0.30 A per independent output test load; VIN12 0.50 A is a conservative planning bound, not a measurement.
stack({
  boardThicknessMm: 1.6,
  fallbackCopperThicknessOz: 1,
  layers: [
    { kind: "copper", name: "TOP", thicknessOz: 1 },
    { kind: "dielectric", material: "FR-4", thicknessMm: 1.53, relativePermittivity: 4.5 },
    { kind: "copper", name: "BOTTOM", thicknessOz: 1 }
  ]
});
drc({
  trackWidthMm: 0.3,
  minTrackWidthMm: 0.2,
  clearanceMm: 0.2,
  edgeClearanceMm: 0.25,
  holeToHoleClearanceMm: 0.25,
  allowedLayers: "OUTER",
  via: { diameterMm: 0.6, drillMm: 0.3, minDiameterMm: 0.6, minDrillMm: 0.3 }
});
powerNet("/PowerSubsystem/VIN12", { maxCurrentA: 0.5, priority: "high", allowedLayers: "OUTER" });
powerNet("/PowerSubsystem/3V_A", { maxCurrentA: 0.3, priority: "high", allowedLayers: "OUTER" });
powerNet("/PowerSubsystem/3V_B", { maxCurrentA: 0.3, priority: "high", allowedLayers: "OUTER" });
powerNet("/PowerSubsystem/5V_OUT", { maxCurrentA: 0.3, priority: "high", allowedLayers: "OUTER" });
plane({
  net: "/PowerSubsystem/GND",
  layers: "OUTER",
  stitching: { gridMm: 8, maxVisibleViaDistanceMm: 10, via: { diameterMm: 0.6, drillMm: 0.3 } }
});
runAll();


