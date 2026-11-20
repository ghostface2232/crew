import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PULL_FIELDS, Pulls, observe } from '../plugin/bridge/pulls.ts';
import type { PullCheck, PullDeps, PullView, PullWatch } from '../plugin/bridge/pulls.ts';

const URL = 'https://github.com/octo/crew/pull/12';
const SECOND_URL = 'https://github.com/octo/crew/pull/13';
const HEAD = '123456789';
const WARNING = 'Do not merge, close or deploy from this news.';

function view(overrides: Partial<PullView> = {}): PullView {
  return {
    url: URL, number: 12, title: 'Update Crew', state: 'OPEN', headRefOid: HEAD,
    author: { login: 'author' }, mergeable: 'MERGEABLE', reviewDecision: '',
    statusCheckRollup: [], reviews: [], ...overrides,
  };
}

function run(name: string, conclusion = 'FAILURE', status = 'COMPLETED'): PullCheck {
  return { __typename: 'CheckRun', name, workflowName: 'CI', conclusion, status };
}

function harness() {
  let now = 10_000;
  let present = true;
  let saves = 0;
  const missions = new Map<string, NonNullable<ReturnType<PullDeps['mission']>>>([
    ['one', { state: 'active', owner: 'lead', root: '/project' }],
    ['two', { state: 'done', owner: 'other', root: '/other' }],
  ]);
  const responses = new Map<string, PullView | string | Error>([[URL, view()], [SECOND_URL, view({ url: SECOND_URL, number: 13 })]]);
  const calls: { args: string[]; cwd?: string }[] = [];
  const changes: string[] = [];
  const polled: string[] = [];
  const deps: PullDeps = {
    gh: async (args, cwd) => {
      calls.push({ args, cwd });
      const output = responses.get(args[2] === '12' ? URL : args[2]);
      if (output instanceof Error) throw output;
      return typeof output === 'string' ? output : JSON.stringify(output);
    },
    now: () => now,
    mission: (id) => missions.get(id),
    present: () => present,
    save: () => { saves++; },
    changed: (watch) => { changes.push(watch.id); },
    polled: (watch) => { polled.push(watch.id); },
  };
  const pulls = new Pulls(deps);
  return {
    pulls, deps, responses, calls, changes, polled, missions,
    advance: (ms: number) => { now += ms; },
    setPresent: (value: boolean) => { present = value; },
    saves: () => saves,
  };
}

