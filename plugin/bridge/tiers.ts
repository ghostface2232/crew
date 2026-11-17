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

/** A model the settings offer for an agent, with the efforts it accepts. */
export interface ModelChoice {
  id: string;
  name: string;
  efforts?: string[];
}

/** The models this Codex account lists, in Codex's own order, read from its model cache; none without a cache. */
export function codexModels(cache = codexCache()): ModelChoice[] {
  let listed: unknown;
  try {
    listed = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } catch {
    return [];
  }
  const models = Array.isArray(listed) ? listed : (listed as { models?: unknown })?.models;
  if (!Array.isArray(models)) return [];
  return models
    .filter((m) => typeof m?.slug === 'string' && m.visibility !== 'hide')
    .map((m) => ({
      id: m.slug as string,
      name: typeof m.display_name === 'string' ? m.display_name : m.slug,
      efforts: Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels.map((level: { effort?: unknown }) => level?.effort).filter((e: unknown): e is string => typeof e === 'string') : [],
    }));
}

/** Efforts in rising order, for picking the nearest one a model offers. */
const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Thinking levels each Antigravity family offered on agy 1.5.9. They only fill the settings' choices:
 * a job takes its levels from its own session, which lists what this account and version really offer.
 */
const ANTIGRAVITY_EFFORTS: Record<string, string[]> = { hydrogen: ['low', 'medium', 'high', 'xhigh'], argon: ['low', 'medium', 'high'] };

/** Antigravity's models are matched by family against the session's own list, so its choices are the families. */
export const ANTIGRAVITY_MODELS: ModelChoice[] = [...new Set(Object.values(TIER_FAMILIES.antigravity))]
  .map((family) => ({ id: family, name: family[0].toUpperCase() + family.slice(1), efforts: ANTIGRAVITY_EFFORTS[family] }));

/** The model a tier gives an agent's job. For Antigravity it is the family, matched against the session's own list. */
export function tierModel(agent: WorkerAgent, tier: Tier, cache?: string): string | undefined {
  const family = TIER_FAMILIES[agent][tier];
  return agent === 'codex' ? codexModel(family, cache) : family;
}

/**
 * The tier a family name stands for when the lead passes one as a model ("Astra", "Astra (frontier)"), as a user
 * or a preset's wording puts it. Only a label without a version that names exactly one family counts.
 */
export function familyTier(agent: WorkerAgent, label: string): Tier | undefined {
  if (/\d/.test(label)) return undefined;
  const words = label.toLowerCase().split(/[^a-z]+/);
  const families = [...new Set(Object.values(TIER_FAMILIES[agent]))].filter((family) => words.includes(family));
  return families.length === 1 ? [...TIERS].reverse().find((tier) => TIER_FAMILIES[agent][tier] === families[0]) : undefined;
}

/** The Codex model ID for a model the account lists under that ID or its display name ("GPT-6-Astra"); otherwise the name as given. */
export function modelId(agent: WorkerAgent, wanted: string, cache?: string): string {
  if (agent !== 'codex') return wanted;
  const name = wanted.toLowerCase();
  return codexModels(cache).find((m) => m.id.toLowerCase() === name || m.name.toLowerCase() === name)?.id ?? wanted;
}

/** The tier whose family a model name belongs to, for holding a named model under a preset's cap; undefined when none matches. */
export function tierOf(agent: WorkerAgent, model: string): Tier | undefined {
  const name = model.toLowerCase();
  return [...TIERS].reverse().find((tier) => name.includes(TIER_FAMILIES[agent][tier]));
}

/** The session's model option that a requested model or family names: an exact value first, else the first value containing it. */
export function pickModel(options: { value?: unknown; name?: unknown }[] | undefined, wanted: string): string | undefined {
  const values = (options ?? []).map((o) => o.value).filter((v): v is string => typeof v === 'string');
  if (values.includes(wanted)) return wanted;
  const needle = wanted.toLowerCase();
  // An orchestrator wraps a family; it is not the family itself.
  return values.find((v) => v.toLowerCase().includes(needle) && !v.toLowerCase().includes('orchestrator'));
}

/**
 * The offered effort a requested one stands for: itself when offered, else the nearest lower one, else the lowest offered.
 * A model with fewer levels then runs as close to the request as it can, never above it.
 */
export function pickEffort(options: { value?: unknown }[] | undefined, wanted: string): string | undefined {
  const values = (options ?? []).map((o) => o.value).filter((v): v is string => typeof v === 'string');
  if (values.includes(wanted)) return wanted;
  const rank = EFFORT_ORDER.indexOf(wanted.toLowerCase());
  if (rank < 0) return undefined;
  const known = values.filter((v) => EFFORT_ORDER.includes(v)).sort((a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b));
  return known.filter((v) => EFFORT_ORDER.indexOf(v) < rank).pop() ?? known[0];
}
