import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { writeFakeBin } from './fake-bin.ts';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-setup-'));
process.env.CREW_HOME = home;
const { copyPlugin, prunePlugins, SetupCache } = await import('../plugin/bridge/setup.ts');
type SetupItem = import('../plugin/bridge/setup.ts').SetupItem;
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

/** A built marketplace as the app carries it, beside the app's own files. */
function marketplace(name: string): string {
  const root = path.join(home, name);
  for (const file of ['.claude-plugin/marketplace.json', 'plugin/bridge/mcp.js', 'runtime/node.exe', 'desktop/main.js', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

test('copyPlugin copies the plugin and runtime, not the app', () => {
  const dest = path.join(home, 'plugins', '1.0.0-abc');
  copyPlugin(marketplace('app'), dest);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['.claude-plugin', 'plugin', 'runtime']);
  assert.equal(fs.readFileSync(path.join(dest, 'runtime/node.exe'), 'utf8'), 'runtime/node.exe');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['1.0.0-abc']);
});

test('copyPlugin leaves a complete copy as it is', () => {
  const dest = path.join(home, 'plugins', '1.0.1-def');
  fs.mkdirSync(path.join(dest, 'plugin'), { recursive: true });
  copyPlugin(marketplace('app2'), dest);
  assert.deepEqual(fs.readdirSync(dest), ['plugin']);
});

test('prunePlugins keeps the registered copy and copies still running, whole', async (t) => {
  const dir = path.join(home, 'prune');
  const copy = (name: string) => {
    for (const file of ['runtime/node.exe', 'runtime/LICENSE', 'plugin/bridge/mcp.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, name, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, name, file), '');
    }
    return path.join(dir, name);
  };
  const current = copy('2.0.0-new');
  copy('1.0.0-old');
  const running = copy('1.5.0-open');
  copy(`1.6.0-new.partial-${process.pid}`);
  copy('1.6.0-new.partial-999999999');
  const node = path.join(running, 'runtime', 'node.exe');
  if (process.platform === 'win32') {
    // Windows refuses to delete a running executable, which is how a copy still in use is told apart.
    fs.copyFileSync(process.execPath, node);
    const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(async () => {
      child.kill();
      await once(child, 'exit');
    });
    await once(child, 'spawn');
  } else {
    // Elsewhere a running executable can be deleted; a read-only folder refuses the same way.
    fs.chmodSync(path.dirname(node), 0o555);
    t.after(() => fs.chmodSync(path.dirname(node), 0o755));
  }
  const files = (root: string) => (fs.readdirSync(root, { recursive: true }) as string[]).sort();
  const before = files(running);
  prunePlugins(dir, [current]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.5.0-open', `1.6.0-new.partial-${process.pid}`, '2.0.0-new']);
  assert.deepEqual(files(running), before);
});

test('a complete checklist is kept ten minutes, an incomplete or failed one a minute, and a refresh always checks', async () => {
  let now = 0;
  let checks = 0;
  let answer: () => Promise<SetupItem[]> = async () => [{ id: 'claude', label: 'Claude Code', ok: true, detail: '' }];
  const cache = new SetupCache(() => { checks++; return answer(); }, () => now);
  await cache.get(false);
  now = SetupCache.COMPLETE_MS;
  await cache.get(false);
  assert.equal(checks, 1);
  now += 1;
  await cache.get(false);
  assert.equal(checks, 2);
  await cache.get(true);
  assert.equal(checks, 3);

  answer = async () => [{ id: 'codex', label: 'Codex CLI', ok: false, detail: 'Not found.' }];
  await cache.get(true);
  now += SetupCache.INCOMPLETE_MS;
  await cache.get(false);
  assert.equal(checks, 4);
  now += 1;
  await cache.get(false);
  assert.equal(checks, 5);

  // A check that fails is not a complete checklist either.
  answer = async () => [{ id: 'claude', label: 'Claude Code', ok: true, detail: '' }];
  await cache.get(true);
  answer = () => Promise.reject(new Error('Invalid config.json'));
  await assert.rejects(cache.get(true), /Invalid config/);
  now += SetupCache.INCOMPLETE_MS + 1;
  await assert.rejects(cache.get(false), /Invalid config/);
  assert.equal(checks, 8);

  cache.reset();
  answer = async () => [];
  await cache.get(false);
  assert.equal(checks, 9);
});

test('an older check that ends after a newer one does not vouch for the newer answer', async () => {
  let now = 0;
  const pending: ((items: SetupItem[]) => void)[] = [];
  let checks = 0;
  const cache = new SetupCache(() => { checks++; return new Promise((resolve) => pending.push(resolve)); }, () => now);
  // A check starts a turn after it is asked for, once anything it waits for has settled.
  const started = () => new Promise((resolve) => setImmediate(resolve));
  const older = cache.get(true);
  const newer = cache.get(true);
  await started();
  pending[1]([{ id: 'codex', label: 'Codex CLI', ok: false, detail: 'Not found.' }]);
  await newer;
  pending[0]([{ id: 'codex', label: 'Codex CLI', ok: true, detail: '' }]);
  await older;
  now = SetupCache.INCOMPLETE_MS + 1;
  void cache.get(false);
  await started();
  assert.equal(checks, 3);
});

test('a check waits for a registration under way', async () => {
  const order: string[] = [];
  let registered!: () => void;
  const registering = new Promise<void>((resolve) => { registered = resolve; }).then(() => { order.push('registered'); });
  const cache = new SetupCache(async () => { order.push('checked'); return []; });
  const answer = cache.get(false, registering);
  registered();
  await answer;
  assert.deepEqual(order, ['registered', 'checked']);
});

test('packaged startup under CREW_HOME leaves the user registration and command alone', async (t) => {
  const profile = fs.mkdtempSync(path.join(home, 'profile-'));
  const calls = path.join(profile, 'calls');
  writeFakeBin(path.join(profile, 'claude'), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('[]');`);
  // A failing Codex probe keeps the user's own configuration out of the test.
  writeFakeBin(path.join(profile, 'codex'), 'process.exit(1);');
  const originalPath = process.env.PATH;
  process.env.PATH = profile + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.method(os, 'homedir', () => profile);
  const { register, COMMAND } = await import(new URL('../plugin/bridge/setup.ts?isolated-profile', import.meta.url).href);
  assert.equal(COMMAND, path.join(profile, '.local', 'bin', 'crew'));
  // Exercise just the packaged startup branch, without running an app or a packaged daemon.
  const daemon = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const startup = daemon.slice(daemon.indexOf("// An app's copy registers"), daemon.indexOf('// Keeps idle SSE'));
  let prunes = 0;
  let probes = 0;
  const start = async (env: NodeJS.ProcessEnv, recorded: boolean) => {
    let pending: Promise<unknown> | undefined;
    vm.runInNewContext(startup, {
      PACKAGED: true, process: { env, platform: 'win32' }, registered: () => recorded,
      registerPlugin: () => pending = register(), prunePlugins: () => { prunes++; },
      registrationMoved: async () => { probes++; return true; },
    });
    await Promise.resolve();
    await pending;
  };
  await start({ CREW_HOME: home }, false);
  await start({ CREW_HOME: home }, true);
  assert.deepEqual([fs.existsSync(calls), fs.existsSync(path.dirname(COMMAND)), prunes, probes], [false, false, 0, 0]);
  // A default-home launch still installs into the isolated profile through the stub.
  await start({}, false);
  assert.match(fs.readFileSync(calls, 'utf8'), /"plugin","install","crew@crew"/);
  assert.ok(fs.lstatSync(COMMAND));
});

test('an older copy of the app leaves the registration to a newer copy that is still there', async (t) => {
  const profile = fs.mkdtempSync(path.join(home, 'profile-'));
  const calls = path.join(profile, 'calls');
  writeFakeBin(path.join(profile, 'claude'), `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n'); console.log('[]');`);
  // Registration also registers with Codex where it is installed; a missing Codex keeps the user's own out of it.
  writeFakeBin(path.join(profile, 'codex'), 'process.exit(1);');
  const originalPath = process.env.PATH;
  process.env.PATH = profile + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.method(os, 'homedir', () => profile);
  // A built copy as an app carries it, one version behind the copy on record.
  const older = path.join(home, 'older');
  fs.cpSync(fileURLToPath(new URL('../plugin/bridge', import.meta.url)), path.join(older, 'plugin/bridge'), { recursive: true });
  fs.mkdirSync(path.join(older, 'plugin/.claude-plugin'));
  fs.writeFileSync(path.join(older, 'plugin/.claude-plugin/plugin.json'), '{"version":"0.0.1"}');
  fs.writeFileSync(path.join(older, 'plugin/.claude-plugin/build'), 'old\n');
  fs.writeFileSync(path.join(older, 'plugin/package.json'), '{"type":"module"}\n');
  const newer = path.join(home, 'newer');
  fs.mkdirSync(newer);
  const record = path.join(home, 'setup.json');
  t.after(() => fs.rmSync(record, { force: true }));
  const taken = JSON.stringify({ root: newer, version: '0.0.2', build: 'new' });
  fs.writeFileSync(record, taken);
  const { register } = await import(pathToFileURL(path.join(older, 'plugin/bridge/setup.ts')).href);

  // What a daemon started from the older copy does at startup.
  const left = await register();
  assert.match(left.detail, /newer Crew \(0\.0\.2\) is registered[^]*repair from it, or its `crew install`/);
  assert.deepEqual([fs.existsSync(calls), fs.readFileSync(record, 'utf8')], [false, taken]);
  // Asked for by the user (the checklist's repair, `crew install`), the older copy is registered: a downgrade on purpose.
  assert.match((await register(true)).detail, /^Installed/);
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).version, '0.0.1');
  fs.writeFileSync(record, taken);

  // A record of a copy that is gone, or of what this copy's own folder held before a downgrade, holds nothing back.
  fs.rmSync(newer, { recursive: true });
  assert.match((await register()).detail, /^Installed/);
  const mine = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(mine.version, '0.0.1');
  fs.writeFileSync(record, JSON.stringify({ ...mine, version: '0.0.2' }));
  await register();
  assert.equal(JSON.parse(fs.readFileSync(record, 'utf8')).version, '0.0.1');
});

test('a built copy registers with Codex, records it as complete only when both hosts run it, and leaves a registration it did not write', async (t) => {
  const profile = fs.mkdtempSync(path.join(home, 'profile-'));
  const calls = path.join(profile, 'calls');
  const marketplaces = path.join(profile, 'marketplaces');
  const failAdd = path.join(profile, 'fail-add');
  const failClaude = path.join(profile, 'fail-claude');
  const malformedClaude = path.join(profile, 'malformed-claude');
  const failVersion = path.join(profile, 'fail-version');
  const claudeAuth = path.join(profile, 'claude-auth');
  const missingCodexPlugin = path.join(profile, 'missing-codex-plugin');
  const codexVersion = JSON.parse(fs.readFileSync('plugin/.codex-plugin/plugin.json', 'utf8')).version;
  const log = `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(1)) + '\\n');`;
  writeFakeBin(path.join(profile, 'claude'), `${log}
    const fs = require('node:fs');
    if (fs.existsSync(${JSON.stringify(failClaude)})) { console.error('temporary lookup failure'); process.exit(1); }
    if (process.argv.slice(2).join(' ') === 'auth status --json') {
      const mode = fs.existsSync(${JSON.stringify(claudeAuth)}) ? fs.readFileSync(${JSON.stringify(claudeAuth)}, 'utf8') : 'signed-in';
      if (mode === 'unsupported') { console.error("error: unknown command 'auth'"); process.exit(1); }
      console.log(JSON.stringify({ loggedIn: mode === 'signed-in' }));
      process.exit(mode === 'signed-in' ? 0 : 1);
    }
    console.log(process.argv[2] === '--version' ? '2.1.326 (Claude Code)' : fs.existsSync(${JSON.stringify(malformedClaude)}) ? '[{}]' : '[]');`);
  writeFakeBin(path.join(profile, 'codex'), `${log}
    const fs = require('node:fs'); const args = process.argv.slice(2).join(' ');
    if (args === '--version' && fs.existsSync(${JSON.stringify(failVersion)})) { console.error('temporary version failure'); process.exit(1); }
    if (args === 'plugin marketplace list') console.log('MARKETPLACE  ROOT\\n' + (fs.existsSync(${JSON.stringify(marketplaces)}) ? fs.readFileSync(${JSON.stringify(marketplaces)}, 'utf8') : ''));
    if (args === 'plugin add crew@crew' && fs.existsSync(${JSON.stringify(failAdd)})) { console.error('no space left'); process.exit(1); }
    if (args === 'plugin list --marketplace crew') console.log(fs.existsSync(${JSON.stringify(missingCodexPlugin)}) ? 'crew@crew  not installed  local' : 'crew@crew  installed, enabled  ${codexVersion}  local');
    if (args === 'app-server') require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { id, method } = JSON.parse(line);
      if (id === undefined) return;
      // Lists the hooks in the user's Codex hooks file as Codex does, none of them trusted yet.
      const file = require('node:path').join(process.env.CODEX_HOME, 'hooks.json');
      const groups = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).hooks : {};
      const hooks = Object.entries(groups).flatMap(([event, list]) => list.flatMap((group) => group.hooks.map((hook) => ({
        key: file + ':' + event, eventName: event[0].toLowerCase() + event.slice(1), command: hook.command, sourcePath: file, currentHash: 'sha256:x', trustStatus: 'untrusted',
      }))));
      const result = method === 'hooks/list' ? { data: [{ hooks }] } : {};
      console.log(JSON.stringify({ id, result }));
    });`);
  const originalPath = process.env.PATH;
  process.env.PATH = profile + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.method(os, 'homedir', () => profile);
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(profile, '.codex');
  t.after(() => { if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome; });
  // A built copy with its Codex templates, its runtime beside it as in Crew.app.
  const app = path.join(home, 'codex-app');
  const root = path.join(app, 'bridge');
  fs.cpSync(fileURLToPath(new URL('../plugin/bridge', import.meta.url)), path.join(root, 'plugin/bridge'), { recursive: true });
  for (const item of ['.claude-plugin', '.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'hooks/codex-plugin.json', 'skills', 'agents']) {
    fs.cpSync(fileURLToPath(new URL(`../plugin/${item}`, import.meta.url)), path.join(root, 'plugin', item), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'plugin/.claude-plugin/build'), 'built\n');
  fs.writeFileSync(path.join(root, 'plugin/package.json'), '{"type":"module"}\n');
  fs.cpSync(fileURLToPath(new URL('../.claude-plugin', import.meta.url)), path.join(root, '.claude-plugin'), { recursive: true });
  // Crew.app keeps its Node beside the marketplace; the Windows build keeps node.exe inside it, which the copy then carries.
  const runtime = process.platform === 'win32' ? path.join(root, 'runtime') : path.join(app, 'runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, process.platform === 'win32' ? 'node.exe' : 'node'), '');
  const record = path.join(home, 'setup.json');
  t.after(() => fs.rmSync(record, { force: true }));
  const { checks, register } = await import(pathToFileURL(path.join(root, 'plugin/bridge/setup.ts')).href);
  const codexCalls = () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter(([bin]) => /codex(\.cjs)?$/.test(bin)).map(([, ...args]) => args.join(' ')) : [];
  const ours = path.join(profile, '.crew', 'codex', 'marketplace');

  // Someone else's `crew` marketplace in Codex is left as it is, and so is the folder.
  const theirs = path.join(profile, 'checkout');
  fs.mkdirSync(path.join(theirs, 'plugin'), { recursive: true });
  fs.writeFileSync(path.join(theirs, 'untracked'), 'keep');
  fs.writeFileSync(marketplaces, `crew  ${theirs}\n`);
  const left = await register(true);
  assert.equal(left.ok, true);
  assert.match(left.detail, /Codex: Registered from .*checkout; the app leaves it as it is\./);
  assert.deepEqual(codexCalls().filter((call) => /remove|add/.test(call)), []);
  assert.ok(fs.existsSync(path.join(theirs, 'untracked')));
  // Its hooks are not the app's to add, so the checklist sends the user to that checkout rather than to Install.
  const sourceOwned = (await checks()).find((item: SetupItem) => item.id === 'codex-hooks');
  assert.deepEqual([sourceOwned?.ok, sourceOwned?.repairable, sourceOwned?.summary], [false, undefined, 'Run `crew install` from the Crew checkout Codex runs.']);
  assert.match(sourceOwned?.detail ?? '', /Codex runs Crew from .*checkout, which the app leaves as it is\. Run `crew install` from there/);
  // Claude Code runs this copy, but Codex does not: recorded, so an older copy finds this one registered, but not
  // complete, so the next start tries again.
  const complete = () => JSON.parse(fs.readFileSync(record, 'utf8')).complete;
  assert.equal(complete(), false);
  assert.ok(fs.existsSync(path.join(profile, '.local', 'bin', 'crew')));

  // A Codex install that fails is reported and leaves the record incomplete.
  fs.rmSync(record);
  fs.rmSync(marketplaces);
  fs.rmSync(calls);
  fs.writeFileSync(failAdd, '');
  const failed = await register(true);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /Codex: Could not install the plugin in Codex: no space left/);
  assert.equal(complete(), false);
  assert.deepEqual(codexCalls().filter((call) => /add/.test(call)), [`plugin marketplace add ${ours}`, 'plugin add crew@crew']);

  // Once both hosts run this copy it is recorded; the marketplace carries the agents the skills read.
  fs.rmSync(failAdd);
  const installed = await register(true);
  assert.equal(installed.ok, true);
  assert.match(installed.detail, /select Trust Hooks in the setup checklist/);
  assert.equal(complete(), true);
  // The setup checklist can guide the user as soon as the plugin is installed.
  assert.equal(fs.existsSync(path.join(home, 'jobs.json')), false);
  const setupItems: SetupItem[] = await checks();
  const firstRun = setupItems.find((item) => item.id === 'codex-hooks');
  assert.equal(firstRun?.ok, false);
  assert.equal(firstRun?.summary, 'Select Trust Hooks to let Codex run Crew hooks.');
  // Crew's hooks are in the user's Codex hooks file, run through the launcher, which runs this copy's compiled bridge.
  const userHooks = JSON.parse(fs.readFileSync(path.join(profile, '.codex', 'hooks.json'), 'utf8'));
  const launcher = path.join(profile, '.crew', 'codex', 'bin', process.platform === 'win32' ? 'lead-hook.cmd' : 'lead-hook');
  assert.ok(userHooks.hooks.SessionStart[0].hooks.every((hook: { command: string }) => hook.command.includes(launcher)));
  assert.match(fs.readFileSync(path.join(profile, '.crew', 'codex', 'bin', 'lead-hook.mjs'), 'utf8'), /\$\{name\}\.js/);
  const claudeCheck = setupItems.find((item) => item.id === 'claude');
  assert.equal(claudeCheck?.summary, 'Installed');
  assert.equal(claudeCheck?.detail, '2.1.326 (Claude Code)');
  assert.equal(setupItems.find((item) => item.id === 'claude-login')?.ok, true);
  assert.equal(setupItems.find((item) => item.id === 'plugin')?.summary, 'Select Install to add the Crew plugin.');
  fs.writeFileSync(claudeAuth, 'signed-out');
  const signedOut = (await checks()).find((item: SetupItem) => item.id === 'claude-login');
  assert.equal(signedOut?.ok, false);
  assert.match(signedOut?.detail ?? '', /claude auth login/);
  fs.writeFileSync(claudeAuth, 'unsupported');
  const unsupported = (await checks()).find((item: SetupItem) => item.id === 'claude-login');
  assert.equal(unsupported?.ok, false);
  assert.match(unsupported?.detail ?? '', /no supported sign-in status command/);
  // On Windows the registered root is the copy in the Crew home, which open sessions keep running through an update.
  const registeredRoot = JSON.parse(fs.readFileSync(record, 'utf8')).root;
  if (process.platform === 'win32') assert.match(registeredRoot, /[\\/]plugins[\\/][^\\/]+-built$/);
  else assert.equal(registeredRoot, fs.realpathSync(root));
  assert.ok(fs.existsSync(path.join(ours, 'plugin/agents/self-reviewer.md')));

  // A marketplace Crew wrote earlier, elsewhere, is replaced: removed, then ours added.
  fs.rmSync(record);
  fs.rmSync(calls);
  const earlier = path.join(profile, 'earlier');
  fs.cpSync(ours, earlier, { recursive: true });
  fs.writeFileSync(marketplaces, `crew  ${earlier}\n`);
  assert.equal((await register(true)).ok, true);
  assert.deepEqual(codexCalls().filter((call) => /remove|add/.test(call)), ['plugin marketplace remove crew', `plugin marketplace add ${ours}`, 'plugin add crew@crew']);

  // A failed query is different from an agent that is absent. Keep earlier copies until both can be checked.
  const oldCopy = path.join(home, 'plugins', 'earlier-test-build');
  if (process.platform === 'win32') fs.mkdirSync(oldCopy, { recursive: true });
  fs.writeFileSync(failClaude, '');
  const claudeUnavailable = await register(true);
  assert.equal(claudeUnavailable.ok, false);
  assert.match(claudeUnavailable.detail, /Could not list Claude Code marketplaces: temporary lookup failure/);
  assert.equal(complete(), false);
  if (process.platform === 'win32') assert.ok(fs.existsSync(oldCopy));
  fs.rmSync(failClaude);
  fs.writeFileSync(malformedClaude, '');
  assert.match((await register(true)).detail, /Claude Code returned an invalid inventory/);
  assert.equal(complete(), false);
  if (process.platform === 'win32') assert.ok(fs.existsSync(oldCopy));
  fs.rmSync(malformedClaude);
  fs.writeFileSync(failVersion, '');
  const codexUnavailable = await register(true);
  assert.equal(codexUnavailable.ok, false);
  assert.match(codexUnavailable.detail, /Could not check the Codex version: temporary version failure/);
  assert.equal(complete(), false);
  if (process.platform === 'win32') assert.ok(fs.existsSync(oldCopy));
  fs.rmSync(failVersion);

  // Without Claude Code, a Codex registration is a registration: recorded, with the command.
  fs.rmSync(record);
  fs.rmSync(marketplaces);
  fs.rmSync(path.join(profile, '.local'), { recursive: true });
  fs.rmSync(path.join(profile, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  const appData = process.env.APPDATA;
  delete process.env.APPDATA;
  process.env.PATH = profile;
  const { codexOnly, codexOnlyItems, missingPlugin } = await (async () => {
    const codexOnly = await register(true);
    const codexOnlyItems: SetupItem[] = await checks();
    fs.writeFileSync(missingCodexPlugin, '');
    const missingPlugin: SetupItem[] = await checks();
    return { codexOnly, codexOnlyItems, missingPlugin };
  })().finally(() => {
    if (appData !== undefined) process.env.APPDATA = appData;
  });
  assert.equal(codexOnly.ok, true);
  assert.match(codexOnly.detail, /^Claude Code was not found\. Codex: Installed in Codex\./);
  assert.equal(codexOnlyItems.some((item) => item.id === 'claude-login'), false);
  assert.equal(codexOnlyItems.find((item) => item.id === 'plugin')?.ok, true);
  assert.equal(missingPlugin.find((item) => item.id === 'plugin')?.ok, false);
  assert.ok(fs.existsSync(record));
  assert.ok(fs.existsSync(path.join(profile, '.local', 'bin', 'crew')));
});

test("a source checkout's Codex hooks run Codex's installed copy of it, not the checkout", async (t) => {
  const profile = fs.mkdtempSync(path.join(home, 'profile-'));
  const installedCopy = path.join(profile, '.codex', 'plugins', 'cache', 'crew', 'crew', '0.0.0');
  writeFakeBin(path.join(profile, 'claude'), "console.log(process.argv[2] === '--version' ? '2.1.326 (Claude Code)' : '[]');");
  writeFakeBin(path.join(profile, 'codex'), `
    const args = process.argv.slice(2).join(' ');
    if (args === 'plugin marketplace list') console.log('MARKETPLACE  ROOT');
    if (args === 'plugin add crew@crew') console.log('Added plugin \`crew\` from marketplace \`crew\`.\\nInstalled plugin root: ' + ${JSON.stringify(installedCopy)});`);
  const originalPath = process.env.PATH;
  process.env.PATH = profile + path.delimiter + originalPath;
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(profile, '.codex');
  t.after(() => {
    process.env.PATH = originalPath;
    if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome;
  });
  t.mock.method(os, 'homedir', () => profile);
  const { register } = await import(new URL('../plugin/bridge/setup.ts?source-codex', import.meta.url).href);
  const registered = await register(true);
  assert.match(registered.detail, /Codex: Installed in Codex\./);
  const module = fs.readFileSync(path.join(profile, '.crew', 'codex', 'bin', 'lead-hook.mjs'), 'utf8');
  assert.ok(module.includes(JSON.stringify(path.join(installedCopy, 'bridge'))), module);
  assert.match(module, /\$\{name\}\.ts/);
  assert.ok(fs.existsSync(path.join(profile, '.codex', 'hooks.json')));
});

test('a job ledger that was set aside shows in the checklist until the file is gone', async () => {
  const { ledgerItem } = await import('../plugin/bridge/setup.ts');
  const dir = fs.mkdtempSync(path.join(home, 'ledger-'));
  assert.equal(ledgerItem(dir), null);
  assert.equal(ledgerItem(path.join(dir, 'missing')), null);
  fs.writeFileSync(path.join(dir, 'jobs.json.unreadable-1'), '{');
  fs.writeFileSync(path.join(dir, 'jobs.json.unreadable-2'), '{');
  const item = ledgerItem(dir)!;
  assert.equal(item.ok, false);
  assert.match(item.detail, /jobs\.json\.unreadable-2\b[^]*receipts and pull request watches/);
  for (const name of ['jobs.json.unreadable-1', 'jobs.json.unreadable-2']) fs.rmSync(path.join(dir, name));
  assert.equal(ledgerItem(dir), null);
});

test('the Codex hooks item asks app-server hooks/list and is trusted only when Codex says so', async (t) => {
  const { codexHooksItem, trustCodexHooks } = await import('../plugin/bridge/setup.ts');
  const { codexHooks, crewHooks, launcherPath } = await import('../plugin/bridge/codex-plugin.ts');
  const dir = fs.mkdtempSync(path.join(home, 'codex-hooks-'));
  const codexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(dir, 'codex-home');
  t.after(() => { if (codexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = codexHome; });
  const file = path.join(dir, 'codex-home', 'hooks.json');
  const launcher = launcherPath(path.join(os.homedir(), '.crew', 'codex', 'bin'));
  const expected = crewHooks(codexHooks(JSON.parse(fs.readFileSync('plugin/hooks/codex.json', 'utf8')), launcher));
  /**
   * A fake `codex app-server` answering hooks/list with `reply` (a JS expression over `hooks`, Crew's hooks as Codex
   * lists them), recording config/batchWrite, or failing as `mode` says.
   */
  const fake = (name: string, reply: string, mode = '') => {
    const bin = path.join(dir, name);
    const listed = expected.map((hook, i) => ({ key: `${file}:${i}`, eventName: hook.event[0].toLowerCase() + hook.event.slice(1), command: hook.command, sourcePath: file, currentHash: `sha256:${i}`, trustStatus: 'trusted' }));
    writeFakeBin(bin, `
      if (process.argv[2] !== 'app-server') process.exit(2);
      const fs = require('node:fs');
      const hooks = ${JSON.stringify(listed)};
      if (${JSON.stringify(mode)} === 'exit') process.exit(1);
      fs.writeFileSync(${JSON.stringify(bin)} + '.pid', String(process.pid));
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') return console.log(JSON.stringify({ id: msg.id, result: {} }));
        if (msg.method === 'config/batchWrite') {
          fs.writeFileSync(${JSON.stringify(bin)} + '.written', JSON.stringify(msg.params));
          return console.log(JSON.stringify({ id: msg.id, result: { status: 'ok' } }));
        }
        if (msg.method !== 'hooks/list' || ${JSON.stringify(mode)} === 'silent') return;
        if (${JSON.stringify(mode)} === 'error') return console.log(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method not found' } }));
        console.log(JSON.stringify({ id: msg.id, result: { data: [{ cwd: msg.params.cwds[0], hooks: ${reply} }] } }));
      });`);
    return bin;
  };
  const hooks = (status: string) => `hooks.map((hook, i) => ({ ...hook, trustStatus: i === 0 ? ${JSON.stringify(status)} : 'trusted' }))`;

  const trusted = await codexHooksItem(fake('trusted', hooks('trusted')));
  assert.deepEqual([trusted.ok, trusted.detail], [true, 'Trusted.']);
  assert.equal(trusted.summary, 'Complete');
  const modified = await codexHooksItem(fake('modified', hooks('modified')));
  assert.equal(modified.ok, false);
  assert.equal(modified.trustable, true);
  assert.equal(modified.detail, `Crew's hooks in ${file} run ${launcher}. To let Codex run them, select Trust Hooks in the setup checklist, or trust them in Codex under Settings → Hooks (\`/hooks\` in the CLI). Then start a new Codex chat or CLI session.`);
  assert.equal(modified.summary, 'Crew hooks were updated. Select Trust Hooks to trust them again.');
  const untrusted = await codexHooksItem(fake('untrusted', hooks('untrusted')));
  assert.deepEqual([untrusted.ok, untrusted.trustable, untrusted.summary], [false, true, 'Select Trust Hooks to let Codex run Crew hooks.']);
  const disabled = await codexHooksItem(fake('disabled', `${hooks('trusted')}.map((hook, i) => ({ ...hook, enabled: i !== 0 }))`));
  assert.equal(disabled.ok, false);
  assert.equal(disabled.trustable, undefined);
  assert.equal(disabled.detail, 'In Codex, open Settings → Hooks and turn on the disabled Crew hooks.');
  // Hooks gone from the user's file are put back by Install, which registers again.
  const missing = await codexHooksItem(fake('missing', `${hooks('trusted')}.slice(1)`));
  assert.deepEqual([missing.ok, missing.repairable, missing.detail], [false, true, `Crew's hooks are missing from ${file}, or are there more than once.`]);
  for (const [name, mode, reason] of [['refused', 'error', /method not found/], ['gone', 'exit', /exited/]] as const) {
    const unknown = await codexHooksItem(fake(name, '[]', mode));
    assert.equal(unknown.ok, false, name);
    assert.match(unknown.detail, /^Could not ask Codex whether they are trusted/, name);
    assert.match(unknown.detail, reason, name);
    assert.match(unknown.summary ?? '', /Select Check Again/, name);
  }
  // A Codex that never answers fails the item once the request times out, and is not left running.
  const silent = await codexHooksItem(fake('silent', '[]', 'silent'), 300);
  assert.equal(silent.ok, false);
  assert.match(silent.detail, /^Could not ask Codex whether they are trusted .*timed out/);
  // A fake ended before it got as far as writing its pid was not left running either.
  const pidFile = path.join(dir, 'silent.pid');
  const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : 0;
  const alive = () => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false);
  const absent = await codexHooksItem(path.join(dir, 'no-such-codex'));
  assert.equal(absent.ok, false);
  assert.match(absent.detail, /^Could not ask Codex/);

  // Trusting records the definition Codex lists now, for Crew's hooks that are not trusted, and nothing else.
  const other = `[...${hooks('untrusted')}, { key: 'mine', eventName: 'stop', command: 'echo mine', sourcePath: ${JSON.stringify(file)}, currentHash: 'sha256:mine', trustStatus: 'untrusted' }]`;
  const trusting = fake('trusting', other);
  await trustCodexHooks(trusting);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${trusting}.written`, 'utf8')), {
    edits: [{ keyPath: `hooks.state.${JSON.stringify(`${file}:0`)}.trusted_hash`, value: 'sha256:0', mergeStrategy: 'replace' }],
    reloadUserConfig: true,
  });
  const settled = fake('settled', hooks('trusted'));
  await trustCodexHooks(settled);
  assert.equal(fs.existsSync(`${settled}.written`), false);
  await assert.rejects(trustCodexHooks(fake('refusing', '[]', 'error')), /method not found/);
});

test('a CLI that outlives its timeout is ended with everything it started, not only its Windows shim', async () => {
  const { run } = await import('../plugin/bridge/setup.ts');
  const dir = fs.mkdtempSync(path.join(home, 'timed-'));
  const bin = path.join(dir, 'slow');
  const pidFile = path.join(dir, 'pid');
  writeFakeBin(bin, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setTimeout(() => {}, 30_000);`);
  const started = Date.now();
  const res = await run(bin, [], 1_000);
  assert.equal(res.ok, false);
  assert.match(res.out, /timed out after 1s/);
  assert.ok(Date.now() - started < 10_000);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false);
});
