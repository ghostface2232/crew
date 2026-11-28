import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';
import type { TestContext } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-client-'));
process.env.CREW_HOME = home;
// Every request is mocked; an unused port keeps a missed mock away from the user's daemon.
process.env.CREW_PORT = '1';
const { api, ensureDaemon, forgetDaemon, health, stopDaemon, verifiedDaemon } = await import('../plugin/bridge/client.ts');
const { baseUrl, PLUGIN_ROOT, PORTS } = await import('../plugin/bridge/config.ts');
const file = path.join(home, 'daemon.json');
const tokenFile = path.join(home, 'token');
const token = 'a'.repeat(64);
beforeEach(() => {
  fs.writeFileSync(tokenFile, token);
  fs.rmSync(file, { force: true });
  forgetDaemon(baseUrl());
});
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

const isHealth = (url: string) => new URL(url).pathname === '/api/health';
function signedHealth(url: string, fields: { pid: number; [key: string]: unknown }) {
  const challenge = new URL(url).searchParams.get('challenge');
  assert.match(challenge ?? '', /^[0-9a-f]{64}$/);
  const proof = createHmac('sha256', token).update('crew-health:' + challenge).digest('hex');
  return Response.json({ name: 'crew', ...fields, proof });
}

function fastWaits(t: TestContext) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now += 100);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void) => { queueMicrotask(callback); });
}

test('an unverified listener never receives a credentialed request', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', async (_url: string, _options: RequestInit) => Response.json({ name: 'crew', pid: process.pid }));
  await assert.rejects(api('GET', '/api/state'), /not a verified Crew daemon/);
  assert.equal(await health(), null);
  for (const call of fetch.mock.calls) {
    const [url, options] = call.arguments;
    assert.ok(typeof url === 'string');
    assert.equal(new URL(url).pathname, '/api/health');
    assert.equal(new Headers(options?.headers).has('authorization'), false);
  }
});

test('an old daemon needs a matching live record and an invalid proof never falls back', async (t) => {
  let fields: { pid: number; proof?: unknown } = { pid: process.pid };
  t.mock.method(globalThis, 'fetch', async () => Response.json({ name: 'crew', ...fields }));
  const record = (port: number, pid: number) => fs.writeFileSync(file, JSON.stringify({ port, pid }));
  record(2, process.pid);
  assert.equal(await health(), null);
  record(1, process.pid + 1);
  assert.equal(await health(), null);
  record(1, process.pid);
  assert.equal((await health())?.pid, process.pid);
  for (const proof of [null, 'z'.repeat(64), '0'.repeat(64)]) {
    fields = { pid: process.pid, proof };
    assert.equal(await health(), null);
  }
  fields = { pid: process.pid };
  t.mock.method(process, 'kill', () => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); });
  assert.equal(await health(), null);
});

test('health without a readable token identifies Crew but sends no authorization', async (t) => {
  fs.rmSync(tokenFile);
  let proof = true;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(new Headers(options.headers).has('authorization'), false);
    if (!isHealth(url)) return Response.json({ ok: true });
    return proof ? signedHealth(url, { pid: process.pid }) : Response.json({ name: 'crew', pid: process.pid });
  });
  assert.deepEqual(await api('GET', '/api/state'), { ok: true });
  proof = false;
  assert.equal((await verifiedDaemon(baseUrl()))?.token, null);
});

test('forgetting a daemon during a probe leaves no cached result and a retry starts a new probe', async (t) => {
  fs.writeFileSync(file, JSON.stringify({ port: 1, pid: process.pid }));
  const pending: (() => void)[] = [];
  t.mock.method(globalThis, 'fetch', (url: string) => new Promise<Response>((resolve) => {
    pending.push(() => resolve(signedHealth(url, { pid: process.pid })));
  }));
  const stale = verifiedDaemon(baseUrl());
  forgetDaemon(baseUrl());
  const retry = verifiedDaemon(baseUrl());
  try {
    assert.equal(pending.length, 2);
  } catch (error) {
    pending[0]();
    await Promise.all([stale, retry]);
    throw error;
  }
  pending[0]();
  await stale;
  const joined = verifiedDaemon(baseUrl());
  pending[1]();
  const fresh = await retry;
  assert.ok(fresh);
  assert.equal(await joined, fresh);
  assert.equal(await verifiedDaemon(baseUrl()), fresh);
  assert.equal(pending.length, 2);
});

