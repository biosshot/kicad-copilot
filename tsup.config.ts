import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig, type Options } from 'tsup';

const require = createRequire(import.meta.url);
const sdkDistDir = dirname(dirname(require.resolve('@modelcontextprotocol/sdk/package.json')));
const sdkEsmPath = (...parts: string[]) => join(sdkDistDir, 'esm', ...parts);

const shared: Options = {
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
};

export default defineConfig([
    { ...shared, entry: { index: 'src/index.ts', cli: 'src/cli.ts' } },
    { ...shared, outDir: 'dist-tests', entry: ['scripts/assemble-schematic.ts', 'scripts/test-*.ts'] },
]);
