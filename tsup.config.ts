import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const sdkDistDir = dirname(dirname(require.resolve('@modelcontextprotocol/sdk/package.json')));
const sdkEsmPath = (...parts: string[]) => join(sdkDistDir, 'esm', ...parts);

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        cli: 'src/cli.ts',
        'assemble-schematic': 'scripts/assemble-schematic.ts',
        'test-assembly-scenarios': 'scripts/test-assembly-scenarios.ts',
        'test-extract-regressions': 'scripts/test-extract-regressions.ts',
        'test-pcb-scenarios': 'scripts/test-pcb-scenarios.ts',
        'test-footprint-spec': 'scripts/test-footprint-spec.ts',
        'test-pcb-live': 'scripts/test-pcb-live.ts',
        'test-routing-live': 'scripts/test-routing-live.ts',
        'test-routing-integration': 'scripts/test-routing-integration.ts',
        'test-analysis': 'scripts/test-analysis.ts',
        'test-schematic-hierarchy': 'scripts/test-schematic-hierarchy.ts',
        'test-mcp-ldo': 'scripts/test-mcp-ldo.ts',
        'test-schematic-matrix': 'scripts/test-schematic-matrix.ts',
    },
    format: ['esm'],
    clean: true,
    dts: false,
    sourcemap: false,
    // Keep eda-copilot-router external so its package-relative KRT assets remain
    // discoverable after kicad-copilot-mcp is installed from npm.
    noExternal: ['@modelcontextprotocol/sdk'],
    esbuildPlugins: [
        {
            name: 'mcp-sdk-extensionless-imports',
            setup(build) {
                // The stdio client uses cross-spawn's native CommonJS loader.
                build.onResolve({ filter: /^@modelcontextprotocol\/sdk\/client\// }, args => ({
                    path: args.path, external: true,
                }));
                build.onResolve({ filter: /^@modelcontextprotocol\/sdk\/server\/mcp$/ }, () => ({
                    path: sdkEsmPath('server', 'mcp.js'),
                }));

                build.onResolve({ filter: /^@modelcontextprotocol\/sdk\/server\/stdio$/ }, () => ({
                    path: sdkEsmPath('server', 'stdio.js'),
                }));
            },
        },
    ],
});