test('API reuses a live daemon verification and discards it after a connection failure', async (t) => {
  fs.writeFileSync(file, JSON.stringify({ port: 1, pid: process.pid }));
  const challenges: (string | null)[] = [];
  let listener: 'verified' | 'disconnected' | 'unverified' = 'verified';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    const authorization = new Headers(options.headers).get('authorization');
    if (isHealth(url)) {
      assert.equal(authorization, null);
      challenges.push(new URL(url).searchParams.get('challenge'));
      return listener === 'verified' ? signedHealth(url, { pid: process.pid }) : Response.json({ name: 'crew', pid: process.pid, proof: 'wrong' });
    }
    requests++;
    assert.equal(authorization, `Bearer ${token}`);
    if (listener === 'disconnected') throw new TypeError('connection closed');
    return Response.json({});
  });
  await Promise.all([api('GET', '/api/state'), api('GET', '/api/state')]);
  assert.equal(requests, 2);
  assert.equal(challenges.length, 1);
  listener = 'disconnected';
  await assert.rejects(api('GET', '/api/state'), /connection closed/);
  listener = 'unverified';
  await assert.rejects(api('GET', '/api/state'), /not a verified Crew daemon/);
  assert.equal(requests, 3);
  assert.equal(challenges.length, 2);
  assert.notEqual(challenges[0], challenges[1]);
});

test('replacement refuses to spawn while the previous daemon still answers', async (t) => {
  fastWaits(t);
  t.mock.method(globalThis, 'fetch', async (url: string) => isHealth(url)
    ? signedHealth(url, { version: '0.0.0', build: 'old', root: PLUGIN_ROOT, active: 0, pid: 12345 }) : Response.json({}));
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
    return signedHealth(url, { version: '0.0.0', build: shutdown ? 'new' : 'old', root: PLUGIN_ROOT, active: 0, pid: shutdown ? 54321 : 12345 });
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => { throw new Error('unexpected spawn'); });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await ensureDaemon();
  assert.ok(shutdown);
  assert.equal(spawn.mock.callCount(), 0);
});

test('startup waits through a foreign port grace period for a daemon on a fallback port', async (t) => {
  PORTS.push(2);
  t.after(() => { PORTS.pop(); });
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, ms: number) => {
    now += ms;
    if (now === 11_000) fs.writeFileSync(file, JSON.stringify({ port: 2, pid: process.pid }));
    queueMicrotask(callback);
  });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (new URL(url).port === '2') return signedHealth(url, { pid: process.pid });
    return Response.json({ name: 'foreign' });
  });
  const spawn = t.mock.method(childProcess, 'spawn', () => ({ on() {}, unref() {} }));
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  await ensureDaemon();
  assert.equal(spawn.mock.callCount(), 1);
  assert.equal(baseUrl(), 'http://127.0.0.1:2');
});

