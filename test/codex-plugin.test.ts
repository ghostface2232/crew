import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { codexHooks, crewHooks, hookTrust, installCodexHooks, launcherPath, listedCrewHooks, writeCodexPlugin, writeLauncher, writtenByCrew } from '../plugin/bridge/codex-plugin.ts';
import type { HooksFile } from '../plugin/bridge/codex-plugin.ts';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-codex-plugin-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

const sourceHooks = () => JSON.parse(fs.readFileSync('plugin/hooks/codex.json', 'utf8'));

/** A built marketplace as scripts/bundle-plugin.mjs lays it out, with this checkout's Codex templates. */
function built(name: string): string {
  const root = path.join(temp, name);
  const plugin = path.join(root, 'plugin');
  for (const item of ['.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'hooks/codex-plugin.json', 'skills', 'agents']) fs.cpSync(path.join('plugin', item), path.join(plugin, item), { recursive: true });
  fs.cpSync('.claude-plugin/marketplace.json', path.join(root, '.claude-plugin', 'marketplace.json'));
  fs.mkdirSync(path.join(plugin, 'bridge'), { recursive: true });
  return root;
}

test("writeCodexPlugin points the MCP server at the app's runtime and gives the plugin no hooks of its own", () => {
  const root = built('app');
  const runtime = path.join(root, 'runtime', 'node');
  const marketplace = writeCodexPlugin(root, runtime, path.join(temp, 'codex'));
  const out = path.join(marketplace, 'plugin');
  const manifest = JSON.parse(fs.readFileSync(path.join(out, '.codex-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest, JSON.parse(fs.readFileSync('plugin/.codex-plugin/plugin.json', 'utf8')));
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
  // Codex would otherwise read Claude Code's hooks/hooks.json; Crew's own go in the user's hooks file.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, manifest.hooks), 'utf8')).hooks, {});
  assert.equal(fs.existsSync(path.join(out, 'hooks/codex.json')), false);
});

test("Crew's hooks for Codex run the launcher with each script's arguments", () => {
  const launcher = '/home/u/.crew/codex/bin/hook';
  const hooks = codexHooks(sourceHooks(), launcher, 'darwin');
  const expected = Object.values(sourceHooks().hooks).flatMap((groups: any) => groups.flatMap((group: any) => group.hooks.map((hook: any) => {
    const [, script, args] = /bridge\/([\w-]+)\.ts"(.*)$/.exec(hook.command)!;
    return `'${launcher}' ${script}${args}`;
  })));
  assert.deepEqual(crewHooks(hooks).map((hook) => hook.command), expected);
  assert.ok(expected.length > 0);
  for (const event of ['Interrupt', 'SessionEnd']) {
    // Codex warns about and clamps larger values when it loads the hook.
    assert.equal(hooks.hooks[event][0].hooks[0].timeout, 3, event);
  }
});

test('a marketplace folder Crew did not write is never replaced', () => {
  const dest = path.join(temp, 'codex-foreign');
  const checkout = path.join(dest, 'marketplace');
  fs.mkdirSync(path.join(checkout, 'plugin', 'bridge'), { recursive: true });
  fs.writeFileSync(path.join(checkout, 'plugin', 'bridge', 'mcp.ts'), 'keep');
  assert.throws(() => writeCodexPlugin(built('foreign'), '/runtime/node', dest), /not written by Crew/);
  assert.equal(fs.readFileSync(path.join(checkout, 'plugin', 'bridge', 'mcp.ts'), 'utf8'), 'keep');
});

test("installCodexHooks keeps the user's hooks and replaces Crew's where they stand", () => {
  const dir = path.join(temp, 'codex-home');
  const file = path.join(dir, 'hooks.json');
  const launcher = '/home/u/.crew/codex/bin/hook';
  const crew = (args: string, timeout = 5): HooksFile => ({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `'${launcher}' context${args}`, timeout }] }],
    Stop: [{ hooks: [{ type: 'command', command: `'${launcher}' wake stop-json${args}`, timeout }] }],
  } });
  const mine = { hooks: [{ type: 'command', command: 'echo mine' }] };
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ note: 'kept', hooks: { SessionStart: [mine], PreToolUse: [mine] } }));
  assert.equal(installCodexHooks(file, crew(''), launcher, 'darwin'), true);
  const first = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(first.note, 'kept');
  assert.deepEqual(first.hooks.SessionStart, [mine, crew('').hooks.SessionStart[0]]);
  assert.deepEqual(first.hooks.PreToolUse, [mine]);
  assert.deepEqual(first.hooks.Stop, crew('').hooks.Stop);

  // The same hooks leave the file as it is, however it is formatted.
  fs.writeFileSync(file, JSON.stringify(first));
  assert.equal(installCodexHooks(file, crew(''), launcher, 'darwin'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(first));

  // A group the user adds after Crew's keeps its place, and Crew's keeps its index when it changes.
  const later = { hooks: [{ type: 'command', command: 'echo later' }] };
  fs.writeFileSync(file, JSON.stringify({ ...first, hooks: { ...first.hooks, SessionStart: [...first.hooks.SessionStart, later] } }));
  installCodexHooks(file, { hooks: { SessionStart: crew(' --x', 7).hooks.SessionStart } }, launcher, 'darwin');
  const second = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(second.hooks.SessionStart, [mine, crew(' --x', 7).hooks.SessionStart[0], later]);
  // An event Crew no longer hooks loses Crew's group, and the event goes once it is empty.
  assert.equal(second.hooks.Stop, undefined);

  // A file that is not a hooks file is left as it is.
  fs.writeFileSync(file, '{"hooks": []}');
  assert.throws(() => installCodexHooks(file, crew(''), launcher, 'darwin'), /not a Codex hooks file/);
  fs.writeFileSync(file, '{"hooks": {"Stop": {}}}');
  assert.throws(() => installCodexHooks(file, crew(''), launcher, 'darwin'), /not a list/);
  fs.writeFileSync(file, 'not json');
  assert.throws(() => installCodexHooks(file, crew(''), launcher, 'darwin'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');

  // Without a hooks file Crew writes one.
  fs.rmSync(file);
  installCodexHooks(file, crew(''), launcher, 'darwin');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), crew(''));
});

