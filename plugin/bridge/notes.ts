import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Holder } from './config.ts';
import { TIERS } from './tiers.ts';
import type { Tier } from './tiers.ts';

// A build line's finding load: the accepted findings by severity.
const LOAD = { high: 0.35, medium: 0.15, low: 0.05 };
// Exposure units of a change, so a large change may carry more findings than a small one. Chosen units, not a measured
// difficulty. Tier is not used: for Codex it picks the model, so it would act as a fixed bonus per model.
const EXPOSURE = { small: 0.5, medium: 1, large: 2, xlarge: 4 };
// A fix line's quality by outcome, lowered by the findings the check of the fix raised.
const FIX_QUALITY = { 'root-cause': 1, patch: 0.55, 'another-review': 0.25 };
// Where a model starts with nothing to compare: a build rate of one high per medium change (7.0), a fix quality of 0.7.
const REFERENCE = { build: 0.36, fix: 0.7 };
// The start weighs as much as three medium changes (or three fixes) of the model's own.
const PRIOR_WEIGHT = 3;
// A review by the builder's own agent counts half.
const SELF_REVIEW = 0.5;
// Ten new evidence lines call for a new prose summary.
export const CONSOLIDATE_AFTER = 10;

export type NoteRole = 'build' | 'fix';
export type FixOutcome = 'root-cause' | 'patch' | 'another-review';
export type ChangeSize = 'small' | 'medium' | 'large' | 'xlarge';
export type Adoption = 'as-is' | 'after-reply' | 'partly' | 'rejected';
export const NOTE_ROLES = ['build', 'fix'] as const;
export const FIX_OUTCOMES = ['root-cause', 'patch', 'another-review'] as const;
export const CHANGE_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export const ADOPTIONS = ['as-is', 'after-reply', 'partly', 'rejected'] as const;
export interface Findings { high: number; medium: number; low: number }
export interface Evidence {
  id: string;
  at: number;
  model: string;
  agent: Holder;
  effort?: string;
  tier?: Tier;
  size: ChangeSize;
  role: NoteRole;
  job?: string;
  reviewer: Holder;
  findings: Findings;
  /** Findings the lead declined, kept so its triage can be checked; not scored. */
  declined?: Findings;
  outcome?: FixOutcome;
  /** How the lead took a delegated job's work, and the follow-up turns it took; shown, not scored. */
  adoption?: Adoption;
  rounds?: number;
  text: string;
}
export interface ModelNote { model: string; agent: Holder; summary: string; summaryAt: number | null; evidence: Evidence[] }
export interface NotesFile { version: 1; models: Record<string, ModelNote> }
export type NoteStatus = 'too few samples' | 'on trial' | 'settled';
export interface ModelScore {
  model: string;
  agent: Holder;
  score: number | null;
  build: number | null;
  fix: number | null;
  samples: number;
  buildSamples: number;
  fixSamples: number;
  status: NoteStatus;
  summary: string;
  lastAt: number | null;
  consolidate: boolean;
  /** Delegated builds by how the lead took them, or null when none says. */
  adoption: { judged: number; asIs: number; afterReply: number; partly: number; rejected: number; rounds: number } | null;
}
export const notesFile = (home: string) => path.join(home, 'model-notes.json');

export function loadNotes(home: string): NotesFile {
  const file = notesFile(home);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!saved || saved.version !== 1 || !saved.models || typeof saved.models !== 'object' || Array.isArray(saved.models)) throw new Error('Expected version 1 and a models object.');
    return { version: 1, models: wellFormed(saved.models) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, models: {} };
    throw new Error(`Could not load ${file}: ${(err as Error).message}`);
  }
}

const HOLDERS = ['codex', 'antigravity', 'claude'];
const counts = (f: any) => f && typeof f === 'object' && ['high', 'medium', 'low'].every((key) => Number.isInteger(f[key]) && f[key] >= 0);

/**
 * Drops entries and lines a hand edit or an older writer left incomplete, so one bad line cannot stop the scores,
 * and every reader (the app decodes strictly) gets the shape it expects.
 */
