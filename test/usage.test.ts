import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_ROLES, defaultHolder, effectiveRole, resolveConfig, ROLES, workersFor } from '../plugin/bridge/config.ts';
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

const windowsCache = (Tools: object[], Version = 4) => JSON.stringify({ Version, Tools });
const windowsTool = (ToolName: string, Windows: object[], extra: object = {}) => ({ ToolName, Windows, Plan: 'Pro', CapturedAt: iso(NOW - 2 * MIN), ...extra });
const windowsWeekly = (UsedRatio: number, extra: object = {}) => ({ Type: 'Weekly', UsedRatio, DurationSeconds: 604800, ResetTime: iso(NOW + 120 * MIN), ...extra });

test('the Windows cache preserves history keys and normalizes window kinds', () => {
  const raw = parseCache(windowsCache([
    windowsTool('Claude', [windowsWeekly(0.39), windowsWeekly(0.43, { Id: 'claude-weekly-scoped-fable', GroupLabel: 'Fable' })]),
    windowsTool('Codex', [windowsWeekly(0.01, { Type: 'BillingCycle' })]),
    windowsTool('Antigravity', [windowsWeekly(0, { Id: 'gemini-5h', GroupLabel: 'Gemini', Type: 'FiveHour', DurationSeconds: 18000 })]),
    windowsTool('Cursor', [windowsWeekly(1)]),
    windowsTool('Copilot', [windowsWeekly(1)]),
    windowsTool('Unknown', [windowsWeekly(1)]),
  ]))!;
  assert.deepEqual(raw.map((p) => [p.agent, p.plan, p.capturedAt]), [
    ['claude', 'Pro', NOW - 2 * MIN], ['codex', 'Pro', NOW - 2 * MIN], ['antigravity', 'Pro', NOW - 2 * MIN],
  ]);
  assert.deepEqual(raw.flatMap((p) => p.windows.map((w) => [w.key, w.kind, w.group, w.usedRatio, w.durationSec, w.resetTime])), [
    ['Weekly', 'weekly', null, 0.39, 604800, NOW + 120 * MIN],
    ['claude-weekly-scoped-fable', 'weekly', 'Fable', 0.43, 604800, NOW + 120 * MIN],
    ['BillingCycle', 'billingCycle', null, 0.01, 604800, NOW + 120 * MIN],
    ['gemini-5h', 'fiveHour', 'Gemini', 0, 18000, NOW + 120 * MIN],
  ]);
  const usage = new UsageTracker().classify(raw, none, NOW);
  assert.equal(usage.providers[0].reason, '39% of the weekly window used.');
});

test('signed-out Windows tools have no reading and unknown Windows shapes stay unknown', () => {
  const raw = parseCache(windowsCache([windowsTool('Claude', [windowsWeekly(1)], { IsSignedOut: true })]));
  assert.deepEqual(raw, []);
  assert.equal(new UsageTracker().classify(raw, none, NOW).providers[0].status, 'unknown');
  assert.equal(parseCache(windowsCache([], 5)), null);
  assert.equal(parseCache(JSON.stringify({ Version: 4, snapshots: [] })), null);
  assert.equal(parseCache(JSON.stringify({ Version: 4, Tools: {} })), null);
});

