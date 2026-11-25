# Installation and CLI

Download `kicad-copilot-skill.zip` from [GitHub Releases](https://github.com/biosshot/kicad-copilot/releases/latest), then extract the complete skill into the agent's skills directory. Node.js >=20.19 is required. For `distribution: "npm"` in `build-info.json`, run `npm ci --omit=dev` in `scripts/runtime` before first use. A matching-platform `bundled` build already contains dependencies. KiCad provides `kicad-cli` for native checks and exports. ngspice and the SPICE model library are prepared when needed.

```sh
node /absolute/path/to/skill/scripts/kicad-copilot-cli.js --help
node /absolute/path/to/skill/scripts/kicad-copilot-cli.js list
node /absolute/path/to/skill/scripts/kicad-copilot-cli.js call get_project_info '{"path":"/absolute/project/path"}'
```

Start a persistent session with `start` and retain the returned ID. Use `<id> tools list`, `<id> tools help <tool>`, `<id> call <tool> [JSON|@file|-]`, `<id> batch <JSON|@file|->`, `<id> status`, and `<id> stop` when finished. `batch` accepts an array of `{ "name": "tool_name", "arguments": {} }` calls and stops on the first error. Use absolute paths and current tool schemas. Long operation IDs belong to their server session: start, wait, and inspect the result using the same session. One-shot `list`, `call`, and `batch` remain available, but cannot be used to poll an operation from a later invocation.

In a restricted agent session, set `KICAD_COPILOT_CACHE_DIR`, `COPILOT_ROUTER_CACHE_DIR`
and `KICAD_COPILOT_CLI_HOME` to separate writable directories inside the workspace
before starting the session. Set `KICAD_CLI_PATH` to the installed executable when
the sandbox redirects `LOCALAPPDATA` and automatic discovery cannot find KiCad.
Keep these paths consistent for the lifetime of the session.

From a source checkout, `npm run build:skill` creates the lightweight `skill/`; `npm run build:skill:bundled` creates a distribution for the current OS and architecture. Packaging needs installed dependencies and a compiled runtime. Install by copying the complete generated directory to the agent's skills directory; do not copy just `SKILL.md`. A generated skill can be replaced only by another generated KiCad skill.
