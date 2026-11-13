import type { Agent } from './jobs.ts';
import type { Role } from './config.ts';

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