test('Windows PascalCase history samples feed projections without changing supplement keys', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-usage-windows-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'usage-history.db'));
  try {
    db.exec('CREATE TABLE samples (tool TEXT, window_key TEXT, captured_at INTEGER, used_ratio REAL, reset_time INTEGER)');
    const insert = db.prepare('INSERT INTO samples VALUES (?, ?, ?, ?, ?)');
    for (const [tool, key] of [['Claude', 'Weekly'], ['Antigravity', 'gemini-5h'], ['Codex', 'Weekly']]) {
      for (const [i, ago] of [40, 20, 0].entries()) insert.run(tool, key, NOW - ago * MIN, 0.5 + i * 0.1, NOW + 120 * MIN);
    }
  } finally {
    db.close();
  }
  const history = (await openHistory(dir))!;
  assert.ok(history);
  try {
    const raw = parseCache(windowsCache([
      windowsTool('Claude', [windowsWeekly(0.7)]),
      windowsTool('Codex', [windowsWeekly(0.7)]),
      windowsTool('Antigravity', [windowsWeekly(0.7, { Id: 'gemini-5h', Type: 'FiveHour' })]),
    ]));
    const usage = new UsageTracker().classify(raw, history.read, NOW);
    for (const provider of usage.providers) assert.equal(provider.windows[0].projectedExhaustion, NOW + 60 * MIN);
    const own = fromCodexLimits({ plan: 'Pro', windows: [{ minutes: 10080, usedPercent: 70, resetsAt: (NOW + 120 * MIN) / 1000 }] }, NOW);
    assert.equal(own.windows[0].key, 'weekly');
    const supplemented = new UsageTracker().classify([own], history.read, NOW);
    assert.equal(supplemented.providers.find((p) => p.agent === 'codex')!.windows[0].projectedExhaustion, NOW + 60 * MIN);
  } finally {
    history.close();
  }
});

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

test('Antigravity accounts for both its account-wide and applicable family windows', () => {
  const tracker = new UsageTracker();
  tracker.models = { antigravity: 'gemini-3.8-flash' };
  const of = (account: number, gemini: number, argon: number, capturedAt = NOW) => tracker.classify(parseCache(cache([snapshot('antigravity', [
    weekly(account), weekly(gemini, { groupLabel: 'Gemini', providerID: 'g', resetTime: iso(NOW + 30 * MIN) }),
    weekly(argon, { groupLabel: 'Gemini 4 Argon', providerID: 'a' }),
  ], capturedAt)])), none, capturedAt).providers.find((p) => p.agent === 'antigravity')!;
  assert.equal(of(0.2, 1, 0.1).status, 'exhausted');
  assert.equal(of(1, 0.2, 0.1).status, 'exhausted');
  const room = of(0.2, 0.2, 1);
  assert.equal(room.status, 'ok');
  assert.deepEqual(room.decidingKeys, ['weekly', 'g']);
  const blocked = of(0.2, 1, 0.1);
  const usage = { ...new UsageTracker().classify(null, none, NOW), providers: [blocked] };
  assert.equal(route('polish', usage, DEFAULT_ROLES).deferUntil, NOW + 30 * MIN);
  tracker.reportLimit('antigravity', 'family limit', NOW);
  assert.equal(of(0.2, 1, 0.1, NOW + MIN).status, 'exhausted');
  assert.equal(of(0.2, 0.2, 1, NOW + 2 * MIN).status, 'ok');
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
  // A further review holder saves its usage too.
  const furtherReviewer = { ...DEFAULT_ROLES, review: { agents: ['codex' as const, 'antigravity' as const] } };
  assert.match(route('delegate', tight, furtherReviewer).reason, /keep what Codex has left for the cross-review/);

  const gone = usageOf({ codex: 'exhausted' });
  assert.equal(route('delegate', gone, DEFAULT_ROLES).assignee, 'claude');
  const review = route('review', gone, DEFAULT_ROLES);
  assert.deepEqual([review.assignee, review.degraded, review.deferUntil], ['claude', true, NOW + 60 * MIN]);

  // When the lead is short too, a tight engineer still takes what separates.
  assert.equal(route('delegate', usageOf({ codex: 'tight', claude: 'tight' }), DEFAULT_ROLES).assignee, 'codex');
  // Its reading is known then, and the reason says so.
  const given = { ...DEFAULT_ROLES, fix: { agents: ['codex' as const] } };
  for (const claude of ['tight', 'exhausted'] as const) for (const kind of ['delegate', 'refactor', 'release', 'fix'] as const) {
    const both = route(kind, usageOf({ codex: 'tight', claude }), given);
    assert.deepEqual([both.assignee, both.fallback], ['codex', ['claude']]);
    assert.equal(both.reason, 'Codex is tight: codex reason. Claude is short too, so the assignment is followed.');
  }
});

