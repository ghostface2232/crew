import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Actions, answerKey, tokenFromFragment } from '../plugin/board/src/api.ts';
import { BoardStore, mergeEvents } from '../plugin/board/src/store.ts';
import { brief, cardsForProject, jobMark, unsettled, missionProgress, relativeDuration, usageWindowName, STOP_OF_STAGE, timeLabel, together } from '../plugin/board/src/model.ts';
import type { BoardJob, BoardState, CrewEvent, Mission } from '../plugin/board/src/types.ts';

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test('all answer surfaces share a lock that survives acceptance until a new request', async () => {
  const actions = new Actions();
  const pending = deferred();
  let calls = 0;
  const key = answerKey('cx-1', 'request-1');
  const work = () => {
    calls++;
    return pending.promise;
  };
  const first = actions.run(key, work);
  assert.equal(await actions.run(key, work), false);
  assert.equal(calls, 1);
  pending.resolve();
  assert.equal(await first, true);
  assert.equal(await actions.run(key, work), false);
  assert.equal(await actions.run(answerKey('cx-1', 'request-2'), async () => {}), true);
});

test('a failed answer can retry without moving its error to the next request', async () => {
  const actions = new Actions();
  const old = deferred();
  const next = deferred();
  const first = actions.run('old', () => old.promise);
  const second = actions.run('new', () => next.promise);
  old.reject(new Error('Disconnected'));
  assert.equal(await first, false);
  assert.equal(actions.get('new').pending, true);
  assert.equal(actions.get('old').tone, 'failed');
  assert.equal(await actions.run('old', async () => {}), true);
  next.resolve();
  assert.equal(await second, true);
});

test('repeatable follow-ups can be sent again after acceptance', async () => {
  const actions = new Actions();
  assert.equal(await actions.run('followup', async () => {}, { once: false }), true);
  assert.equal(await actions.run('followup', async () => {}, { once: false }), true);
});

test('states combine by urgency and elapsed time uses coarse labels', () => {
  assert.equal(together(['done', 'working', 'waiting']), 'waiting');
  assert.equal(together(['done', 'stalled', 'working']), 'stalled');
  assert.equal(together(['done', 'idle']), 'done');
  assert.equal(together([]), '');
  assert.equal(jobMark({ state: 'running', stalled: true } as BoardJob), 'stalled');
  assert.equal(jobMark({ state: 'waiting', stalled: true } as BoardJob), 'waiting');
  assert.equal(jobMark({ state: 'cancelled' } as BoardJob), 'idle');
  assert.deepEqual([brief(42_000), brief(479_000), brief(3_780_000)], ['42s', '7m', '1h 3m']);
  assert.equal(
    timeLabel({ state: 'failed', createdAt: 0, endedAt: 660_000 } as BoardJob, 1_000_000),
    'stopped after 11m',
  );
  assert.equal(STOP_OF_STAGE['self-review'], STOP_OF_STAGE['cross-review']);
});

test('unfinished jobs outlive the recent mission limit without duplicates', () => {
  const missions = ['old', 'recent', 'newest'].map(
    (id, index) => ({ id, state: 'abandoned', endedAt: (index + 1) * 100, createdAt: 1 }) as Mission,
  );
  const jobs = [
    { id: 'cx-old', mission: 'old', state: 'running', endedAt: null, createdAt: 2 },
    { id: 'cx-recent', mission: 'recent', state: 'waiting', endedAt: null, createdAt: 3 },
  ] as BoardJob[];
  assert.deepEqual(
    cardsForProject(missions, jobs).loose.map((job) => job.id),
    ['cx-old'],
  );
  assert.deepEqual(
    cardsForProject(missions, jobs).ended.map((mission) => mission.id),
    ['newest', 'recent'],
  );
  jobs[0].endedAt = 400;
  assert.equal(cardsForProject(missions, jobs).loose.length, 0);
});

test('a reconnect replaces snapshots and events, including restarted event sequences', () => {
  const store = new BoardStore();
  let updates = 0;
  const unsubscribe = store.subscribe(() => updates++);
  const state = {
    now: Date.now(),
    jobs: [{ id: 'a' }],
    claude: [],
    missions: [],
    agents: {},
    roles: {},
    limits: {},
    events: [{ seq: 100 }],
  } as unknown as BoardState;
  store.receive('state', state);
  store.receive('job', { id: 'a', state: 'waiting' });
  assert.equal(store.getSnapshot().jobs.length, 1);
  assert.equal(store.getSnapshot().jobs[0].state, 'waiting');
  store.receive('claude', { session: { id: 'lead' }, removed: false });
  store.receive('claude', { session: { id: 'lead' }, removed: true });
  assert.equal(store.getSnapshot().claude.length, 0);
  store.receive('state', { ...state, jobs: [], events: [{ seq: 1 }] });
  assert.deepEqual(store.getSnapshot().events, [{ seq: 1 }]);
  assert.equal(store.getSnapshot().jobs.length, 0);
  assert.equal(store.getSnapshot().revision, 2);
  assert.equal(updates, 5);
  unsubscribe();
});

test('events deduplicate overlap between a detail fetch and the stream and stay bounded', () => {
  const events = [{ seq: 2 }, { seq: 1 }] as CrewEvent[];
  assert.deepEqual(
    mergeEvents(events, [{ seq: 2 }, { seq: 3 }] as CrewEvent[], 2).map((event) => event.seq),
    [2, 3],
  );
});

