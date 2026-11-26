import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { addEvidence, addRating, loadNotes, notesFile, renderNotes, reviewKind, scoreAll, setSummary, WORKER_ITEMS } from '../plugin/bridge/notes.ts';
import type { Evidence, NotesFile } from '../plugin/bridge/notes.ts';

const input: Omit<Evidence, 'id' | 'at'> = {
  model: 'model-a', agent: 'codex', reviewer: 'claude', role: 'build', size: 'medium',
  findings: { high: 0, medium: 0, low: 0 }, text: 'Clean review.',
};
function home(t: TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-notes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'home');
}
function fixture(lines: Partial<Evidence>[]): NotesFile {
  return { version: 2, ratings: [], models: { 'model-a': { model: 'model-a', agent: 'codex', summary: '', summaryAt: null,
    evidence: lines.map((e, i) => ({ ...input, id: `ev-${i}`, at: i, ...e })) } } };
}

test('round trip creates home and atomically replaces the file', (t) => {
  const dir = home(t);
  assert.deepEqual(loadNotes(dir), { version: 2, models: {}, ratings: [] });
  const { evidence, score } = addEvidence(dir, { ...input, at: 42, text: '  First\nsecond  ', findings: {} as Evidence['findings'] });
  assert.match(evidence.id, /^ev-[0-9a-f]{6}$/);
  assert.equal(evidence.at, 42);
  assert.equal(evidence.text, 'First second');
  assert.deepEqual(evidence.findings, { high: 0, medium: 0, low: 0 });
  assert.equal(score.score, 7.9);
  assert.deepEqual(loadNotes(dir).models['model-a'].evidence, [evidence]);
  addEvidence(dir, input);
  assert.equal(loadNotes(dir).models['model-a'].evidence.length, 2);
  assert.ok(fs.existsSync(notesFile(dir)));
  assert.equal(fs.existsSync(`${notesFile(dir)}.tmp`), false);
});

test('invalid evidence is refused without changing storage', (t) => {
  const dir = home(t);
  addEvidence(dir, input);
  const before = fs.readFileSync(notesFile(dir), 'utf8');
  const cases: [object, RegExp][] = [
    [{ role: 'fix' }, /outcome/], [{ outcome: 'patch' }, /outcome/],
    [{ role: 'fix', outcome: 'wrong' }, /outcome/], [{ agent: 'wrong' }, /agent/], [{ reviewer: 'wrong' }, /reviewer/],
    [{ findings: { high: -1 } }, /high/], [{ findings: { low: 0.5 } }, /low/], [{ findings: { medium: null } }, /medium/],
    [{ agent: 'claude' }, /already belongs/], [{ model: ' ' }, /model/], [{ text: ' ' }, /text/],
    [{ tier: 'wrong' }, /tier/], [{ size: 'wrong' }, /size/], [{ role: 'wrong' }, /role/], [{ at: NaN }, /timestamp/],
    [{ declined: { high: -1 } }, /declined\.high/], [{ declined: { low: 0.5 } }, /declined\.low/],
    [{ adoption: 'as-is' }, /delegated job/], [{ job: 'cx-1', adoption: 'merged' }, /delegated job/],
    [{ job: 'cx-1', role: 'fix', outcome: 'patch', adoption: 'as-is' }, /delegated job/],
    [{ job: 'cx-1', rounds: 1 }, /rounds/], [{ job: 'cx-1', adoption: 'as-is', rounds: -1 }, /rounds/],
  ];
  for (const [change, error] of cases) assert.throws(() => addEvidence(dir, { ...input, ...change }), error);
  // A call missing several fields is told all of them at once, with the values allowed.
  const { size, reviewer, text, ...partial } = input;
  assert.throws(() => addEvidence(dir, partial as typeof input),
    /^Error: Missing or invalid: reviewer \(one of codex, antigravity, claude\); size \(one of small, medium, large, xlarge\); text \(one line of facts from the review\)\.$/);
  assert.equal(fs.readFileSync(notesFile(dir), 'utf8'), before);
});

test('text limits and summaries are normalized and persisted', (t) => {
  const dir = home(t);
  assert.equal(addEvidence(dir, { ...input, text: 'x'.repeat(400) }).evidence.text.length, 300);
  assert.throws(() => setSummary(dir, 'unknown', 'summary'), /Unknown model/);
  assert.throws(() => setSummary(dir, input.model, ' '), /summary/);
  const score = setSummary(dir, input.model, `  ${'x'.repeat(1300)}  `, 100);
  assert.equal(score.summary.length, 1200);
  assert.equal(loadNotes(dir).models[input.model].summaryAt, 100);
});

test('corrupt JSON names the file and stays untouched', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir);
  fs.writeFileSync(notesFile(dir), '{broken');
  assert.throws(() => loadNotes(dir), (err: Error) => err.message.includes(notesFile(dir)));
  assert.equal(fs.readFileSync(notesFile(dir), 'utf8'), '{broken');
});

test('build scores a finding rate over exposure, with self-review weight and a prior, and no tier or clamp', () => {
  // A model starts at the reference rate 0.36 (7.0), whatever the others score; one clean review moves it up, a
  // self-review about half as far, and one high finding on a medium change is the reference itself.
  assert.equal(scoreAll(fixture([{}]))[0].score, 7.9);
  assert.equal(scoreAll(fixture([{ reviewer: 'codex' }]))[0].score, 7.5);
  assert.equal(scoreAll(fixture([{ findings: { high: 1, medium: 0, low: 0 } }]))[0].score, 7.0);
  // A large change has twice the exposure; the tier changes nothing.
  const large = scoreAll(fixture([{ size: 'large', findings: { high: 1, medium: 0, low: 0 } }]))[0].score;
  assert.equal(large, 7.7);
  for (const tier of ['fast', 'frontier'] as const) assert.equal(scoreAll(fixture([{ tier, size: 'large', findings: { high: 1, medium: 0, low: 0 } }]))[0].score, large);
  // Every further finding costs more: nothing is clamped.
  const highs = [3, 10, 100].map((high) => scoreAll(fixture([{ findings: { high, medium: 0, low: 0 } }]))[0].score!);
  assert.deepEqual(highs, [5.1, 0.9, 0]);
});

