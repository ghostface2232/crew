import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKERS } from './config.ts';
import type { Config, Role } from './config.ts';
import type { Agent } from './jobs.ts';

/**
 * Usage as measured by AgentGauge, and the routing it implies (docs/03-agentgauge-integration.md).
 * Crew only reads AgentGauge's cache and history files; it never polls a provider itself.
 */

export type UsageStatus = 'ok' | 'tight' | 'exhausted' | 'stale' | 'unknown';

export interface UsageWindow {
  /** Stable within a provider, e.g. "fiveHour", "weekly", "claude-weekly-scoped-fable". */
  key: string;
  kind: string;
  /** Model or family the window is scoped to; null for the account-wide window. */
  group: string | null;
  /** 0 to 1. */
  usedRatio: number;
  /** Epoch ms, or null when the provider reports none. */
  resetTime: number | null;
  durationSec: number | null;
  /** Epoch ms at which the window runs out at the recent pace, when that is before the reset. */
  projectedExhaustion: number | null;
  status: UsageStatus;
}

export interface ProviderUsage {
  agent: Agent;
  plan: string | null;
  /** Epoch ms of AgentGauge's reading; null when there is none. */
  capturedAt: number | null;
  /** The tightest account-wide window decides this; scoped windows are listed but do not. */
  status: UsageStatus;
  /** One short sentence saying why, shown as a tooltip and returned to the lead. */
  reason: string;
  windows: UsageWindow[];
}

export interface Usage {
  generatedAt: number;
  /** "none" when AgentGauge's files are absent or unreadable; every provider is then "unknown". */
  source: 'agentgauge' | 'none';
  providers: ProviderUsage[];
}

/** What the lead is about to hand out. "lead" asks whether the lead itself should keep going. */
export type RouteKind = Role | 'lead';

export interface RouteDecision {
  kind: RouteKind;
  /** Who should do it. For a role this is its holder or "claude" (the lead does it itself); never an agent the user did not assign. */
  assignee: Agent;
  reason: string;
  /** Who to turn to next if the assignee fails. */
  fallback: Agent[];
  /** The work goes ahead without its usual cross-check, and the result should say so. */
  degraded: boolean;
  /** Epoch ms after which deferred work (polish) should be tried again; null when nothing is deferred. */
  deferUntil: number | null;
}

// --- Reading AgentGauge ----------------------------------------------------


const AGENTS: Agent[] = ['claude', 'codex', 'antigravity'];
/** AgentGauge stretches its polling to 30 minutes when the user is away; a reading older than this is not acted on. */
export const STALE_MS = 45 * 60_000;
/** Without enough samples for a projection: tight at 15% left, and ok again only at 30%, so routing does not flap. */
const TIGHT_REMAINING = 0.15;
const OK_REMAINING = 0.3;
const PROJECTION_SPAN_MS = 90 * 60_000;
const MIN_SPAN_MS = 30 * 60_000;
/** A reported limit stands until AgentGauge reads the agent again and finds room, or this long at most. */
const REPORT_MS = 5 * 60 * 60_000;

/** Where AgentGauge keeps its files on this platform; null where this version cannot read them. */
export function agentGaugeDir(): string | null {
  if (process.env.CREW_AGENTGAUGE_DIR) return process.env.CREW_AGENTGAUGE_DIR;
  // The Windows cache has another shape (version 4, a Tools array) that has not been verified here.
  return process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'AgentGauge') : null;
}

export interface Sample {
  at: number;
  usedRatio: number;
  resetTime: number | null;
}

/**
 * When the window runs out at the pace of the samples, by a least-squares fit, or null when it does not
 * before `resetTime`. `enough` is false when the samples cannot support a projection at all: fewer than
 * three, or spanning under 30 minutes. Samples from before the window last reset are ignored.
 */
