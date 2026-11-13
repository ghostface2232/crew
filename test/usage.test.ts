import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_ROLES } from '../plugin/bridge/config.ts';
import { describeUsage, fromCodexLimits, openHistory, parseCache, projectExhaustion, route, STALE_MS, UsageMonitor, UsageTracker } from '../plugin/bridge/usage.ts';
import type { Sample, Usage, UsageStatus } from '../plugin/bridge/usage.ts';

const NOW = Date.parse('2026-11-13T04:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const none = () => [];

/** A cache document in AgentGauge's macOS shape, as read from a real 0.8.2 install. */
function cache(snapshots: object[], version = 1): string {
  return JSON.stringify({ version, snapshots });
}
const snapshot = (tool: string, windows: object[], capturedAt = NOW - 2 * MIN) => ({ tool, plan: 'Pro', capturedAt: iso(capturedAt), windows });
const weekly = (usedRatio: number, extra: object = {}) => ({ type: 'weekly', duration: 604800, resetTime: iso(NOW + 24 * 60 * MIN), usedRatio, ...extra });

test('the macOS cache is read into windows keyed as the history database keys them', () => {
  const raw = parseCache(cache([
    snapshot('claude', [weekly(0.89), weekly(0.42, { groupLabel: 'Fable', providerID: 'claude-weekly-scoped-fable' })]),
    snapshot('cursor', [{ type: 'billingCycle', usedRatio: 0.1 }]),
  ]))!;
  // Cursor is not an agent Crew runs, so it is left out.
  assert.deepEqual(raw.map((p) => p.agent), ['claude']);
  assert.deepEqual(raw[0].windows.map((w) => [w.key, w.kind, w.group, w.usedRatio, w.durationSec]), [
    ['weekly', 'weekly', null, 0.89, 604800],
    ['claude-weekly-scoped-fable', 'weekly', 'Fable', 0.42, 604800],
  ]);
  assert.equal(raw[0].capturedAt, NOW - 2 * MIN);
});

test('a cache of another version or shape is unknown, not guessed at', () => {
  assert.equal(parseCache(cache([], 4)), null);
  assert.equal(parseCache(JSON.stringify({ version: 1, Tools: [] })), null);
  assert.equal(parseCache('{ not json'), null);
  const usage = new UsageTracker().classify(null, none, NOW);
  assert.equal(usage.source, 'none');
  assert.deepEqual(usage.providers.map((p) => [p.agent, p.status]), [['claude', 'unknown'], ['codex', 'unknown'], ['antigravity', 'unknown']]);
  assert.deepEqual(describeUsage(usage), []);
});

test('a projection needs three samples over half an hour, a rising pace, and exhaustion before the reset', () => {
  const reset = NOW + 120 * MIN;
  const at = (minutesAgo: number, usedRatio: number, resetTime: number | null = reset): Sample => ({ at: NOW - minutesAgo * MIN, usedRatio, resetTime });
  assert.deepEqual(projectExhaustion([at(40, 0.5), at(0, 0.7)], reset), { enough: false, at: null });
  assert.deepEqual(projectExhaustion([at(20, 0.5), at(10, 0.6), at(0, 0.7)], reset), { enough: false, at: null });
  // 0.5% a minute from 70%: an hour to go, well before the reset.
  const rising = projectExhaustion([at(40, 0.5), at(20, 0.6), at(0, 0.7)], reset);
  assert.equal(rising.enough, true);
  assert.ok(Math.abs(rising.at! - (NOW + 60 * MIN)) < MIN);
  // The same pace with a reset in half an hour never runs out.
  assert.deepEqual(projectExhaustion([at(40, 0.5, NOW + 30 * MIN), at(20, 0.6, NOW + 30 * MIN), at(0, 0.7, NOW + 30 * MIN)], NOW + 30 * MIN), { enough: true, at: null });
  assert.deepEqual(projectExhaustion([at(40, 0.7), at(20, 0.7), at(0, 0.7)], reset), { enough: true, at: null });
  // Samples from before the window last reset say nothing about this cycle.
  const earlier = reset - 5 * 60 * MIN;
  assert.deepEqual(projectExhaustion([at(40, 0.9, earlier), at(20, 0.95, earlier), at(0, 0.1)], reset), { enough: false, at: null });
  // Within a cycle the reported reset time wobbles by seconds; those samples still count.
  const wobbly = projectExhaustion([at(40, 0.5, reset + 1000), at(20, 0.6, reset - 2000), at(0, 0.7)], reset);
  assert.ok(wobbly.enough && Math.abs(wobbly.at! - (NOW + 60 * MIN)) < MIN);
});

test('a window is judged by what is left, with hysteresis, whatever its recent pace', () => {
  const tracker = new UsageTracker();
  const status = (ratio: number, samples: Sample[] = []) =>
    tracker.classify(parseCache(cache([snapshot('codex', [weekly(ratio)])])), () => samples, NOW).providers.find((p) => p.agent === 'codex')!;
  assert.equal(status(0.5).status, 'ok');
  assert.equal(status(0.85).status, 'tight'); // exactly 15% left
  assert.equal(status(0.7).status, 'ok'); // exactly 30% left
  assert.equal(status(0.8).status, 'ok'); // between the thresholds, and it was ok
  assert.equal(status(0.9).status, 'tight');
  assert.equal(status(0.8).status, 'tight'); // stays tight until 30% is left again
  assert.equal(status(0.7).status, 'ok');
  assert.equal(status(1).status, 'exhausted');
  assert.match(status(1).reason, /weekly window is used up/);

  // The pace is shown, not acted on: it misjudged how fast windows are actually used.
  const reset = NOW + 24 * 60 * MIN;
  const flat = [0, 20, 40].map((ago) => ({ at: NOW - ago * MIN, usedRatio: 0.9, resetTime: reset }));
  const low = new UsageTracker().classify(parseCache(cache([snapshot('codex', [weekly(0.9)])])), () => flat, NOW).providers.find((p) => p.agent === 'codex')!;
  assert.equal(low.status, 'tight');
  assert.match(low.reason, /10% of the weekly window is left/);
  const steep = [40, 20, 0].map((ago, i) => ({ at: NOW - ago * MIN, usedRatio: 0.4 + i * 0.1, resetTime: reset }));
  const room = new UsageTracker().classify(parseCache(cache([snapshot('codex', [weekly(0.6)])])), () => steep, NOW).providers.find((p) => p.agent === 'codex')!;
  assert.equal(room.status, 'ok');
  assert.ok(room.windows[0].projectedExhaustion! < reset);
});

test('the account-wide window decides; a provider with only per-model windows follows the configured model, else its tightest family', () => {
  const tracker = new UsageTracker();
  const of = (windows: object[]) => tracker.classify(parseCache(cache([snapshot('antigravity', windows)])), none, NOW).providers.find((p) => p.agent === 'antigravity')!;
  // A scoped window that is used up does not exhaust the account.
  const scoped = of([weekly(0.2), weekly(1, { groupLabel: 'Fable', providerID: 'scoped' })]);
  assert.equal(scoped.status, 'ok');
  assert.equal(scoped.windows[1].status, 'exhausted');
  // Only families, one used up and one with room: a job does not move to another model by itself.
  const families = [weekly(1, { groupLabel: 'Gemini', providerID: 'g' }), weekly(0.1, { groupLabel: 'Claude/GPT', providerID: 'c' })];
  assert.equal(of(families).status, 'exhausted');
  tracker.models = { antigravity: 'claude-sonnet-5-5' };
  assert.equal(of(families).status, 'ok');
  tracker.models = { antigravity: 'gemini-3.8-flash' };
  assert.equal(of(families).status, 'exhausted');
  // A model that names no family falls back to the tightest.
  tracker.models = { antigravity: 'something-else' };
  assert.equal(of(families).status, 'exhausted');
});

test('an old reading is stale, and a reported limit stands until a later reading shows room', () => {
  const tracker = new UsageTracker();
  const codex = (capturedAt: number, ratio = 0.2, now = NOW) =>
    tracker.classify(parseCache(cache([snapshot('codex', [weekly(ratio)], capturedAt)])), none, now).providers.find((p) => p.agent === 'codex')!;
  assert.equal(codex(NOW - STALE_MS - MIN).status, 'stale');

  tracker.reportLimit('codex', 'usageLimitExceeded\nmore', NOW);
  const limited = codex(NOW - 5 * MIN);
  assert.equal(limited.status, 'exhausted');
  assert.equal(limited.reason, 'A job hit the usage limit: usageLimitExceeded');
  // The report outranks even a stale reading: a job has just failed.
  assert.equal(codex(NOW - STALE_MS - MIN).status, 'exhausted');
  // A later reading with no windows shows nothing, so the limit stands.
  assert.equal(tracker.classify(parseCache(cache([snapshot('codex', [], NOW + MIN)])), none, NOW + 2 * MIN).providers.find((p) => p.agent === 'codex')!.status, 'exhausted');
  // A reading after the report that is still full keeps it; one with room lifts it.
  assert.equal(codex(NOW + MIN, 1, NOW + 2 * MIN).status, 'exhausted');
  assert.equal(codex(NOW + 3 * MIN, 0.2, NOW + 4 * MIN).status, 'ok');
  assert.equal(codex(NOW + 3 * MIN, 0.2, NOW + 5 * MIN).status, 'ok');
});

function usageOf(statuses: Partial<Record<'claude' | 'codex' | 'antigravity', UsageStatus>>): Usage {
  const reset = NOW + 60 * MIN;
  return {
    generatedAt: NOW,
    source: 'agentgauge',
    providers: (['claude', 'codex', 'antigravity'] as const).map((agent) => {
      const status = statuses[agent] ?? 'ok';
      return { agent, plan: null, capturedAt: NOW, status, reason: `${agent} reason.`, windows: [{ key: 'weekly', kind: 'weekly', group: null, usedRatio: 0.5, resetTime: reset, durationSec: 604800, projectedExhaustion: null, status }] };
    }),
  };
}

test('with room everywhere, and with stale or unknown readings, the roles are followed', () => {
  for (const usage of [usageOf({}), usageOf({ codex: 'stale', antigravity: 'unknown', claude: 'stale' })]) {
    assert.equal(route('delegate', usage, DEFAULT_ROLES).assignee, 'codex');
    assert.equal(route('review', usage, DEFAULT_ROLES).assignee, 'codex');
    assert.equal(route('polish', usage, DEFAULT_ROLES).assignee, 'antigravity');
    assert.equal(route('lead', usage, DEFAULT_ROLES).assignee, 'claude');
    for (const kind of ['delegate', 'review', 'polish', 'lead'] as const) {
      const decision = route(kind, usage, DEFAULT_ROLES);
      assert.equal(decision.degraded, false);
      assert.equal(decision.deferUntil, null);
    }
  }
});

test('a tight engineer keeps its usage for the review, and an exhausted one loses the cross-review', () => {
  const tight = usageOf({ codex: 'tight' });
  const implement = route('delegate', tight, DEFAULT_ROLES);
  assert.equal(implement.assignee, 'claude');
  assert.match(implement.reason, /keep what Codex has left for the cross-review/);
  assert.deepEqual(implement.fallback, ['codex']);
  assert.equal(route('review', tight, DEFAULT_ROLES).assignee, 'codex');

  const gone = usageOf({ codex: 'exhausted' });
  assert.equal(route('delegate', gone, DEFAULT_ROLES).assignee, 'claude');
  const review = route('review', gone, DEFAULT_ROLES);
  assert.deepEqual([review.assignee, review.degraded, review.deferUntil], ['claude', true, NOW + 60 * MIN]);

  // When the lead is short too, a tight engineer still takes what separates.
  assert.equal(route('delegate', usageOf({ codex: 'tight', claude: 'tight' }), DEFAULT_ROLES).assignee, 'codex');
});

test('polish waits for the reset, and routing never hands a role to an agent the user did not assign', () => {
  const polish = route('polish', usageOf({ antigravity: 'exhausted' }), DEFAULT_ROLES);
  assert.deepEqual([polish.assignee, polish.deferUntil, polish.fallback], ['antigravity', NOW + 60 * MIN, ['claude']]);

  const statuses: UsageStatus[] = ['ok', 'tight', 'exhausted', 'stale', 'unknown'];
  for (const claude of statuses) for (const codex of statuses) for (const antigravity of statuses) {
    const usage = usageOf({ claude, codex, antigravity });
    for (const kind of ['delegate', 'review', 'polish'] as const) {
      const { assignee, fallback } = route(kind, usage, DEFAULT_ROLES);
      for (const agent of [assignee, ...fallback]) assert.ok(agent === 'claude' || agent === DEFAULT_ROLES[kind].agent, `${kind} went to ${agent}`);
    }
    assert.notEqual(route('lead', usage, DEFAULT_ROLES).assignee, 'antigravity');
  }
});

test('a short lead hands off implementation, and an exhausted one hands the session to Codex if it can', () => {
  assert.match(route('lead', usageOf({ claude: 'tight' }), DEFAULT_ROLES).reason, /hand more implementation to Codex/);
  const handoff = route('lead', usageOf({ claude: 'exhausted' }), DEFAULT_ROLES);
  assert.deepEqual([handoff.assignee, handoff.degraded], ['codex', true]);
  // The session is handed only to an engineer measured to have room.
  for (const codex of ['exhausted', 'tight', 'stale', 'unknown'] as const) assert.equal(route('lead', usageOf({ claude: 'exhausted', codex }), DEFAULT_ROLES).assignee, 'claude');
  // Antigravity as engineer is the user's choice, but it is never given the lead.
  const roles = { ...DEFAULT_ROLES, delegate: { agent: 'antigravity' as const } };
  assert.equal(route('lead', usageOf({ claude: 'exhausted' }), roles).assignee, 'claude');
});

test('the history database is opened read-only and read per window', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-usage-'));
  assert.equal(await openHistory(dir), null);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'usage-history.db'));
  db.exec('CREATE TABLE samples (tool TEXT NOT NULL, window_key TEXT NOT NULL, group_label TEXT NULL, captured_at INTEGER NOT NULL, used_ratio REAL NOT NULL, reset_time INTEGER NULL, used_tokens INTEGER NULL, limit_tokens INTEGER NULL, reset_credits INTEGER NULL, reset_credit_expiry INTEGER NULL)');
  const insert = db.prepare('INSERT INTO samples (tool, window_key, captured_at, used_ratio, reset_time) VALUES (?, ?, ?, ?, ?)');
  insert.run('codex', 'weekly', NOW - 100 * MIN, 0.1, NOW);
  insert.run('codex', 'weekly', NOW - 10 * MIN, 0.2, NOW);
  insert.run('codex', 'fiveHour', NOW - 10 * MIN, 0.9, null);
  db.close();

  const history = (await openHistory(dir))!;
  assert.deepEqual(history.read('codex', 'weekly', NOW - 90 * MIN), [{ at: NOW - 10 * MIN, usedRatio: 0.2, resetTime: NOW }]);
  assert.deepEqual(history.read('codex', 'fiveHour', 0), [{ at: NOW - 10 * MIN, usedRatio: 0.9, resetTime: null }]);
  assert.deepEqual(history.read('claude', 'weekly', 0), []);
  history.close();
});