test('fix scores apart from build and never moves the score or the rank', () => {
  for (const [outcome, expected] of [['root-cause', 7.7], ['patch', 6.6], ['another-review', 5.9]] as const) {
    const s = scoreAll(fixture([{ role: 'fix', outcome }]))[0];
    assert.deepEqual([s.fix, s.build, s.score], [expected, null, null]);
  }
  // Findings the check of the fix raised lower it.
  assert.equal(scoreAll(fixture([{ role: 'fix', outcome: 'root-cause', findings: { high: 1, medium: 0, low: 0 } }]))[0].fix, 7.0);
  const file = fixture(Array(8).fill({ findings: { high: 1, medium: 0, low: 0 } }));
  file.models.fixer = { model: 'fixer', agent: 'codex', summary: '', summaryAt: null,
    evidence: fixture([...Array(8).fill({ findings: { high: 1, medium: 0, low: 0 } }), ...Array(8).fill({ role: 'fix', outcome: 'root-cause' })]).models['model-a'].evidence };
  const scores = scoreAll(file);
  const [a, b] = ['model-a', 'fixer'].map((model) => scores.find((s) => s.model === model)!);
  assert.equal(a.score, b.score);
  assert.deepEqual([b.buildSamples, b.fixSamples], [8, 8]);
});

const notes = (models: Record<string, Partial<Evidence>[]>): NotesFile => ({ version: 2, ratings: [], models: Object.fromEntries(Object.entries(models).map(([model, lines]) => [model,
  { model, agent: 'codex' as const, summary: '', summaryAt: null, evidence: lines.map((e, i) => ({ ...input, model, id: `ev-${model}-${i}`, at: i, ...e })) }])) });
const scoreOf = (file: NotesFile, model: string) => scoreAll(file).find((s) => s.model === model)!.score!;

test('a review that finds more is read as one, from a model it reviewed beside another', () => {
  // The cross model's work drew twice the findings from the strict review as from the light one, so the strict
  // review's findings count for less: a model it alone reviewed is read close to one with half the findings under the
  // light review, and well above one with the same findings under it.
  const medium = (n: number) => ({ findings: { high: 0, medium: n, low: 0 } });
  const strict = { reviewedBy: ['strict-model'] }, light = { reviewedBy: ['light-model'] };
  const cross = [...Array(10).fill({ ...strict, ...medium(4) }), ...Array(10).fill({ ...light, ...medium(2) })];
  const file = notes({ cross, strict: Array(10).fill({ ...strict, ...medium(4) }), light: Array(10).fill({ ...light, ...medium(2) }), same: Array(10).fill({ ...light, ...medium(4) }) });
  const gap = scoreOf(file, 'light') - scoreOf(file, 'strict');
  assert.ok(Math.abs(gap) < 0.5);
  assert.ok(scoreOf(file, 'strict') > scoreOf(file, 'same') + 1);
  // With no model reviewed by both, only the priors split the difference between the review and the work.
  const apart = notes({ strict: Array(10).fill({ ...strict, ...medium(4) }), light: Array(10).fill({ ...light, ...medium(2) }) });
  assert.ok(scoreOf(apart, 'light') - scoreOf(apart, 'strict') > gap);
});

test('hard work is expected to draw more findings, and clean routine work says little', () => {
  const medium = (n: number) => ({ findings: { high: 0, medium: n, low: 0 } });
  // The same findings on hard work read better than on standard work, and on routine work worse.
  const file = notes({ hard: Array(10).fill({ difficulty: 'hard', ...medium(2) }), standard: Array(10).fill(medium(2)), routine: Array(10).fill({ difficulty: 'routine', ...medium(2) }) });
  assert.ok(scoreOf(file, 'hard') > scoreOf(file, 'standard') && scoreOf(file, 'standard') > scoreOf(file, 'routine'));
  // Clean work: hard lines were expected to draw findings, so their absence lifts a model further than routine lines'.
  const clean = notes({ hard: Array(10).fill({ difficulty: 'hard' }), routine: Array(10).fill({ difficulty: 'routine' }), other: Array(10).fill(medium(2)) });
  assert.ok(scoreOf(clean, 'hard') > scoreOf(clean, 'routine'));
  // A line without a difficulty counts as standard, and the mix is counted the same way.
  assert.equal(scoreOf(notes({ a: [{}], b: [medium(1)] }), 'a'), scoreOf(notes({ a: [{ difficulty: 'standard' }], b: [medium(1)] }), 'a'));
  assert.deepEqual(scoreAll(notes({ a: [{}, { difficulty: 'hard' }, { difficulty: 'routine' }, { role: 'fix', outcome: 'patch' }] }))[0].difficulty, { routine: 1, standard: 1, hard: 1 });
});

test('routine lines together weigh at most two lines, in the score and in the status', () => {
  const others = { other: Array(10).fill({ findings: { high: 0, medium: 2, low: 0 } }) };
  // However many clean routine lines a model has, they lift it no further than two of them would, and never settle it.
  const routine = (n: number) => scoreAll(notes({ ...others, polisher: Array(n).fill({ difficulty: 'routine', size: 'small' }) })).find((s) => s.model === 'polisher')!;
  assert.equal(routine(50).score, routine(2).score);
  assert.equal(routine(50).status, 'too few samples');
  // Nor does a run of them under a review kind of their own move where every model is read.
  const kinds = (n: number) => scoreAll(notes({ strict: Array(10).fill({ reviewedBy: ['strict-model'], findings: { high: 0, medium: 2, low: 0 } }),
    light: Array(10).fill({ reviewedBy: ['light-model'], findings: { high: 0, medium: 1, low: 0 } }),
    polisher: Array(n).fill({ difficulty: 'routine', size: 'small', reviewedBy: ['light-model'] }) })).map((s) => [s.model, s.score]);
  assert.deepEqual(kinds(200), kinds(2));
  // One standard line and three routine ones are three reviews: on trial, not short by a rounding error.
  assert.equal(scoreAll(notes({ ...others, mixed: [{}, ...Array(3).fill({ difficulty: 'routine', size: 'small' })] })).find((s) => s.model === 'mixed')!.status, 'on trial');
  // Standard lines keep counting.
  const standard = (n: number) => scoreAll(notes({ ...others, builder: Array(n).fill({ size: 'small' }) })).find((s) => s.model === 'builder')!;
  assert.ok(standard(50).score! > standard(2).score!);
  assert.equal(standard(50).status, 'settled');
});

