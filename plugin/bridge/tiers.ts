import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { WorkerAgent } from './config.ts';

/**
 * How demanding a job is. The lead picks one per job; the bridge turns it into a model, so the same rule
 * holds for every job whoever starts it (the lead, the board, or a preset-free install).
 * - fast: plain searches and lookups
 * - light: simple, well-specified tasks
 * - standard: most work, including most UI changes
 * - frontier: especially hard or complex work, or a UI rebuilt from scratch / a very large UI change
 */
export const TIERS = ['fast', 'light', 'standard', 'frontier'] as const;
export type Tier = (typeof TIERS)[number];

/**
 * Model family per tier. Families, not versions: when a newer model of a family ships, jobs use it
 * without a change here. Antigravity has two families worth using: Hydrogen for nearly everything,
 * Argon only for literary or very complex document editing.
 */
export const TIER_FAMILIES: Record<WorkerAgent, Record<Tier, string>> = {
  codex: { fast: 'luna', light: 'terra', standard: 'sol', frontier: 'astra' },
  antigravity: { fast: 'hydrogen', light: 'hydrogen', standard: 'hydrogen', frontier: 'argon' },
};

/** Codex effort by tier when the lead names none: medium for most work, high for the hardest. */
export function tierEffort(tier: Tier): string {
  return tier === 'frontier' ? 'high' : 'medium';
}

/** The tier a job runs at when the lead names none. A read-only question is usually a lookup. */
export function defaultTier(spec: { ask?: boolean }): Tier {
  return spec.ask ? 'light' : 'standard';
}

function codexCache(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models_cache.json');
}

/**
 * The newest model of `family` that this Codex account lists, read from Codex's own model cache.
 * Undefined when Codex has no cache or lists no such model; the job then runs on Codex's default.
 */
export function codexModel(family: string, cache = codexCache()): string | undefined {
  let listed: unknown;
  try {
    listed = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    return undefined;
  }
  const models = Array.isArray(listed) ? listed : (listed as { models?: unknown })?.models;
  if (!Array.isArray(models)) return undefined;
  const version = (slug: string) => (/(\d+(?:\.\d+)*)/.exec(slug)?.[1] ?? '0').split('.').map(Number);
  const newer = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0);
    return 0;
  };
  const matches = models
    .filter((m) => typeof m?.slug === 'string' && m.visibility !== 'hide' && new RegExp(`(^|-)${family}$`, 'i').test(m.slug))
    .map((m) => m.slug as string)
    .sort((a, b) => newer(version(a), version(b)));
  return matches[0];
}

/** The model a tier gives an agent's job. For Antigravity it is the family, matched against the session's own list. */
export function tierModel(agent: WorkerAgent, tier: Tier, cache?: string): string | undefined {
  const family = TIER_FAMILIES[agent][tier];
  return agent === 'codex' ? codexModel(family, cache) : family;
}

/** The session's model option that a requested model or family names: an exact value first, else the first value containing it. */
export function pickModel(options: { value?: unknown; name?: unknown }[] | undefined, wanted: string): string | undefined {
  const values = (options ?? []).map((o) => o.value).filter((v): v is string => typeof v === 'string');
  if (values.includes(wanted)) return wanted;
  const needle = wanted.toLowerCase();
  // An orchestrator wraps a family; it is not the family itself.
  return values.find((v) => v.toLowerCase().includes(needle) && !v.toLowerCase().includes('orchestrator'));
}
