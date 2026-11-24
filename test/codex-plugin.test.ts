import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { codexHooks, hookKeys, hookTrust, writeCodexPlugin, writtenByCrew } from '../plugin/bridge/codex-plugin.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-codex-plugin-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const sourceHooks = () => JSON.parse(fs.readFileSync('plugin/hooks/codex.json', 'utf8'));

/** A built marketplace as scripts/bundle-plugin.mjs lays it out, with this checkout's Codex templates. */
function built(name: string): string {
  const root = path.join(temp, name);
  const plugin = path.join(root, 'plugin');
  for (const item of ['.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'skills', 'agents']) fs.cpSync(path.join('plugin', item), path.join(plugin, item), { recursive: true });
  fs.cpSync('.claude-plugin/marketplace.json', path.join(root, '.claude-plugin', 'marketplace.json'));
  fs.mkdirSync(path.join(plugin, 'bridge'), { recursive: true });
  return root;
}

test("writeCodexPlugin points the MCP server and hooks at the app's runtime and compiled bridge", () => {
  const root = built('app');
  const runtime = path.join(root, 'runtime', 'node');
  const { marketplace, launcher } = writeCodexPlugin(root, runtime, path.join(temp, 'codex'), 'darwin');
  const out = path.join(marketplace, 'plugin');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, '.codex-plugin/plugin.json'), 'utf8')), JSON.parse(fs.readFileSync('plugin/.codex-plugin/plugin.json', 'utf8')));
  assert.deepEqual(fs.readdirSync(path.join(out, 'skills')).sort(), fs.readdirSync('plugin/skills').sort());
  assert.ok(fs.existsSync(path.join(marketplace, '.claude-plugin/marketplace.json')));
  // The skills name their subagents' instructions relative to themselves; Codex copies only the plugin folder.
  for (const skill of ['run', 'review']) {
    const text = fs.readFileSync(path.join(out, 'skills', skill, 'SKILL.md'), 'utf8');
    for (const [, ref] of text.matchAll(/`(\.\.\/\.\.\/agents\/[\w.-]+)`/g)) assert.ok(fs.existsSync(path.resolve(out, 'skills', skill, ref)), `${skill}: ${ref}`);
  }
  assert.ok(writtenByCrew(marketplace));

  const mcp = JSON.parse(fs.readFileSync(path.join(out, 'codex.mcp.json'), 'utf8'));
  // No cwd: the server starts in the session's folder, not Codex's cache.
  assert.deepEqual(mcp.mcpServers.crew, { command: runtime, args: [path.join(root, 'plugin', 'bridge', 'mcp.js')] });

  const hooks = JSON.parse(fs.readFileSync(path.join(out, 'hooks/codex.json'), 'utf8'));
  const commands = Object.values(hooks.hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks.map((hook: any) => hook.command)));
  const expected = Object.values(sourceHooks().hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks.map((hook: any) => {
    const [, script, args] = /bridge\/([\w-]+)\.ts"(.*)$/.exec(hook.command)!;
    return `'${launcher}' ${script}${args}`;
  })));
  assert.deepEqual(commands, expected);
  assert.ok(commands.length > 0);
});

test('a marketplace folder Crew did not write is never replaced', () => {
  const dest = path.join(temp, 'codex-foreign');
  const checkout = path.join(dest, 'marketplace');
  fs.mkdirSync(path.join(checkout, 'plugin', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'plugin', 'bridge', 'mcp.ts'), 'keep');
  assert.throws(() => writeCodexPlugin(built('foreign'), '/runtime/node', dest, 'darwin'), /not written by Crew/);
  assert.equal(fs.readFileSync(path.join(checkout, 'plugin', 'bridge', 'mcp.ts'), 'utf8'), 'keep');
  assert.equal(fs.existsSync(path.join(dest, 'bin')), false);
});

test('hook commands stay the same across builds, so Codex keeps trusting them', () => {
  const dest = path.join(temp, 'codex-stable');
  const first = writeCodexPlugin(built('build-1'), '/runtime-1/node', dest, 'darwin');
  const before = fs.readFileSync(path.join(first.marketplace, 'plugin/hooks/codex.json'), 'utf8');
  const second = writeCodexPlugin(built('build-2'), '/runtime-2/node', dest, 'darwin');
  assert.equal(fs.readFileSync(path.join(second.marketplace, 'plugin/hooks/codex.json'), 'utf8'), before);
  assert.match(fs.readFileSync(second.launcher, 'utf8'), /runtime-2/);
});

