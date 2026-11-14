import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import type { TestContext } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-client-'));
process.env.CREW_HOME = home;
// Every request is mocked; an unused port keeps a missed mock away from the user's daemon.
process.env.CREW_PORT = '1';
const { ensureDaemon, stopDaemon } = await import('../plugin/bridge/client.ts');
const { PLUGIN_ROOT } = await import('../plugin/bridge/config.ts');
const file = path.join(home, 'daemon.json');
after(() => fs.rmSync(home, { recursive: true, force: true }));

function fastWaits(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now += 100);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => { queueMicrotask(callback); });
}

test('replacement refuses to spawn while the previous daemon still answers', async (t) => {
  fastWaits(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.endsWith('/api/health')
    ? { name: 'crew', version: '0.0.0', build: 'old', root: PLUGIN_ROOT, active: 0, pid: 12345 } : {}));
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected spawn'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await assert.rejects(ensureDaemon(), /previous Crew daemon.*did not stop/);
  assert.equal(spawn.mock.callCount(), 0);
});

test('replacement leaves a daemon another client started in the meantime', async (t) => {
  fastWaits(t);
  let shutdown = false;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/api/shutdown')) { shutdown = true; return Response.json({}); }
    return Response.json({ name: 'crew', version: '0.0.0', build: shutdown ? 'new' : 'old', root: PLUGIN_ROOT, active: 0, pid: shutdown ? 54321 : 12345 });
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected spawn'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await ensureDaemon();
  assert.ok(shutdown);
  assert.equal(spawn.mock.callCount(), 0);
});

test('stop retries a missing PID file before signalling the confirmed process', async (t) => {
  fastWaits(t);
  let alive = true;
  let reads = 0;
  fs.rmSync(file, { force: true });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!url.endsWith('/api/health')) return Response.json({ error: 'no token' }, { status: 403 });
    if (!alive) throw new Error('down');
    if (++reads === 4) fs.writeFileSync(file, JSON.stringify({ pid: 12345 }));
    return Response.json({ name: 'crew', pid: 12345 });
  });
  const kill = t.mock.method(process, 'kill', (pid: number, signal: string) => {
    assert.deepEqual([pid, signal], [12345, 'SIGTERM']);
    alive = false;
    return true;
  });
  await stopDaemon();
  assert.equal(kill.mock.callCount(), 1);
  assert.equal(fs.existsSync(file), false);
});

test('stop explains when the PID cannot be confirmed and never signals it', async (t) => {
  fastWaits(t);
  fs.rmSync(file, { force: true });
  t.mock.method(globalThis, 'fetch', async (url: string) => Response.json(url.endsWith('/api/health')
    ? { name: 'crew', pid: 12345 } : { error: 'no token' }, { status: url.endsWith('/api/health') ? 200 : 403 }));
  const kill = t.mock.method(process, 'kill', () => { throw new Error('unconfirmed signal'); });
  await assert.rejects(stopDaemon(), /PID could not be confirmed/);
  assert.equal(kill.mock.callCount(), 0);
});

for (const replaced of [false, true]) {
  test(`forced Windows stop cleans only its own PID file (replaced: ${replaced})`, async (t) => {
    fastWaits(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    let alive = true;
    fs.writeFileSync(file, JSON.stringify({ pid: 12345 }));
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (!url.endsWith('/api/health')) return Response.json({ error: 'no token' }, { status: 403 });
      if (!alive) throw new Error('down');
      return Response.json({ name: 'crew', pid: 12345 });
    });
    t.mock.method(process, 'kill', () => {
      alive = false;
      if (replaced) fs.writeFileSync(file, JSON.stringify({ pid: 54321 }));
      return true;
    });
    await stopDaemon();
    assert.equal(fs.existsSync(file), replaced);
    if (replaced) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 54321);
  });
}
