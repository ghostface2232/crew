import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { Actions, answerKey, onUnauthorized, stream, ticketFromFragment, UnauthorizedError } from '../plugin/board/src/api.ts';
import { BoardStore, mergeEvents } from '../plugin/board/src/store.ts';
import { formatDate, longDay, shortDateTime, shortDay, shortMonth, timeOfDay } from '../plugin/board/src/dates.ts';
import { Notifier } from '../plugin/board/src/notify.ts';
import { elapsed, evidenceSide, evidenceTurn, orderEvidence, jobLabel, leadMission, projectNames, unsettled, missionStops, missionStep, missionStopPosition, missionJobStep, missionLooksFinished, pullIsStale, pullStatuses, relativeDuration, usageWindowName, STOP_OF_STAGE } from '../plugin/board/src/model.ts';
import type { BoardJob, BoardPull, BoardState, ClaudeSession, CrewEvent, Mission } from '../plugin/board/src/types.ts';

function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function stubGlobal(t: TestContext, key: string, value: unknown) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
  Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  });
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

test('elapsed time and project names use the app\'s labels', () => {
  assert.deepEqual([elapsed(42_000), elapsed(479_000), elapsed(3_780_000)], ['<1m', '7m', '1h 3m']);
  assert.deepEqual([...projectNames(['/a/app', '/b/app', '/c/tool']).values()], ['a/app', 'b/app', 'tool']);
  assert.deepEqual(
    [...projectNames(['C:\\Users\\me\\OneDrive\\crew', 'C:\\Users\\me\\work\\site', 'D:\\x\\site', '/x/site']).values()],
    ['crew', 'work\\site', 'D:\\x\\site', '/x/site'],
  );
  assert.deepEqual([...projectNames(['C:\\a\\app', 'D:\\b\\APP']).values()], ['a\\app', 'b\\APP']);
  assert.equal(jobLabel({ state: 'running', stalled: true } as BoardJob), 'May be stuck');
  assert.equal(jobLabel({ state: 'waiting', stalled: true, waiting: { type: 'approval' } } as BoardJob), 'Needs approval');
  assert.equal(STOP_OF_STAGE['self-review'], STOP_OF_STAGE['cross-review']);
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
  assert.equal(updates, 2);
  unsubscribe();
});

test('events deduplicate overlap between a detail fetch and the stream and stay bounded', () => {
  const events = [{ seq: 2 }, { seq: 1 }] as CrewEvent[];
  assert.deepEqual(
    mergeEvents(events, [{ seq: 2 }, { seq: 3 }] as CrewEvent[], 2).map((event) => event.seq),
    [2, 3],
  );
});

test('single-event merges agree with the general path for appends, duplicates and late arrivals', () => {
  const events = [{ seq: 1 }, { seq: 3 }] as CrewEvent[];
  for (const [seq, limit, expected] of [
    [4, 3, [1, 3, 4]],
    [4, 2, [3, 4]],
    [3, 3, [1, 3]],
    [2, 3, [1, 2, 3]],
  ] as const) {
    const event = { seq } as CrewEvent;
    const merged = mergeEvents(events, [event], limit);
    assert.deepEqual(merged, mergeEvents(events, [event, event], limit));
    assert.deepEqual(merged.map((item) => item.seq), expected);
    assert.equal(merged.find((item) => item.seq === seq), event);
  }
});

test('board dates preserve invalid dates and follow changes to the local time zone', (t) => {
  const original = process.env.TZ;
  t.after(() => {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  });
  const date = new Date('2025-01-01T01:30:00Z');
  const invalid = new Date(NaN);
  const formatters = [
    [longDay, { weekday: 'long', month: 'long', day: 'numeric' }],
    [shortDay, { weekday: 'short', month: 'short', day: 'numeric' }],
    [shortMonth, { month: 'short' }],
    [timeOfDay, { hour: 'numeric', minute: '2-digit' }],
    [shortDateTime, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }],
  ] as const;
  for (const zone of ['UTC', 'America/Los_Angeles']) {
    process.env.TZ = zone;
    for (const [formatter, options] of formatters) {
      assert.equal(formatDate(formatter, invalid), invalid.toLocaleString());
      assert.equal(formatDate(formatter, date), date.toLocaleString([], options), zone);
    }
  }
});