function wellFormed(models: Record<string, any>): Record<string, ModelNote> {
  const kept: Record<string, ModelNote> = {};
  for (const [model, note] of Object.entries(models)) {
    if (!note || !HOLDERS.includes(note.agent) || !Array.isArray(note.evidence)) continue;
    const evidence = note.evidence.filter((e: any) => e && typeof e.id === 'string' && Number.isFinite(e.at) && e.model === model && e.agent === note.agent && HOLDERS.includes(e.reviewer)
      && CHANGE_SIZES.includes(e.size) && NOTE_ROLES.includes(e.role) && (e.tier === undefined || TIERS.includes(e.tier))
      && (e.role === 'build' || FIX_OUTCOMES.includes(e.outcome)) && typeof e.text === 'string'
      && counts(e.findings) && (e.declined === undefined || counts(e.declined))
      && (e.adoption === undefined || (e.role === 'build' && typeof e.job === 'string' && e.job && ADOPTIONS.includes(e.adoption)))
      && (e.rounds === undefined || (e.adoption !== undefined && Number.isInteger(e.rounds) && e.rounds >= 0)));
    Object.defineProperty(kept, model, {
      value: { model, agent: note.agent, summary: typeof note.summary === 'string' ? note.summary : '', summaryAt: Number.isFinite(note.summaryAt) ? note.summaryAt : null, evidence },
      enumerable: true, configurable: true, writable: true,
    });
  }
  // A hand edit may leave a job noted twice; only its latest line counts, as noting it again would leave it.
  const latest = new Map<string, Evidence>();
  for (const e of Object.values(kept).flatMap((m) => m.evidence)) {
    const key = `${e.job}\0${e.role}`;
    if (typeof e.job === 'string' && (latest.get(key)?.at ?? -Infinity) <= e.at) latest.set(key, e);
  }
  for (const m of Object.values(kept)) m.evidence = m.evidence.filter((e) => typeof e.job !== 'string' || latest.get(`${e.job}\0${e.role}`) === e);
  return kept;
}

const lines = (models: Record<string, any>) => Object.values(models).reduce((sum, note) => sum + 1 + (Array.isArray(note?.evidence) ? note.evidence.length : 0), 0);

/** Loading skips what it cannot read, so a save would erase it; keep the file as it was first. */
function keepDropped(target: string): void {
  let models: Record<string, any>;
  try {
    models = JSON.parse(fs.readFileSync(target, 'utf8')).models;
  } catch { return; /* Nothing to keep: no file yet, or one loadNotes already refuses. */ }
  // A failed copy must stop the save, or the lines are lost with no copy.
  if (lines(wellFormed(models)) < lines(models)) fs.copyFileSync(target, `${target}.dropped-${Date.now()}`);
}

function save(home: string, file: NotesFile): void {
  fs.mkdirSync(home, { recursive: true });
  const target = notesFile(home);
  keepDropped(target);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(file));
  fs.renameSync(`${target}.tmp`, target);
}