test('polish waits for the reset, and routing never hands a role to an agent the user did not assign', () => {
  const polish = route('polish', usageOf({ antigravity: 'exhausted' }), DEFAULT_ROLES);
  assert.deepEqual([polish.assignee, polish.deferUntil, polish.fallback], ['antigravity', NOW + 60 * MIN, ['claude']]);

  const statuses: UsageStatus[] = ['ok', 'tight', 'exhausted', 'stale', 'unknown'];
  const mixed = resolveConfig({ roles: { refactor: { agent: 'antigravity' }, review: { agent: 'antigravity' }, verify: { agent: 'codex' } } }).roles;
  for (const claude of statuses) for (const codex of statuses) for (const antigravity of statuses) {
    const usage = usageOf({ claude, codex, antigravity });
    for (const roles of [DEFAULT_ROLES, mixed]) for (const kind of ROLES) {
      const { assignee, fallback } = route(kind, usage, roles);
      for (const agent of [assignee, ...fallback]) assert.ok(agent === 'claude' || roles[kind].agents.includes(agent), `${kind} went to ${agent}`);
    }
    assert.notEqual(route('lead', usage, DEFAULT_ROLES).assignee, 'antigravity');
  }
});

test('every role has its own policy when its holder runs out', () => {
  const gone = usageOf({ codex: 'exhausted' });
  const verify = route('verify', gone, DEFAULT_ROLES);
  assert.deepEqual([verify.assignee, verify.degraded], ['claude', true]);
  assert.match(verify.reason, /Run the app in your own self-review/);
  const debate = route('debate', gone, DEFAULT_ROLES);
  assert.deepEqual([debate.assignee, debate.degraded], ['claude', true]);
  assert.match(debate.reason, /Decide yourself, and say that the debate was skipped/);
  // The lead taking release work over keeps it to preparation.
  assert.match(route('release', gone, DEFAULT_ROLES).reason, /publish or deploy nothing/);
  assert.equal(route('refactor', gone, DEFAULT_ROLES).degraded, false);
  // Fixing stays with the lead unless the user gives it to a worker; a worker out of usage hands it back.
  assert.equal(route('fix', usageOf({}), DEFAULT_ROLES).assignee, 'claude');
  const given = { ...DEFAULT_ROLES, fix: { agents: ['codex' as const] } };
  assert.equal(route('fix', usageOf({}), given).assignee, 'codex');
  const out = route('fix', gone, given);
  assert.equal(out.assignee, 'claude');
  assert.match(out.reason, /Fix the findings yourself\.$/);
  assert.doesNotMatch(route('refactor', usageOf({ codex: 'tight' }), DEFAULT_ROLES).reason, /Polish/);
});

test('a role\'s workers are tried before the lead, and Claude holding it alone means the lead does it', () => {
  const roles = resolveConfig({ roles: { review: { agents: ['antigravity', 'codex'] }, polish: { agents: ['claude', 'antigravity'] }, debate: { agents: ['claude'] } } }).roles;
  const moved = route('review', usageOf({ codex: 'exhausted' }), roles);
  assert.equal(moved.assignee, 'antigravity');
  assert.match(moved.reason, /^Codex is exhausted[^]*Antigravity holds the role and has room\.$/);
  assert.deepEqual(moved.holders, [{ agent: 'codex', status: 'exhausted' }, { agent: 'antigravity', status: 'ok' }]);
  assert.equal(route('polish', usageOf({}), roles).assignee, 'antigravity');
  const lead = route('polish', usageOf({ antigravity: 'exhausted' }), roles);
  assert.deepEqual([lead.assignee, lead.reason], ['claude', 'Antigravity is exhausted: antigravity reason. Claude holds the role: do the work yourself, or in a subagent.']);
  const own = route('debate', usageOf({}), roles);
  assert.deepEqual([own.assignee, own.reason], ['claude', 'Claude holds the role: do the work yourself, or in a subagent.']);
});