test('ratings of routine work together weigh at most two ratings, as its lines do', () => {
  const rated = (n: number, difficulty: Evidence['difficulty']) => notes({
    other: Array.from({ length: 6 }, (_, i) => ({ job: `cx-o${i}`, rating: { correctness: 3 }, findings: { high: 0, medium: 1, low: 0 } })),
    polisher: [...Array.from({ length: 3 }, (_, i) => ({ job: `cx-s${i}`, rating: { correctness: 4 } })),
      ...Array.from({ length: n }, (_, i) => ({ job: `cx-r${i}`, difficulty, size: 'small' as const, rating: { correctness: 5 } }))],
  });
  // However many fives routine work collects, they lift its correctness no further than two of them would.
  assert.equal(scoreOf(rated(20, 'routine'), 'polisher'), scoreOf(rated(2, 'routine'), 'polisher'));
  // The same fives on standard work keep counting.
  assert.ok(scoreOf(rated(20, 'standard'), 'polisher') > scoreOf(rated(2, 'standard'), 'polisher'));
  // Routine ratings alone count toward the minimum by their capped share: twenty of them are two, too few to move it.
  const alone = (n: number) => notes({ other: Array.from({ length: 6 }, (_, i) => ({ job: `cx-o${i}`, rating: { correctness: 3 } })),
    polisher: [{}, ...Array.from({ length: n }, (_, i) => ({ job: `cx-r${i}`, difficulty: 'routine' as const, size: 'small' as const, rating: { correctness: 5 } }))] });
  const polisher = scoreAll(alone(20)).find((s) => s.model === 'polisher')!;
  assert.deepEqual([polisher.ratings, polisher.score], [0, polisher.build]);
  // One standard rating and three routine ones count as three, whole.
  const mixed = (n: number) => notes({ other: Array.from({ length: 6 }, (_, i) => ({ job: `cx-o${i}`, rating: { correctness: 3 } })),
    polisher: [{ job: 'cx-s', rating: { correctness: 5 } }, ...Array.from({ length: n }, (_, i) => ({ job: `cx-r${i}`, difficulty: 'routine' as const, size: 'small' as const, rating: { correctness: 5 } }))] });
  assert.equal(scoreAll(mixed(3)).find((s) => s.model === 'polisher')!.ratings, 3);
});

test('a reviewer\'s ratings of the lead\'s own routine work are capped through the review jobs its lines name', () => {
  // The lead's work has no job, so its line names the review jobs that read it, and their ratings are traced back.
  const reviewed = (n: number, difficulty: Evidence['difficulty']) => {
    const file = notes({
      lead: Array.from({ length: n }, (_, i) => ({ reviewer: 'codex' as const, difficulty, size: 'small' as const, reviewedBy: ['cross'], reviewJobs: [`cx-rv${i}`] })),
      cross: Array.from({ length: n }, (_, i) => ({ role: 'review' as const, job: `cx-rv${i}`, of: { model: 'lead' } })),
      other: [{ findings: { high: 0, medium: 1, low: 0 } }],
    });
    file.models.lead.agent = 'claude';
    file.models.lead.evidence.forEach((e) => { e.agent = 'claude'; });
    file.ratings = Array.from({ length: n }, (_, i) => ({ id: `rt-${i}`, at: i, by: 'codex' as const, byModel: 'cross', byJob: `cx-rv${i}`, items: { correctness: 5 }, fact: 'x' }));
    return scoreAll(file).find((s) => s.model === 'lead')!;
  };
  assert.equal(reviewed(20, 'routine').score, reviewed(2, 'routine').score);
  assert.equal(reviewed(20, 'routine').ratings, 0);
  // Standard work is not capped, so its ratings count.
  assert.ok(reviewed(20, 'standard').ratings >= 3);
});

test('a review kind is the first reviewer from another agent, with extra reviews as their own term', () => {
  const agents: Record<string, 'codex' | 'claude'> = { 'model-a': 'codex', 'claude-x': 'claude' };
  const kind = (e: Partial<Evidence>) => reviewKind({ ...input, id: 'ev', at: 0, ...e } as Evidence, (m) => agents[m]);
  // Whatever the order, the review from another agent is the kind and the builder's own agent's is an extra review.
  assert.deepEqual(kind({ reviewedBy: ['model-a', 'claude-x'] }), { kind: 'claude-x', extra: 1 });
  assert.deepEqual(kind({ reviewedBy: ['claude-x', 'model-a'] }), { kind: 'claude-x', extra: 1 });
  // A self-reviewer on another model of the builder's agent, with no notes of its own, is still the builder's agent's
  // when the line recorded it, so the cross-review stays the kind.
  assert.deepEqual(kind({ agent: 'claude', model: 'claude-x', reviewedBy: ['claude-sub', 'gpt-cross'], reviewAgents: ['claude', 'codex'] }), { kind: 'gpt-cross', extra: 1 });
  // A review only by the builder's own agent is its own kind.
  assert.deepEqual(kind({ reviewedBy: ['model-a'] }), { kind: 'model-a (own agent)', extra: 0 });
  // Older lines: the lead reading a worker's job, a self-review, and a cross-review of the lead's work are three kinds.
  assert.deepEqual([kind({ job: 'cx-1' }), kind({ reviewer: 'codex' }), kind({ agent: 'claude', model: 'claude-x' })].map((k) => k.kind),
    ['claude review of a job', 'codex self-review', 'claude self-review']);
  assert.equal(kind({ agent: 'claude', model: 'claude-x', reviewer: 'codex' }).kind, 'codex cross-review');
  const file = notes({ a: [{ reviewedBy: ['model-a', 'cross-model'] }, { reviewedBy: ['cross-model'] }], b: [{}] });
  // Both of a's lines share the cross model's kind; the self-reviewer beside it is an extra review, not the kind.
  const text = renderNotes(scoreAll(file), file, { models: ['a'] });
  assert.match(text, /model-a \+ cross-model reviewed, build/);
  // Older lines without models fall back to the reviewer's agent: a worker's job read by the lead is its own kind.
  assert.ok(Number.isFinite(scoreOf(notes({ a: [{ job: 'cx-1' }, {}], b: [{ reviewer: 'codex' }] }), 'a')));
});

test('every model starts at the reference, whatever the others and their line counts', () => {
  // A busy clean model does not lift the start of the others, and a sparse poor one does not lower it.
  const file = fixture([{}, {}, {}]);
  const lines = (n: number, e: Partial<Evidence>) => fixture(Array(n).fill(e)).models['model-a'].evidence;
  file.models.busy = { model: 'busy', agent: 'codex', summary: '', summaryAt: null, evidence: lines(100, {}) };
  file.models.sparse = { model: 'sparse', agent: 'codex', summary: '', summaryAt: null, evidence: lines(5, { findings: { high: 2, medium: 0, low: 0 } }) };
  assert.deepEqual(scoreAll(file).map((s) => [s.model, s.score]), [['busy', 9.8], ['model-a', 8.5], ['sparse', 5.3]]);
});

