import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readdir, lstat, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Usage: node scripts/audit-package.mjs [skill directory] [fresh output directory]
// Set KICAD_CLI_PATH when KiCad is not discoverable in the current environment.
const target = resolve(process.argv[2] || join(repo, 'skill'));
await mkdir(join(repo, '.test-output'), { recursive: true });
const output = process.argv[3] ? resolve(process.argv[3])
    : await mkdtemp(join(repo, '.test-output/package-audit-'));
await mkdir(output, { recursive: true });
const launcher = join(target, 'scripts/kicad-copilot-cli.js');
const env = { ...process.env, NODE_PATH: '', KICAD_COPILOT_CACHE_DIR: join(output, 'cache'),
    KICAD_COPILOT_CLI_HOME: join(output, 'Сессии с пробелами') };
const checks = [];
const command = (...args) => {
    const result = spawnSync(process.execPath, [launcher, ...args], { cwd: output, env,
        encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    checks.push({ args, status: result.status, stdout: result.stdout, stderr: result.stderr,
        error: result.error?.message });
    return result;
};
const success = (...args) => { const r = command(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
let id;
try {
    const links = [];
    async function walk(path) {
        for (const entry of await readdir(path, { withFileTypes: true })) {
            const child = join(path, entry.name);
            if ((await lstat(child)).isSymbolicLink()) links.push(child);
            else if (entry.isDirectory()) await walk(child);
        }
    }
    await walk(target);
    assert.deepEqual(links, [], 'portable artifact contains links');
    success('--help');
    const tools = JSON.parse(success('list')).tools;
    assert.ok(tools.length >= 15);
    const docs = new Set(tools.flatMap(tool => [...(tool.description || '').matchAll(/(?:read: |instructions: )([^\n]+\.md)/g)].map(m => m[1])));
    for (const doc of docs) { assert.ok(doc.startsWith(target), `escaped docs path ${doc}`); await access(doc); }
    assert.ok(docs.size, 'no documentation paths found');
    id = success('start');
    assert.match(id, /^[a-f0-9]{16}$/);
    success(id, 'tools', 'help', 'create_doc');
    const project = join(output, 'Проект с пробелами', 'пример.kicad_pro');
    const create = JSON.parse(success(id, 'call', 'create_doc', JSON.stringify({ doc: { doc_type: 'project', path: project } })));
    assert.ok(!create.isError, JSON.stringify(create));
    const info = JSON.parse(success(id, 'call', 'get_project_info', JSON.stringify({ path: project })));
    assert.ok(!info.isError, JSON.stringify(info));
    const batch = command(id, 'batch', JSON.stringify([
        { name: 'get_project_info', arguments: { path: project } },
        { name: 'create_doc', arguments: { doc: { doc_type: 'project', path: project } } },
        { name: 'create_doc', arguments: { doc: { doc_type: 'schematic', path: join(output, 'must-not-exist.kicad_sch') } } },
    ]));
    assert.equal(batch.status, 1);
    const results = JSON.parse(batch.stdout);
    assert.equal(results.length, 2, 'batch did not stop after failed mutation');
    assert.ok(results[1].isError);
    await assert.rejects(access(join(output, 'must-not-exist.kicad_sch')));
    assert.equal(command(id, 'call', 'not_a_tool').status, 1);
    assert.equal(command(id, 'call', 'get_project_info', '{broken').status, 1);
    success(id, 'status');
    success(id, 'stop');
    assert.equal(command(id, 'status').status, 1);
    id = undefined;
    console.log(JSON.stringify({ status: 'pass', tools: tools.length, docs: [...docs], relocated: target, checks: checks.length }));
} finally {
    if (id) command(id, 'stop', '--force');
    await writeFile(join(output, 'commands.json'), JSON.stringify(checks, null, 2));
}
