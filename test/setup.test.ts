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
