import { createRequire } from 'node:module';
import { copyFile, mkdir } from 'node:fs/promises';
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
        'test-pcb-live': 'scripts/test-pcb-live.ts',
        'test-routing-live': 'scripts/test-routing-live.ts',
        'test-router-package-adapter': 'scripts/test-router-package-adapter.ts',
        'router-package-adapter': 'src/routing/router-package-adapter.ts',
    },
    format: ['esm'],
    clean: true,
    dts: false,
    sourcemap: false,
    noExternal: ['@modelcontextprotocol/sdk', '@easyeda-copilot/router'],
    async onSuccess() {
        const target = join('dist', 'autorouter');
        await mkdir(target, { recursive: true });
        await Promise.all([
            copyFile(join('autorouter', 'pcbRouterWorker.js'), join(target, 'pcbRouterWorker.js')),
            copyFile(
                join('autorouter', 'PCBRouter-YFDILLBW-YFDILLBW.wasm'),
                join(target, 'PCBRouter-YFDILLBW-YFDILLBW.wasm'),
            ),
        ]);
    },
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
