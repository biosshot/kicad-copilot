# Circuit modification rules

## Component search

Prefer the exact manufacturer MPN:

```ts
component_search({ MPN: "RC0805FR-071KL" })
```

If the manufacturer MPN is unknown, the `MPN` field may contain a descriptive
fallback such as `"1k 1% 0805 resistor"` or `"red LED 0805"`. Use that only to
discover candidates. Inspect the results, select a real orderable component,
and retain its exact returned `part_uuid` and manufacturer MPN.

Do not present a generic description as an exact MPN, and never invent an MPN
or UUID. Confirm package, electrical ratings, tolerance, and other requirements
before selecting among multiple results. Keep `value` concise for the schematic
(for example `1k`); use `search_query` for the descriptive lookup intent.

## Functional block grouping

Group components by a completed electrical function and its local signal path,
not by component type.

- Keep a main IC, transistor, or op-amp together with the local components that
  make its stage work: input network, feedback, gain or bias resistors,
  compensation, and local filtering.
- Do not split one amplifier stage into separate `OpAmp` and `Resistors` blocks.
- A block with only one or two components is valid only when it is a real
  self-contained function or endpoint, such as a connector, fuse, or LED with
  its series resistor. Do not use a tiny block for a fragment that belongs to a
  larger stage.
- If extraction produced fragmented block names, correct them before layout.
  Prefer one final `beautify_schematic` call containing every component of each
  affected functional block.

Example: `AmplifierStage: ["U1", "R1", "R2", "R3", "C1"]`, not separate
blocks for `U1` and its passive network.

## Extraction request

`extract_circuit` accepts circuit changes and one local `path` to an existing
`.kicad_sch` file.

Prefer combining known related changes into one call. Multiple calls are valid
for separate sheets, staged work, or when an intermediate inspection reduces
risk. Do not combine unrelated changes merely to reduce the call count.

The modification contains:

- `add_components`: real components to add;
- `add_reused_blocks`: reusable circuit blocks to add;
- `rm_components`: designators to remove, or `null`;
- `external_rm_connect`: external pin connections to break, or `null`;
- `external_connect`: otherwise untouched external pins to connect, or `null`.

Every `add_components` entry requires:

- `designator`;
- concise ASCII `value`;
- pins with `pin_number`, `name`, and `signal_name`;
- `block_name`;
- useful `search_query`;
- exact non-null `part_uuid`.

## Signals

Use one identical `signal_name` for all pins that belong to the same net.
Leave it empty only when the pin should remain unconnected. Use `NC` for a pin
that should receive an explicit KiCad no-connect marker.

GND becomes a KiCad GND power symbol. VCC and other named short symbols become
KiCad global-label ports.

Edge sections become real KiCad wires. GND and named short-symbol ports
use KiCad power-style symbols at the wire endpoints. A global label is added
only when a named external or otherwise free pin cannot use a short symbol.

## Removal and replacement

Remove components by base designator. Removing `U1` affects all its units.
Request an explicit replacement by putting the old designator in
`rm_components` and the new component with the same designator in
`add_components`.
When replacement is requested, KiCad Copilot first attempts a safe
in-place replacement. If pin mapping is unsafe, it falls back to ordinary
remove-and-assemble behavior in free sheet space.

After a removal, replacement, `external_rm_connect`, or `external_connect`
reassignment, run `beautify_schematic` once on the surviving affected block(s).
It repositions listed components, so exclude untouched user-arranged blocks.

## Reused blocks

Search by function, inspect the returned parameters and ports, then pass the
exact block UUID and requested recalculation values. Map every exposed block
port to an intentional signal name.
