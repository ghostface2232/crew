import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { LEAD } from './config.ts';
import type { Holder } from './config.ts';
import { TIERS } from './tiers.ts';
import type { Tier } from './tiers.ts';
import { clip } from './text.ts';

// A build line's finding load: the accepted findings by severity.
const LOAD = { high: 0.35, medium: 0.15, low: 0.05 };
// Exposure units of a change, so a large change may carry more findings than a small one. Chosen units, not a measured
// size. Tier is not used: for Codex it picks the model, so it would act as a fixed bonus per model.
const EXPOSURE = { small: 0.5, medium: 1, large: 2, xlarge: 4 };
// The build fit's priors, on the log of the finding rate. A builder starts at the reference rate (7.0), not at the
// others' average, so a model has to show its work to rise, and moves about ±0.5 from it on evidence. A review kind may
// find about twice or half as much as the average review. Hard work is expected to draw twice the findings of standard
// work and routine work half, and the data may move either by about ±0.4. Each review beyond the first starts as
// adding nothing.
const BUILD_PRIOR = { builder: 0.5, review: 0.7, difficulty: 0.4, extraReview: 0.4 };
// How tightly the average build line's review is held at zero, so a builder's term is its rate under that review.
const LEVEL_PRECISION = 1e4;
const DIFFICULTY_START = { routine: Math.log(0.5), hard: Math.log(2) };
// A model's routine lines together weigh at most this many lines, however many there are: wording, comments, and
// other mechanical edits say little about how a model builds, so a long run of them cannot carry a score far.
const ROUTINE_LINES = 2;
// A fix line's quality by outcome, lowered by the findings the check of the fix raised.
const FIX_QUALITY = { 'root-cause': 1, patch: 0.55, 'another-review': 0.25 };
// Where a model starts with nothing to compare: a build rate of one high per medium change (7.0), a fix quality of 0.7.
const REFERENCE = { build: 0.36, fix: 0.7 };
// The start weighs as much as three fixes of the model's own.
const PRIOR_WEIGHT = 3;
// A review by the builder's own agent counts half.
const SELF_REVIEW = 0.5;
// A lead's adoption of a delegated job as how well the work followed its brief.
const BRIEF = { 'as-is': 1, 'after-reply': 0.7, partly: 0.4, rejected: 0 };
// Where an item starts with nothing observed: brief as merged after one reply, findings as a little over half
// accepted, and report, which has ratings only, where a build starts.
const ITEM_REFERENCE = { brief: 0.7, findings: 0.6, report: 0.7 };
// The start for a reviewer's findings weighs as much as one high and one medium finding.
const FINDINGS_PRIOR = 0.5;
// Peer ratings run from 1 to 5, and move an item from where its evidence put it: neutral leaves it there, all fives
// would take it to the top and all ones to zero. Half of the item moves with them and half stays: the user's choice.
const NEUTRAL = 3;
const PEER_SHARE = 0.5;
// Fewer ratings than this do not move an item: one or two are an anecdote.
export const MIN_RATINGS = 3;
// A rater's mean over the other models is taken off its ratings, drawn toward neutral by one rating; a model's mean
// rating is drawn toward neutral by two, so one rating decides nothing.
const RATER_PRIOR = 1;
const RATING_PRIOR = 2;
// A builder rating the review of its own work has a stake in it.
const BUILDER_RATING = 0.5;
// Work with an accepted high finding is not rated above neutral for correctness, whatever its rater said.
const HIGH_FINDING_CAP = 3;
// Ten new evidence lines call for a new prose summary.
export const CONSOLIDATE_AFTER = 10;

export type NoteRole = 'build' | 'fix' | 'review';
export type FixOutcome = 'root-cause' | 'patch' | 'another-review';
export type ChangeSize = 'small' | 'medium' | 'large' | 'xlarge';
export type Adoption = 'as-is' | 'after-reply' | 'partly' | 'rejected';
/** How hard a piece of work was, set when it was handed out rather than after its review, so a result cannot change it. */
export type Difficulty = 'routine' | 'standard' | 'hard';
export const NOTE_ROLES = ['build', 'fix', 'review'] as const;
export const FIX_OUTCOMES = ['root-cause', 'patch', 'another-review'] as const;
export const CHANGE_SIZES = ['small', 'medium', 'large', 'xlarge'] as const;
export const ADOPTIONS = ['as-is', 'after-reply', 'partly', 'rejected'] as const;
export const DIFFICULTIES = ['routine', 'standard', 'hard'] as const;
// A build line names at most this many reviews of its work.
export const MAX_REVIEWS = 10;
/** What a peer rates, each from 1 to 5: the work's correctness, how it followed its brief, how honest its report was, and how useful a review's findings were. */
export const RATING_ITEMS = ['correctness', 'brief', 'report', 'findings'] as const;
// The anchors for correctness and findings, shared by the lead and the workers so all rate on one scale. A merge
// blocker caps correctness at 3, as an accepted high finding does (HIGH_FINDING_CAP).
export const CORRECTNESS_SCALE = '5: no findings, or minor ones only. 4: real findings, none blocking the merge. 3: something must be fixed before merging, but the core of the work is right. 2: a merge blocker in the core of the work. 1: wrong in its main path';
export const FINDINGS_SCALE = '1: wrong, or noise. 3: real but minor. 5: caught what would have shipped broken';
export type RatingItem = (typeof RATING_ITEMS)[number];
export type RatingItems = Partial<Record<RatingItem, number>>;
/**
 * The items each kind of line or job may rate: the lead rates a builder or fixer and a review; a reviewer the work it
 * read; a builder the review it got back. A fix has no correctness: that item is the build score's, and how a fix went
 * is its outcome.
 */