test('a holder that cannot do the work is never suggested, nor an exhausted one as fallback', () => {
  // verify follows review, but Antigravity cannot run the app, so it is skipped there and the review policy holds.
  const roles = resolveConfig({ roles: { review: { agents: ['codex', 'antigravity'] } } }).roles;
  const verify = route('verify', usageOf({ codex: 'exhausted' }), roles);
  assert.deepEqual([verify.assignee, verify.degraded], ['claude', true]);
  assert.match(verify.reason, /Run the app in your own self-review/);
  assert.ok(!verify.fallback.includes('antigravity'));
  const onlyAntigravity = resolveConfig({ roles: { verify: { agents: ['antigravity'] } } }).roles;
  assert.deepEqual([route('verify', usageOf({}), onlyAntigravity).assignee, route('verify', usageOf({}), onlyAntigravity).degraded], ['claude', true]);
  // A disabled agent is skipped too.
  const off = route('review', usageOf({ codex: 'exhausted' }), roles, ['antigravity']);
  assert.equal(off.assignee, 'claude');
  // An exhausted holder is not offered as the next try.
  const both = resolveConfig({ roles: { review: { agent: 'antigravity', also: ['codex'] } } }).roles;
  assert.ok(!route('review', usageOf({ codex: 'exhausted' }), both).fallback.includes('codex'));
});

test('the lead hands implementation to the first worker holding it, never to itself', () => {
  const roles = resolveConfig({ roles: { delegate: { agent: 'claude', also: ['codex'] } } }).roles;
  assert.match(route('lead', usageOf({ claude: 'tight' }), roles).reason, /hand more implementation to Codex/);
  assert.equal(route('lead', usageOf({ claude: 'exhausted' }), roles).assignee, 'claude');
  const alone = resolveConfig({ roles: { delegate: { agent: 'claude' } } }).roles;
  assert.match(route('lead', usageOf({ claude: 'tight' }), alone).reason, /give more implementation to subagents/);
});

test('a short lead hands off implementation, and an exhausted one keeps the session', () => {
  assert.match(route('lead', usageOf({ claude: 'tight' }), DEFAULT_ROLES).reason, /hand more implementation to Codex/);
  const exhausted = route('lead', usageOf({ claude: 'exhausted' }), DEFAULT_ROLES);
  assert.deepEqual([exhausted.assignee, exhausted.degraded], ['claude', true]);
  assert.match(exhausted.reason, /Finish the step you are on/);
  for (const codex of ['exhausted', 'tight', 'stale', 'unknown'] as const) {
    const decision = route('lead', usageOf({ claude: 'exhausted', codex }), DEFAULT_ROLES);
    assert.equal(decision.assignee, 'claude');
    assert.match(decision.reason, /No other agent can lead/);
  }
  // Antigravity as engineer is the user's choice, but it is never given the lead.
  const roles = { ...DEFAULT_ROLES, delegate: { agents: ['antigravity' as const] } };
  assert.equal(route('lead', usageOf({ claude: 'exhausted' }), roles).assignee, 'claude');
});