export function projectExhaustion(samples: Sample[], resetTime: number | null): { enough: boolean; at: number | null } {
  const cycle = samples.filter((s) => s.resetTime === resetTime).sort((a, b) => a.at - b.at);
  if (cycle.length < 3 || cycle[cycle.length - 1].at - cycle[0].at < MIN_SPAN_MS) return { enough: false, at: null };
  const meanT = cycle.reduce((sum, s) => sum + s.at, 0) / cycle.length;
  const meanU = cycle.reduce((sum, s) => sum + s.usedRatio, 0) / cycle.length;
  const slope = cycle.reduce((sum, s) => sum + (s.at - meanT) * (s.usedRatio - meanU), 0) / cycle.reduce((sum, s) => sum + (s.at - meanT) ** 2, 0);
  if (!(slope > 0) || resetTime === null) return { enough: true, at: null };
  const at = meanT + (1 - meanU) / slope;
  return { enough: true, at: at < resetTime ? Math.round(at) : null };
}

interface RawWindow extends Omit<UsageWindow, 'projectedExhaustion' | 'status'> {}
export interface RawProvider {
  agent: Agent;
  plan: string | null;
  capturedAt: number | null;
  windows: RawWindow[];
}

const time = (value: unknown): number | null => {
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

/** The macOS cache (version 1). Anything else, or a record of the wrong shape, yields null: unknown, never a guess. */
export function parseCache(text: string): RawProvider[] | null {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (doc?.version !== 1 || !Array.isArray(doc.snapshots)) return null;
  const providers: RawProvider[] = [];
  for (const snapshot of doc.snapshots) {
    if (!AGENTS.includes(snapshot?.tool) || !Array.isArray(snapshot.windows)) continue;
    providers.push({
      agent: snapshot.tool,
      plan: typeof snapshot.plan === 'string' ? snapshot.plan : null,
      capturedAt: time(snapshot.capturedAt),
      windows: snapshot.windows
        .filter((w: any) => typeof w?.type === 'string' && Number.isFinite(w.usedRatio))
        .map((w: any) => ({
          key: typeof w.providerID === 'string' ? w.providerID : w.type,
          kind: w.type,
          group: typeof w.groupLabel === 'string' ? w.groupLabel : null,
          usedRatio: Math.min(Math.max(w.usedRatio, 0), 1),
          resetTime: time(w.resetTime),
          durationSec: Number.isFinite(w.duration) ? w.duration : null,
        })),
    });
  }
  return providers;
}

const SEVERITY: Record<UsageStatus, number> = { unknown: 0, stale: 0, ok: 1, tight: 2, exhausted: 3 };
const worst = (statuses: UsageStatus[]): UsageStatus => statuses.reduce((a, b) => (SEVERITY[b] > SEVERITY[a] ? b : a), 'ok' as UsageStatus);
const least = (statuses: UsageStatus[]): UsageStatus => statuses.reduce((a, b) => (SEVERITY[b] < SEVERITY[a] ? b : a));
const percent = (ratio: number) => `${Math.round(ratio * 100)}%`;
const windowName = (w: Pick<UsageWindow, 'kind' | 'group'>) =>
  `${w.group ? `${w.group} ` : ''}${({ fiveHour: '5-hour', weekly: 'weekly', billingCycle: 'billing-cycle' } as Record<string, string>)[w.kind] ?? w.kind} window`;

export type SampleReader = (agent: Agent, key: string, since: number) => Sample[];

/**
 * Turns AgentGauge's files into classified usage. It holds what classification needs between readings:
 * the previous status of each window for the hysteresis, and limits reported by failed jobs.
 */
export class UsageTracker {
  private previous = new Map<string, UsageStatus>();
  private reported = new Map<Agent, { at: number; detail: string }>();

  /** A job failed on this agent's usage limit; it is exhausted now, whatever the last reading says. */
  reportLimit(agent: Agent, detail: string, at: number): void {
    this.reported.set(agent, { at, detail });
  }

  classify(raw: RawProvider[] | null, samples: SampleReader, now: number): Usage {
    const providers = AGENTS.map((agent) => this.provider(agent, raw?.find((p) => p.agent === agent), samples, now));
    return { generatedAt: now, source: raw ? 'agentgauge' : 'none', providers };
  }

  private provider(agent: Agent, raw: RawProvider | undefined, samples: SampleReader, now: number): ProviderUsage {
    const report = this.reported.get(agent);
    // A reading taken after the report that shows room means the limit has lifted.
    const lifted = report && (now - report.at > REPORT_MS || Boolean(raw?.capturedAt && raw.capturedAt > report.at && raw.windows.every((w) => w.group !== null || w.usedRatio < 0.999)));
    if (lifted) this.reported.delete(agent);
    const limited = report && !lifted ? report : null;

    const windows: UsageWindow[] = (raw?.windows ?? []).map((w) => {
      const projection = projectExhaustion(samples(agent, w.key, now - PROJECTION_SPAN_MS), w.resetTime);
      const id = `${agent}:${w.key}`;
      let status: UsageStatus;
      if (w.usedRatio >= 0.999) status = 'exhausted';
      else if (projection.enough) status = projection.at === null ? 'ok' : 'tight';
      else {
        const remaining = 1 - w.usedRatio;
        status = remaining <= TIGHT_REMAINING ? 'tight' : remaining >= OK_REMAINING ? 'ok' : this.previous.get(id) === 'tight' ? 'tight' : 'ok';
      }
      this.previous.set(id, status);
      return { ...w, projectedExhaustion: projection.at, status };
    });

    const base = { agent, plan: raw?.plan ?? null, capturedAt: raw?.capturedAt ?? null, windows };
    if (limited) return { ...base, status: 'exhausted', reason: `A job hit the usage limit: ${limited.detail.split('\n')[0].slice(0, 160)}` };
    if (!raw || raw.capturedAt === null) return { ...base, status: 'unknown', reason: 'AgentGauge has no reading for this agent.' };
    if (now - raw.capturedAt > STALE_MS) return { ...base, status: 'stale', reason: `AgentGauge's last reading is ${Math.round((now - raw.capturedAt) / 60_000)} minutes old.` };
    if (!windows.length) return { ...base, status: 'unknown', reason: 'AgentGauge reported no usage windows for this agent.' };

    // Account-wide windows decide. A provider that only has per-model windows is as tight as its roomiest
    // model family, since work can go to that one.
    const wide = windows.filter((w) => w.group === null);
    let deciding: UsageWindow[];
    if (wide.length) deciding = wide;
    else {
      const groups = [...new Set(windows.map((w) => w.group))].map((group) => windows.filter((w) => w.group === group));
      const target = least(groups.map((g) => worst(g.map((w) => w.status))));
      deciding = groups.find((g) => worst(g.map((w) => w.status)) === target)!;
    }
    const status = worst(deciding.map((w) => w.status));
    const tightest = deciding.filter((w) => w.status === status).sort((a, b) => b.usedRatio - a.usedRatio)[0];
    const reason = status === 'ok'
      ? `${percent(tightest.usedRatio)} of the ${windowName(tightest)} used.`
      : status === 'exhausted'
        ? `The ${windowName(tightest)} is used up.`
        : tightest.projectedExhaustion !== null
          ? `At the recent pace the ${windowName(tightest)} runs out before it resets (${percent(tightest.usedRatio)} used).`
          : `${percent(1 - tightest.usedRatio)} of the ${windowName(tightest)} is left.`;
    return { ...base, status, reason };
  }
}

/** Reads the history database read-only. Returns no samples when it is absent or cannot be opened. */
export async function openHistory(dir: string): Promise<{ read: SampleReader; close(): void } | null> {
  const file = path.join(dir, 'usage-history.db');
  if (!fs.existsSync(file)) return null;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file, { readOnly: true });
    const query = db.prepare('SELECT captured_at AS at, used_ratio AS usedRatio, reset_time AS resetTime FROM samples WHERE tool = ? AND window_key = ? AND captured_at >= ? ORDER BY captured_at');
    return {
      read: (agent, key, since) => {
        try {
          return (query.all(agent, key, since) as any[]).map((row) => ({ at: Number(row.at), usedRatio: Number(row.usedRatio), resetTime: row.resetTime === null ? null : Number(row.resetTime) }));
        } catch {
          return [];
        }
      },
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/** Keeps the latest classified usage, re-read when AgentGauge writes its cache and re-judged as time passes. */
export class UsageMonitor {
  private tracker = new UsageTracker();
  private history: Awaited<ReturnType<typeof openHistory>> = null;
  private latest: Usage;
  private dir: string | null;
  private onChange: (usage: Usage) => void;
  private timer: NodeJS.Timeout | null = null;
  private live = new Map<Agent, RawProvider>();

  constructor(dir: string | null, onChange: (usage: Usage) => void) {
    this.dir = dir;
    this.onChange = onChange;
    this.latest = this.tracker.classify(null, () => [], Date.now());
  }

  async start(): Promise<void> {
    if (!this.dir) return;
    this.history = await openHistory(this.dir);
    this.refresh();
    fs.watchFile(path.join(this.dir, 'usage-cache.json'), { interval: 5000 }, () => this.refresh());
    // Statuses change with the clock alone: a reading goes stale, a reported limit lapses.
    this.timer = setInterval(() => this.refresh(), 60_000);
    this.timer.unref();
  }

  current(): Usage {
    return this.latest;
  }

  reportLimit(agent: Agent, detail: string): void {
    this.tracker.reportLimit(agent, detail, Date.now());
    this.refresh();
  }

  /**
   * A reading an agent gave of itself while working, such as Codex's rate limits. It stands in for
   * AgentGauge's when it is the newer of the two, which it is while the user is away and AgentGauge polls slowly.
   */
  supplement(provider: RawProvider): void {
    this.live.set(provider.agent, provider);
    this.refresh();
  }

  refresh(): void {
    let raw: ReturnType<typeof parseCache> = null;
    if (this.dir) {
      try {
        raw = parseCache(fs.readFileSync(path.join(this.dir, 'usage-cache.json'), 'utf8'));
      } catch {
        raw = null;
      }
    }
    if (this.live.size) {
      const merged = new Map((raw ?? []).map((p) => [p.agent, p]));
      for (const [agent, own] of this.live) if ((own.capturedAt ?? 0) > (merged.get(agent)?.capturedAt ?? 0)) merged.set(agent, own);
      raw = [...merged.values()];
    }
    const next = this.tracker.classify(raw, this.history?.read ?? (() => []), Date.now());
    const same = JSON.stringify({ ...next, generatedAt: 0 }) === JSON.stringify({ ...this.latest, generatedAt: 0 });
    this.latest = next;
    if (!same) this.onChange(next);
  }

  stop(): void {
    if (this.dir) fs.unwatchFile(path.join(this.dir, 'usage-cache.json'));
    if (this.timer) clearInterval(this.timer);
    this.history?.close();
  }
}

// --- Routing ---------------------------------------------------------------

const name = (agent: Agent) => (agent === 'claude' ? 'Claude' : WORKERS[agent].name);

/**
 * Who should take a piece of work, from the role table and current usage (docs/03, section 8.2).
 * It only ever answers with the role's holder or the lead: it never gives an agent a role the user
 * did not assign. A stale or unknown reading changes nothing, so the default roles are followed.
 */
export function route(kind: RouteKind, usage: Usage, roles: Config['roles']): RouteDecision {
  const of = (agent: Agent) => usage.providers.find((p) => p.agent === agent);
  const status = (agent: Agent): UsageStatus => of(agent)?.status ?? 'unknown';
  const short = (agent: Agent) => status(agent) === 'tight' || status(agent) === 'exhausted';
  const resets = (agent: Agent): number | null => {
    const times = (of(agent)?.windows ?? []).filter((w) => w.status === status(agent) && w.resetTime !== null).map((w) => w.resetTime!);
    return times.length ? Math.max(...times) : null;
  };
  const plain = (assignee: Agent, reason: string, fallback: Agent[] = []): RouteDecision => ({ kind, assignee, reason, fallback, degraded: false, deferUntil: null });
  const why = (agent: Agent) => `${name(agent)} is ${status(agent)}: ${of(agent)?.reason ?? 'no reading.'}`;
  /** Said when the holder keeps the work: with no usable reading, that is the assignment and not a finding. */
  const keeps = (agent: Agent) => (status(agent) === 'ok' ? `${name(agent)} holds the role and has room.` : `${name(agent)} holds the role. Its usage is not known (${of(agent)?.reason ?? 'no reading.'}), so the assignment is followed.`);

  if (kind === 'lead') {
    const engineer = roles.delegate.agent;
    if (status('claude') === 'exhausted') {
      const takeover = engineer === 'codex' && status('codex') !== 'exhausted';
      return { kind, assignee: takeover ? 'codex' : 'claude', reason: `${why('claude')} ${takeover ? 'Write a handoff note and hand the session to Codex.' : 'No other agent can lead; stop and tell the user.'}`, fallback: [], degraded: true, deferUntil: resets('claude') };
    }
    if (status('claude') === 'tight') return plain('claude', `${why('claude')} Keep to planning and merge decisions, and hand more implementation to ${name(engineer)}.`, short(engineer) ? [] : [engineer]);
    return plain('claude', status('claude') === 'ok' ? 'Claude has room; lead as usual.' : `Claude's usage is not known (${of('claude')?.reason ?? 'no reading.'}); lead as usual.`);
  }

  const holder = roles[kind].agent;
  if (kind === 'delegate') {
    if (status(holder) === 'exhausted') return plain('claude', `${why(holder)} Do this piece yourself, in a subagent if it is large.`);
    if (status(holder) === 'tight' && !short('claude')) {
      return plain('claude', `${why(holder)} Take implementation yourself or in subagents${roles.review.agent === holder ? `, and keep what ${name(holder)} has left for the cross-review` : ''}.`, [holder]);
    }
    return plain(holder, short('claude') && !short(holder) ? `${why('claude')} Hand ${name(holder)} as much implementation as separates cleanly.` : keeps(holder), ['claude']);
  }
  if (kind === 'review') {
    if (status(holder) === 'exhausted') {
      return { kind, assignee: 'claude', reason: `${why(holder)} Run the self-review a second time with the review focus, and say that the cross-review was skipped.`, fallback: [], degraded: true, deferUntil: resets(holder) };
    }
    return plain(holder, status(holder) === 'tight' ? `${why(holder)} The cross-review still goes to it; keep it to one round.` : keeps(holder), ['claude']);
  }
  // Polish is not a merge gate, so it can wait for the reset.
  if (short(holder)) {
    return { kind, assignee: holder, reason: `${why(holder)} Polish can wait until its usage resets; make an urgent wording fix yourself.`, fallback: ['claude'], degraded: false, deferUntil: resets(holder) };
  }
  return plain(holder, keeps(holder));
}

/** One line per agent, for the lead's status output. */
export function describeUsage(usage: Usage): string[] {
  if (usage.source === 'none') return [];
  return usage.providers.map((p) => {
    const wide = p.windows.filter((w) => w.group === null);
    const shown = (wide.length ? wide : p.windows).map((w) => `${percent(w.usedRatio)} of the ${windowName(w)}`).join(', ');
    return `${name(p.agent)}: ${p.status}${shown ? ` — ${shown}` : ''}${p.status === 'ok' ? '' : `. ${p.reason}`}`;
  });
}

/** Codex's own rate limits, as its app-server reports them, in the shape of an AgentGauge reading. */
export function fromCodexLimits(limits: { plan: string | null; windows: { minutes: number | null; usedPercent: number; resetsAt: number | null }[] }, now: number): RawProvider {
  return {
    agent: 'codex',
    plan: limits.plan,
    capturedAt: now,
    windows: limits.windows.filter((w) => Number.isFinite(w.usedPercent)).map((w) => {
      // The two windows Codex has; the keys match AgentGauge's so the history still applies.
      const kind = w.minutes !== null && w.minutes <= 300 ? 'fiveHour' : 'weekly';
      // Codex reports the reset in seconds.
      const resetTime = w.resetsAt === null ? null : w.resetsAt < 1e12 ? w.resetsAt * 1000 : w.resetsAt;
      return { key: kind, kind, group: null, usedRatio: Math.min(Math.max(w.usedPercent / 100, 0), 1), resetTime, durationSec: w.minutes === null ? null : w.minutes * 60 };
    }),
  };
}
