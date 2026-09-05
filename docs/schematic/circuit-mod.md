# Circuit modification rules

## Component search

For a native symbol or reusable sheet, use its `part_uuid` returned by `get_schematic` or `get_project_info`. `component_search({ part_uuid })` resolves registered local assets before querying the catalogue. Reuse the returned ID; no LCSC equivalent is required.

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

- `add_components`: components or hierarchical sheet inclusions to add;
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

| Signal | Meaning |
| --- | --- |
| `GND` or `global:GND` | Project-wide net named `GND` |
| `local:ROOT:FB` | Root-page local net named `FB` |
| `local:power:FB` | Local net in `power.kicad_sch` |
| `hier:power:AIN` while editing `power.kicad_sch` | Hierarchical label `AIN` inside this file |
| `hier:ADC_A:AIN` on a page containing `ADC_A` | Pin `AIN` of that sheet inclusion |
| `global:NC` | Real net named `NC`, distinct from the no-connect marker |

Copy scoped names from `get_schematic`. A file's scope is `ROOT` for the project root, otherwise its path relative to the project directory without `.kicad_sch`, using `/` (for example `blocks/adc`). A scope identifies the edited file definition; native instance paths keep repeated inclusions electrically separate. A file used outside a project is its own `ROOT`.

The first two colons separate `local`/`hier`, the sheet, and the name. The rest of the string is the literal name, including `/`, `~`, or further colons. There is no additional escaping. Explicit `global:` consumes only its first colon.

The adapter validates and resolves these references before layout. It strips the addressing prefix when writing native labels. Local references to another file are errors, never global fallbacks. Hierarchical references on a parent must identify an existing pin (or a pin of a sheet added in the same call). Connecting within a child can create a new hierarchical label; existing inclusions receive matching pins. New ports default to bidirectional; existing port directions are retained.

Wire sections remain native wires. Generated net markers use the resolved native label type, including when the server proposes a power-style service component. Existing power symbols keep their native meaning. Local and global labels with the same literal name on one page cannot represent independent nets; conflicting requests are rejected.

Schematic buses currently require expansion before using component layout; unsupported bus wiring is rejected rather than silently flattened.

## Removal and replacement

Remove components by base designator. Removing `U1` affects all its units.
An exact unit designator such as `U1.2` selects only that unit. For a sheet, use its returned designator; the source file is not deleted.
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