test('stream lifecycle closes connections on unmount and exposes disconnection', async () => {
  const store = new BoardStore();
  let fail!: (error: Error) => void;
  let signal!: AbortSignal;
  const cleanup = store.connect((_route, _receive, given) => {
    signal = given;
    return new Promise((_resolve, reject) => { fail = reject; });
  });
  await new Promise((resolve) => setImmediate(resolve));
  fail(new Error('connection reset'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().connection, 'lost');
  cleanup();
  assert.equal(signal.aborted, true);
});

test('the stream is read whole across chunks that end inside a character or an event', async (t) => {
  const bytes = Buffer.from(`event: state\ndata: {"title":"한글"}\n\n: keep-alive\n\nevent: job\ndata: {"id":"cx-1"}\n\nevent: job\ndata: {"id":"unfinished`);
  // One byte at a time cuts every character and every event somewhere.
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const sent: RequestInit[] = [];
  t.mock.method(globalThis, 'fetch', async (_route: string, init: RequestInit) => { sent.push(init); return new Response(body); });
  const events: [string, unknown][] = [];
  await stream('/api/stream', (type, data) => events.push([type, JSON.parse(data)]), new AbortController().signal);
  assert.deepEqual(events, [['state', { title: '한글' }], ['job', { id: 'cx-1' }]]);
  // A page that holds no credential sends none: the desktop app signs its requests itself.
  assert.deepEqual(sent[0].headers, {});
});

test('a refused stream signs the board out instead of retrying as an outage', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: 'unauthorized' }, { status: 401 }); });
  let told = 0;
  const unsubscribe = onUnauthorized(() => told++);
  await assert.rejects(stream('/api/stream', () => {}, new AbortController().signal), UnauthorizedError);
  unsubscribe();
  assert.equal(told, 1);
  const store = new BoardStore();
  const cleanup = store.connect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.getSnapshot().connection, 'unauthorized');
  cleanup();
  assert.equal(calls, 2);
});

test('short plans drive stops, passed positions and job attachment in their own order', () => {
  const mission = { id: 'm', stage: 'self-review', state: 'active', stages: ['implement', 'self-review', 'final'] } as Mission;
  assert.deepEqual(missionStops(mission).map((stop) => stop.name), ['Build', 'Review', 'Final']);
  assert.equal(missionStep(mission), 1);
  assert.deepEqual([0, 1, 2].map((index) => missionStopPosition(mission, index)), ['past', 'now', 'todo']);
  assert.equal(missionJobStep(mission, { kind: 'delegate' }), 0);
  assert.equal(missionJobStep(mission, { kind: 'review' }), 1);
  assert.equal(missionJobStep(mission, { kind: 'polish' }), 1);
  mission.stage = 'final';
  mission.state = 'done';
  assert.deepEqual([0, 1, 2].map((index) => missionStopPosition(mission, index)), ['past', 'past', 'past']);
  mission.state = 'active'; mission.stages = ['final'];
  mission.stage = 'cross-review'; mission.stages = ['cross-review', 'implement', 'self-review'];
  assert.deepEqual(missionStops(mission).map((stop) => stop.name), ['Review', 'Build', 'Review 2']);
  // A named stop goes by its name and is left out of the numbering, but keeps its kind for attaching jobs.
  mission.labels = ['Sample check', null, null];
  assert.deepEqual(missionStops(mission).map((stop) => stop.name), ['Sample check', 'Build', 'Review']);
  assert.equal(missionJobStep(mission, { kind: 'review' }), 0);
  delete mission.labels;
  mission.stage = 'self-review';
  assert.equal(missionJobStep(mission, { kind: 'review' }), 2);
  delete mission.stages;
  assert.equal(missionStops(mission).length, 6);
  assert.equal(missionStep(mission), 2);
});

test('repeated stops use the saved occurrence and retain jobs on the stop where they started', () => {
  const mission = { id: 'm', stage: 'fix', stageIndex: 4, state: 'active', stages: ['implement', 'self-review', 'fix', 'cross-review', 'fix', 'final'] } as Mission;
  assert.deepEqual(missionStops(mission).map((stop) => stop.name), ['Build', 'Review', 'Fix', 'Review 2', 'Fix 2', 'Final']);
  assert.equal(missionStep(mission), 4);
  assert.equal(missionJobStep(mission, { kind: 'review', missionStep: 1 }), 1);
  assert.equal(missionJobStep(mission, { kind: 'review', missionStep: 3 }), 3);
  assert.equal(missionJobStep(mission, { kind: 'delegate', missionStep: 4 }), 4);
  mission.stages = [...mission.stages!.slice(0, 5), 'polish', 'cross-review', 'final'];
  assert.equal(missionJobStep(mission, { kind: 'review', missionStep: 1 }), 1);
  assert.equal(missionJobStep(mission, { kind: 'review', missionStep: 3 }), 3);
});