test('the launcher is rewritten for each build while the hook commands name the same path', () => {
  const dir = path.join(temp, 'codex-stable', 'bin');
  const first = writeLauncher(dir, '/runtime-1/node', '/build-1/bridge', '.js', 'darwin');
  const second = writeLauncher(dir, '/runtime-2/node', '/build-2/bridge', '.js', 'darwin');
  assert.equal(first, second);
  assert.equal(second, launcherPath(dir, 'darwin'));
  assert.match(fs.readFileSync(second, 'utf8'), /runtime-2/);
  assert.match(fs.readFileSync(path.join(dir, 'hook.mjs'), 'utf8'), /build-2/);
  assert.equal(launcherPath(dir, 'win32'), path.join(dir, 'hook.cmd'));
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
  const launcher = writeLauncher(path.join(temp, 'codex-launch'), process.execPath, bridge, '.js', 'darwin');
  const res = spawnSync('/bin/sh', ['-c', `'${launcher}' probe stop-json`], { input: '{"session_id":"t"}', encoding: 'utf8' });
  assert.equal(res.status, 3);
  assert.equal(res.stdout, '["stop-json"]{"session_id":"t"}');
  // Once Crew is removed, the hooks left in the user's file do nothing.
  const gone = spawnSync('/bin/sh', ['-c', `'${launcher}' removed stop-json`], { input: '{}', encoding: 'utf8' });
  assert.equal(gone.status, 0);
  assert.equal(gone.stdout, '');
});

test('Windows hook commands call the launcher through pwsh', () => {
  const hooks = codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/bridge/wake.ts" stop-json', timeout: 5 }] }] } }, "C:\\Users\\O'Neil\\.crew\\codex\\bin\\hook.cmd", 'win32');
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0], { type: 'command', command: "& 'C:\\Users\\O''Neil\\.crew\\codex\\bin\\hook.cmd' wake stop-json; exit $LASTEXITCODE", timeout: 5 });
});

test('a hook in another form is refused rather than written wrong', () => {
  assert.throws(() => codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node x.js' }] }] } }, '/hook', 'darwin'), /Cannot rewrite/);
});

test("Crew's hooks are found in Codex's hooks/list by event, command and file, and trusted only when every one is", () => {
  const file = path.join(temp, 'home', '.codex', 'hooks.json');
  const expected = crewHooks(codexHooks(sourceHooks(), '/home/u/.crew/codex/bin/hook', 'darwin'));
  const camel = (event: string) => event[0].toLowerCase() + event.slice(1);
  const listed = (status: (index: number) => string, other: object[] = [], source = file) => ({ data: [{ cwd: '/home', hooks: [
    ...other,
    ...expected.map((hook, index) => ({ key: `${source}:${index}`, eventName: camel(hook.event), command: hook.command, sourcePath: source, currentHash: `sha256:${index}`, trustStatus: status(index) } as Record<string, unknown>)),
  ] }] });
  const trust = (list: unknown) => hookTrust(listedCrewHooks(list, file, expected));
  assert.equal(trust(listed(() => 'trusted')), 'trusted');
  // Another hook's state is not Crew's to report, nor is a hook with Crew's command in another file.
  assert.equal(trust(listed(() => 'trusted', [{ key: 'other', eventName: 'stop', command: 'echo', sourcePath: file, trustStatus: 'untrusted' }])), 'trusted');
  assert.equal(trust(listed(() => 'trusted', [], path.join(temp, 'project', '.codex', 'hooks.json'))), 'missing');
  // Codex may spell the file with the extended-length prefix on Windows.
  if (process.platform === 'win32') assert.equal(trust(listed(() => 'trusted', [], `\\\\?\\${file}`)), 'trusted');
  assert.equal(trust(listed((i) => (i === 0 ? 'modified' : 'trusted'))), 'modified');
  // A hook never trusted outweighs one changed since: either way the user trusts them again, but the first never ran.
  assert.equal(trust(listed((i) => (i === 0 ? 'modified' : i === 1 ? 'untrusted' : 'trusted'))), 'untrusted');
  assert.equal(trust(listed(() => 'someNewState')), 'untrusted');
  const short = listed(() => 'trusted');
  short.data[0].hooks.pop();
  assert.equal(trust(short), 'missing');
  const disabled = listed(() => 'trusted');
  Object.assign(disabled.data[0].hooks[0], { enabled: false });
  assert.equal(trust(disabled), 'disabled');
  Object.assign(disabled.data[0].hooks[1], { trustStatus: 'untrusted' });
  assert.equal(trust(disabled), 'untrusted');
  assert.throws(() => listedCrewHooks({}, file, expected), /without a list/);
});

test('the compiled bridge the launcher runs is laid out by the desktop build', () => {
  // scripts/bundle-plugin.mjs copies the Codex templates into the build; without them registration cannot run.
  const script = fs.readFileSync('scripts/bundle-plugin.mjs', 'utf8');
  for (const item of ['.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'hooks/codex-plugin.json']) assert.ok(script.includes(`'${item}'`), item);
  execFileSync(process.execPath, ['--check', 'scripts/bundle-plugin.mjs']);
});