test('status counts build reviews, a self-review as half, and consolidation follows timestamps', (t) => {
  for (const [n, status] of [[0, 'too few samples'], [2, 'too few samples'], [3, 'on trial'], [7, 'on trial'], [8, 'settled']] as const) {
    assert.equal(scoreAll(fixture(Array(n).fill({})))[0].status, status);
  }
  assert.equal(scoreAll(fixture(Array(5).fill({ reviewer: 'codex' })))[0].status, 'too few samples');
  assert.equal(scoreAll(fixture(Array(6).fill({ reviewer: 'codex' })))[0].status, 'on trial');
  assert.equal(scoreAll(fixture(Array(9).fill({ role: 'fix', outcome: 'root-cause' })))[0].status, 'too few samples');
  const dir = home(t);
  for (let at = 1; at <= 9; at++) addEvidence(dir, { ...input, at });
  assert.equal(scoreAll(loadNotes(dir))[0].consolidate, false);
  assert.equal(addEvidence(dir, { ...input, at: 10 }).score.consolidate, true);
  assert.equal(setSummary(dir, input.model, 'Summary.', 10).consolidate, false);
  addEvidence(dir, { ...input, at: 10 });
  for (let at = 11; at <= 20; at++) addEvidence(dir, { ...input, at });
  assert.equal(scoreAll(loadNotes(dir))[0].consolidate, true);
  assert.equal(scoreAll(loadNotes(dir))[0].lastAt, 20);
});

test('rendering filters models and agents and shows latest evidence and null scores', () => {
  const at = new Date(2026, 10, 15).getTime();
  const file = fixture([{ at, text: 'Latest.', job: 'cx-123', tier: 'frontier', declined: { high: 0, medium: 2, low: 1 } }, { at: at - 86400000, text: 'Older.' }]);
  file.models.empty = { model: 'empty', agent: 'claude', summary: '', summaryAt: null, evidence: [] };
  const scores = scoreAll(file);
  const text = renderNotes(scores, file, { models: ['model-a'], evidence: 1 });
  assert.match(text, /### model-a \(codex\) — 8\.3\/10, too few samples, 2 build\(s\), 0 fix\(es\)/);
  assert.match(text, /build 8\.3 · fix —/);
  assert.match(text, /builds by tier: frontier 1/);
  assert.match(text, /builds by difficulty: standard 2/);
  assert.match(text, /2026-11-15 cx-123 \(claude reviewed, build, frontier\/medium, declined 2 medium 1 low\): Latest\./);
  assert.doesNotMatch(text, /Older/);
  assert.match(renderNotes(scores, file, { agents: ['claude'] }), /—\/10.*No summary yet\./s);
  assert.equal(renderNotes(scores, file, { models: [] }), '');
  assert.equal(renderNotes(scores, file, { models: ['empty'], agents: ['codex'] }), '');
  assert.doesNotMatch(renderNotes(scores, file, { evidence: 0 }), /Latest/);
  scores[0].consolidate = true;
  assert.match(renderNotes(scores, file), /Summary is due: rewrite it from the evidence\./);
});

test('scores sort by unrounded rate, then by model, with fix-only models and then empty ones last', () => {
  const file = fixture([{}]);
  for (const model of ['z', 'b', 'empty-z', 'empty-a']) file.models[model] = {
    model, agent: 'codex', summary: '', summaryAt: null,
    evidence: model.startsWith('empty') ? [] : fixture(model === 'z' ? [{ role: 'fix', outcome: 'patch' }] : [{}]).models['model-a'].evidence,
  };
  assert.deepEqual(scoreAll(file).map((s) => s.model), ['b', 'model-a', 'z', 'empty-a', 'empty-z']);
  assert.equal(scoreAll(file).at(-1)!.lastAt, null);
  // Both show 8.8; the one with fewer findings comes first, whatever its name.
  const low = { findings: { high: 0, medium: 0, low: 1 } };
  const tie = fixture([...Array(7).fill(low), { findings: { high: 0, medium: 0, low: 2 } }]);
  tie.models.b = { model: 'b', agent: 'codex', summary: '', summaryAt: null, evidence: fixture(Array(8).fill(low)).models['model-a'].evidence };
  assert.deepEqual(scoreAll(tie).map((s) => [s.model, s.score]), [['b', 8.8], ['model-a', 8.8]]);
});

test('noting the same job and role again replaces its line, while another role or no job adds one', (t) => {
  const dir = home(t);
  addEvidence(dir, { ...input, job: 'cx-1', findings: { high: 1, medium: 0, low: 0 }, text: 'first' });
  addEvidence(dir, { ...input, job: 'cx-1', text: 'corrected' });
  addEvidence(dir, { ...input, job: 'cx-1', role: 'fix', outcome: 'patch', text: 'fixed' });
  addEvidence(dir, { ...input, text: 'no job' });
  addEvidence(dir, { ...input, text: 'no job again' });
  assert.deepEqual(loadNotes(dir).models['model-a'].evidence.map((e) => e.text), ['corrected', 'fixed', 'no job', 'no job again']);
  // Noted again under the model the session reported later, the job leaves its first model.
  addEvidence(dir, { ...input, model: 'model-b', job: 'cx-1', text: 'under its real model' });
  const file = loadNotes(dir);
  assert.deepEqual(file.models['model-a'].evidence.map((e) => e.text), ['fixed', 'no job', 'no job again']);
  assert.deepEqual(file.models['model-b'].evidence.map((e) => e.text), ['under its real model']);
  // A model the move leaves with no lines goes; one that had none already stays.
  const saved = loadNotes(dir);
  saved.models.idle = { model: 'idle', agent: 'codex', summary: 'Kept.', summaryAt: 1, evidence: [] };
  fs.writeFileSync(notesFile(dir), JSON.stringify(saved));
  addEvidence(dir, { ...input, model: 'model-c', job: 'cx-1', text: 'moved again' });
  assert.deepEqual(Object.keys(loadNotes(dir).models), ['model-a', 'idle', 'model-c']);
});

test('a job noted twice by a hand edit counts once, by its latest line', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir, { recursive: true });
  const line = (id: string, at: number, model = 'model-a', role = 'build') => ({ ...input, model, role, ...(role === 'fix' ? { outcome: 'patch' } : {}), id, at, job: 'cx-9' });
  fs.writeFileSync(notesFile(dir), JSON.stringify({ version: 1, models: {
    'model-a': { model: 'model-a', agent: 'codex', evidence: [line('ev-1', 1), line('ev-3', 3, 'model-a', 'fix'), { ...line('ev-4', 4), size: 'huge' }] },
    'model-b': { model: 'model-b', agent: 'codex', evidence: [line('ev-2', 2, 'model-b')] },
  } }));
  const file = loadNotes(dir);
  // The malformed later line does not hide the valid one before it.
  assert.deepEqual([file.models['model-a'].evidence.map((e) => e.id), file.models['model-b'].evidence.map((e) => e.id)], [['ev-3'], ['ev-2']]);
});

