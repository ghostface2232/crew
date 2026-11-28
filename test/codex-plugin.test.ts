import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { codexHooks, crewHooks, crewPluginOn, hookTrust, installCodexHooks, launcherPath, listedCrewHooks, WORKER_ENV, writeCodexPlugin, writeLauncher, writtenByCrew } from '../plugin/bridge/codex-plugin.ts';
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
  assert.deepEqual(mcp.mcpServers, {
    crew: {
      command: runtime,
      args: [path.join(root, 'plugin', 'bridge', 'mcp.js')],
      default_tools_approval_mode: 'approve',
    },
  });
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

test('a marketplace that cannot be replaced stays whole, and what an earlier attempt left behind is cleared', (t) => {
  const root = built('swap');
  const dest = path.join(temp, 'codex-swap');
  const marketplace = writeCodexPlugin(root, '/runtime/node', dest);
  const leftover = path.join(dest, 'marketplace.0123456789ab.old');
  fs.mkdirSync(leftover);
  // One another registration is building now stays.
  const building = path.join(dest, 'marketplace.ba9876543210');
  fs.mkdirSync(building);
  const hourAgo = new Date(Date.now() - 3_600_000);
  fs.utimesSync(leftover, hourAgo, hourAgo);
  // Windows refuses to move a folder another process holds open.
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    if (to === marketplace && !String(from).endsWith('.old')) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    rename(from, to);
  });
  assert.throws(() => writeCodexPlugin(root, '/runtime/node2', dest), /EPERM/);
  assert.ok(writtenByCrew(marketplace));
  assert.ok(fs.existsSync(path.join(marketplace, '.claude-plugin', 'marketplace.json')));
  assert.match(fs.readFileSync(path.join(marketplace, 'plugin', 'codex.mcp.json'), 'utf8'), /"\/runtime\/node"/);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['marketplace', 'marketplace.ba9876543210']);
  t.mock.restoreAll();
  fs.utimesSync(building, hourAgo, hourAgo);
  writeCodexPlugin(root, '/runtime/node2', dest);
  assert.match(fs.readFileSync(path.join(marketplace, 'plugin', 'codex.mcp.json'), 'utf8'), /"\/runtime\/node2"/);
  assert.deepEqual(fs.readdirSync(dest), ['marketplace']);
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

  // A handler the user put in Crew's group stays, after Crew's; a Crew handler left twice is taken out.
  const added = { type: 'command', command: 'echo added' };
  const crewStart = crew('').hooks.SessionStart[0];
  fs.writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [mine, { ...crewStart, hooks: [...crewStart.hooks, added] }, crewStart] } }));
  installCodexHooks(file, crew(''), launcher, 'darwin');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart, [mine, crewStart, { ...crewStart, hooks: [added] }]);
  // Registering the same hooks again moves nothing, a mixed group and the groups after it included.
  const next = { hooks: [{ type: 'command', command: 'echo next' }] };
  const mixed = JSON.stringify({ hooks: { SessionStart: [mine, { ...crewStart, hooks: [...crewStart.hooks, added] }, next] } });
  fs.writeFileSync(file, mixed);
  assert.equal(installCodexHooks(file, { hooks: { SessionStart: crew('').hooks.SessionStart } }, launcher, 'darwin'), false);
  assert.equal(fs.readFileSync(file, 'utf8'), mixed);
  // A handler that only mentions the launcher is the user's.
  const mention = { hooks: [{ type: 'command', command: `test -x '${launcher}' && echo ok` }] };
  fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [mention] } }));
  installCodexHooks(file, crew(''), launcher, 'darwin');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop, [mention, ...crew('').hooks.Stop]);

  // A symbolic link is written through, and the file keeps its permissions.
  if (process.platform !== 'win32') {
    const real = path.join(dir, 'dotfiles-hooks.json');
    fs.writeFileSync(real, '{}');
    fs.chmodSync(real, 0o600);
    fs.rmSync(file);
    fs.symlinkSync(real, file);
    installCodexHooks(file, crew(''), launcher, 'darwin');
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), crew(''));
    assert.equal(fs.statSync(real).mode & 0o777, 0o600);
    // A link whose target is missing gets its target written, and stays a link.
    fs.rmSync(real);
    installCodexHooks(file, crew(''), launcher, 'darwin');
    assert.ok(fs.lstatSync(file).isSymbolicLink());
    assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), crew(''));
    fs.rmSync(file);
  }
  if (process.platform === 'win32') {
    // A file whose access control list the user protected keeps it.
    fs.writeFileSync(file, '{}');
    const acl = (script: string) => spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
    const quoted = `'${file.replaceAll("'", "''")}'`;
    acl(`$a = Get-Acl -LiteralPath ${quoted}; $a.SetAccessRuleProtection($true, $true); Set-Acl -LiteralPath ${quoted} -AclObject $a`);
    const isProtected = () => acl(`(Get-Acl -LiteralPath ${quoted}).AreAccessRulesProtected`).stdout.trim();
    assert.equal(isProtected(), 'True');
    installCodexHooks(file, crew(''), launcher, 'darwin');
    assert.equal(isProtected(), 'True');
    fs.rmSync(file);
  }

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
  assert.match(fs.readFileSync(path.join(dir, 'lead-hook.mjs'), 'utf8'), /build-2/);
  // Not the `hook` an earlier Crew wrote for its plugin hooks, which an older copy would write back.
  assert.equal(launcherPath(dir, 'win32'), path.join(dir, 'lead-hook.cmd'));
  assert.equal(launcherPath(dir, 'darwin'), path.join(dir, 'lead-hook'));
});

