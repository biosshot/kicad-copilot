# Hierarchical three-rail DC-DC test board

This is a complete KiCad 10 schematic and routed PCB for a self-contained test project: one 12 V input feeds three independent TPS62130 adjustable buck channels, with separate 3 V A, 3 V B, and 5 V output connectors.

## Open the project

Open `DCDC_Acceptance.kicad_pro` in KiCad 10. The project includes its symbol library, footprint library, and 3D model files under project-relative paths. No external library download is required.

## Schematic hierarchy

```text
DCDC_Acceptance
└── PowerSubsystem
    ├── Buck3V     → 3V_A
    ├── SH2         → 3V_B (second instance of Buck3V.kicad_sch)
    └── Buck5V     → 5V_OUT
```

The PowerSubsystem sheet also contains CN1 (12 V input), CN2 (3V_A), CN3 (3V_B), and CN4 (5V_OUT). Every connector has a separate GND contact. Both 3 V rails use the same child-sheet design with distinct physical references and independent passives. `previews/schematic/` contains rendered sheets, including the two repeated Buck3V instances.

## Electrical assumptions

- Input: 12 V nominal. Keep the eventual source tolerance below the regulator’s 17 V recommended maximum.
- Test load assumption: 0.30 A on each output independently (3V_A, 3V_B, and 5V_OUT). This is a chosen test operating point, not a guaranteed or measured rating.
- Router current assumptions: 0.30 A per output and 0.50 A on the shared 12 V feed. The 0.50 A input value is a conservative planning assumption; converter efficiency and thermal capacity were not measured.
- Divider values use TI’s nominal equation `VOUT = 0.8 V × (1 + Rtop/Rbottom)`: 274 kΩ / 100 kΩ gives 2.992 V nominal; 523 kΩ / 100 kΩ gives 4.984 V nominal. Reference and resistor tolerances affect actual output limits.
- The TPS62130 power-good pin (PG) is intentionally left unconnected. FSW and DEF are tied low. AVIN, PVIN, and EN use the 12 V input.
- AGND, PGND, and exposed pad 17 are tied to the common ground plane. The exposed pad is soldered.

## Board and routing assumptions

- 80 × 50 mm, two copper layers; all components on the top side.
- Provisional stack used for routing calculations: JLCPCB standard 2-layer FR-4, 1.6 mm board, 1 oz outer copper, Dk 4.5. The routing DSL represents the dielectric as the nominal 1.53 mm remainder after 35 µm top and bottom copper. This is an approximation for current/routing calculations, not a verified fabrication stack. No controlled-impedance requirement or claim is made.
- Ground copper zones are on both outer layers. Native analysis reports 71 vias and one connected ground domain; the router also reported that some local stitching vias could not be placed near QFN ground pads.
- PCB analysis reports 196 routed track segments, 71 vias, two ground zones, and zero unrouted nets. The router’s terminal summary reported 92 logical tracks; the analyzer’s 196 is the final segment count after KiCad geometry is loaded.
- The board is sparse, with converter circuitry grouped toward one side. It was accepted as a functional routing/ hierarchy test fixture, not optimized for area or fabrication release.

## Local JST footprint correction

The local project copy of the JST XH footprint has two numbered 1.8 mm plated pads for the electrical posts and one unnumbered 1.2 mm locating-boss hole. The catalogue geometry marked the unnumbered boss hole as plated copper with a 1.2 mm drill, which created zero-annulus DRC errors. The local `.pretty` footprint and its four board instances were changed to KiCad NPTH using the KiCad 10 `pcbnew` API. The numbered electrical pads remain plated. JST’s XH drawing distinguishes the electrical PCB holes from the molded boss dimensions; see the linked manufacturer catalogue below. This correction is limited to this example project and does not alter the upstream catalogue/importer.

## Verification and remaining findings

- Native KiCad 10 ERC: one error remains: `power_pin_not_driven` on an AGND power-input pin in the repeated Buck3V instance. The external input connector is passive and the available schematic operations do not provide a PWR_FLAG. This is recorded rather than suppressed.
- Native KiCad 10 DRC with zone refill: zero errors and zero unconnected items; 30 warnings remain: 28 library-footprint mismatch warnings and two silkscreen-clearance warnings on C16.
- PCB analysis: the routed connectivity is complete. It also flags missing assembly fiducials and 0/14 test-point coverage. No fiducials or test points were added because this is a functional hierarchy/routing test fixture, not an assembly-release design.
- No regulator load test, output ripple/accuracy measurement, thermal test, EMI test, transient test, or fabrication validation was performed. Check the ceramic capacitors’ effective capacitance under DC bias and review the library-footprint warnings before manufacturing.

The native ERC and DRC JSON, the independent schematic netlist, and routing intent are under `evidence/`. The board preview is under `previews/`.

## Sources

- [TI TPS62130A datasheet, Rev. F](https://www.ti.com/lit/ds/symlink/tps62130a.pdf)
- [Bourns SRP4020TA datasheet](https://www.bourns.com/docs/product-datasheets/srp4020ta.pdf)
- [JST XH connector catalogue](https://www.jst.com/wp-content/uploads/2025/06/eXH.pdf)
- [JLCPCB PCB capabilities](https://jlcpcb.com/capabilities/pcb-capabilities) and [copper-weight guide](https://jlcpcb.com/help/article/jlcpcb-copper-weight)