export const LEAD_ITEMS: Record<NoteRole, readonly RatingItem[]> = { build: ['correctness', 'brief', 'report'], fix: ['brief', 'report'], review: ['findings'] };
export const WORKER_ITEMS = { review: ['correctness', 'report'], delegate: ['findings'] } as const satisfies Record<string, readonly RatingItem[]>;
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
  /** For a build line: how hard the work was, as set when it was handed out. A line without one counts as standard. */
  difficulty?: Difficulty;
  /** For a build line: the model of each review its accepted findings came from, the lead reading a worker's diff included. */
  reviewedBy?: string[];
  /** For a review line: the work it reviewed, by its job when a worker built it; `fix` when that job was a fix. */
  of?: { job?: string; model: string; fix?: true };
  /** The lead's rating of this line's work, resting on `text`. Only a job's work is rated, never the lead's own. */
  rating?: RatingItems;
  text: string;
}
/**
 * A worker's rating of work it saw in its job, given in the turn it saw it. It names no target: a reviewer's goes to
 * the work its review line names, a builder's to the reviews of its job, so it counts once the lead notes the review.
 */
export interface Rating { id: string; at: number; by: Holder; byModel?: string; byJob: string; items: RatingItems; fact: string }
export interface ModelNote { model: string; agent: Holder; summary: string; summaryAt: number | null; evidence: Evidence[] }
export interface NotesFile { version: 2; models: Record<string, ModelNote>; ratings: Rating[] }
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
  reviewSamples: number;
  /** Each item out of 10, from the observed evidence and the peer ratings together; null with neither. `score` is correctness. */
  items: Record<RatingItem, number | null>;
  /** Peer ratings that moved an item: those of items with enough of them. */
  ratings: number;
  status: NoteStatus;
  summary: string;
  lastAt: number | null;
  consolidate: boolean;
  /** Build lines by how hard their work was; a line without a difficulty counts as standard, as the score takes it. */
  difficulty: Record<Difficulty, number>;
  /** Delegated builds by how the lead took them, or null when none says. */
  adoption: { judged: number; asIs: number; afterReply: number; partly: number; rejected: number; rounds: number } | null;
}
export const notesFile = (home: string) => path.join(home, 'model-notes.json');

export function loadNotes(home: string): NotesFile {
  const file = notesFile(home);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Version 1 had no ratings and no review lines; its lines are read as they are.
    if (!saved || ![1, 2].includes(saved.version) || !saved.models || typeof saved.models !== 'object' || Array.isArray(saved.models)) throw new Error('Expected version 1 or 2 and a models object.');
    return { version: 2, models: wellFormed(saved.models), ratings: wellRated(saved.ratings) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 2, models: {}, ratings: [] };
    throw new Error(`Could not load ${file}: ${(err as Error).message}`);
  }
}

const HOLDERS = ['codex', 'antigravity', 'claude'];
const rated = (items: any, allowed: readonly string[]) => items && typeof items === 'object' && !Array.isArray(items) && Object.keys(items).length > 0
  && Object.entries(items).every(([item, value]) => allowed.includes(item) && Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5);
const wellRated = (ratings: unknown): Rating[] => (Array.isArray(ratings) ? ratings : []).filter((r: any) => r && typeof r.id === 'string' && Number.isFinite(r.at) && HOLDERS.includes(r.by)
  && (r.byModel === undefined || typeof r.byModel === 'string') && typeof r.byJob === 'string' && r.byJob && rated(r.items, RATING_ITEMS) && typeof r.fact === 'string' && r.fact.trim() !== '');
const reviewModels = (list: unknown) => Array.isArray(list) && list.length > 0 && list.length <= MAX_REVIEWS && list.every((m) => typeof m === 'string' && m.trim() !== '');
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
      && (e.role !== 'fix' || FIX_OUTCOMES.includes(e.outcome)) && typeof e.text === 'string'
      && (e.of === undefined || (e.role === 'review' && e.of !== null && typeof e.of === 'object' && typeof e.of.model === 'string' && e.of.model !== '' && (e.of.job === undefined || typeof e.of.job === 'string') && (e.of.fix === undefined || e.of.fix === true)))
      && (e.rating === undefined || (typeof e.job === 'string' && e.job !== '' && rated(e.rating, LEAD_ITEMS[e.role as NoteRole])))
      && counts(e.findings) && (e.declined === undefined || counts(e.declined))
      && (e.adoption === undefined || (e.role === 'build' && typeof e.job === 'string' && e.job && ADOPTIONS.includes(e.adoption)))
      && (e.rounds === undefined || (e.adoption !== undefined && Number.isInteger(e.rounds) && e.rounds >= 0))
      && (e.difficulty === undefined || (e.role === 'build' && DIFFICULTIES.includes(e.difficulty)))
      && (e.reviewedBy === undefined || (e.role === 'build' && reviewModels(e.reviewedBy))));
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
const given = (ratings: unknown) => (Array.isArray(ratings) ? ratings.length : 0);