test('the hook command runs the named script through the launcher only while Crew runs in that Codex home', () => {
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
  const codexHome = path.join(temp, 'launch-codex-home');
  fs.mkdirSync(codexHome, { recursive: true });
  const config = (text: string) => fs.writeFileSync(path.join(codexHome, 'config.toml'), text);
  /** Runs Crew's hook command for `script` as Codex would, in its shell: pwsh on Windows, sh elsewhere. */
  const hook = (launcher: string, script: string, env: Record<string, string> = {}, cwd = temp) => {
    const { command } = crewHooks(codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `node "\${PLUGIN_ROOT}/bridge/${script}.ts" stop-json` }] }] } }, launcher))[0];
    const shell = process.platform === 'win32' ? ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]] as const : ['/bin/sh', ['-c', command]] as const;
    const { NoDefaultCurrentDirectoryInExePath: _, [WORKER_ENV]: _worker, ...base } = process.env;
    return spawnSync(shell[0], [...shell[1]], { input: '{"session_id":"t"}', encoding: 'utf8', cwd, env: { ...base, CODEX_HOME: codexHome, ...env } });
  };
  const launcher = writeLauncher(path.join(temp, 'codex-launch'), process.execPath, bridge, '.js');

  config('[plugins."crew@crew"]\nenabled = true\n\n[other]\nenabled = false\n');
  const res = hook(launcher, 'probe');
  assert.equal(res.status, 3, res.stderr);
  assert.equal(res.stdout, '["stop-json"]{"session_id":"t"}');
  // A Crew worker runs none of the lead's hooks.
  assert.deepEqual([hook(launcher, 'probe', { [WORKER_ENV]: '1' }).status, hook(launcher, 'probe', { [WORKER_ENV]: '1' }).stdout], [0, '']);
  // Nor does a Codex home with Crew's plugin off, or without it.
  config('[plugins."crew@crew"]\nenabled = false\n');
  assert.deepEqual([hook(launcher, 'probe').status, hook(launcher, 'probe').stdout], [0, '']);
  config('[plugins."other@x"]\nenabled = true\n');
  assert.deepEqual([hook(launcher, 'probe').status, hook(launcher, 'probe').stdout], [0, '']);
  // Once Crew is removed, the hooks left in the user's file do nothing, whether its script or its runtime is gone.
  config('[plugins."crew@crew"]\nenabled = true\n');
  assert.deepEqual([hook(launcher, 'removed').status, hook(launcher, 'removed').stdout], [0, '']);
  const orphan = writeLauncher(path.join(temp, 'codex-orphan'), path.join(temp, 'gone', process.platform === 'win32' ? 'node.exe' : 'node'), bridge, '.js');
  assert.deepEqual([hook(orphan, 'probe').status, hook(orphan, 'probe').stdout], [0, '']);
  if (process.platform === 'win32') {
    // A source checkout's `node` is never one in the session's project folder, which cmd.exe would try first.
    const project = path.join(temp, 'project-with-node');
    fs.mkdirSync(project, { recursive: true });
    fs.copyFileSync(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'hostname.exe'), path.join(project, 'node.exe'));
    const source = writeLauncher(path.join(temp, 'codex-source'), 'node', bridge, '.js');
    const local = hook(source, 'probe', {}, project);
    assert.equal(local.status, 3, local.stderr);
    assert.equal(local.stdout, '["stop-json"]{"session_id":"t"}');
  }
});

