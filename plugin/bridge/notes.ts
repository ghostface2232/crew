import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Holder } from './config.ts';
import { TIERS } from './tiers.ts';
import type { Tier } from './tiers.ts';

// Difficulty adjusts both the penalty and the evidence weight.
const TIER_FACTOR: Record<Tier, number> = { fast: 0.7, light: 0.85, standard: 1, frontier: 1.25 };
// Larger changes carry more evidence and soften finding penalties.
const SIZE_FACTOR = { small: 0.8, medium: 1, large: 1.3 };
// Accepted findings reduce build quality by severity.
const PENALTY = { high: 0.35, medium: 0.15, low: 0.05 };
// Fix quality records whether the underlying cause was resolved.
const FIX_QUALITY = { 'root-cause': 1, patch: 0.55, 'another-review': 0.25 };
// Two prior samples temper early scores toward 70 percent.
const K = 2, P = 0.7;
// A reviewer needs five builds before calibration applies.
const CALIBRATE_AFTER = 5;
// Ten new evidence lines call for a new prose summary.
export const CONSOLIDATE_AFTER = 10;

export type NoteRole = 'build' | 'fix';
export type FixOutcome = 'root-cause' | 'patch' | 'another-review';
export type ChangeSize = 'small' | 'medium' | 'large';
export const NOTE_ROLES = ['build', 'fix'] as const;
export const FIX_OUTCOMES = ['root-cause', 'patch', 'another-review'] as const;
export const CHANGE_SIZES = ['small', 'medium', 'large'] as const;
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
  outcome?: FixOutcome;
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

/**
 * Drops entries and lines a hand edit or an older writer left incomplete, so one bad line cannot stop the scores,
 * and every reader (the app decodes strictly) gets the shape it expects.
 */
function wellFormed(models: Record<string, any>): Record<string, ModelNote> {
  const kept: Record<string, ModelNote> = {};
  for (const [model, note] of Object.entries(models)) {
    if (!note || !HOLDERS.includes(note.agent) || !Array.isArray(note.evidence)) continue;
    const evidence = note.evidence.filter((e: any) => e && typeof e.id === 'string' && Number.isFinite(e.at) && HOLDERS.includes(e.reviewer)
      && CHANGE_SIZES.includes(e.size) && NOTE_ROLES.includes(e.role) && (e.tier === undefined || TIERS.includes(e.tier))
      && (e.role === 'build' || FIX_OUTCOMES.includes(e.outcome)) && typeof e.text === 'string' && e.findings
      && ['high', 'medium', 'low'].every((key) => Number.isInteger(e.findings[key]) && e.findings[key] >= 0));
    Object.defineProperty(kept, model, {
      value: { model, agent: note.agent, summary: typeof note.summary === 'string' ? note.summary : '', summaryAt: Number.isFinite(note.summaryAt) ? note.summaryAt : null, evidence },
      enumerable: true, configurable: true, writable: true,
    });
  }
  return kept;
}

function save(home: string, file: NotesFile): void {
  fs.mkdirSync(home, { recursive: true });
  const target = notesFile(home);
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
  const findings = {} as Findings;
  for (const key of ['high', 'medium', 'low'] as const) {
    const count = input.findings?.[key] === undefined ? 0 : input.findings[key];
    if (!Number.isInteger(count) || count < 0) throw new Error(`findings.${key} must be a non-negative integer.`);
    findings[key] = count;
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
  const evidence: Evidence = { ...input, model, findings, text, id, at };
  // Noting a job again (a retried call, a resumed session) corrects its line rather than counting the job twice.
  note.evidence = note.evidence.filter((e) => !(input.job && e.job === input.job && e.role === input.role));
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

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const penalty = (e: Evidence) => PENALTY.high * e.findings.high + PENALTY.medium * e.findings.medium + PENALTY.low * e.findings.low;

export function scoreAll(file: NotesFile): ModelScore[] {
  const builds = Object.values(file.models).flatMap((m) => m.evidence.filter((e) => e.role === 'build'));
  const globalMean = builds.length ? builds.reduce((sum, e) => sum + penalty(e), 0) / builds.length : 0;
  const calibration = new Map<Holder, number>();
  for (const reviewer of ['codex', 'antigravity', 'claude'] as const) {
    const lines = builds.filter((e) => e.reviewer === reviewer);
    const mean = lines.length ? lines.reduce((sum, e) => sum + penalty(e), 0) / lines.length : 0;
    calibration.set(reviewer, lines.length < CALIBRATE_AFTER ? 1 : mean === 0 ? (globalMean > 0 ? 1.25 : 1) : clamp(globalMean / mean, 0.75, 1.25));
  }
  function score(lines: Evidence[]): number | null {
    if (!lines.length) return null;
    let weighted = 0, weights = 0;
    for (const e of lines) {
      const d = TIER_FACTOR[e.tier ?? 'standard'] * SIZE_FACTOR[e.size];
      const q = e.role === 'build' ? clamp(1 - penalty(e) * calibration.get(e.reviewer)! / d, 0, 1) : FIX_QUALITY[e.outcome!];
      const w = d * (e.reviewer === e.agent ? 0.5 : 1);
      weighted += w * q;
      weights += w;
    }
    return Math.round((weighted + K * P) / (weights + K) * 100) / 10;
  }
  return Object.values(file.models).map((m): ModelScore => {
    const build = m.evidence.filter((e) => e.role === 'build');
    const fix = m.evidence.filter((e) => e.role === 'fix');
    const samples = m.evidence.length;
    return {
      model: m.model, agent: m.agent, score: score(m.evidence), build: score(build), fix: score(fix),
      samples, buildSamples: build.length, fixSamples: fix.length,
      status: samples < 3 ? 'too few samples' : samples < 8 ? 'on trial' : 'settled', summary: m.summary,
      lastAt: samples ? m.evidence.reduce((latest, e) => Math.max(latest, e.at), -Infinity) : null,
      consolidate: m.evidence.filter((e) => m.summaryAt === null || e.at > m.summaryAt).length >= CONSOLIDATE_AFTER,
    };
  }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.model.localeCompare(b.model));
}

export function renderNotes(scores: ModelScore[], file: NotesFile, options: { models?: string[]; agents?: Holder[]; evidence?: number } = {}): string {
  const number = (n: number | null) => n === null ? '—' : n.toFixed(1);
  return scores.filter((s) => (!options.models || options.models.includes(s.model)) && (!options.agents || options.agents.includes(s.agent))).map((s) => {
    const lines = [`### ${s.model} (${s.agent}) — ${number(s.score)}/10, ${s.status}, ${s.samples} samples`];
    if (s.build !== null || s.fix !== null) lines.push(`build ${number(s.build)} · fix ${number(s.fix)}`);
    lines.push(s.summary || 'No summary yet.');
    const count = Math.max(0, Math.floor(options.evidence ?? 5));
    const evidence = [...file.models[s.model].evidence].sort((a, b) => b.at - a.at).slice(0, count);
    for (const e of evidence) {
      const date = new Date(e.at);
      const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      lines.push(`- ${day} ${e.job || '—'} (${e.reviewer} reviewed, ${e.role}, ${e.tier ?? 'standard'}/${e.size}): ${e.text}`);
    }
    if (s.consolidate) lines.push('Summary is due: rewrite it from the evidence.');
    return lines.join('\n\n');
  }).join('\n\n');
}