test('a Codex lead does the roles Codex holds itself, and a role Claude holds goes to a Claude worker', () => {
  // Claude's usage says nothing about a Codex lead.
  assert.match(route('lead', usageOf({ claude: 'exhausted', codex: 'ok' }), DEFAULT_ROLES, [], 'codex').reason, /Codex has room/);
  const exhausted = route('lead', usageOf({ codex: 'exhausted' }), DEFAULT_ROLES, [], 'codex');
  // An assignee that is the lead's own agent means the lead; implementation is Codex's too, so no one else can lead.
  assert.deepEqual([exhausted.assignee, exhausted.degraded], ['codex', true]);
  assert.match(exhausted.reason, /No other agent can lead/);
  // A role Codex holds is the Codex lead's own work, as a role Claude holds is a Claude lead's.
  const build = route('delegate', usageOf({ codex: 'tight' }), DEFAULT_ROLES, [], 'codex');
  assert.deepEqual([build.assignee, build.reason], ['codex', 'Codex holds the role: do the work yourself, or in a subagent.']);
  // Held by both, the role goes to the other agent's worker first, as it does under a Claude lead.
  const shared = { ...DEFAULT_ROLES, delegate: { agents: ['codex' as const, 'claude' as const] } };
  assert.equal(route('delegate', usageOf({ codex: 'ok', claude: 'ok' }), shared, [], 'codex').assignee, 'claude');
  assert.equal(route('delegate', usageOf({ codex: 'tight', claude: 'ok' }), shared).assignee, 'claude');
  const fix = route('fix', usageOf({}), DEFAULT_ROLES, [], 'codex');
  assert.equal(fix.assignee, 'claude');
  assert.match(fix.reason, /^Claude holds the role\./);
  // Claude short of usage gives the work back to the lead, with Claude as the fallback.
  const tight = route('fix', usageOf({ claude: 'tight', codex: 'ok' }), DEFAULT_ROLES, [], 'codex');
  assert.deepEqual([tight.assignee, tight.fallback], ['codex', ['claude']]);
  assert.match(tight.reason, /^Claude is tight: .*Take this work yourself or in subagents/);
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


test('empty family names and empty alternatives match no model', () => {
  for (const groupLabel of ['', 'Claude/', '/Claude', ' / ']) {
    const tracker = new UsageTracker();
    tracker.models = { antigravity: 'gemini-3.8-flash' };
    const raw = parseCache(cache([snapshot('antigravity', [
      weekly(1, { groupLabel, providerID: 'empty' }),
      weekly(0, { groupLabel: 'Gemini', providerID: 'g' }),
    ])]));
    assert.equal(tracker.classify(raw, none, NOW).providers.find((p) => p.agent === 'antigravity')!.status, 'ok', groupLabel);
  }
});

test('with no holder named, wording goes to Antigravity and other work to Codex, past one that is disabled or cannot do it', () => {
  const roles = resolveConfig({ roles: { delegate: { agents: ['codex', 'antigravity'] }, review: { agents: ['antigravity', 'codex'] }, polish: { agents: ['codex', 'antigravity', 'claude'] } } }).roles;
  assert.equal(defaultHolder('delegate', roles.delegate), 'codex');
  assert.equal(defaultHolder('polish', roles.polish), 'antigravity');
  assert.equal(defaultHolder('polish', roles.polish, ['antigravity']), 'codex');
  // A job's settings come from the worker it goes to, which skips a disabled one too.
  const off = resolveConfig({ antigravity: { bin: 'agy', enabled: false }, roles: { polish: { agents: ['codex', 'antigravity'] } } });
  assert.equal(effectiveRole(off, 'polish').agent, 'codex');
  // verify follows review, but Antigravity cannot run the app.
  assert.deepEqual(workersFor('verify', roles.verify), ['codex']);
  const lone = resolveConfig({ roles: { verify: { agents: ['antigravity', 'claude'] }, debate: { agents: ['antigravity'] } } }).roles;
  assert.equal(defaultHolder('verify', lone.verify), 'claude');
  // With nothing able left, the first worker is named anyway, so the job is refused with its reason.
  assert.equal(defaultHolder('debate', lone.debate, ['antigravity']), 'antigravity');
  // route tries the role's preferred worker first.
  assert.equal(route('polish', usageOf({}), roles).assignee, 'antigravity');
  assert.deepEqual(route('polish', usageOf({}), roles).holders?.map((h) => h.agent), ['antigravity', 'codex', 'claude']);
});