// On Windows a daemon started through WMI writes its log through cmd.exe, which holds it unshared until that daemon
// exits. `busy` opens of daemon.log fail with EBUSY; `rival` is a daemon that answers while the log is still busy.
for (const [name, busy, rival] of [
  ['replacement waits for the log a stopping daemon still holds', 2, false],
  ['replacement leaves a daemon that comes up while the log is held', 2, true],
  ['replacement explains a log that stays held', Infinity, false],
] as const) {
  test(name, async (t) => {
    fastWaits(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    let phase: 'old' | 'down' | 'new' = 'old';
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (url.endsWith('/api/shutdown')) { phase = 'down'; return Response.json({}); }
      if (phase === 'down') throw new Error('down');
      return signedHealth(url, { version: '0.0.0', build: 'b', root: PLUGIN_ROOT, active: 0, pid: phase === 'old' ? 12345 : 54321, ...(phase === 'old' ? { partialEnv: true } : {}) });
    });
    let opens = 0;
    const { openSync, closeSync } = fs;
    t.mock.method(fs, 'openSync', (target: fs.PathLike, flags: fs.OpenMode = 'r', mode?: fs.Mode) => {
      if (!String(target).endsWith('daemon.log')) return openSync(target, flags, mode);
      if (++opens <= busy) {
        if (rival && opens === busy) phase = 'new';
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return -1;
    });
    t.mock.method(fs, 'closeSync', (fd: number) => { if (fd !== -1) closeSync(fd); });
    const spawn = t.mock.method(childProcess, 'spawn', () => {
      phase = 'new';
      return { on() {}, unref() {} };
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    if (busy === Infinity) await assert.rejects(ensureDaemon(), /another process still holds .*daemon\.log/);
    else await ensureDaemon();
    assert.equal(spawn.mock.callCount(), busy === Infinity || rival ? 0 : 1);
  });
}

test('a hook report retries with the newly created token and exits successfully on failure', (t) => {
  const reportHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-report-'));
  t.after(() => fs.rmSync(reportHome, { recursive: true, force: true }));
  const input = { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: '한글' };
  const result = childProcess.spawnSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    import path from 'node:path';
    const home = process.env.CREW_HOME;
    fs.writeFileSync(path.join(home, 'daemon.json'), JSON.stringify({ port: 1, pid: process.pid }));
    globalThis.fetch = async (url, options) => {
      const pathname = new URL(url).pathname;
      if (pathname === '/api/health') return Response.json({ name: 'crew', pid: process.pid });
      const file = path.join(home, 'token');
      console.log(JSON.stringify([pathname, options.headers.authorization ?? null, JSON.parse(options.body)]));
      if (!fs.existsSync(file)) fs.writeFileSync(file, 'a'.repeat(64));
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    };
    await import(${JSON.stringify(new URL('../plugin/bridge/report.ts', import.meta.url).href)});
  `], {
    // The desktop app's id for the session goes along with the hook's payload.
    env: { ...process.env, CREW_HOME: reportHome, CLAUDE_CODE_HOST_SESSION_ID: 'local_1' },
    input: JSON.stringify(input), encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const sent = { ...input, desktop_session_id: 'local_1' };
  assert.deepEqual(result.stdout.trim().split('\n').map((line) => JSON.parse(line)), [
    ['/api/hooks/claude', null, sent],
    ['/api/hooks/claude', `Bearer ${'a'.repeat(64)}`, sent],
  ]);
});

test('stop retries a missing PID file before signalling the confirmed process', async (t) => {
  fastWaits(t);
  let alive = true;
  let reads = 0;
  fs.rmSync(file, { force: true });
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (!isHealth(url)) return Response.json({ error: 'no token' }, { status: 403 });
    if (!alive) throw new Error('down');
    if (++reads === 4) fs.writeFileSync(file, JSON.stringify({ port: 1, pid: 12345 }));
    return signedHealth(url, { pid: 12345 });
  });
  const kill = t.mock.method(process, 'kill', (pid: number, signal: string | number) => {
    assert.equal(pid, 12345);
    if (signal === 0) return alive;
    assert.equal(signal, 'SIGTERM');
    alive = false;
    return true;
  });
  await stopDaemon();
  assert.equal(kill.mock.calls.filter(({ arguments: [, signal] }) => signal === 'SIGTERM').length, 1);
  assert.equal(fs.existsSync(file), false);
});

test('stop signals a live recorded daemon even when its proof uses a different token', async (t) => {
  PORTS.push(2);
  t.after(() => { PORTS.pop(); });
  fastWaits(t);
  let listening = true;
  fs.writeFileSync(file, JSON.stringify({ port: 2, pid: 12345 }));
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.ok(isHealth(url));
    return Response.json({ name: 'crew', pid: 12345, proof: 'wrong' });
  });
  t.mock.method(net, 'connect', (port: number, host: string) => {
    assert.deepEqual([port, host], [2, '127.0.0.1']);
    const socket = Object.assign(new EventEmitter(), { setTimeout() {}, destroy() {} });
    queueMicrotask(() => socket.emit(listening ? 'connect' : 'error', new Error('connection refused')));
    return socket;
  });
  t.mock.method(process, 'kill', (pid: number, signal: string | number) => {
    assert.equal(pid, 12345);
    if (signal === 0) return true;
    assert.equal(signal, 'SIGTERM');
    listening = false;
    return true;
  });
  await stopDaemon();
  assert.equal(listening, false);
  assert.equal(fs.existsSync(file), false);
});

for (const record of ['missing', 'different'] as const) {
  test(`stop explains when the PID record is ${record} and never signals it`, async (t) => {
    fastWaits(t);
    if (record === 'different') fs.writeFileSync(file, JSON.stringify({ port: 1, pid: process.pid }));
    t.mock.method(globalThis, 'fetch', async (url: string) => isHealth(url)
      ? signedHealth(url, { pid: process.pid + 1 }) : Response.json({ error: 'no token' }, { status: 403 }));
    const kill = t.mock.method(process, 'kill', (_pid: number, signal: string | number) => {
      assert.equal(signal, 0);
      return true;
    });
    await assert.rejects(stopDaemon(), record === 'missing' ? /PID could not be confirmed/ : /is still running/);
    assert.ok(kill.mock.calls.every(({ arguments: [, signal] }) => signal === 0));
  });
}

for (const replaced of [false, true]) {
  test(`forced Windows stop cleans only its own PID file (replaced: ${replaced})`, async (t) => {
    fastWaits(t);
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    t.after(() => Object.defineProperty(process, 'platform', platform));
    let alive = true;
    fs.writeFileSync(file, JSON.stringify({ port: 1, pid: 12345 }));
    t.mock.method(globalThis, 'fetch', async (url: string) => {
      if (!isHealth(url)) return Response.json({ error: 'no token' }, { status: 403 });
      if (!alive) throw new Error('down');
      return signedHealth(url, { pid: 12345 });
    });
    t.mock.method(process, 'kill', (_pid: number, signal: string | number) => {
      if (signal === 0) return alive;
      alive = false;
      if (replaced) fs.writeFileSync(file, JSON.stringify({ pid: 54321 }));
      return true;
    });
    await stopDaemon();
    assert.equal(fs.existsSync(file), replaced);
    if (replaced) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 54321);
  });
}