test('incomplete entries and lines are skipped and the rest keeps the shape readers expect', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir, { recursive: true });
  const good = { ...input, id: 'ev-1', at: 1 };
  fs.writeFileSync(notesFile(dir), JSON.stringify({ version: 1, models: {
    'model-a': { model: 'model-a', agent: 'codex', evidence: [good, { ...good, id: 'ev-2', size: 'huge' }, { ...good, id: 'ev-3', findings: { high: -1 } }, { ...good, id: 'ev-4', role: 'fix' }, { ...good, id: 'ev-5', agent: undefined }, { ...good, id: 'ev-6', model: 'model-x' }] },
    'model-b': { model: 'model-b', agent: 'cursor', evidence: [] },
    'model-c': { model: 'model-c', agent: 'claude' },
  } }));
  const file = loadNotes(dir);
  assert.deepEqual(Object.keys(file.models), ['model-a']);
  assert.deepEqual([file.models['model-a'].summary, file.models['model-a'].summaryAt, file.models['model-a'].evidence.map((e) => e.id)], ['', null, ['ev-1']]);
  assert.equal(scoreAll(file)[0].score, 7.9);
});

test('a save keeps a copy of the file when loading had skipped lines, and none when nothing was skipped', (t) => {
  const dir = home(t);
  addEvidence(dir, input);
  const copies = () => fs.readdirSync(dir).filter((name) => name.includes('.dropped-'));
  addEvidence(dir, { ...input, text: 'again' });
  assert.deepEqual(copies(), []);
  const saved = JSON.parse(fs.readFileSync(notesFile(dir), 'utf8'));
  saved.models['model-a'].evidence.push({ ...saved.models['model-a'].evidence[0], id: 'ev-old', size: 'huge' });
  const raw = JSON.stringify(saved);
  fs.writeFileSync(notesFile(dir), raw);
  addEvidence(dir, { ...input, text: 'after the edit' });
  assert.equal(copies().length, 1);
  assert.equal(fs.readFileSync(path.join(dir, copies()[0]), 'utf8'), raw);
  assert.equal(loadNotes(dir).models['model-a'].evidence.length, 3);
});

test('a model with few reviews starts at the reference and ranks after every model with enough', () => {
  const file = fixture(Array(8).fill({ findings: { high: 0, medium: 1, low: 0 } }));
  file.models.fresh = { model: 'fresh', agent: 'codex', summary: '', summaryAt: null, evidence: fixture([{}, {}]).models['model-a'].evidence };
  const [settled, fresh] = scoreAll(file);
  // The fresh one starts at the reference, 7.0, not where the settled model stands.
  assert.deepEqual([settled.model, settled.score, settled.status], ['model-a', 8.2, 'settled']);
  // Two clean reviews lift it above the settled model's score, but not above it in the ranking.
  assert.deepEqual([fresh.model, fresh.score, fresh.status], ['fresh', 8.3, 'too few samples']);
});

test('a save stops when the copy of skipped lines cannot be made, so nothing is erased', (t) => {
  const dir = home(t);
  addEvidence(dir, input);
  const saved = JSON.parse(fs.readFileSync(notesFile(dir), 'utf8'));
  saved.models['model-a'].evidence.push({ ...saved.models['model-a'].evidence[0], id: 'ev-old', size: 'huge' });
  const raw = JSON.stringify(saved);
  fs.writeFileSync(notesFile(dir), raw);
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('No space left'); });
  assert.throws(() => addEvidence(dir, { ...input, text: 'more' }), /No space left/);
  assert.equal(fs.readFileSync(notesFile(dir), 'utf8'), raw);
});

test('an xlarge change carries twice a large one\'s exposure', () => {
  const rate = (size: Evidence['size']) => scoreAll(fixture(Array.from({ length: 20 }, () => ({ size, findings: { high: 0, medium: 2, low: 0 } }))))[0].score!;
  // The same findings on bigger changes are a lower rate: about 0.15 per unit for large, half that for xlarge.
  assert.deepEqual([rate('large'), rate('xlarge')], [8.5, 9.2]);
});

test('adoption is totalled per model, shown in the notes, and not scored', () => {
  const lines: Partial<Evidence>[] = [
    { job: 'cx-1', adoption: 'as-is', rounds: 0 }, { job: 'cx-2', adoption: 'after-reply', rounds: 2 },
    { job: 'cx-3', adoption: 'rejected', rounds: 1 }, { job: 'cx-4' },
  ];
  const file = fixture(lines);
  const [score] = scoreAll(file);
  assert.deepEqual(score.adoption, { judged: 3, asIs: 1, afterReply: 1, partly: 0, rejected: 1, rounds: 3 });
  assert.equal(score.score, scoreAll(fixture(lines.map(({ job }) => ({ job }))))[0].score);
  assert.equal(scoreAll(fixture([{}]))[0].adoption, null);
  const text = renderNotes([score], file);
  assert.match(text, /adopted: 1 as is, 1 after a reply, 0 in part, 1 rejected, of 3; 3 follow-up round\(s\)/);
  assert.match(text, /cx-2 \(claude reviewed, build, medium, after-reply after 2 round\(s\)\)/);
});

test('loading drops an adoption the writer would refuse', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir, { recursive: true });
  const bad: Partial<Evidence>[] = [{ adoption: 'as-is' }, { job: '', adoption: 'as-is' }, { job: 'cx-2', adoption: 'merged' as Evidence['adoption'] }, { job: 'cx-3', rounds: 1 }, { job: 'cx-4', adoption: 'partly', rounds: 1 }];
  fs.writeFileSync(notesFile(dir), JSON.stringify(fixture(bad)));
  assert.deepEqual(loadNotes(dir).models['model-a'].evidence.map((e) => e.job), ['cx-4']);
});

const high = { high: 1, medium: 0, low: 0 };
const review = { role: 'review', of: { model: 'model-b' } } as const;

test('a stored review line whose builder is not an object is dropped by itself, not with the whole file', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir, { recursive: true });
  const bad = [{ role: 'review', job: 'rv-1', of: null }, { role: 'review', job: 'rv-2', of: 'model-b' }, { role: 'review', job: 'rv-3' }, { job: 'cx-1' }] as unknown as Partial<Evidence>[];
  fs.writeFileSync(notesFile(dir), JSON.stringify(fixture(bad)));
  assert.deepEqual(loadNotes(dir).models['model-a'].evidence.map((e) => e.job), ['rv-3', 'cx-1']);
});