test('a newer reading from the agent itself stands in for a stale AgentGauge one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-usage-'));
  const old = Date.now() - STALE_MS - MIN;
  fs.writeFileSync(path.join(dir, 'usage-cache.json'), cache([snapshot('codex', [weekly(0.2)], old), snapshot('claude', [weekly(0.2)], old)]));
  const seen: Usage[] = [];
  const monitor = new UsageMonitor(dir, (usage) => seen.push(usage));
  monitor.refresh();
  const codex = () => monitor.current().providers.find((p) => p.agent === 'codex')!;
  assert.equal(codex().status, 'stale');
  assert.match(route('delegate', monitor.current(), DEFAULT_ROLES).reason, /usage is not known .* so the assignment is followed/);

  const reset = Math.round(Date.now() / 1000) + 3600;
  monitor.supplement(fromCodexLimits({ plan: 'Pro', windows: [{ minutes: 300, usedPercent: 100, resetsAt: reset }, { minutes: 10080, usedPercent: 41, resetsAt: null }] }, Date.now()));
  assert.equal(codex().status, 'exhausted');
  assert.deepEqual(codex().windows.map((w) => [w.key, w.usedRatio, w.resetTime, w.durationSec]), [['fiveHour', 1, reset * 1000, 18000], ['weekly', 0.41, null, 604800]]);
  // Claude has no such channel and stays as AgentGauge left it.
  assert.equal(monitor.current().providers.find((p) => p.agent === 'claude')!.status, 'stale');
  assert.equal(seen.at(-1), monitor.current());
  assert.equal(route('review', monitor.current(), DEFAULT_ROLES).degraded, true);
});