test('a lead row follows its focused active mission, falling back to its newest active mission', () => {
  const older = { id: 'older', state: 'active', owner: 'lead', createdAt: 1000, updatedAt: 9999 } as Mission;
  const newer = { ...older, id: 'newer', createdAt: 2000, updatedAt: 2000 };
  const closed = { ...older, id: 'closed', state: 'done', createdAt: 3000 } as const;
  const foreign = { ...older, id: 'foreign', owner: 'other', createdAt: 4000 };
  const all = [older, newer, closed, foreign];
  const session = { id: 'lead' };
  assert.equal(leadMission({ ...session, mission: older.id }, all), older);
  for (const mission of [undefined, 'missing', closed.id, foreign.id])
    assert.equal(leadMission({ ...session, mission }, all), newer);
  assert.equal(leadMission(session, [older]), older);
  assert.equal(leadMission(session, [closed, foreign]), undefined);
});

test('a pull request lists its statuses most urgent first, and only ended reads or quiet watches go stale', () => {
  const pull = { state: 'open', checks: 'none', review: '', conflict: false, checkedAt: 1000 } as BoardPull;
  const words = (change: Partial<BoardPull>) => pullStatuses({ ...pull, ...change }).map(({ word }) => word);
  assert.deepEqual(words({}), []);
  assert.deepEqual(words({ checks: 'failing', review: 'changes_requested', conflict: true }), ['Conflict', 'Checks failing', 'Changes requested']);
  assert.deepEqual(words({ checks: 'pending', review: 'approved' }), ['Checks running', 'Approved']);
  assert.deepEqual(words({ checks: 'passing', review: 'approved' }), ['Approved', 'Checks passed']);
  assert.deepEqual(words({ checks: 'passing', review: 'review_required' }), ['Checks passed']);
  assert.deepEqual(pullStatuses({ ...pull, review: 'changes_requested' }), [{ word: 'Changes requested', tone: 'waiting', needsLead: true }]);
  // An ended pull request is its end state alone.
  assert.deepEqual(pullStatuses({ ...pull, state: 'merged', checks: 'failing', conflict: true }), [{ word: 'Merged', tone: 'merged' }]);
  assert.deepEqual(pullStatuses({ ...pull, state: 'closed' }), [{ word: 'Closed', tone: '' }]);

  const quiet = 1000 + 15 * 60_000;
  assert.equal(pullIsStale(pull, quiet), false);
  assert.equal(pullIsStale(pull, quiet + 1), true);
  assert.equal(pullIsStale({ ...pull, error: 'gh failed' }, 1000), true);
  assert.equal(pullIsStale({ ...pull, ended: true }, 1000), true);
  assert.equal(pullIsStale({ ...pull, state: 'merged' }, quiet + 1), false);
});