test('a review line that names no builder is an audit, and its reviewer\'s rating of the code counts for no one', (t) => {
  const dir = home(t);
  addEvidence(dir, { ...input, model: 'model-b', job: 'cx-1' });
  const before = scoreAll(loadNotes(dir)).find((score) => score.model === 'model-b')!;
  const { evidence } = addEvidence(dir, { ...input, model: 'model-r', agent: 'antigravity', job: 'rv-1', role: 'review', findings: high });
  assert.equal(evidence.of, undefined);
  // The reviewer rated what it read; an audit read no one job's work.
  addRating(dir, { by: 'antigravity', byModel: 'model-r', byJob: 'rv-1', items: { correctness: 1 }, fact: 'Two holes.' }, WORKER_ITEMS.review);
  const notes = loadNotes(dir);
  assert.equal(notes.models['model-r'].evidence.length, 1, 'the line survives a reload');
  const scores = scoreAll(notes);
  assert.deepEqual(scores.find((score) => score.model === 'model-b')!.items, before.items);
  assert.equal(scores.find((score) => score.model === 'model-r')!.reviewSamples, 1);
  assert.match(renderNotes(scores, notes), /rv-1 \(audit, review, medium\)/);
});

test('a review line scores its reviewer on the share of its finding load the lead accepted', () => {
  // One accepted high against the start of 0.6 with the weight of 0.5: (0.35 + 0.3) / (0.35 + 0.5).
  const kept = scoreAll(fixture([{ ...review, findings: high }]))[0];
  assert.deepEqual([kept.items.findings, kept.score, kept.reviewSamples, kept.buildSamples], [7.6, null, 1, 0]);
  // A declined high of the same weight halves what was raised: (0.35 + 0.3) / (0.7 + 0.5).
  assert.equal(scoreAll(fixture([{ ...review, findings: high, declined: high }]))[0].items.findings, 5.4);
  // A review that raised nothing says nothing about its findings.
  assert.equal(scoreAll(fixture([{ ...review }]))[0].items.findings, null);
});

test('brief follows how the lead took delegated work, and report has ratings only', () => {
  const taken = (adoption: Evidence['adoption']) => scoreAll(fixture([{ job: 'cx-1', adoption }]))[0].items;
  assert.ok(taken('as-is').brief! > taken('after-reply').brief! && taken('after-reply').brief! > taken('partly').brief! && taken('partly').brief! > taken('rejected').brief!);
  assert.deepEqual([scoreAll(fixture([{}]))[0].items.brief, taken('as-is').report], [null, null]);
});

test('peer ratings count from three on, move half of an item from where the evidence put it, and can be left out', () => {
  const rated = (n: number, rating: Evidence['rating']) => fixture(Array.from({ length: 4 }, (_, i) => ({ job: `cx-${i}`, ...(i < n ? { rating } : {}) })));
  const base = scoreAll(rated(0, {}))[0];
  assert.equal(base.score, base.build);
  // One or two ratings are an anecdote: they move nothing, and are not counted as having moved anything.
  assert.deepEqual([scoreAll(rated(2, { correctness: 1 }))[0].score, scoreAll(rated(2, { correctness: 1 }))[0].ratings], [base.score, 0]);
  const low = scoreAll(rated(3, { correctness: 1 }))[0];
  assert.deepEqual([low.score! < base.score!, low.build, low.ratings], [true, base.build, 3]);
  // Half of the item stays with the evidence, whatever the ratings say.
  assert.ok(low.score! > base.score! * 0.5);
  // Neutral ratings leave a score where it was, and the best there are never lower it.
  assert.equal(scoreAll(rated(3, { correctness: 3 }))[0].score, base.score);
  assert.ok(scoreAll(rated(4, { correctness: 5 }))[0].score! > base.score!);
  assert.equal(scoreAll(rated(3, { correctness: 1 }), { ratings: false })[0].score, base.score);
  // An item with no evidence is its reference of 7.0, moved by its ratings.
  assert.ok(scoreAll(rated(3, { report: 5 }))[0].items.report! > 7 && scoreAll(rated(3, { report: 1 }))[0].items.report! < 7);
  assert.equal(scoreAll(rated(3, { report: 3 }))[0].items.report, 7);
});

test('a rating is read against its rater per item, counts half from the model\'s own agent, and never lifts flawed work', () => {
  // Rated five by a rater whose every rating of the item is five, model-a gains less than when the same rater marks another down.
  const file = (other: Evidence['rating']) => {
    const f = fixture(Array.from({ length: 3 }, (_, i) => ({ job: `cx-a${i}`, rating: { report: 5 } })));
    f.models['model-b'] = { model: 'model-b', agent: 'codex', summary: '', summaryAt: null,
      evidence: Array.from({ length: 3 }, (_, i) => ({ ...input, model: 'model-b', id: `ev-b${i}`, at: i, job: `cx-b${i}`, rating: other })) };
    return scoreAll(f).find((s) => s.model === 'model-a')!.items.report!;
  };
  assert.ok(file({ report: 5 }) < file({ report: 1 }));
  // What the rater gives another item says nothing of how it rates this one.
  assert.equal(file({ brief: 1 }), file({ brief: 5 }));
  // Reading against the rater only brings a rating toward neutral: threes stay neutral whatever the rater gives
  // elsewhere, and one more five never lowers the model it goes to.
  const two = (mine: number[], other: number) => {
    const f = fixture(mine.map((correctness, i) => ({ job: `cx-a${i}`, rating: { correctness } })));
    f.models['model-b'] = { model: 'model-b', agent: 'codex', summary: '', summaryAt: null,
      evidence: Array.from({ length: 3 }, (_, i) => ({ ...input, model: 'model-b', id: `ev-b${i}`, at: i, job: `cx-b${i}`, rating: { correctness: other } })) };
    const s = scoreAll(f).find((score) => score.model === 'model-a')!;
    return s.score! - s.build!;
  };
  assert.deepEqual([two([3, 3, 3], 5), two([3, 3, 3], 1)], [0, 0]);
  assert.ok(two([5, 5, 5, 3, 3], 5) <= two([5, 5, 5, 5, 3], 5) && two([5, 5, 5, 5, 3], 5) <= two([5, 5, 5, 5, 5], 5));
  assert.ok(two([5, 5, 5], 5) >= 0 && two([1, 1, 1], 1) <= 0);
  // The lead rating a model of its own agent counts half: the same ratings take off less.
  const lost = (agent: 'codex' | 'claude', ratedBy?: 'codex') => {
    const f = fixture(Array.from({ length: 3 }, (_, i) => ({ job: `cx-${i}`, agent, reviewer: 'antigravity' as const, rating: { correctness: 1 }, ...(ratedBy ? { ratedBy } : {}) })));
    f.models['model-a'].agent = agent;
    const s = scoreAll(f)[0];
    return (s.build! - s.score!) / s.build!;
  };
  assert.ok(lost('claude') > 0 && lost('claude') < lost('codex'));
  // A Codex lead rates as Codex: its ratings of Codex's work count half, and of Claude's in full.
  assert.equal(lost('codex', 'codex'), lost('claude'));
  assert.equal(lost('claude', 'codex'), lost('codex'));
  // Three fives on work with an accepted high finding count as three threes.
  const flawed = (correctness: number) => scoreAll(fixture(Array.from({ length: 3 }, (_, i) => ({ job: `cx-${i}`, findings: high, rating: { correctness } }))))[0].score;
  assert.equal(flawed(5), flawed(3));
});