/** Loading skips what it cannot read, so a save would erase it; keep the file as it was first. */
function keepDropped(target: string): void {
  let saved: { version?: unknown; ratings?: unknown };
  let dropped: boolean;
  try {
    saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    const { models } = saved as { models: Record<string, any> };
    dropped = lines(wellFormed(models)) < lines(models) || wellRated(saved.ratings).length < given(saved.ratings);
  } catch { return; /* Nothing to keep: no file yet, or one loadNotes already refuses. */ }
  // A failed copy must stop the save, or the lines are lost with no copy.
  if (dropped) fs.copyFileSync(target, `${target}.dropped-${Date.now()}`);
  // An older daemon cannot read what this one writes, so the file it could read is kept once.
  if (saved.version === 1 && !fs.existsSync(`${target}.v1`)) fs.copyFileSync(target, `${target}.v1`);
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
  const text = clip((oneLine ? value.replace(/[\r\n]+/g, ' ') : value).trim(), limit).trim();
  if (!text) throw new Error(`${name} must be a non-empty string.`);
  return text;
}

export function addEvidence(home: string, input: Omit<Evidence, 'id' | 'at'> & { at?: number }, options: { ratings?: boolean } = {}): { evidence: Evidence; score: ModelScore } {
  // Every problem goes in one error with the values allowed, so a caller can correct the whole call in one retry.
  const problems: string[] = [];
  const check = (ok: boolean, problem: string) => { if (!ok) problems.push(problem); };
  const nonEmpty = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const oneOf = (values: readonly string[]) => `one of ${values.join(', ')}`;
  check(nonEmpty(input.model), 'model (the exact model id)');
  for (const key of ['agent', 'reviewer'] as const) check(HOLDERS.includes(input[key]), `${key} (${oneOf(HOLDERS)})`);
  check(CHANGE_SIZES.includes(input.size), `size (${oneOf(CHANGE_SIZES)})`);
  check(NOTE_ROLES.includes(input.role), `role (${oneOf(NOTE_ROLES)})`);
  check(input.tier === undefined || TIERS.includes(input.tier), `tier (${oneOf(TIERS)})`);
  if (input.role === 'fix') check(FIX_OUTCOMES.includes(input.outcome!), `outcome (required for fix: ${oneOf(FIX_OUTCOMES)})`);
  if (input.role !== 'fix') check(input.outcome === undefined, `outcome (only for fix; leave it out for ${input.role})`);
  // A review line without `of` is an audit: code as it stood, by several builders, so no one's work to name.
  if (input.role === 'review') check(input.of === undefined || nonEmpty(input.of.model), 'of (the work the review covered: of_job, or of_model for work done in your session)');
  else check(input.of === undefined, 'of (only for a review line)');
  if (input.rating !== undefined) {
    const allowed = LEAD_ITEMS[input.role] ?? [];
    check(Boolean(input.job), 'rating (only for a job\'s work, with job_id; your own work is rated by its reviewer)');
    check(rated(input.rating, allowed), `rating (${allowed.join(', ')} for ${input.role}, each a whole number from 1 to 5)`);
  }
  check(input.adoption === undefined || (input.role === 'build' && Boolean(input.job) && ADOPTIONS.includes(input.adoption)), `adoption (only for a delegated job's build line: ${oneOf(ADOPTIONS)})`);
  check(input.rounds === undefined || (input.adoption !== undefined && Number.isInteger(input.rounds) && input.rounds >= 0), 'rounds (a non-negative integer, given with adoption)');
  check(input.difficulty === undefined || (input.role === 'build' && DIFFICULTIES.includes(input.difficulty)), `difficulty (only for a build line: ${oneOf(DIFFICULTIES)})`);
  check(input.reviewedBy === undefined || (input.role === 'build' && reviewModels(input.reviewedBy)), `reviewed_by (only for a build line: 1 to ${MAX_REVIEWS} model ids, one per review)`);
  const counted = (given: Partial<Findings> | undefined, name: string): Findings => {
    const result = {} as Findings;
    for (const key of ['high', 'medium', 'low'] as const) {
      const count = given?.[key] === undefined ? 0 : given[key];
      check(Number.isInteger(count) && count >= 0, `${name}.${key} (a non-negative integer)`);
      result[key] = count as number;
    }
    return result;
  };
  const findings = counted(input.findings, 'findings');
  const declined = input.declined === undefined ? undefined : counted(input.declined, 'declined');
  check(nonEmpty(input.text), 'text (one line of facts from the review)');
  const at = input.at ?? Date.now();
  check(Number.isFinite(at), 'at (a finite timestamp)');
  if (problems.length) throw new Error(`Missing or invalid: ${problems.join('; ')}.`);
  const model = cleanText(input.model, 'model', Infinity);
  const text = cleanText(input.text, 'text', 300, true);
  const file = loadNotes(home);
  const existing = Object.hasOwn(file.models, model) ? file.models[model] : undefined;
  if (existing && existing.agent !== input.agent) throw new Error(`Model ${model} already belongs to agent ${existing.agent}.`);
  const note = existing ?? { model, agent: input.agent, summary: '', summaryAt: null, evidence: [] };
  let id: string;
  const ids = new Set(Object.values(file.models).flatMap((m) => m.evidence.map((e) => e.id)));
  do { id = `ev-${randomBytes(3).toString('hex')}`; } while (ids.has(id));
  const evidence: Evidence = { ...input, model, findings, ...(declined ? { declined } : {}), ...(input.reviewedBy ? { reviewedBy: input.reviewedBy.map((m) => m.trim()) } : {}), text, id, at };
  if (input.of) evidence.of = { ...(input.of.job ? { job: input.of.job } : {}), model: input.of.model.trim(), ...(input.of.fix ? { fix: true } : {}) };
  // Noting a job again (a retried call, a resumed session, a model the session reported later) replaces its line
  // rather than counting the job twice; the line moves to the model named now, and a model it leaves empty goes.
  if (input.job) for (const other of Object.values(file.models)) {
    // The lead's rating of the job stays with it when a later note of the same line brings none.
    const earlier = other.evidence.find((e) => e.job === input.job && e.role === input.role)?.rating;
    if (earlier && !evidence.rating) evidence.rating = earlier;
    const before = other.evidence.length;
    other.evidence = other.evidence.filter((e) => !(e.job === input.job && e.role === input.role));
    if (before && !other.evidence.length && other !== existing) delete file.models[other.model];
  }
  note.evidence.push(evidence);
  Object.defineProperty(file.models, model, { value: note, enumerable: true, configurable: true, writable: true });
  save(home, file);
  return { evidence, score: scoreAll(file, options).find((s) => s.model === model)! };
}