function cleanText(value: string, name: string, limit: number, oneLine = false): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a non-empty string.`);
  const text = (oneLine ? value.replace(/[\r\n]+/g, ' ') : value).trim().slice(0, limit).trim();
  if (!text) throw new Error(`${name} must be a non-empty string.`);
  return text;
}

export function addEvidence(home: string, input: Omit<Evidence, 'id' | 'at'> & { at?: number }): { evidence: Evidence; score: ModelScore } {
  const model = cleanText(input.model, 'model', Infinity);
  for (const key of ['agent', 'reviewer'] as const) {
    if (!HOLDERS.includes(input[key])) throw new Error(`${key} must be a valid holder.`);
  }
  if (!CHANGE_SIZES.includes(input.size)) throw new Error('Invalid size.');
  if (!NOTE_ROLES.includes(input.role)) throw new Error('Invalid role.');
  if (input.tier !== undefined && !TIERS.includes(input.tier)) throw new Error('Invalid tier.');
  if (input.role === 'fix' && !FIX_OUTCOMES.includes(input.outcome!)) throw new Error('fix requires a valid outcome.');
  if (input.role === 'build' && input.outcome !== undefined) throw new Error('build forbids outcome.');
  if (input.adoption !== undefined && (input.role !== 'build' || !input.job || !ADOPTIONS.includes(input.adoption))) throw new Error('adoption is for a delegated job\'s build line: as-is, after-reply, partly, or rejected.');
  if (input.rounds !== undefined && (input.adoption === undefined || !Number.isInteger(input.rounds) || input.rounds < 0)) throw new Error('rounds must be a non-negative integer, given with adoption.');
  const findings = {} as Findings;
  for (const key of ['high', 'medium', 'low'] as const) {
    const count = input.findings?.[key] === undefined ? 0 : input.findings[key];
    if (!Number.isInteger(count) || count < 0) throw new Error(`findings.${key} must be a non-negative integer.`);
    findings[key] = count;
  }
  let declined: Findings | undefined;
  if (input.declined !== undefined) {
    declined = {} as Findings;
    for (const key of ['high', 'medium', 'low'] as const) {
      const count = input.declined?.[key] ?? 0;
      if (!Number.isInteger(count) || count < 0) throw new Error(`declined.${key} must be a non-negative integer.`);
      declined[key] = count;
    }
  }
  const text = cleanText(input.text, 'text', 300, true);
  const at = input.at ?? Date.now();
  if (!Number.isFinite(at)) throw new Error('at must be a finite timestamp.');
  const file = loadNotes(home);
  const existing = Object.hasOwn(file.models, model) ? file.models[model] : undefined;
  if (existing && existing.agent !== input.agent) throw new Error(`Model ${model} already belongs to agent ${existing.agent}.`);
  const note = existing ?? { model, agent: input.agent, summary: '', summaryAt: null, evidence: [] };
  let id: string;
  const ids = new Set(Object.values(file.models).flatMap((m) => m.evidence.map((e) => e.id)));
  do { id = `ev-${randomBytes(3).toString('hex')}`; } while (ids.has(id));
  const evidence: Evidence = { ...input, model, findings, ...(declined ? { declined } : {}), text, id, at };
  // Noting a job again (a retried call, a resumed session, a model the session reported later) replaces its line
  // rather than counting the job twice; the line moves to the model named now, and a model it leaves empty goes.
  if (input.job) for (const other of Object.values(file.models)) {
    const before = other.evidence.length;
    other.evidence = other.evidence.filter((e) => !(e.job === input.job && e.role === input.role));
    if (before && !other.evidence.length && other !== existing) delete file.models[other.model];
  }
  note.evidence.push(evidence);
  Object.defineProperty(file.models, model, { value: note, enumerable: true, configurable: true, writable: true });
  save(home, file);
  return { evidence, score: scoreAll(file).find((s) => s.model === model)! };
}

export function setSummary(home: string, model: string, summary: string, at = Date.now()): ModelScore {
  const file = loadNotes(home);
  if (!Object.hasOwn(file.models, model)) throw new Error(`Unknown model ${model}.`);
  if (!Number.isFinite(at)) throw new Error('at must be a finite timestamp.');
  file.models[model].summary = cleanText(summary, 'summary', 1200);
  file.models[model].summaryAt = at;
  save(home, file);
  return scoreAll(file).find((s) => s.model === model)!;
}

const load = (f: Findings) => LOAD.high * f.high + LOAD.medium * f.medium + LOAD.low * f.low;
const weight = (e: Evidence) => (e.reviewer === e.agent ? SELF_REVIEW : 1);
type Scope = 'build' | 'fix';
/** A role's evidence as a ratio: build is finding load over exposure, fix is quality over lines. */
function sums(lines: Evidence[], scope: Scope): { num: number; den: number } {
  let num = 0, den = 0;
  for (const e of lines) {
    const w = weight(e);
    if (scope === 'build') { num += w * load(e.findings); den += w * EXPOSURE[e.size]; }
    else { num += w * FIX_QUALITY[e.outcome!] * Math.exp(-load(e.findings)); den += w; }
  }
  return { num, den };
}
const shrink = (s: { num: number; den: number }, prior: number) => (s.num + PRIOR_WEIGHT * prior) / (s.den + PRIOR_WEIGHT);

/**
 * Scores each model per role. Build: the rate of accepted finding load per exposure unit, drawn toward a start, shown
 * as 10·exp(−rate), so more findings always cost more and nothing is clamped. Fix: mean quality, drawn the same way.
 * The start is the mean of the other models' own estimates (each counted once, so a busy model cannot set everyone's
 * start) and the reference, which counts as one more model. Reviewers are not calibrated: the data cannot tell a harsh
 * reviewer from one that was given worse work. `score` is the build score; fix is shown beside it, never pooled.
 */
export function scoreAll(file: NotesFile): ModelScore[] {
  const models = Object.values(file.models);
  const roleLines = (m: ModelNote, scope: Scope) => m.evidence.filter((e) => e.role === scope);
  const own = new Map<Scope, Map<string, { num: number; den: number }>>();
  for (const scope of ['build', 'fix'] as const) {
    own.set(scope, new Map(models.filter((m) => roleLines(m, scope).length).map((m) => [m.model, sums(roleLines(m, scope), scope)])));
  }
  /** A model's estimate for a role, unrounded, or null with no lines. */
  function estimate(model: string, scope: Scope): number | null {
    const mine = own.get(scope)!.get(model);
    if (!mine) return null;
    const others = [...own.get(scope)!].filter(([name]) => name !== model).map(([, s]) => shrink(s, REFERENCE[scope]));
    const start = (others.reduce((sum, v) => sum + v, 0) + REFERENCE[scope]) / (others.length + 1);
    return shrink(mine, start);
  }
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const rates = new Map<string, number | null>(models.map((m) => [m.model, estimate(m.model, 'build')]));
  const group = (s: ModelScore) => (s.score !== null ? (s.status === 'too few samples' ? 1 : 0) : s.samples ? 2 : 3);
  const byRate = (a: ModelScore, b: ModelScore) => (rates.get(a.model) ?? 0) - (rates.get(b.model) ?? 0);
  return models.map((m): ModelScore => {
    const build = roleLines(m, 'build');
    const fix = roleLines(m, 'fix');
    const rate = rates.get(m.model)!;
    const quality = estimate(m.model, 'fix');
    // Status counts build reviews, a self-review as half, since only build sets the score.
    const reviews = build.reduce((sum, e) => sum + weight(e), 0);
    const samples = m.evidence.length;
    const buildScore = rate === null ? null : tenth(10 * Math.exp(-rate));
    const adopted = build.filter((e) => e.adoption);
    const taken = (a: Adoption) => adopted.filter((e) => e.adoption === a).length;
    return {
      model: m.model, agent: m.agent, score: buildScore, build: buildScore, fix: quality === null ? null : tenth(10 * quality),
      samples, buildSamples: build.length, fixSamples: fix.length,
      status: reviews < 3 ? 'too few samples' : reviews < 8 ? 'on trial' : 'settled', summary: m.summary,
      lastAt: samples ? m.evidence.reduce((latest, e) => Math.max(latest, e.at), -Infinity) : null,
      consolidate: m.evidence.filter((e) => m.summaryAt === null || e.at > m.summaryAt).length >= CONSOLIDATE_AFTER,
      adoption: adopted.length ? {
        judged: adopted.length, asIs: taken('as-is'), afterReply: taken('after-reply'), partly: taken('partly'), rejected: taken('rejected'),
        rounds: adopted.reduce((sum, e) => sum + (e.rounds ?? 0), 0),
      } : null,
    };
  // Models with too few reviews come after every ranked one, whatever their score; then models with fixes only, and
  // last models with no lines. Within a group the unrounded rate decides, so a tie on the shown score is not left to the name.
  }).sort((a, b) => group(a) - group(b) || byRate(a, b) || a.model.localeCompare(b.model));
}

export function renderNotes(scores: ModelScore[], file: NotesFile, options: { models?: string[]; agents?: Holder[]; evidence?: number } = {}): string {
  const number = (n: number | null) => n === null ? '—' : n.toFixed(1);
  return scores.filter((s) => (!options.models || options.models.includes(s.model)) && (!options.agents || options.agents.includes(s.agent))).map((s) => {
    const lines = [`### ${s.model} (${s.agent}) — ${number(s.score)}/10, ${s.status}, ${s.buildSamples} build(s), ${s.fixSamples} fix(es)`];
    if (s.build !== null || s.fix !== null) lines.push(`build ${number(s.build)} · fix ${number(s.fix)}`);
    // Scores are finding rates on the work each model was given; the tiers say what that work was.
    const tiers = new Map<string, number>();
    for (const e of file.models[s.model].evidence) if (e.role === 'build' && e.tier) tiers.set(e.tier, (tiers.get(e.tier) ?? 0) + 1);
    if (tiers.size) lines.push(`builds by tier: ${TIERS.filter((t) => tiers.has(t)).map((t) => `${t} ${tiers.get(t)}`).join(', ')}`);
    const a = s.adoption;
    if (a) lines.push(`adopted: ${a.asIs} as is, ${a.afterReply} after a reply, ${a.partly} in part, ${a.rejected} rejected, of ${a.judged}; ${a.rounds} follow-up round(s)`);
    lines.push(s.summary || 'No summary yet.');
    const count = Math.max(0, Math.floor(options.evidence ?? 5));
    const evidence = [...file.models[s.model].evidence].sort((a, b) => b.at - a.at).slice(0, count);
    for (const e of evidence) {
      const date = new Date(e.at);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      const declined = e.declined && load(e.declined) ? `, declined ${(['high', 'medium', 'low'] as const).filter((k) => e.declined![k]).map((k) => `${e.declined![k]} ${k}`).join(' ')}` : '';
      const adoption = e.adoption ? `, ${e.adoption}${e.rounds ? ` after ${e.rounds} round(s)` : ''}` : '';
      lines.push(`- ${day} ${e.job || '—'} (${e.reviewer} reviewed, ${e.role}, ${e.tier ? `${e.tier}/` : ''}${e.size}${declined}${adoption}): ${e.text}`);
    }
    if (s.consolidate) lines.push('Summary is due: rewrite it from the evidence.');
    return lines.join('\n\n');
  }).join('\n\n');
}