/** Three jobs model-a built, each reviewed by model-r, with what the reviewers and the builders rated. */
function reviewed(t: TestContext, options: { correctness?: number; findings?: number; accepted?: Evidence['findings']; own?: boolean } = {}) {
  const dir = home(t);
  for (const i of [1, 2, 3]) {
    // Work of the lead's own has no job; a worker's is under the model its build line names, whatever the review line says.
    addEvidence(dir, { ...input, ...(options.own ? {} : { job: `cx-${i}` }) });
    addEvidence(dir, { ...input, model: 'model-r', agent: 'antigravity', role: 'review', job: `rv-${i}`, findings: options.accepted ?? { high: 0, medium: 1, low: 0 },
      of: options.own ? { model: 'model-a' } : { job: `cx-${i}`, model: 'stale-model' } });
    if (options.correctness) addRating(dir, { by: 'antigravity', byModel: 'model-r', byJob: `rv-${i}`, items: { correctness: options.correctness }, fact: 'Checked the main path.' }, WORKER_ITEMS.review);
    if (options.findings) addRating(dir, { by: 'codex', byModel: 'model-a', byJob: `cx-${i}`, items: { findings: options.findings }, fact: 'The finding was real.' }, WORKER_ITEMS.delegate);
  }
  const scores = scoreAll(loadNotes(dir));
  return { dir, a: scores.find((s) => s.model === 'model-a')!, r: scores.find((s) => s.model === 'model-r')! };
}

test('a reviewer\'s rating reaches the model that built the work, and a builder\'s the model that reviewed it', (t) => {
  const none = reviewed(t);
  const both = reviewed(t, { correctness: 1, findings: 5 });
  // The reviewers' ones lower the builder's score and leave its build; the builders' fives lift the reviewer's findings.
  assert.deepEqual([both.a.score! < none.a.score!, both.a.build, both.a.ratings, both.a.items.findings], [true, none.a.build, 3, null]);
  assert.deepEqual([both.r.items.findings! > none.r.items.findings!, both.r.ratings, both.r.score], [true, 3, null]);
  assert.equal(scoreAll(loadNotes(both.dir)).some((s) => s.model === 'stale-model'), false);
  // A builder has a stake in the review of its own work: its ratings move the item less than the lead's same ones.
  for (const i of [1, 2, 3]) addEvidence(none.dir, { ...input, model: 'model-r', agent: 'antigravity', role: 'review', job: `rv-${i}`, findings: { high: 0, medium: 1, low: 0 }, of: { job: `cx-${i}`, model: 'model-a' }, rating: { findings: 5 } });
  const lead = scoreAll(loadNotes(none.dir)).find((s) => s.model === 'model-r')!.items.findings!;
  assert.ok(lead > both.r.items.findings!);
});

test('one rating counts once however many reviews of the job there were, and a rating waits for its review line', (t) => {
  const dir = home(t);
  addEvidence(dir, { ...input, job: 'cx-1' });
  addRating(dir, { by: 'codex', byModel: 'model-a', byJob: 'cx-1', items: { findings: 1 }, fact: 'Noise.' }, WORKER_ITEMS.delegate);
  const findings = () => scoreAll(loadNotes(dir)).find((s) => s.model === 'model-r')!;
  for (const i of [1, 2, 3]) addEvidence(dir, { ...input, model: 'model-r', role: 'review', job: `rv-${i}`, findings: high, of: { job: 'cx-1', model: 'model-a' } });
  const before = findings();
  assert.equal(before.ratings, 0);
  // Three ratings by three jobs do count, and until their review lines exist a reviewer's own ratings reach nobody.
  for (const i of [1, 2, 3]) addRating(dir, { by: 'codex', byModel: 'model-r', byJob: `rv-x${i}`, items: { correctness: 1 }, fact: 'x' }, WORKER_ITEMS.review);
  assert.deepEqual(scoreAll(loadNotes(dir)).map((s) => s.ratings), [0, 0]);
  assert.equal(findings().items.findings, before.items.findings);
});

test('a rating that reaches two reviewers of a job moves both alike, whichever was noted first', (t) => {
  const findings = (order: string[]) => {
    const dir = home(t);
    for (const i of [1, 2, 3]) {
      addEvidence(dir, { ...input, job: `cx-${i}` });
      for (const model of order) addEvidence(dir, { ...input, model, agent: 'antigravity', role: 'review', job: `${model}-${i}`, findings: { high: 0, medium: 1, low: 0 }, of: { job: `cx-${i}`, model: 'model-a' } });
      addRating(dir, { by: 'codex', byModel: 'model-a', byJob: `cx-${i}`, items: { findings: 5 }, fact: 'The findings were real.' }, WORKER_ITEMS.delegate);
    }
    const scores = scoreAll(loadNotes(dir));
    return ['model-r', 'model-s'].map((model) => scores.find((s) => s.model === model)!.items.findings);
  };
  const [r, s] = findings(['model-r', 'model-s']);
  assert.equal(r, s);
  assert.deepEqual(findings(['model-s', 'model-r']), [r, s]);
});