/** Keeps a worker's rating of what it saw in its job. Rating again replaces the job's earlier one. */
export function addRating(home: string, input: Omit<Rating, 'id' | 'at'> & { at?: number }, allowed: readonly RatingItem[] = RATING_ITEMS): Rating {
  const problems: string[] = [];
  if (!HOLDERS.includes(input.by)) problems.push(`by (one of ${HOLDERS.join(', ')})`);
  if (typeof input.byJob !== 'string' || !input.byJob) problems.push('byJob (the job that rates)');
  if (!rated(input.items, allowed)) problems.push(`at least one of ${allowed.join(', ')}, each a whole number from 1 to 5`);
  if (typeof input.fact !== 'string' || !input.fact.trim()) problems.push('fact (one line from the work that the numbers rest on)');
  const at = input.at ?? Date.now();
  if (!Number.isFinite(at)) problems.push('at (a finite timestamp)');
  if (problems.length) throw new Error(`Missing or invalid: ${problems.join('; ')}.`);
  const file = loadNotes(home);
  let id: string;
  const ids = new Set(file.ratings.map((r) => r.id));
  do { id = `rt-${randomBytes(3).toString('hex')}`; } while (ids.has(id));
  const rating: Rating = { id, at, by: input.by, ...(input.byModel ? { byModel: input.byModel } : {}), byJob: input.byJob, items: { ...input.items }, fact: cleanText(input.fact, 'fact', 300, true) };
  file.ratings = [...file.ratings.filter((r) => r.byJob !== input.byJob), rating];
  save(home, file);
  return rating;
}

export function setSummary(home: string, model: string, summary: string, at = Date.now(), options: { ratings?: boolean } = {}): ModelScore {
  const file = loadNotes(home);
  if (!Object.hasOwn(file.models, model)) throw new Error(`Unknown model ${model}.`);
  if (!Number.isFinite(at)) throw new Error('at must be a finite timestamp.');
  file.models[model].summary = cleanText(summary, 'summary', 1200);
  file.models[model].summaryAt = at;
  save(home, file);
  return scoreAll(file, options).find((s) => s.model === model)!;
}

const load = (f: Findings) => LOAD.high * f.high + LOAD.medium * f.medium + LOAD.low * f.low;
const weight = (e: Evidence) => (e.reviewer === e.agent ? SELF_REVIEW : 1);
/** Fix evidence as mean quality over lines. */
function sums(lines: Evidence[]): { num: number; den: number } {
  let num = 0, den = 0;
  for (const e of lines) { const w = weight(e); num += w * FIX_QUALITY[e.outcome!] * Math.exp(-load(e.findings)); den += w; }
  return { num, den };
}
const shrink = (s: { num: number; den: number }, prior: number) => (s.num + PRIOR_WEIGHT * prior) / (s.den + PRIOR_WEIGHT);

/**
 * What kind of review a build line's findings came from. Reviews differ in how much they find: a dedicated cross-review
 * by a strong model finds far more than the lead reading a worker's diff, so the same work reads as worse the harder
 * it is reviewed. The kind is the model of the first review by another agent than the builder's (or of the first
 * review, when all are its own agent's), marked when that is the builder's own agent. Older lines without models fall
 * back to the reviewer's agent and whether it reviewed a worker's job or the lead's own work.
 */
export function reviewKind(e: Evidence, agentOf: (model: string) => Holder | undefined): { kind: string; extra: number } {
  if (!e.reviewedBy) return { kind: `${e.reviewer} ${e.reviewer === e.agent ? 'self-review' : e.job ? 'review of a job' : 'cross-review'}`, extra: 0 };
  const own = (m: string) => m === e.model || agentOf(m) === e.agent;
  const first = e.reviewedBy.find((m) => !own(m)) ?? e.reviewedBy[0];
  return { kind: own(first) ? `${first} (own agent)` : first, extra: e.reviewedBy.length - 1 };
}