test('looks finished requires a quiet owner and no open jobs or tasks for 20 minutes', () => {
  const mission = { id: 'm', state: 'active', updatedAt: 1000 } as Mission;
  const now = 1000 + 20 * 60_000;
  assert.equal(missionLooksFinished(mission, [], now - 1), false);
  assert.equal(missionLooksFinished(mission, [], now), true);
  // A lead working on its own keeps the mission from looking finished.
  assert.equal(missionLooksFinished(mission, [], now, { state: 'working' } as ClaudeSession), false);
  assert.equal(missionLooksFinished(mission, [], now, { state: 'idle' } as ClaudeSession), true);
  for (const state of ['running', 'waiting', 'done', 'failed', 'cancelled']) {
    const jobs = [{ mission: 'm', state, endedAt: null }] as BoardJob[];
    assert.equal(missionLooksFinished(mission, jobs, now), state !== 'running' && state !== 'waiting');
    jobs[0].mission = 'other';
    assert.equal(missionLooksFinished(mission, jobs, now), true);
  }
  for (const state of ['done', 'abandoned'] as const)
    assert.equal(missionLooksFinished({ ...mission, state }, [], now), false);
  for (const state of ['todo', 'doing', 'done', 'dropped'] as const)
    assert.equal(missionLooksFinished({ ...mission, tasks: [{ id: 'task', title: 'Test', state }] }, [], now), state === 'done' || state === 'dropped');
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

test('transport passes usage and preset events to the store', async () => {
  let receive!: (type: string, data: string) => void;
  const store = new BoardStore();
  const cleanup = store.connect((_route, given) => {
    receive = given;
    return new Promise(() => {});
  });
  await new Promise((resolve) => setImmediate(resolve));
  receive('usage', JSON.stringify({ source: 'none', providers: [] }));
  receive('preset', JSON.stringify({ preset: null, presets: {} }));
  assert.equal(store.getSnapshot().usage?.source, 'none');
  assert.equal(store.getSnapshot().preset, null);
  cleanup();
  // An event from a connection that was closed is not applied.
  receive('preset', JSON.stringify({ preset: 'best', presets: {} }));
  assert.equal(store.getSnapshot().preset, null);
});

test('launch fragments accept only a complete 64-digit hexadecimal ticket', () => {
  const ticket = '0123456789abcdef'.repeat(4);
  assert.equal(ticketFromFragment(`#ticket=${ticket}`), ticket);
  assert.equal(ticketFromFragment(`#view=board&ticket=${ticket.toUpperCase()}&other=value`), ticket.toUpperCase());
  for (const fragment of ['', '#cx-build', '#ticket=', `#ticket=${ticket.slice(1)}`, `#ticket=${ticket}0`,
    `#ticket=${'g'.repeat(64)}`, `#other=ticket=${ticket}`, `#ticket=${ticket}%0A`, `#token=${ticket}`]) {
    assert.equal(ticketFromFragment(fragment), null);
  }
});

test('an ended job counts until its worktree is gone and the lead has read its result', () => {
  const tree = { path: '/w', branch: 'crew-cx-000000', base: 'abc' };
  assert.equal(unsettled({ worktree: tree, seq: 3, delivered: 3 } as BoardJob), true);
  assert.equal(unsettled({ worktree: null, seq: 4, delivered: 3 } as BoardJob), true);
  assert.equal(unsettled({ worktree: null, seq: 4, delivered: 4 } as BoardJob), false);
});

test('captures read their side from their name and order as reference, before, after', () => {
  assert.deepEqual(evidenceSide('fox-before.png'), { view: 'fox', side: 'before' });
  assert.deepEqual(evidenceSide('After_Fox Idle.PNG'), { view: 'fox idle', side: 'after' });
  assert.equal(evidenceSide('before.png'), null);
  assert.equal(evidenceSide('aftermath.png'), null);
  // The separators around a view are not part of it, and a name that is only separators is no view; the app reads both so.
  assert.deepEqual(['hero--after.png', 'hero - after.png', 'before - hero.png'].map((file) => evidenceSide(file)?.view), ['hero', 'hero', 'hero']);
  assert.equal(evidenceSide('before--.png'), null);
  const item = (file: string, turn: number, from: 'worker' | 'lead' = 'worker') => ({ file, turn, from });
  const items = [
    item('fox-after.png', 3), item('fox-before.png', 1), item('rock-after.png', 3), item('rock-before.png', 2),
    item('notes.png', 3), item('lead-1-concept.png', 1, 'lead'), item('lead-2-concept.png', 2, 'lead'),
  ];
  assert.deepEqual(orderEvidence(items).map((found) => found.file),
    ['lead-1-concept.png', 'lead-2-concept.png', 'fox-before.png', 'rock-before.png', 'notes.png', 'fox-after.png', 'rock-after.png']);
  // Names that tie are ordered by code unit, as the app orders them, not by locale.
  assert.deepEqual(orderEvidence(['fox.png', 'hero_a.png', 'hero-a.png', 'Rock.png'].map((file) => item(file, 1))).map((found) => found.file), ['Rock.png', 'fox.png', 'hero-a.png', 'hero_a.png']);
  // Only a job with several turns needs to say which of them a capture is from.
  assert.equal(evidenceTurn(item('a.png', 1), 1), 'Turn 1');
  assert.equal(evidenceTurn(item('a.png', 1), 3), 'Turn 1 of 3');
  assert.equal(evidenceTurn(item('a.png', 1, 'lead'), 3), 'Attached by the lead');
});

test('stream keeps the first event name, joins data lines and consumes blank lines without overlap', async (t) => {
  const chunks = ['event:  first  \nevent: second\ndata:  one\ndata:\ndata:three\n', '\n\ndata: next\n\n\n\nevent: empty\n\ndata:\n\n'];
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  t.mock.method(globalThis, 'fetch', async () => new Response(body));
  const frames: [string, string][] = [];
  await stream('/api/stream', (type, data) => frames.push([type, data]), new AbortController().signal);
  assert.deepEqual(frames, [['first', ' one\n\nthree'], ['message', 'next'], ['message', '']]);
});

test('stream notifications see a request and its resolution before the next frame, with focus at arrival', (t) => {
  const store = new BoardStore();
  const listener = t.mock.fn();
  t.after(store.subscribe(listener));

  let focused = false;
  let frames = 0;
  stubGlobal(t, 'document', Object.assign(new EventTarget(), { hasFocus: () => focused }));
  stubGlobal(t, 'requestAnimationFrame', () => ++frames);
  stubGlobal(t, 'cancelAnimationFrame', () => {});

  const notify = new Notifier();
  const update = t.mock.method(notify, 'update');
  let receive!: (type: string, data: string) => void;
  t.after(store.connect((_path, onEvent) => {
    receive = onEvent;
    return new Promise(() => {});
  }, notify));

  const job = { id: 'cx-1', state: 'running' };
  receive('state', JSON.stringify({ now: Date.now(), jobs: [job], claude: [], events: [] }));
  update.mock.resetCalls();
  listener.mock.resetCalls();
  receive('job', JSON.stringify({ ...job, state: 'waiting', waiting: { id: 'request-1' } }));
  focused = true;
  receive('job', JSON.stringify(job));
  receive('event', JSON.stringify({ seq: 1 }));

  assert.equal(frames, 1);
  assert.equal(listener.mock.callCount(), 0);
  assert.deepEqual(update.mock.calls.map(({ arguments: [state, focus] }) => [state.jobs[0].state, focus]), [
    ['waiting', false],
    ['running', true],
  ]);
});

test('store publishes the latest snapshot once per frame and flushes connection changes immediately', (t) => {
  const frames = new Map<number, FrameRequestCallback>();
  let frameId = 0;
  const frame = (callback: FrameRequestCallback) => {
    frames.set(++frameId, callback);
    return frameId;
  };
  const cancel = (id: number) => frames.delete(id);
  stubGlobal(t, 'requestAnimationFrame', frame);
  stubGlobal(t, 'cancelAnimationFrame', cancel);
  const doc = Object.assign(new EventTarget(), { hidden: false });
  stubGlobal(t, 'document', doc);
  t.mock.timers.enable({ apis: ['setTimeout'] });

  const store = new BoardStore();
  const seen: number[] = [];
  const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot().events.at(-1)?.seq ?? 0));
  store.receive('event', { seq: 1 });
  store.receive('event', { seq: 2 });
  assert.equal(store.getSnapshot().events.length, 2);
  assert.deepEqual(seen, []);
  assert.equal(frames.size, 1);
  frames.get(frameId)!(0);
  assert.deepEqual(seen, [2]);

  store.receive('event', { seq: 3 });
  doc.hidden = true;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 0);
  t.mock.timers.tick(0);
  assert.deepEqual(seen, [2, 3]);

  store.receive('event', { seq: 4 });
  store.signOut();
  assert.equal(store.getSnapshot().connection, 'unauthorized');
  assert.deepEqual(seen, [2, 3, 4]);
  t.mock.timers.tick(0);
  assert.deepEqual(seen, [2, 3, 4]);

  doc.hidden = false;
  store.receive('event', { seq: 5 });
  assert.equal(frames.size, 1);
  unsubscribe();
  assert.equal(frames.size, 0);

  doc.hidden = true;
  const unsubscribeHidden = store.subscribe(() => assert.fail('the timer was cancelled'));
  store.receive('event', { seq: 6 });
  unsubscribeHidden();
  const unsubscribeNext = store.subscribe(() => assert.fail('a stale timer must not notify new subscribers'));
  t.mock.timers.tick(0);
  doc.hidden = false;
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(frames.size, 0);
  unsubscribeNext();
});