test('stream lifecycle closes connections on unmount and exposes disconnection', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ now: Date.now(), events: [] }));
  const store = new BoardStore();
  let closed = false;
  const stream = {
    addEventListener() {},
    onerror: null as null | (() => void),
    close() {
      closed = true;
    },
  };
  const cleanup = store.connect(() => stream as unknown as EventSource);
  await new Promise((resolve) => setImmediate(resolve));
  stream.onerror!();
  assert.equal(store.getSnapshot().connection, 'lost');
  cleanup();
  assert.equal(closed, true);
});

test('mission progress uses all seven stages and only its unfinished jobs', () => {
  const mission = { id: 'm', stage: 'cross-review', state: 'active' } as Mission;
  const jobs = [
    { mission: 'm', state: 'running', endedAt: null },
    { mission: 'm', state: 'waiting', endedAt: null },
    { mission: 'm', state: 'done', endedAt: 10 },
    { mission: 'm', state: 'failed', endedAt: 11 },
    { mission: 'm', state: 'cancelled', endedAt: 12 },
    { mission: 'other', state: 'running', endedAt: null },
  ] as BoardJob[];
  assert.equal(missionProgress(mission, jobs), 0.5);
  assert.equal(missionProgress(mission, []), 0.5);
  assert.equal(missionProgress({ ...mission, state: 'abandoned' }, jobs), 0.5);
  assert.equal(missionProgress({ ...mission, state: 'done' }, jobs), 1);
  const stages = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'] as const;
  stages.forEach((stage, index) => {
    assert.equal(missionProgress({ ...mission, stage }, jobs), (index + 0.5) / 7);
    assert.equal(missionProgress({ ...mission, stage, state: 'abandoned' }, []), (index + 0.5) / 7);
  });
});

test('usage labels and relative durations remain compact', () => {
  assert.equal(usageWindowName('fiveHour'), '5-hour');
  assert.equal(usageWindowName('weekly'), 'Weekly');
  assert.equal(usageWindowName('billingCycle'), 'Billing cycle');
  assert.equal(usageWindowName('dailyQuota'), 'daily Quota');
  assert.equal(relativeDuration(-1), '1m');
  assert.equal(relativeDuration(20 * 60_000), '20m');
  assert.equal(relativeDuration(3 * 3600_000), '3h');
  assert.equal(relativeDuration(7 * 86400_000), '7d');
});

test('usage and preset events replace immutable snapshots and older state clears them', () => {
  const store = new BoardStore();
  const usage = { source: 'none', generatedAt: 1, providers: [] } as const;
  const presets = { economy: {}, balanced: {}, best: {} };
  const initial = store.getSnapshot();
  store.receive('usage', usage);
  store.receive('preset', { preset: 'economy', presets });
  assert.equal(initial.usage, undefined);
  assert.equal(initial.preset, undefined);
  assert.equal(store.getSnapshot().usage, usage);
  assert.equal(store.getSnapshot().preset, 'economy');
  assert.equal(store.getSnapshot().presets, presets);
  const state = { ...initial, now: Date.now() };
  store.receive('state', { ...state, usage, preset: 'best', presets });
  assert.equal(store.getSnapshot().preset, 'best');
  store.receive('state', state);
  assert.equal(store.getSnapshot().usage, undefined);
  assert.equal(store.getSnapshot().preset, undefined);
  assert.equal(store.getSnapshot().presets, undefined);
});

test('transport subscribes to usage and preset events', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ now: Date.now(), events: [] }));
  const listeners = new Map<string, (event: { data: string }) => void>();
  const store = new BoardStore();
  const cleanup = store.connect(() => ({
    addEventListener: (type: string, listener: (event: { data: string }) => void) => listeners.set(type, listener),
    close() {},
  }) as unknown as EventSource);
  await new Promise((resolve) => setImmediate(resolve));
  listeners.get('usage')!({ data: JSON.stringify({ source: 'none', providers: [] }) });
  listeners.get('preset')!({ data: JSON.stringify({ preset: null, presets: {} }) });
  assert.equal(store.getSnapshot().usage?.source, 'none');
  assert.equal(store.getSnapshot().preset, null);
  cleanup();
});

test('launch fragments accept only a complete 64-digit hexadecimal token', () => {
  const token = '0123456789abcdef'.repeat(4);
  assert.equal(tokenFromFragment(`#token=${token}`), token);
  assert.equal(tokenFromFragment(`#view=board&token=${token.toUpperCase()}&other=value`), token.toUpperCase());
  for (const fragment of ['', '#cx-build', '#token=', `#token=${token.slice(1)}`, `#token=${token}0`,
    `#token=${'g'.repeat(64)}`, `#other=token=${token}`, `#token=${token}%0A`]) {
    assert.equal(tokenFromFragment(fragment), null);
  }
});

test('an ended job counts until its worktree is gone and the lead has read its result', () => {
  const tree = { path: '/w', branch: 'crew-cx-000000', base: 'abc' };
  assert.equal(unsettled({ worktree: tree, seq: 3, delivered: 3 } as BoardJob), true);
  assert.equal(unsettled({ worktree: null, seq: 4, delivered: 3 } as BoardJob), true);
  assert.equal(unsettled({ worktree: null, seq: 4, delivered: 4 } as BoardJob), false);
});
