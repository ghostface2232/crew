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
  // Registration also registers with Codex where it is installed; a missing Codex keeps the user's own out of it.
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

test('a built copy registers with Codex, records only when both hosts run it, and leaves a registration it did not write', async (t) => {
  const profile = fs.mkdtempSync(path.join(home, 'profile-'));
  const calls = path.join(profile, 'calls');
  const marketplaces = path.join(profile, 'marketplaces');
  const failAdd = path.join(profile, 'fail-add');
  const noClaude = path.join(profile, 'no-claude');
  const log = `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(1)) + '\\n');`;
  writeFakeBin(path.join(profile, 'claude'), `${log} if (require('node:fs').existsSync(${JSON.stringify(noClaude)})) process.exit(1); console.log('[]');`);
  writeFakeBin(path.join(profile, 'codex'), `${log}
    const fs = require('node:fs'); const args = process.argv.slice(2).join(' ');
    if (args === 'plugin marketplace list') console.log('MARKETPLACE  ROOT\\n' + (fs.existsSync(${JSON.stringify(marketplaces)}) ? fs.readFileSync(${JSON.stringify(marketplaces)}, 'utf8') : ''));
    if (args === 'plugin add crew@crew' && fs.existsSync(${JSON.stringify(failAdd)})) { console.error('no space left'); process.exit(1); }`);
  const originalPath = process.env.PATH;
  process.env.PATH = profile + path.delimiter + originalPath;
  t.after(() => { process.env.PATH = originalPath; });
  t.mock.method(os, 'homedir', () => profile);
  // A built copy with its Codex templates, its runtime beside it as in Crew.app.
  const app = path.join(home, 'codex-app');
  const root = path.join(app, 'bridge');
  fs.cpSync(fileURLToPath(new URL('../plugin/bridge', import.meta.url)), path.join(root, 'plugin/bridge'), { recursive: true });
  for (const item of ['.claude-plugin', '.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'skills', 'agents']) {
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
  const { register } = await import(pathToFileURL(path.join(root, 'plugin/bridge/setup.ts')).href);
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
  // Claude Code runs this copy, but Codex does not, so nothing is recorded and the next start tries again.
  assert.equal(fs.existsSync(record), false);
  assert.ok(fs.existsSync(path.join(profile, '.local', 'bin', 'crew')));

  // A Codex install that fails is reported and leaves the record unwritten.
  fs.rmSync(marketplaces);
  fs.rmSync(calls);
  fs.writeFileSync(failAdd, '');
  const failed = await register(true);
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /Codex: Could not install the plugin in Codex: no space left/);
  assert.equal(fs.existsSync(record), false);
  assert.deepEqual(codexCalls().filter((call) => /add/.test(call)), [`plugin marketplace add ${ours}`, 'plugin add crew@crew']);

  // Once both hosts run this copy it is recorded; the marketplace carries the agents the skills read.
  fs.rmSync(failAdd);
  assert.equal((await register(true)).ok, true);
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

  // Without Claude Code, a Codex registration is a registration: recorded, with the command.
  fs.rmSync(record);
  fs.rmSync(marketplaces);
  fs.rmSync(path.join(profile, '.local'), { recursive: true });
  fs.writeFileSync(noClaude, '');
  const codexOnly = await register(true);
  assert.equal(codexOnly.ok, true);
  assert.match(codexOnly.detail, /^Claude Code was not found\. Codex: Installed in Codex\./);
  assert.ok(fs.existsSync(record));
  assert.ok(fs.existsSync(path.join(profile, '.local', 'bin', 'crew')));
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

test('the Codex hooks item asks app-server hooks/list and is trusted only when Codex says so', async () => {
  const { codexHooksItem } = await import('../plugin/bridge/setup.ts');
  const { hookKeys } = await import('../plugin/bridge/codex-plugin.ts');
  const keys = hookKeys(JSON.parse(fs.readFileSync('plugin/hooks/codex.json', 'utf8')), 'hooks/codex.json');
  const dir = fs.mkdtempSync(path.join(home, 'codex-hooks-'));
  /** A fake `codex app-server` answering hooks/list with `reply` (a JS expression over `keys`), or failing as `mode` says. */
  const fake = (name: string, reply: string, mode = '') => {
    const bin = path.join(dir, name);
    writeFakeBin(bin, `
      if (process.argv[2] !== 'app-server') process.exit(2);
      const keys = ${JSON.stringify(keys)};
      if (${JSON.stringify(mode)} === 'exit') process.exit(1);
      require('node:fs').writeFileSync(${JSON.stringify(path.join(dir, name))} + '.pid', String(process.pid));
      require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
        const msg = JSON.parse(line);
        if (msg.id === undefined) return;
        if (msg.method === 'initialize') return console.log(JSON.stringify({ id: msg.id, result: {} }));
        if (msg.method !== 'hooks/list' || ${JSON.stringify(mode)} === 'silent') return;
        if (${JSON.stringify(mode)} === 'error') return console.log(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method not found' } }));
        console.log(JSON.stringify({ id: msg.id, result: { data: [{ cwd: msg.params.cwds[0], hooks: ${reply} }] } }));
      });`);
    return bin;
  };
  const hooks = (status: string) => `keys.map((key, i) => ({ key, pluginId: 'crew@crew', trustStatus: i === 0 ? ${JSON.stringify(status)} : 'trusted' }))`;

  const trusted = await codexHooksItem(fake('trusted', hooks('trusted')));
  assert.deepEqual([trusted.ok, trusted.detail], [true, 'Trusted.']);
  const modified = await codexHooksItem(fake('modified', hooks('modified')));
  assert.equal(modified.ok, false);
  assert.match(modified.detail, /^Changed by an update since you trusted them, so Codex skips them until you trust them again\. .*`\/hooks`/);
  const untrusted = await codexHooksItem(fake('untrusted', hooks('untrusted')));
  assert.equal(untrusted.ok, false);
  assert.match(untrusted.detail, /^Codex runs its hooks only once trusted/);
  for (const [name, mode, reason] of [['refused', 'error', /method not found/], ['gone', 'exit', /exited/]] as const) {
    const unknown = await codexHooksItem(fake(name, '[]', mode));
    assert.equal(unknown.ok, false, name);
    assert.match(unknown.detail, /^Could not ask Codex whether they are trusted/, name);
    assert.match(unknown.detail, reason, name);
  }
  // A Codex that never answers fails the item once the request times out, and is not left running.
  const silent = await codexHooksItem(fake('silent', '[]', 'silent'), undefined, 300);
  assert.equal(silent.ok, false);
  assert.match(silent.detail, /^Could not ask Codex whether they are trusted .*timed out/);
  const pid = Number(fs.readFileSync(path.join(dir, 'silent.pid'), 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false);
  const missing = await codexHooksItem(path.join(dir, 'no-such-codex'));
  assert.equal(missing.ok, false);
  assert.match(missing.detail, /^Could not ask Codex/);
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
