# Mechanical validation

Read this file when placement changes the outline, holes, connectors, switches, buttons, displays, LEDs, antennas, card slots, or other user/enclosure-facing parts.

## 1. Build a mechanical inventory

For each mechanical component, record:

- designator and footprint;
- intended board side and accessible board edge;
- direction of its mating face, opening, actuator, light, or display;
- whether the body must remain inside, may slide near the edge, must overhang, or has an exact location;
- required enclosure, cable, antenna, and mounting clearance.

Do not assume every connector belongs on an edge. Vertical headers, internal FFC, board-to-board connectors, and test connectors may belong inside the board.

## 2. Choose the placement primitive

- Prefer `edgePlace` for a connector or control that should stay inside near an edge. It accounts for neighboring placement and can slide to a valid nearby position.
- Use `edgeMount` when the body must physically extend beyond `Edge.Cuts`. USB, AUX, RJ45, barrel jacks, and side-entry card slots may use either primitive depending on their footprint and enclosure.
- Use `fixed` only for an exact mechanical coordinate, such as a mounting hole or enclosure-defined connector.
- Use `face: "outward"` for directional external interfaces. Use `face: "any"` only when direction is truly irrelevant.

There is no universal inset. Derive it from footprint size, mating geometry, neighboring parts, and enclosure access. Around `0.5 mm` is only a common recommendation for an inside-edge external part; compact designs may need less.

For overhang:

1. Prefer the footprint or datasheet mechanical drawing.
2. Expose the complete mating opening so the PCB edge cannot block insertion.
3. Keep electrical pads and required retention tabs supported by the PCB.
4. Do not protrude farther than needed.
5. Ask the user for the required protrusion when enclosure geometry is important and unavailable.

If automatic face detection is uncertain or reports a warning, inspect the footprint/datasheet and declare `.faceAt0(...)` before `.edgePlace(...)` or `.edgeMount(...)`.

## 3. Keepouts and access

Use the smallest justified placement keepout. A typical local mechanical keepout is below `10 mm`; do not create a blanket `20 mm` region without a datasheet, enclosure, antenna, safety, or user requirement. Verified requirements override this recommendation.

`constraintRegion` protects placement only. It does not create a copper keepout. Antennas and high-voltage/mechanical exclusions may require separate copper rules and verification.

Check plug insertion volume, cable bend direction, finger access, card travel, switch movement, display visibility, antenna clearance, mounting hardware, and collisions between adjacent connectors.

## 4. LLM gate before user approval

After the mechanical placement is applied:

1. Run `analyze_pcb({ path: "board.kicad_pcb", placement: true, assembly: true })`.
2. Render only needed views of the applied board with `kicad-cli`: normally the affected side, plus a closer `--zoom`/`--pan` view when connector orientation is unclear. Use a 2D SVG view when pad support or exact edge overlap must be checked.
3. Treat the solver preview as diagnostic, not the authoritative view of the saved board.
4. Verify every item below before asking for approval.

```text
[ ] correct board edge and top/bottom side
[ ] opening, actuator, LED, or display faces the intended direction
[ ] externally accessed directional connector does not face into the board
[ ] inset or overhang matches component geometry
[ ] electrical pads and required retention features remain supported
[ ] plug, cable, card, and fingers have access
[ ] nearby mechanical components do not block each other
[ ] holes, enclosure areas, and antenna regions are clear
[ ] alignment and rotations look intentional
```

Fix an obvious in-scope error such as an inward-facing USB connector before presenting the result. If a critical dimension or intended direction is unknown, ask one focused question or mark it `UNVERIFIED`; do not guess.

Then show the relevant native preview and a concise mechanical summary. Ask the user to choose `KEEP`, `FIX`, or `RESTORE`. Never restore automatically.