/**
 * Each builder's finding rate at standard difficulty under an average review, from a Poisson model of every build
 * line's finding load: exposure × exp(builder + review kind + difficulty + extra reviews), each term drawn toward its
 * start (BUILD_PRIOR). Fitting them together is what lets a model that takes hard work under strict
 * review be compared with one that takes routine work under a light one. A line weighs by the findings expected of it,
 * so clean routine work says little and clean hard work says much. Self-reviews count half.
 */
function buildRates(file: NotesFile): Map<string, number> {
  const agentOf = (model: string) => (Object.hasOwn(file.models, model) ? file.models[model].agent : undefined);
  // A line belongs to the model whose notes hold it.
  const lines = Object.values(file.models).flatMap((m) => m.evidence.filter((e) => e.role === 'build').map((e) => ({ ...e, model: m.model })));
  if (!lines.length) return new Map();
  const names: string[] = [];
  const means: number[] = [];
  const precisions: number[] = [];
  const index = new Map<string, number>();
  const param = (name: string, mean: number, sd: number) => {
    if (!index.has(name)) { index.set(name, names.length); names.push(name); means.push(mean); precisions.push(1 / (sd * sd)); }
    return index.get(name)!;
  };
  const kinds = lines.map((e) => reviewKind(e, agentOf));
  const routine = new Map<string, number>();
  for (const e of lines) if (e.difficulty === 'routine') routine.set(e.model, (routine.get(e.model) ?? 0) + 1);
  const extra = param('extra review', 0, BUILD_PRIOR.extraReview);
  const rows = lines.map((e, i) => {
    const terms = [param(`builder ${e.model}`, Math.log(REFERENCE.build / LOAD.medium), BUILD_PRIOR.builder), param(`review ${kinds[i].kind}`, 0, BUILD_PRIOR.review)];
    const difficulty = e.difficulty ?? 'standard';
    if (difficulty !== 'standard') terms.push(param(`difficulty ${difficulty}`, DIFFICULTY_START[difficulty], BUILD_PRIOR.difficulty));
    // Counted in medium findings, so the Poisson weight of a line is on the scale of a count.
    const share = difficulty === 'routine' ? Math.min(1, ROUTINE_LINES / routine.get(e.model)!) : 1;
    return { terms, extra: kinds[i].extra, y: load(e.findings) / LOAD.medium, exposure: EXPOSURE[e.size], w: weight(e) * share };
  });
  const theta = means.slice();
  // The review of the average build line, weighed as the fit weighs lines, is held at zero: a builder's own term is
  // then its rate under that review, so neither its own reviews nor a run of routine lines moves where it is read.
  const total = rows.reduce((s, r) => s + r.w, 0);
  const average = new Array<number>(theta.length).fill(0);
  for (const r of rows) { average[r.terms[1]] += r.w / total; average[extra] += r.w * r.extra / total; }
  // Newton's method on the log posterior, which is strictly concave with every term drawn toward a start.
  for (let step = 0; step < 100; step++) {
    const level = average.reduce((s, a, j) => s + a * theta[j], 0);
    const gradient = theta.map((t, j) => -(t - means[j]) * precisions[j] - LEVEL_PRECISION * average[j] * level);
    const hessian = theta.map((_, j) => theta.map((__, k) => (j === k ? precisions[j] : 0) + LEVEL_PRECISION * average[j] * average[k]));
    for (const r of rows) {
      const mu = r.exposure * Math.exp(r.terms.reduce((s, j) => s + theta[j], 0) + r.extra * theta[extra]);
      const x = new Map<number, number>(r.terms.map((j) => [j, 1]));
      if (r.extra) x.set(extra, r.extra);
      for (const [j, xj] of x) {
        gradient[j] += r.w * (r.y - mu) * xj;
        for (const [k, xk] of x) hessian[j][k] += r.w * mu * xj * xk;
      }
    }
    const delta = solve(hessian, gradient);
    // Counts past any real review (around 1e17 findings on a line) leave the system too ill-conditioned to solve;
    // the last finite estimate stands rather than turning every model's score into NaN.
    if (!delta.every(Number.isFinite)) break;
    // A full step from far off can overshoot into overflow; one of at most 1 per term keeps every rate finite.
    const largest = Math.max(...delta.map(Math.abs));
    const scale = Math.min(1, 1 / largest);
    delta.forEach((d, j) => { theta[j] += scale * d; });
    if (largest < 1e-10) break;
  }
  const level = average.reduce((s, a, j) => s + a * theta[j], 0);
  return new Map([...index].filter(([name]) => name.startsWith('builder ')).map(([name, j]) => [name.slice('builder '.length), LOAD.medium * Math.exp(theta[j] + level)]));
}