test('the cap on flawed work holds for a reviewer\'s rating and for work without a job, and a fix is not rated for correctness', (t) => {
  const flawed = (correctness: number, own: boolean) => reviewed(t, { correctness, accepted: high, own }).a.score;
  assert.equal(flawed(5, false), flawed(3, false));
  assert.equal(flawed(5, true), flawed(3, true));
  assert.ok(reviewed(t, { correctness: 5 }).a.score! > reviewed(t, { correctness: 3 }).a.score!);
  const dir = home(t);
  assert.throws(() => addEvidence(dir, { ...input, job: 'cx-9', role: 'fix', outcome: 'patch', rating: { correctness: 5 } }), /brief, report for fix/);
  // A reviewer's correctness rating of a fix job says nothing of how its model builds: the score stays empty.
  for (const i of [1, 2, 3]) {
    addEvidence(dir, { ...input, job: `fx-${i}`, role: 'fix', outcome: 'patch' });
    addEvidence(dir, { ...input, model: 'model-r', role: 'review', job: `rv-${i}`, of: { job: `fx-${i}`, model: 'model-a', fix: true } });
    addRating(dir, { by: 'codex', byModel: 'model-r', byJob: `rv-${i}`, items: { correctness: 5, report: 5 }, fact: 'x' }, WORKER_ITEMS.review);
  }
  const fixer = scoreAll(loadNotes(dir)).find((s) => s.model === 'model-a')!;
  assert.deepEqual([fixer.score, fixer.build, fixer.ratings, fixer.items.report! > 7], [null, null, 3, true]);
});

test('ratings are validated, replaced per job, kept through a later note of the line, and never dropped without a copy', (t) => {
  const dir = home(t);
  addRating(dir, { by: 'codex', byModel: 'model-r', byJob: 'rv-1', items: { correctness: 2 }, fact: 'Lost writes under load.' }, WORKER_ITEMS.review);
  addRating(dir, { by: 'codex', byJob: 'cx-1', items: { findings: 4 }, fact: 'The race was real.' }, WORKER_ITEMS.delegate);
  addRating(dir, { by: 'codex', byJob: 'rv-1', items: { correctness: 4 }, fact: 'Second look.' }, WORKER_ITEMS.review);
  assert.deepEqual(loadNotes(dir).ratings.map((r) => [r.byJob, r.items]), [['cx-1', { findings: 4 }], ['rv-1', { correctness: 4 }]]);
  assert.throws(() => addRating(dir, { by: 'codex', byJob: 'rv-1', items: { findings: 4 }, fact: 'x' }, WORKER_ITEMS.review), /correctness, report/);
  assert.throws(() => addRating(dir, { by: 'codex', byJob: 'rv-1', items: { correctness: 4, brief: 9 } as never, fact: 'x' }, WORKER_ITEMS.review), /correctness, report/);
  assert.throws(() => addRating(dir, { by: 'codex', byJob: 'rv-1', items: { correctness: 6 }, fact: 'x' }, WORKER_ITEMS.review), /1 to 5/);
  assert.throws(() => addRating(dir, { by: 'codex', byJob: 'rv-1', items: { correctness: 4 }, fact: ' ' }, WORKER_ITEMS.review), /fact/);
  assert.equal(loadNotes(dir).ratings.length, 2);
  // The lead's rating of a job stays when the line is noted again without one, and a new one replaces it.
  addEvidence(dir, { ...input, job: 'cx-1', rating: { correctness: 4, brief: 5 } });
  assert.deepEqual(addEvidence(dir, { ...input, job: 'cx-1', text: 'Corrected.' }).evidence.rating, { correctness: 4, brief: 5 });
  assert.deepEqual(addEvidence(dir, { ...input, job: 'cx-1', rating: { brief: 2 } }).evidence.rating, { brief: 2 });
  // A rating a hand edit left without its fact is skipped on load, and the file is copied before a save erases it.
  const saved = JSON.parse(fs.readFileSync(notesFile(dir), 'utf8'));
  saved.ratings[0].fact = ' ';
  fs.writeFileSync(notesFile(dir), JSON.stringify(saved));
  assert.equal(loadNotes(dir).ratings.length, 1);
  addEvidence(dir, input);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('.dropped-')).length, 1);
});

test('scores that are all zero still rank by their finding rate', () => {
  const file = fixture(Array(3).fill({ findings: { high: 10000, medium: 0, low: 0 } }));
  file.models['model-b'] = { model: 'model-b', agent: 'codex', summary: '', summaryAt: null,
    evidence: Array.from({ length: 3 }, (_, i) => ({ ...input, model: 'model-b', id: `ev-b${i}`, at: i, findings: { high: 9000, medium: 0, low: 0 } })) };
  assert.deepEqual(scoreAll(file).map((s) => [s.model, s.score]), [['model-b', 0], ['model-a', 0]]);
});

test('the lead rates only a job\'s work, with the items of the line\'s role, and a review line names what it covered', (t) => {
  const dir = home(t);
  assert.throws(() => addEvidence(dir, { ...input, rating: { correctness: 4 } }), /only for a job's work/);
  assert.throws(() => addEvidence(dir, { ...input, job: 'cx-1', rating: { findings: 4 } }), /correctness, brief, report for build/);
  assert.throws(() => addEvidence(dir, { ...input, job: 'rv-1', role: 'review', of: { model: ' ' } }), /of \(the work the review covered/);
  assert.throws(() => addEvidence(dir, { ...input, of: { model: 'model-b' } }), /only for a review line/);
  const { evidence } = addEvidence(dir, { ...input, job: 'rv-1', role: 'review', of: { model: 'model-b' }, rating: { findings: 5 }, declined: high });
  assert.deepEqual([evidence.of, evidence.rating], [{ model: 'model-b' }, { findings: 5 }]);
  const text = renderNotes(scoreAll(loadNotes(dir)), loadNotes(dir));
  assert.match(text, /0 build\(s\), 0 fix\(es\), 1 review\(s\)/);
  assert.match(text, /rv-1 \(reviewed model-b, review, medium, declined 1 high, rated findings 5\)/);
});

test('a version 1 file is read as it is, and kept once when the first save rewrites it', (t) => {
  const dir = home(t);
  fs.mkdirSync(dir);
  const old = JSON.stringify({ version: 1, models: fixture([{}, { role: 'fix', outcome: 'patch' }]).models });
  fs.writeFileSync(notesFile(dir), old);
  assert.deepEqual([loadNotes(dir).models['model-a'].evidence.length, loadNotes(dir).ratings], [2, []]);
  addEvidence(dir, input);
  addEvidence(dir, input);
  assert.equal(JSON.parse(fs.readFileSync(notesFile(dir), 'utf8')).version, 2);
  assert.equal(fs.readFileSync(`${notesFile(dir)}.v1`, 'utf8'), old);
  assert.equal(fs.readdirSync(dir).filter((name) => name.includes('dropped')).length, 0);
});