test('a failed check is sent once across polls; new keys on the same head do not count another head', async () => {
  const h = harness();
  const { watch } = await h.pulls.link('one', '12');
  h.responses.set(URL, view({ statusCheckRollup: [run('build'), run('build')] }));
  h.advance(300_000);
  await h.pulls.tick();
  assert.equal(watch.news?.length, 1);
  assert.match(watch.news![0].reason, /octo\/crew#12 at 1234567.*CI \/ build/);
  const saved = h.saves();
  h.advance(300_000);
  await h.pulls.tick();
  assert.equal(watch.news?.length, 1);
  assert.equal(h.saves(), saved);
  h.responses.set(URL, view({ statusCheckRollup: [
    run('build'), { __typename: 'StatusContext', context: 'ci/lint', state: 'ERROR' },
  ] }));
  h.advance(300_000);
  await h.pulls.tick();
  assert.equal(watch.news?.length, 2);
  assert.match(watch.news![1].reason, /ci\/lint.*also failed on the same head/);
  assert.doesNotMatch(watch.news![1].reason, /CI \/ build/);
  assert.equal(watch.failingHeads, 1);
  assert.deepEqual(watch.told.checks, ['CI / build', 'ci/lint']);
});

test('the third failing head holds further failures until a head passes', async () => {
  const { watch } = await harness().pulls.link('one', '12');
  const failing = (head: string) => observe(watch, view({ headRefOid: head, statusCheckRollup: [run('build', 'TIMED_OUT')] }));
  const first = failing('11111111');
  assert.equal(first[0].kind, 'checks');
  assert.match(first[0].reason, /gh pr checks.*gh run view --log-failed.*reply.*delegate with role fix/);
  assert.match(failing('22222222')[0].reason, /new head after a push.*earlier failure.*same fix/);
  assert.match(failing('33333333')[0].reason, /three heads in a row.*user.*pass pr to mission again, with id "one"/);
  assert.equal(watch.held, true);
  assert.deepEqual(failing('44444444'), []);
  assert.equal(watch.failingHeads, 4);
  assert.deepEqual(watch.told, { head: '44444444', checks: ['CI / build'] });

  const passed = observe(watch, view({ headRefOid: '55555555', statusCheckRollup: [
    { __typename: 'StatusContext', context: 'ci/build', state: 'SUCCESS' },
  ] }));
  assert.deepEqual(passed.map((item) => item.kind), ['passed']);
  assert.match(passed[0].reason, /octo\/crew#12 at 5555555.*failure reported before is gone/);
  assert.equal(watch.failingHeads, 0);
  assert.equal(watch.held, undefined);
  assert.match(failing('66666666')[0].reason, /gh run view --log-failed/);
});

test('empty, inconclusive and pending checks do not clear a failure', async () => {
  const { watch } = await harness().pulls.link('one', '12');
  observe(watch, view({ statusCheckRollup: [run('build', 'STARTUP_FAILURE')] }));
  const cases: [PullView['statusCheckRollup'], PullWatch['checks']][] = [
    [null, 'none'],
    [[], 'none'],
    [[run('build', 'SKIPPED'), run('lint', 'CANCELLED'), run('test', 'NEUTRAL'), run('action', 'ACTION_REQUIRED')], 'none'],
    [[run('lint', 'SUCCESS'), run('build', '', 'QUEUED')], 'pending'],
    [[{ __typename: 'StatusContext', context: 'ci/build', state: 'EXPECTED' }], 'pending'],
  ];
  for (const [statusCheckRollup, expected] of cases) {
    assert.deepEqual(observe(watch, view({ headRefOid: 'next-head', statusCheckRollup })), []);
    assert.equal(watch.checks, expected);
    assert.equal(watch.failingHeads, 1);
  }
});

test('reviews record every id and send only new feedback from other reviewers', async () => {
  const { watch } = await harness().pulls.link('one', '12');
  const reviewed = view({ reviewDecision: 'CHANGES_REQUESTED', reviews: [
    { id: 'own', author: { login: 'author' }, state: 'COMMENTED', body: 'My own review' },
    { id: 'approved', author: { login: 'reviewer' }, state: 'APPROVED', body: 'Looks good' },
    { id: 'change', author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'Please fix\r\nthis.' },
  ] });
  const news = observe(watch, reviewed);
  assert.deepEqual(news.map((item) => item.kind), ['review']);
  assert.match(news[0].reason, /reviewer \(CHANGES_REQUESTED\) "Please fix this\.".*own words.*gh pr view.*--comments.*gh api repos\/octo\/crew\/pulls\/12\/comments/);
  assert.doesNotMatch(news[0].reason, /My own review|Looks good/);
  assert.equal(watch.review, 'changes_requested');
  assert.deepEqual(watch.reviews, ['own', 'approved', 'change']);
  assert.deepEqual(observe(watch, reviewed), []);
  const reviews = Array.from({ length: 201 }, (_, i) => ({
    id: String(i), state: i === 0 ? 'COMMENTED' : 'APPROVED', author: { login: 'reviewer' },
  }));
  const latest = view({ reviews });
  assert.deepEqual(observe(watch, latest).map(({ kind }) => kind), ['review']);
  assert.deepEqual(observe(watch, latest), []);
  assert.deepEqual(watch.reviews, reviews.map(({ id }) => id));
  for (const empty of [[], undefined, null]) observe(watch, view({ reviews: empty }));
  const restored = harness().pulls;
  restored.restore([watch]);
  assert.deepEqual(observe(restored.list()[0], latest), []);
  observe(watch, view({ reviews: reviews.slice(-1) }));
  assert.deepEqual(watch.reviews, ['200']);
});

test('a conflict only returns after a mergeable observation; a merged PR only updates its title and state', async () => {
  const { watch } = await harness().pulls.link('one', '12');
  const conflict = view({ mergeable: 'CONFLICTING' });
  assert.deepEqual(observe(watch, conflict).map((item) => item.kind), ['conflict']);
  assert.deepEqual(observe(watch, view({ mergeable: 'UNKNOWN' })), []);
  assert.equal(watch.conflict, true);
  assert.deepEqual(observe(watch, conflict), []);
  assert.deepEqual(observe(watch, view()), []);
  assert.equal(watch.conflict, false);
  assert.equal(watch.conflictTold, undefined);
  assert.deepEqual(observe(watch, conflict).map((item) => item.kind), ['conflict']);

  assert.deepEqual(observe(watch, view({
    state: 'MERGED', title: 'Merged title', headRefOid: 'other', statusCheckRollup: [run('build')],
    reviews: [{ id: 'later', state: 'COMMENTED', author: { login: 'reviewer' } }],
  })), []);
  assert.equal(watch.ended, true);
  assert.equal(watch.state, 'merged');
  assert.equal(watch.title, 'Merged title');
  assert.equal(watch.head, HEAD);
  assert.deepEqual(watch.reviews, []);
});

test('news stays within the caps and keeps its guidance and closing sentence after delivery', async () => {
  const h = harness();
  const { watch } = await h.pulls.link('one', '12');
  const checks = Array.from({ length: 10 }, (_, i) => run(`check-${i}-${'界"'.repeat(300)}`));
  const reviews = Array.from({ length: 6 }, (_, i) => ({
    id: String(i), author: { login: `reviewer-${i}` }, state: 'COMMENTED', body: '🙂"'.repeat(300),
  }));
  h.responses.set(URL, view({ statusCheckRollup: checks, reviews, mergeable: 'CONFLICTING' }));
  h.advance(300_000);
  await h.pulls.tick();
  const items = watch.news!;
  assert.deepEqual(items.map(({ kind, seq, acked }) => [kind, seq, acked]), [
    ['checks', 1, false], ['review', 2, false], ['conflict', 3, false],
  ]);
  for (const { reason } of items) {
    assert.ok(reason.length < 1000);
    assert.ok(reason.endsWith(WARNING));
  }
  assert.match(items[0].reason, /check-7-.*\(\+2 more\).*gh run view --log-failed/);
  assert.doesNotMatch(items[0].reason, /check-8-/);
  assert.match(items[1].reason, /reviewer-3.*\(\+2 more\).*--comments/);
  assert.doesNotMatch(items[1].reason, /reviewer-4/);
});

test('link primes without news and relinking only lifts a hold', async () => {
  const h = harness();
  h.responses.set(URL, view({
    statusCheckRollup: [run('build')], mergeable: 'CONFLICTING', reviewDecision: 'REVIEW_REQUIRED',
  }));
  const { watch, summary, resumed } = await h.pulls.link('one', '#12');
  assert.deepEqual(h.calls, [{ args: ['pr', 'view', '12', '--json', PULL_FIELDS], cwd: '/project' }]);
  assert.match(watch.id, /^pr-[0-9a-f]{6}$/);
  assert.match(summary, /^octo\/crew#12 · open · checks failing \(CI \/ build\) · review required · conflicts with its base$/);
  assert.equal(resumed, false);
  assert.equal(watch.news, undefined);
  assert.equal(watch.failingHeads, 1);

  watch.held = true;
  watch.failingHeads = 3;
  const before = { ...watch, held: undefined, failingHeads: 0 };
  h.responses.set(URL, view({ headRefOid: 'new-head' }));
  const again = await h.pulls.link('one', URL);
  assert.equal(again.watch, watch);
  assert.equal(again.resumed, true);
  assert.match(again.summary, /none/);
  assert.deepEqual({ ...watch, held: undefined }, before);
  assert.deepEqual(h.changes, [watch.id, watch.id]);
  assert.equal(h.saves(), 2);

  await assert.rejects(h.pulls.link('one', '--help'), /pull request number/);
  await assert.rejects(h.pulls.link('missing', '12'), /unknown or abandoned/);
  assert.equal(h.calls.length, 2);
  h.responses.set(URL, new Error('first line\nsecond line'));
  await assert.rejects(h.pulls.link('one', '12'), { message: 'The GitHub CLI could not read the pull request: "first line"' });
});

test('ticks skip absent leads and end abandoned or forgotten missions', async () => {
  const h = harness();
  const one = (await h.pulls.link('one', URL)).watch;
  const two = (await h.pulls.link('two', SECOND_URL)).watch;
  h.advance(300_000);
  h.setPresent(false);
  h.missions.get('one')!.state = 'abandoned';
  await h.pulls.tick();
  assert.equal(one.ended, true);
  assert.equal(two.ended, undefined);
  assert.equal(h.calls.length, 2);
  h.missions.delete('two');
  await h.pulls.tick();
  assert.equal(two.ended, true);
  assert.deepEqual(h.changes, [one.id, two.id, one.id, two.id]);
});

test('ticks use the 60 s, 5 min and 15 s thresholds for the right watches', async () => {
  const h = harness();
  h.responses.set(URL, view({ statusCheckRollup: [run('build', '', 'IN_PROGRESS')] }));
  await h.pulls.link('one', URL);
  await h.pulls.link('two', SECOND_URL);
  h.calls.length = 0;
  const tick = async (ms: number, expected: string[], session?: string) => {
    h.advance(ms);
    await h.pulls.tick(session);
    assert.deepEqual(h.calls.splice(0), expected.map((url) => ({
      args: ['pr', 'view', url, '--json', PULL_FIELDS], cwd: undefined,
    })));
  };
  await tick(14_999, [], 'other');
  await tick(1, [SECOND_URL], 'other');
  await tick(44_999, []);
  await tick(1, [URL]);
  await tick(254_999, [URL]);
  await tick(1, [SECOND_URL]);
});

test('poll errors and invalid JSON send no news, notify only on change and leave other watches running', async () => {
  const h = harness();
  const one = (await h.pulls.link('one', URL)).watch;
  const two = (await h.pulls.link('two', SECOND_URL)).watch;
  h.changes.length = 0;
  h.responses.set(URL, new Error('gh failed\ndetails'));
  h.responses.set(SECOND_URL, view({ url: SECOND_URL, number: 13, statusCheckRollup: [run('lint')] }));
  h.advance(300_000);
  await h.pulls.tick();
  assert.equal(one.error, 'gh failed');
  assert.equal(one.checkedAt, 310_000);
  assert.equal(one.news, undefined);
  assert.equal(two.news?.[0].kind, 'checks');
  assert.deepEqual(h.changes, [one.id, two.id]);

  h.advance(300_000);
  await h.pulls.tick();
  assert.deepEqual(h.changes, [one.id, two.id]);
  // The board still hears of a reading that changed nothing, so it does not take a watched pull request for a stale one.
  assert.deepEqual(h.polled, [one.id, two.id]);
  assert.equal(one.checkedAt, 610_000);
  for (const output of ['unexpected output', JSON.stringify(view({ reviews: [null!] }))]) {
    h.responses.set(URL, output);
    h.advance(300_000);
    await h.pulls.tick();
    assert.match(one.error!, /Expected pull request JSON/);
    assert.equal(one.news, undefined);
  }
  h.responses.set(URL, view());
  h.advance(300_000);
  await h.pulls.tick();
  assert.equal(one.error, undefined);
  assert.deepEqual(h.changes, [one.id, two.id, one.id, one.id]);
});

test('a concurrent tick returns while the current poll is still running', async () => {
  const h = harness();
  await h.pulls.link('one', URL);
  let finish!: (output: string) => void;
  let queries = 0;
  const response = new Promise<string>((resolve) => { finish = resolve; });
  h.deps.gh = () => { queries++; return response; };
  h.advance(300_000);
  const running = h.pulls.tick();
  try {
    await h.pulls.tick('lead');
    assert.equal(queries, 1);
  } finally {
    finish(JSON.stringify(view()));
    await running;
  }
});

test('snapshots retain pending news and the latest 20 acknowledged items, then restore defaults', async () => {
  const h = harness();
  const pending = (await h.pulls.link('one', URL)).watch;
  h.advance(1);
  const acknowledged = (await h.pulls.link('two', SECOND_URL)).watch;
  pending.ended = true;
  acknowledged.ended = true;
  const item = (seq: number, acked: boolean) => ({
    seq, eventSeq: 0, kind: 'checks' as const, reason: 'A check failed.', acked, offers: 0,
  });
  pending.news = Array.from({ length: 24 }, (_, i) => item(i + 1, i > 0));
  pending.newsSeq = 24;
  acknowledged.news = [item(1, true)];
  h.missions.clear();
  assert.deepEqual(h.pulls.saved(new Set([acknowledged.id])).map(({ id }) => id), [pending.id, acknowledged.id]);
  const saved = h.pulls.saved(new Set());
  assert.deepEqual(saved.map(({ id }) => id), [pending.id]);
  assert.deepEqual(saved[0].news?.map(({ seq }) => seq), [1, ...Array.from({ length: 20 }, (_, i) => i + 5)]);
  assert.equal(pending.news.length, 24);

  const restored = harness().pulls;
  restored.restore(JSON.parse(JSON.stringify(saved)));
  assert.deepEqual(restored.list(), saved);
  assert.deepEqual(restored.saved(new Set()), saved);
  const minimal = { id: 'pr-minimal', url: URL, repo: 'octo/crew', mission: 'one', number: 12 };
  restored.restore([null, 42, minimal, { ...minimal, id: 'bad', number: '12' }]);
  assert.deepEqual(restored.list().map(({ id }) => id), [minimal.id]);
  assert.deepEqual(restored.list()[0].told, { head: '', checks: [] });
  assert.deepEqual(restored.list()[0].reviews, []);
  assert.equal(restored.list()[0].state, 'open');
  restored.restore({});
  assert.deepEqual(restored.list(), []);
});

test('a failed link save leaves no new watch and preserves an existing hold', async () => {
  const h = harness();
  const save = h.deps.save;
  h.deps.save = () => { throw new Error('disk full'); };
  await assert.rejects(h.pulls.link('one', URL), /disk full/);
  assert.deepEqual(h.pulls.list(), []);
  assert.deepEqual(h.changes, []);

  h.deps.save = save;
  const { watch } = await h.pulls.link('one', URL);
  watch.held = true;
  watch.failingHeads = 4;
  h.deps.save = () => { throw new Error('disk full'); };
  await assert.rejects(h.pulls.link('one', URL), /disk full/);
  assert.equal(watch.held, true);
  assert.equal(watch.failingHeads, 4);
  assert.deepEqual(h.changes, [watch.id]);
});

test('check keys stay on one line and at most 100 characters', async () => {
  const { watch } = await harness().pulls.link('one', URL);
  observe(watch, view({ statusCheckRollup: [
    { ...run('build\r\nstep'), workflowName: 'CI\nworkflow' },
    { __typename: 'StatusContext', context: `ci\n${'s'.repeat(150)}`, state: 'ERROR' },
  ] }));
  assert.deepEqual(watch.told.checks, ['CI workflow / build step', `ci ${'s'.repeat(97)}`]);
});

test('an in-flight observation cannot update a watch whose mission has ended tracking', async () => {
  for (const state of ['abandoned', 'missing']) {
    const h = harness();
    const { watch } = await h.pulls.link('one', URL);
    const { promise, resolve } = Promise.withResolvers<string>();
    h.deps.gh = () => promise;
    h.advance(300_000);
    const running = h.pulls.tick();
    if (state === 'abandoned') h.missions.get('one')!.state = 'abandoned';
    else h.missions.delete('one');
    resolve(JSON.stringify(view({ title: 'Ignored', statusCheckRollup: [run('build')] })));
    await running;
    assert.equal(watch.ended, true);
    assert.equal(watch.title, 'Update Crew');
    assert.equal(watch.news, undefined);
    assert.deepEqual(h.changes, [watch.id, watch.id]);
  }
});
