import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import type { JobView } from '../plugin/bridge/render.ts';

function job(id: string, overrides: Partial<JobView> = {}): JobView {
  return {
    id, agent: 'codex', kind: 'review', title: id, state: 'running', phase: 'working',
    project: '/project', mission: 'mission', createdAt: Date.now(), seq: 2, delivered: 0,
    notes: [], turns: 1, ...overrides,
  } as JobView;
}

function harness(t: TestContext, jobs: JobView[], beforeClaim?: (current: JobView) => void) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-wake-'));
  const preload = path.join(home, 'api.mjs');
  // IPC models the existing API without opening a port or reading the user's daemon token.
  fs.writeFileSync(preload, `
    let next = 0, now;
    const pending = new Map();
    const realNow = Date.now;
    Date.now = () => now ?? realNow();
    const timer = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...args) => {
      process.send({ timer: ms });
      return timer(fn, Math.min(ms, 25), ...args);
    };
    process.on('message', ({ id, data, time }) => {
      now = time;
      pending.get(id)(Response.json(data));
      pending.delete(id);
    });
    globalThis.fetch = (url, options) => new Promise((resolve) => {
      const id = ++next;
      pending.set(id, resolve);
      process.send({ id, route: new URL(url).pathname, method: options.method,
        body: options.body ? JSON.parse(options.body) : undefined });
    });
  `);
  const h = { now: Date.now(), stateReads: 0, claims: [] as string[], timers: [] as number[] };
  const polls: (() => void)[] = [];
  const wake = (watched: JobView) => {
    const child = fork(path.resolve('plugin/bridge/wake.ts'), [], {
      execArgv: ['--import', preload], stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      env: { ...process.env, CREW_HOME: home, CREW_PORT: '1' },
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => { stderr += chunk; });
    const watcher = { result: undefined as { code: number | null; stderr: string } | undefined,
      exited: new Promise<{ code: number | null; stderr: string }>((resolve) => {
        child.once('exit', (code) => { watcher.result = { code, stderr }; resolve(watcher.result); });
      }) };
    child.on('message', (message: any) => {
      if (message.timer !== undefined) { h.timers.push(message.timer); return; }
      const reply = (data: unknown) => child.send({ id: message.id, data, time: h.now });
      if (message.route === '/api/state') {
        h.stateReads++;
        reply({ jobs });
        return;
      }
      const current = jobs.find((j) => message.route.startsWith(`/api/jobs/${j.id}`));
      assert.ok(current, message.route);
      if (message.route.endsWith('/wait')) polls.push(() => reply({ job: current }));
      else if (message.route.endsWith('/delivered')) {
        beforeClaim?.(current);
        const claimed = message.body.seq > current.delivered;
        if (claimed) { current.delivered = message.body.seq; h.claims.push(current.id); }
        reply({ claimed });
      } else reply(current);
    });
    child.stdin!.end(JSON.stringify({ tool_response: `[${watched.id}]` }));
    t.after(async () => {
      if (!watcher.result) { child.kill(); await watcher.exited; }
    });
    return watcher;
  };
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const update = (current: JobView, changes: Partial<JobView>) => {
    Object.assign(current, changes, { seq: current.seq + 1 });
    for (const reply of polls.splice(0)) reply();
  };
  const until = async (ready: () => boolean) => {
    const deadline = Date.now() + 5000;
    while (!ready()) {
      assert.ok(Date.now() < deadline, 'watcher did not reach the expected state');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  return { clock: h, wake, update, until };
}

test('parallel mission watchers deliver two settled jobs in one wake', { timeout: 10000 }, async (t) => {
  const first = job('cx-000001', { state: 'done', report: 'First report' });
  const second = job('cx-000002', { createdAt: first.createdAt + 1000 });
  const h = harness(t, [second, first]);
  const a = h.wake(first);
  const b = h.wake(second);
  await h.until(() => h.clock.stateReads >= 3 || Boolean(a.result));
  assert.equal(a.result, undefined, 'the first completion must wait for its running peer');
  h.update(second, { state: 'done', report: 'Second report' });
  const results = await Promise.all([a.exited, b.exited]);
  assert.deepEqual(results.map((r) => r.code).sort(), [0, 2]);
  const output = results.find((r) => r.code === 2)!.stderr;
  assert.match(output, /First report[\s\S]*Second report/);
  assert.equal(results.find((r) => r.code === 0)!.stderr, '');
  assert.deepEqual(h.clock.claims, [first.id, second.id]);
  assert.deepEqual(await h.wake(second).exited, { code: 0, stderr: '' });
});

const important: { name: string; changes: Partial<JobView>; expected: RegExp }[] = [
  { name: 'waiting', changes: { state: 'waiting', waiting: { id: 'approval', type: 'approval', reason: 'Choose now', since: Date.now() } }, expected: /Choose now/ },
  { name: 'question', changes: { questionSeq: 3, questions: [{ id: 'q1', text: 'Choose now', at: Date.now() }] }, expected: /ASKS YOU.*Choose now/ },
  { name: 'completed with a question', changes: { state: 'done', questionSeq: 3, questions: [{ id: 'q1', text: 'Choose now', at: Date.now() }] }, expected: /ASKS YOU.*Choose now/ },
  { name: 'failed', changes: { state: 'failed', error: { message: 'Worker failed', limit: false } }, expected: /error: Worker failed/ },
  { name: 'usage limit', changes: { state: 'failed', error: { message: 'Usage limit reached', limit: true } }, expected: /out of usage for now/ },
  { name: 'cancelled', changes: { state: 'cancelled' }, expected: /CANCELLED/ },
  { name: 'stalled', changes: { stalled: true }, expected: /no activity for a while, may be stuck/ },
];

for (const { name, changes, expected } of important) {
  test(`a ${name} peer wakes the batch while another peer still runs`, { timeout: 10000 }, async (t) => {
    const first = job('cx-000001', { state: 'done' });
    const peer = job('cx-000002');
    const running = job('cx-000003');
    const h = harness(t, [first, peer, running]);
    const watcher = h.wake(first);
    await h.until(() => h.clock.stateReads >= 2 || Boolean(watcher.result));
    assert.equal(watcher.result, undefined);
    h.update(peer, changes);
    const result = await watcher.exited;
    assert.equal(result.code, 2);
    assert.match(result.stderr, expected);
    assert.ok(result.stderr.includes(`[${first.id}]`));
    assert.ok(result.stderr.includes(`[${peer.id}]`));
    assert.ok(!result.stderr.includes(`[${running.id}]`));
    assert.equal(running.delivered, 0);
    assert.ok(!h.clock.timers.includes(1500), 'important updates must skip the delivery grace period');
  });

  test(`a watched ${name} job wakes immediately with already-settled peers`, { timeout: 10000 }, async (t) => {
    const own = job('cx-000001', { ...changes, seq: 3 });
    const settled = job('cx-000002', { state: 'done' });
    const running = job('cx-000003');
    const h = harness(t, [own, settled, running]);
    const result = await h.wake(own).exited;
    assert.equal(result.code, 2);
    assert.match(result.stderr, expected);
    assert.ok(result.stderr.includes(`[${settled.id}]`));
    assert.ok(!result.stderr.includes(`[${running.id}]`));
    assert.equal(running.delivered, 0);
    assert.ok(!h.clock.timers.includes(1000), 'important updates must not wait for peers');
    assert.ok(!h.clock.timers.includes(1500), 'important updates must skip the delivery grace period');
  });
}

test('running peers retain their own watcher for a later wake after an important update', { timeout: 10000 }, async (t) => {
  const failed = job('cx-000001', { state: 'failed' });
  const running = job('cx-000002');
  const h = harness(t, [failed, running]);
  const later = h.wake(running);
  assert.equal((await h.wake(failed).exited).code, 2);
  assert.equal(later.result, undefined);
  assert.equal(running.delivered, 0);
  h.update(running, { state: 'done' });
  const result = await later.exited;
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes(`[${running.id}]`));
  assert.ok(!result.stderr.includes(`[${failed.id}]`));
});

test('batch matching excludes other missions, projects, old jobs and delivered jobs', { timeout: 10000 }, async (t) => {
  const own = job('cx-000001', { state: 'done' });
  const h = harness(t, [own,
    job('cx-000002', { mission: 'other' }),
    job('cx-000003', { project: '/other' }),
    job('cx-000004', { createdAt: own.createdAt - 20_001 }),
    job('cx-000005', { createdAt: own.createdAt + 20_001 }),
    job('cx-000006', { delivered: 2 }),
  ]);
  assert.equal((await h.wake(own).exited).code, 2);
  assert.deepEqual(h.clock.claims, [own.id]);
});

test('a stuck peer cannot postpone the wake past thirty minutes', { timeout: 10000 }, async (t) => {
  const own = job('cx-000001', { state: 'done' });
  const h = harness(t, [own, job('cx-000002')]);
  const watcher = h.wake(own);
  await h.until(() => h.clock.stateReads >= 2 || Boolean(watcher.result));
  assert.equal(watcher.result, undefined);
  h.clock.now += 30 * 60 * 1000;
  assert.equal((await watcher.exited).code, 2);
  assert.deepEqual(h.clock.claims, [own.id]);
});

test('jobs without a mission retain the single-job wake behavior', { timeout: 10000 }, async (t) => {
  const own = job('cx-000001', { mission: undefined, state: 'done' });
  const h = harness(t, [own, job('cx-000002', { mission: undefined })]);
  assert.equal((await h.wake(own).exited).code, 2);
  assert.equal(h.clock.stateReads, 0);
  assert.deepEqual(h.clock.claims, [own.id]);
});

test('a peer claimed by another reader is omitted from the combined report', { timeout: 10000 }, async (t) => {
  const first = job('cx-000001', { state: 'done' });
  const second = job('cx-000002', { state: 'done' });
  const h = harness(t, [first, second], (current) => {
    if (current.id === first.id) second.delivered = second.seq;
  });
  const result = await h.wake(first).exited;
  assert.equal(result.code, 2);
  assert.ok(result.stderr.includes(`[${first.id}]`));
  assert.ok(!result.stderr.includes(`[${second.id}]`));
  assert.deepEqual(h.clock.claims, [first.id]);
});
