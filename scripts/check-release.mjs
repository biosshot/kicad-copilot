import { readFile } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
for (const [name, version] of Object.entries(pkg.dependencies)) {
    if (/^(file:|link:|workspace:)/.test(version)) {
        throw new Error(`${name} uses ${version}. Publish the compatible backend first, then pin its registry version before publishing KiCad Copilot. Bundled skills may use the tested local backend.`);
    }
}
console.log('Release dependencies are portable.');
