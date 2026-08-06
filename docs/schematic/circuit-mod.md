# Circuit modification rules

## Component search

`component_search` accepts an exact `part_uuid` or exact MPN. Do not invent a
UUID. When search returns multiple results, select the part that satisfies the
electrical and packaging requirements.

## Extraction request

`extract_circuit` accepts circuit changes and one local `path` to an existing
`.kicad_sch` file.

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
use KiCad power-style symbols at the wire endpoints. Internal named nets may
receive one local label so their names survive a KiCad netlist round trip.

## Removal and replacement

Remove components by base designator. Removing `U1` affects all its units.
Request an explicit replacement by putting the old designator in
`rm_components` and the new component with the same designator in
`add_components`.
When replacement is requested, KiCad Copilot first attempts a safe
in-place replacement. If pin mapping is unsafe, it falls back to ordinary
remove-and-assemble behavior in free sheet space.

## Reused blocks

Search by function, inspect the returned parameters and ports, then pass the
exact block UUID and requested recalculation values. Map every exposed block
port to an intentional signal name.