test('statuses age with the clock even without AgentGauge', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: NOW });
  const seen: Usage[] = [];
  const monitor = new UsageMonitor(null, (usage) => seen.push(usage));
  await monitor.start();
  t.after(() => monitor.stop());
  monitor.supplement(fromCodexLimits({ plan: null, windows: [{ minutes: 300, usedPercent: 10, resetsAt: null }] }, NOW));
  const codex = () => monitor.current().providers.find((p) => p.agent === 'codex')!.status;
  assert.equal(codex(), 'ok');
  t.mock.timers.tick(STALE_MS + 2 * MIN);
  assert.equal(codex(), 'stale');
});

test('polish selects the Gemini family without borrowing Argon windows or reset times', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const monitor = new UsageMonitor(null, () => {});
  t.after(() => monitor.stop());
  const reading = (gemini: number, argon: number) => parseCache(cache([snapshot('antigravity', [
    weekly(gemini, { groupLabel: 'Gemini', providerID: 'g-weekly', resetTime: iso(NOW + 60 * MIN) }),
    weekly(0, { type: 'fiveHour', groupLabel: 'Gemini', providerID: 'g-five' }),
    weekly(0, { groupLabel: 'Claude/GPT', providerID: 'c-weekly' }),
    weekly(0, { type: 'fiveHour', groupLabel: 'Claude/GPT', providerID: 'c-five' }),
    weekly(argon, { groupLabel: 'Gemini 4 Argon', providerID: 'argon' }),
  ])]))![0];
  monitor.supplement(reading(0, 0.57));
  for (const model of [undefined, 'gemini-3.8-flash']) {
    monitor.setModels({ antigravity: model });
    assert.equal(route('polish', monitor.current(), DEFAULT_ROLES).deferUntil, null);
    t.mock.timers.tick(2 * MIN);
    monitor.refresh();
    assert.match(route('polish', monitor.current(), DEFAULT_ROLES).reason, /has room/);
  }
  monitor.supplement(reading(0, 0.9));
  assert.equal(route('polish', monitor.current(), DEFAULT_ROLES).deferUntil, null);
  monitor.supplement(reading(0.9, 0.9));
  assert.equal(route('polish', monitor.current(), DEFAULT_ROLES).deferUntil, NOW + 60 * MIN);
  monitor.setModels({ antigravity: 'gemini-4-argon' });
  assert.equal(route('polish', monitor.current(), DEFAULT_ROLES).deferUntil, NOW + 24 * 60 * MIN);
});