test("crewPluginOn reads Crew's plugin state from config.toml as Codex writes it and people edit it", () => {
  const on = [
    '[plugins."crew@crew"]\nenabled = true',
    '[plugins."crew@crew"] # Installed by Crew\nenabled = true',
    "[plugins.'crew@crew']\nenabled = true\n\n[other]\nenabled = false",
    '[plugins."crew@crew"]\nenabled = true\n[other]\nname = "a # b"',
    '[plugins]\n"crew@crew" = { enabled = true }',
    '[plugins."crew@crew"]',
  ];
  const off = [
    '',
    '[plugins."other@x"]\nenabled = true',
    '[plugins."crew@crew"]\nenabled = false',
    '[plugins."crew@crew"]\n"enabled" = false',
    '[plugins."crew@crew"]\nenabled = false # off for now',
    '[features]\nplugins = false\n\n[plugins."crew@crew"]\nenabled = true',
    '[plugins]\n"crew@crew" = { enabled = false }',
    'plugins."crew@crew".enabled = false',
  ];
  for (const text of on) assert.equal(crewPluginOn(text), true, text);
  for (const text of off) assert.equal(crewPluginOn(text), false, text);
});

test('Windows hook commands call the launcher through pwsh', () => {
  const hooks = codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/bridge/wake.ts" stop-json', timeout: 5 }] }] } }, "C:\\Users\\O'Neil\\.crew\\codex\\bin\\hook.cmd", 'win32');
  assert.deepEqual(hooks.hooks.Stop[0].hooks[0], { type: 'command', command: "& 'C:\\Users\\O''Neil\\.crew\\codex\\bin\\hook.cmd' wake stop-json; exit $LASTEXITCODE", timeout: 5 });
  // PowerShell takes curly single quotes for quotes too.
  const curly = codexHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "${PLUGIN_ROOT}/bridge/wake.ts" stop-json' }] }] } }, 'C:\\Users\\O\u2019Brien\\hook.cmd', 'win32');
  assert.equal(curly.hooks.Stop[0].hooks[0].command, "& 'C:\\Users\\O\u2019\u2019Brien\\hook.cmd' wake stop-json; exit $LASTEXITCODE");
  if (process.platform === 'win32') {
    const script = path.join(temp, 'curly.ps1');
    fs.writeFileSync(script, `﻿${curly.hooks.Stop[0].hooks[0].command}`);
    const parsed = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script}', [ref]$null, [ref]$e); $e.Count`], { encoding: 'utf8' });
    assert.equal(parsed.stdout.trim(), '0', parsed.stderr);
  }
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
  // The same hook listed twice is not trusted on either's account: registering again leaves one.
  const twice = listed(() => 'trusted');
  twice.data[0].hooks.push({ ...twice.data[0].hooks[0], key: 'copy', trustStatus: 'untrusted' });
  assert.equal(listedCrewHooks(twice, file, expected)[0], undefined);
  assert.equal(trust(twice), 'missing');
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
