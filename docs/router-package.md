# Local router package adapter

KiCad remains outside the routing core. The host adapter performs three
explicit operations:

1. `importKiCadRoutingBoard(path)` parses the native board and project rules
   into the EDA-neutral `RoutingBoard`.
2. `@easyeda-copilot/router` runs the routing DSL and backend without KiCad.
3. `applyKiCadRoutingResult(context, result, outputPath)` applies the complete
   router-owned copper state to a new board, optionally writes the effective
   DRC, refills zones, and runs native KiCad verification.

The captured source is immutable. The adapter refuses to overwrite it and
also verifies that it was not changed while the offline router was running.
Existing copper is fixed by default; callers must opt into editable ownership
when they want `RoutingResult.copper` to replace it.

The local package subpath is:

```js
import {
  importKiCadRoutingBoard,
  applyKiCadRoutingResult,
} from 'kicad-copilot-mcp/router-package-adapter'
```

`applyDrcRules()` and `runAll()` materialize the effective routing rules in
the output `.kicad_pro` and `.kicad_dru`. `runRouting()` preserves the source
project rules.