test('an Antigravity limit is lifted only by room in the applicable family', () => {
  const tracker = new UsageTracker();
  tracker.models = { antigravity: 'gemini-3.8-flash' };
  const raw = (ratio: number) => parseCache(cache([snapshot('antigravity', [
    weekly(ratio, { groupLabel: 'Gemini', providerID: 'g' }),
    weekly(1, { groupLabel: 'Gemini 4 Argon', providerID: 'a' }),
  ], NOW + MIN)]));
  tracker.reportLimit('antigravity', 'quota', NOW);
  const of = (ratio: number) => tracker.classify(raw(ratio), none, NOW + 2 * MIN).providers.find((p) => p.agent === 'antigravity')!;
  assert.equal(of(1).status, 'exhausted');
  assert.equal(of(0).status, 'ok');
});

test('a 57% Argon window does not change routing as projection samples age out', () => {
  const tracker = new UsageTracker();
  const raw = parseCache(cache([snapshot('antigravity', [
    weekly(0, { groupLabel: 'Gemini', providerID: 'g' }),
    weekly(0.57, { groupLabel: 'Gemini 4 Argon', providerID: 'a' }),
  ])]));
  const reset = NOW + 24 * 60 * MIN;
  const samples = [40, 20, 0].map((ago, i) => ({ at: NOW - ago * MIN, usedRatio: 0.37 + i * 0.1, resetTime: reset }));
  tracker.models = { antigravity: 'gemini-4-argon' };
  const first = tracker.classify(raw, (_agent, key) => key === 'a' ? samples : [], NOW);
  assert.ok(first.providers.find((p) => p.agent === 'antigravity')!.windows[1].projectedExhaustion! < reset);
  const later = tracker.classify(raw, none, NOW + 2 * MIN);
  for (const usage of [first, later]) assert.match(route('polish', usage, DEFAULT_ROLES).reason, /has room/);
});
