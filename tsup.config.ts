import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

const require = createRequire(import.meta.url);
const sdkDistDir = dirname(dirname(require.resolve('@modelcontextprotocol/sdk/package.json')));
const sdkEsmPath = (...parts: string[]) => join(sdkDistDir, 'esm', ...parts);

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'assemble-schematic': 'scripts/assemble-schematic.ts',
        'test-assembly-scenarios': 'scripts/test-assembly-scenarios.ts',
        'test-extract-regressions': 'scripts/test-extract-regressions.ts',
        'test-pcb-scenarios': 'scripts/test-pcb-scenarios.ts',
        'test-footprint-spec': 'scripts/test-footprint-spec.ts',
        'test-pcb-live': 'scripts/test-pcb-live.ts',
        'test-routing-live': 'scripts/test-routing-live.ts',
        'test-router-package-adapter': 'scripts/test-router-package-adapter.ts',
        'test-krt-board-transport': 'scripts/test-krt-board-transport.ts',
        'router-package-adapter': 'src/routing/router-package-adapter.ts',
    },
    format: ['esm'],
    clean: true,
    dts: false,
    sourcemap: false,
    noExternal: ['@modelcontextprotocol/sdk', '@easyeda-copilot/router'],
    esbuildPlugins: [
        {
            name: 'mcp-sdk-extensionless-imports',
            setup(build) {
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