test('the launcher runs the named script in its own process, passing arguments, output and exit status', { skip: process.platform === 'win32' }, () => {
  const root = built('launch');
  const bridge = path.join(root, 'plugin', 'bridge');
  // A script that, like wake.ts, acts only when it is the entry point.
  fs.writeFileSync(path.join(bridge, 'probe.js'), [
    "import { fileURLToPath } from 'node:url';",
    'if (process.argv[1] === fileURLToPath(import.meta.url)) {',
    "  process.stdout.write(JSON.stringify(process.argv.slice(2)) + fs.readFileSync(0, 'utf8'));",
    '  process.exit(3);',
    '}',
    "import fs from 'node:fs';",
  ].join('\n'));
  fs.writeFileSync(path.join(bridge, 'package.json'), '{"type":"module"}');
  const { launcher } = writeCodexPlugin(root, process.execPath, path.join(temp, 'codex-launch'), 'darwin');
  const res = spawnSync('/bin/sh', ['-c', `'${launcher}' probe stop-json`], { input: '{"session_id":"t"}', encoding: 'utf8' });
  assert.equal(res.status, 3);
  assert.equal(res.stdout, '["stop-json"]{"session_id":"t"}');
});

test('Windows hook commands call the launcher through pwsh', () => {
  const hooks = codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/bridge/wake.ts" stop-json', timeout: 5 }] }] } }, "C:\\Users\\O'Neil\\.crew\\codex\\bin\\hook.cmd", 'win32');
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0], { type: 'command', command: "& 'C:\\Users\\O''Neil\\.crew\\codex\\bin\\hook.cmd' wake stop-json; exit $LASTEXITCODE", timeout: 5 });
});

test('a hook in another form is refused rather than written wrong', () => {
  assert.throws(() => codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } }, '/hook', 'darwin'), /Cannot rewrite/);
});

test("hookTrust reads Codex's hooks/list for every Crew hook", () => {
  const keys = hookKeys(sourceHooks(), 'hooks/codex.json');
  assert.ok(keys.includes('crew@crew:hooks/codex.json:session_start:0:0'));
  assert.ok(keys.includes('crew@crew:hooks/codex.json:user_prompt_submit:0:0'));
  const listed = (status: (key: string, index: number) => string, other: object[] = []) =>
    ({ data: [{ cwd: '/home', hooks: [...other, ...keys.map((key, index) => ({ key, pluginId: 'crew@crew', trustStatus: status(key, index) }))] }] });
  assert.equal(hookTrust(listed(() => 'trusted'), keys), 'trusted');
  // Another plugin's untrusted hook is not Crew's to report.
  assert.equal(hookTrust(listed(() => 'trusted', [{ key: 'other@x:hooks.json:stop:0:0', trustStatus: 'untrusted' }]), keys), 'trusted');
  assert.equal(hookTrust(listed((_, i) => (i === 0 ? 'modified' : 'trusted')), keys), 'modified');
  // A hook never trusted outweighs one changed since: either way the user trusts them again, but the first never ran.
  assert.equal(hookTrust(listed((_, i) => (i === 0 ? 'modified' : i === 1 ? 'untrusted' : 'trusted')), keys), 'untrusted');
  assert.equal(hookTrust(listed(() => 'trusted'), [...keys, 'crew@crew:hooks/codex.json:post_compact:0:0']), 'untrusted');
  assert.equal(hookTrust(listed(() => 'someNewState'), keys), 'untrusted');
  assert.throws(() => hookTrust({}, keys), /without a list/);
});

test('the compiled bridge the launcher runs is laid out by the desktop build', () => {
  // scripts/bundle-plugin.mjs copies the Codex templates into the build; without them registration cannot run.
  const script = fs.readFileSync('scripts/bundle-plugin.mjs', 'utf8');
  for (const item of ['.codex-plugin', 'codex.mcp.json', 'hooks/codex.json']) assert.ok(script.includes(`'${item}'`), item);
  execFileSync(process.execPath, ['--check', 'scripts/bundle-plugin.mjs']);
});