/** Solves a small symmetric positive definite system by Gaussian elimination. */
function solve(matrix: number[][], vector: number[]): number[] {
  const n = vector.length;
  const m = matrix.map((row, i) => [...row, vector[i]]);
  for (let i = 0; i < n; i++) {
    for (let r = i + 1; r < n; r++) {
      const f = m[r][i] / m[i][i];
      for (let c = i; c <= n; c++) m[r][c] -= f * m[i][c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let i = n - 1; i >= 0; i--) {
    let sum = m[i][n];
    for (let c = i + 1; c < n; c++) sum -= m[i][c] * x[c];
    x[i] = sum / m[i][i];
  }
  return x;
}

/** One rating of one item, with whom it is about. `source` is the rating it came from, which may reach several models. */
interface Vote { model: string; item: RatingItem; value: number; rater: string; weight: number; source: string; routine?: true; share?: number }
/**
 * Every rating as votes on the models they are about. The lead's ride on its lines. A worker's names no target, so the
 * review lines give it one: a reviewer's rating is of the work its line names, a builder's of the reviews of its job.
 * A builder cannot say which review it means, so each model that reviewed its job gets the rating, once.
 */
function votes(file: NotesFile): Vote[] {
  const all = Object.values(file.models).flatMap((m) => m.evidence);
  const agentOf = (model: string) => (Object.hasOwn(file.models, model) ? file.models[model].agent : undefined);
  const reviews = all.filter((e) => e.role === 'review');
  // A job's work belongs to the model its build line is under now, which a later note may have moved.
  const builders = new Map(all.filter((e) => e.role === 'build' && e.job).map((e) => [e.job!, e.model]));
  // Flawed work: an accepted high finding on its build line, or on a review of it.
  // Routine work, by its build line, so a rating of it is capped as the line is.
  const routine = new Set(all.filter((e) => e.role === 'build' && e.job && e.difficulty === 'routine').map((e) => e.job!));
  const flawed = new Set([...all.filter((e) => e.role === 'build' && e.job && e.findings.high > 0).map((e) => e.job!),
    ...reviews.filter((e) => e.of?.job && e.findings.high > 0).map((e) => e.of!.job!)]);
  const out: Vote[] = [];
  const seen = new Set<string>();
  const cast = (model: string, items: RatingItems, by: Holder, rater: string, source: string, weight: number, capped: boolean, easy = false) => {
    for (const item of RATING_ITEMS) {
      const key = `${source}\0${model}\0${item}`;
      if (items[item] === undefined || seen.has(key)) continue;
      seen.add(key);
      // The cap is the rating's value from here on, so capped work does not make its rater look generous either.
      const value = item === 'correctness' && capped ? Math.min(items[item], HIGH_FINDING_CAP) : items[item];
      out.push({ model, item, value, rater, source, weight: weight * (agentOf(model) === by ? SELF_REVIEW : 1), ...(easy && item === 'correctness' ? { routine: true as const } : {}) });
    }
  };
  for (const e of all) if (e.rating) cast(e.model, e.rating, LEAD, LEAD, e.id, 1, Boolean(e.job && flawed.has(e.job)), e.role === 'build' && e.difficulty === 'routine');
  for (const r of file.ratings) {
    const rater = r.byModel ?? r.by;
    const { findings, correctness, ...rest } = r.items;
    for (const line of reviews) {
      const job = line.of?.job;
      // An audit names no builder, so what its reviewer made of the code is a rating of no one.
      if (line.job === r.byJob && line.of) {
        // Correctness is the build score's item: a review of a fix says nothing about how its model builds.
        const work = correctness === undefined || line.of.fix ? rest : { ...rest, correctness };
        cast((job && builders.get(job)) ?? line.of.model, work, r.by, rater, r.id, 1, line.findings.high > 0 || Boolean(job && flawed.has(job)), Boolean(job && routine.has(job)));
      }
      if (findings !== undefined && job === r.byJob) cast(line.model, { findings }, r.by, rater, r.id, BUILDER_RATING, false);
    }
  }
  // A model's correctness ratings of routine work together weigh at most ROUTINE_LINES ratings, as its routine lines
  // do in the build score: work with little to get wrong rates five almost always, and would otherwise carry the score.
  const easy = new Map<string, number>();
  for (const v of out) if (v.routine) easy.set(v.model, (easy.get(v.model) ?? 0) + 1);
  // They count toward MIN_RATINGS by the same share, so a few of them alone do not let ratings move the score.
  for (const v of out) if (v.routine) { v.share = Math.min(1, ROUTINE_LINES / easy.get(v.model)!); v.weight *= v.share; }
  return out;
}

/**
 * How far each model's ratings sit from neutral per item, from −1 (all ones) to 1 (all fives), with how many ratings
 * that rests on. A rating is read against how its rater rates other models on the item: that mean, drawn toward
 * neutral, is taken off, so a rater that gives everyone five moves nobody much. It only ever brings a rating toward
 * neutral, never past it, and a model's own ratings are left out of it, so a further good rating never lowers the
 * model it is given to, and a rating elsewhere never turns a neutral one into a mark against.
 */
function peers(all: Vote[]): Map<string, { shift: number; count: number }> {
  // Per rater and item, each rating with every model it reached: it is one rating of its rater's however many it
  // reached, and it is a rating of each of them, so none of them reads it as a rating of another model.
  const raters = new Map<string, Map<string, Map<string, number>>>();
  for (const v of all) {
    const sources = raters.get(`${v.rater}\0${v.item}`) ?? new Map<string, Map<string, number>>();
    sources.set(v.source, (sources.get(v.source) ?? new Map<string, number>()).set(v.model, v.value));
    raters.set(`${v.rater}\0${v.item}`, sources);
  }
  const lean = (v: Vote) => {
    let sum = 0, n = 0;
    for (const targets of raters.get(`${v.rater}\0${v.item}`)!.values()) {
      if (targets.has(v.model)) continue;
      sum += [...targets.values()].reduce((a, b) => a + b, 0) / targets.size;
      n += 1;
    }
    return (sum + RATER_PRIOR * NEUTRAL) / (n + RATER_PRIOR) - NEUTRAL;
  };
  const sums = new Map<string, { num: number; den: number; count: number }>();
  for (const v of all) {
    const off = v.value - NEUTRAL;
    const value = NEUTRAL + (off > 0 ? Math.max(0, off - Math.max(0, lean(v))) : Math.min(0, off - Math.min(0, lean(v))));
    const key = `${v.model}\0${v.item}`;
    const s = sums.get(key) ?? { num: 0, den: 0, count: 0 };
    sums.set(key, { num: s.num + v.weight * value, den: s.den + v.weight, count: s.count + (v.share ?? 1) });
  }
  return new Map([...sums].map(([key, s]) => [key, { shift: ((s.num + RATING_PRIOR * NEUTRAL) / (s.den + RATING_PRIOR) - NEUTRAL) / 2, count: s.count }]));
}
/** Where ratings alone would put a value: all fives at the top, all ones at zero, neutral where it was. */
const moved = (base: number, shift: number) => (shift >= 0 ? base + shift * (1 - base) : base * (1 + shift));

/**
 * Scores each model per role. Build: each model's finding rate from `buildRates`, shown as 10·exp(−rate), so more
 * findings always cost more and nothing is clamped. Fix: mean quality, drawn toward the mean of the other models' own
 * (each counted once, so a busy model cannot set everyone's start) and the reference, which counts as one more model.
 * Fix is shown beside build, never pooled.
 *
 * The four items lay the peer ratings over that evidence. Correctness is the build score, brief the lead's adoption of
 * delegated work, findings the share of a reviewer's finding load the lead accepted; report has ratings only, around a
 * reference. Ratings count only from MIN_RATINGS on, and then move half of the item (PEER_SHARE) from where the
 * evidence put it, so neutral ratings change nothing and good ones never lower it. `score` is correctness, which
 * ratings cannot give a model with no build: with `ratings` off, or too few given, it is the build score.
 */
export function scoreAll(file: NotesFile, options: { ratings?: boolean } = {}): ModelScore[] {
  const models = Object.values(file.models);
  const peer = peers(options.ratings === false ? [] : votes(file));
  const roleLines = (m: ModelNote, role: NoteRole) => m.evidence.filter((e) => e.role === role);
  const fixes = new Map(models.filter((m) => roleLines(m, 'fix').length).map((m) => [m.model, sums(roleLines(m, 'fix'))]));
  /** A model's fix quality, unrounded, or null with no fix lines: drawn toward the mean of the other models' own. */
  function fixQuality(model: string): number | null {
    const mine = fixes.get(model);
    if (!mine) return null;
    const others = [...fixes].filter(([name]) => name !== model).map(([, s]) => shrink(s, REFERENCE.fix));
    const start = (others.reduce((sum, v) => sum + v, 0) + REFERENCE.fix) / (others.length + 1);
    return shrink(mine, start);
  }
  const tenth = (n: number) => Math.round(n * 10) / 10;
  const fitted = buildRates(file);
  const rates = new Map<string, number | null>(models.map((m) => [m.model, fitted.get(m.model) ?? null]));
  const enough = (model: string, name: RatingItem) => { const given = peer.get(`${model}\0${name}`); return given && given.count >= MIN_RATINGS ? given : undefined; };
  /** An item from 0 to 1: its evidence, moved by its ratings once there are enough; without evidence, its reference moved by them. */
  const item = (model: string, name: RatingItem, observed: number | null): number | null => {
    const shift = enough(model, name)?.shift;
    if (shift === undefined) return observed;
    if (observed !== null) return observed + PEER_SHARE * (moved(observed, shift) - observed);
    return name === 'correctness' ? null : moved(ITEM_REFERENCE[name], shift);
  };
  const correctness = new Map<string, number | null>(models.map((m) => {
    const rate = rates.get(m.model)!;
    return [m.model, item(m.model, 'correctness', rate === null ? null : Math.exp(-rate))];
  }));
  const group = (s: ModelScore) => (s.score !== null ? (s.status === 'too few samples' ? 1 : 0) : s.samples ? 2 : 3);
  // The rate breaks a tie the score cannot: past a few hundred findings every score is zero.
  const byScore = (a: ModelScore, b: ModelScore) => (correctness.get(b.model) ?? 0) - (correctness.get(a.model) ?? 0) || (rates.get(a.model) ?? 0) - (rates.get(b.model) ?? 0);
  return models.map((m): ModelScore => {
    const build = roleLines(m, 'build');
    const fix = roleLines(m, 'fix');
    const review = m.evidence.filter((e) => e.role === 'review');
    const rate = rates.get(m.model)!;
    const quality = fixQuality(m.model);
    // Status counts build reviews, a self-review as half, since only build sets the score; routine lines count as
    // they weigh in the score, so a run of them alone never settles a model.
    const routine = build.filter((e) => e.difficulty === 'routine').length;
    const reviews = build.reduce((sum, e) => sum + weight(e) * (e.difficulty === 'routine' ? Math.min(1, ROUTINE_LINES / routine) : 1), 0);
    const samples = m.evidence.length;
    const buildScore = rate === null ? null : tenth(10 * Math.exp(-rate));
    const adopted = build.filter((e) => e.adoption);
    const taken = (a: Adoption) => adopted.filter((e) => e.adoption === a).length;
    const accepted = review.reduce((sum, e) => sum + load(e.findings), 0);
    const raised = accepted + review.reduce((sum, e) => sum + (e.declined ? load(e.declined) : 0), 0);
    const outOfTen = (value: number | null) => (value === null ? null : tenth(10 * value));
    const items = {
      correctness: outOfTen(correctness.get(m.model)!),
      brief: outOfTen(item(m.model, 'brief', adopted.length ? shrink({ num: adopted.reduce((sum, e) => sum + BRIEF[e.adoption!], 0), den: adopted.length }, ITEM_REFERENCE.brief) : null)),
      report: outOfTen(item(m.model, 'report', null)),
      // A review that raised nothing says nothing about its findings.
      findings: outOfTen(item(m.model, 'findings', raised ? (accepted + FINDINGS_PRIOR * ITEM_REFERENCE.findings) / (raised + FINDINGS_PRIOR) : null)),
    };
    return {
      model: m.model, agent: m.agent, score: items.correctness, build: buildScore, fix: quality === null ? null : tenth(10 * quality),
      samples, buildSamples: build.length, fixSamples: fix.length, reviewSamples: review.length, items,
      ratings: Math.round(RATING_ITEMS.reduce((sum, name) => sum + (enough(m.model, name)?.count ?? 0), 0)),
      status: reviews < 3 ? 'too few samples' : reviews < 8 ? 'on trial' : 'settled', summary: m.summary,
      difficulty: Object.fromEntries(DIFFICULTIES.map((d) => [d, build.filter((e) => (e.difficulty ?? 'standard') === d).length])) as Record<Difficulty, number>,
      lastAt: samples ? m.evidence.reduce((latest, e) => Math.max(latest, e.at), -Infinity) : null,
      consolidate: m.evidence.filter((e) => m.summaryAt === null || e.at > m.summaryAt).length >= CONSOLIDATE_AFTER,
      adoption: adopted.length ? {
        judged: adopted.length, asIs: taken('as-is'), afterReply: taken('after-reply'), partly: taken('partly'), rejected: taken('rejected'),
        rounds: adopted.reduce((sum, e) => sum + (e.rounds ?? 0), 0),
      } : null,
    };
  // Models with too few reviews come after every ranked one, whatever their score; then models with no build, and
  // last models with no lines. Within a group the unrounded score decides, so a tie on the shown score is not left to the name.
  }).sort((a, b) => group(a) - group(b) || byScore(a, b) || a.model.localeCompare(b.model));
}

export function renderNotes(scores: ModelScore[], file: NotesFile, options: { models?: string[]; agents?: Holder[]; evidence?: number } = {}): string {
  const number = (n: number | null) => n === null ? '—' : n.toFixed(1);
  const stars = (items: RatingItems) => RATING_ITEMS.filter((name) => items[name] !== undefined).map((name) => `${name} ${items[name]}`).join(' ');
  return scores.filter((s) => (!options.models || options.models.includes(s.model)) && (!options.agents || options.agents.includes(s.agent))).map((s) => {
    const lines = [`### ${s.model} (${s.agent}) — ${number(s.score)}/10, ${s.status}, ${s.buildSamples} build(s), ${s.fixSamples} fix(es)${s.reviewSamples ? `, ${s.reviewSamples} review(s)` : ''}`];
    if (s.build !== null || s.fix !== null) lines.push(`build ${number(s.build)} · fix ${number(s.fix)}`);
    const others = (['brief', 'report', 'findings'] as const).filter((name) => s.items[name] !== null);
    if (others.length) lines.push(`${others.map((name) => `${name} ${number(s.items[name])}`).join(' · ')}${s.ratings ? ` (${s.ratings} peer rating(s) counted)` : ''}`);
    // Scores are finding rates on the work each model was given; the tiers say what that work was.
    const tiers = new Map<string, number>();
    for (const e of file.models[s.model].evidence) if (e.role === 'build' && e.tier) tiers.set(e.tier, (tiers.get(e.tier) ?? 0) + 1);
    if (tiers.size) lines.push(`builds by tier: ${TIERS.filter((t) => tiers.has(t)).map((t) => `${t} ${tiers.get(t)}`).join(', ')}`);
    if (s.buildSamples) lines.push(`builds by difficulty: ${[...DIFFICULTIES].reverse().filter((d) => s.difficulty[d]).map((d) => `${d} ${s.difficulty[d]}`).join(', ')}`);
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
      const about = e.role !== 'review' ? `${e.reviewedBy ? e.reviewedBy.join(' + ') : e.reviewer} reviewed${e.difficulty ? `, ${e.difficulty}` : ''}` : e.of ? `reviewed ${e.of.job ?? e.of.model}` : 'audit';
      const rating = e.rating ? `, rated ${stars(e.rating)}` : '';
      lines.push(`- ${day} ${e.job || '—'} (${about}, ${e.role}, ${e.tier ? `${e.tier}/` : ''}${e.size}${declined}${adoption}${rating}): ${e.text}`);
    }
    if (s.consolidate) lines.push('Summary is due: rewrite it from the evidence.');
    return lines.join('\n\n');
  }).join('\n\n');
}
