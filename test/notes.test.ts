import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { addEvidence, loadNotes, notesFile, renderNotes, scoreAll, setSummary } from '../plugin/bridge/notes.ts';
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
  return { version: 1, models: { 'model-a': { model: 'model-a', agent: 'codex', summary: '', summaryAt: null,
    evidence: lines.map((e, i) => ({ ...input, id: `ev-${i}`, at: i, ...e })) } } };
}

test('round trip creates home and atomically replaces the file', (t) => {
  const dir = home(t);
  assert.deepEqual(loadNotes(dir), { version: 1, models: {} });
  const { evidence, score } = addEvidence(dir, { ...input, at: 42, text: '  First\nsecond  ', findings: {} as Evidence['findings'] });
  assert.match(evidence.id, /^ev-[0-9a-f]{6}$/);
  assert.equal(evidence.at, 42);
  assert.equal(evidence.text, 'First second');
  assert.deepEqual(evidence.findings, { high: 0, medium: 0, low: 0 });
  assert.equal(score.score, 7.6);
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
  // Alone, a model starts at the reference rate 0.36 with the weight of three medium changes: 1.08 / 4 = 0.27, 10·e^-0.27.
  assert.equal(scoreAll(fixture([{}]))[0].score, 7.6);
  // A self-review counts half: 1.08 / 3.5.
  assert.equal(scoreAll(fixture([{ reviewer: 'codex' }]))[0].score, 7.3);
  assert.equal(scoreAll(fixture([{ findings: { high: 1, medium: 0, low: 0 } }]))[0].score, 7.0);
  // A large change has twice the exposure; the tier changes nothing.
  const large = scoreAll(fixture([{ size: 'large', findings: { high: 1, medium: 0, low: 0 } }]))[0].score;
  assert.equal(large, 7.5);
  for (const tier of ['fast', 'frontier'] as const) assert.equal(scoreAll(fixture([{ tier, size: 'large', findings: { high: 1, medium: 0, low: 0 } }]))[0].score, large);
  // Every further finding costs more: nothing is clamped.
  const highs = [3, 10, 100].map((high) => scoreAll(fixture([{ findings: { high, medium: 0, low: 0 } }]))[0].score!);
  assert.deepEqual(highs, [5.9, 3.2, 0]);
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

test('reviewers are not calibrated, and each other model counts once in the start', () => {
  // The same findings score the same whoever reviewed them, apart from a self-review's half weight.
  const harsh = { reviewer: 'antigravity' as const, findings: { high: 2, medium: 0, low: 0 } };
  assert.equal(scoreAll(fixture(Array(5).fill(harsh)))[0].score, scoreAll(fixture(Array(5).fill({ ...harsh, reviewer: 'claude' })))[0].score);
  // A busy clean model and a sparse poor one set the start together, not by their line counts.
  const file = fixture([{}, {}, {}]);
  const lines = (n: number, e: Partial<Evidence>) => fixture(Array(n).fill(e)).models['model-a'].evidence;
  file.models.busy = { model: 'busy', agent: 'codex', summary: '', summaryAt: null, evidence: lines(100, {}) };
  file.models.sparse = { model: 'sparse', agent: 'codex', summary: '', summaryAt: null, evidence: lines(5, { findings: { high: 2, medium: 0, low: 0 } }) };
  assert.deepEqual(scoreAll(file).map((s) => [s.model, s.score]), [['busy', 9.9], ['model-a', 8.5], ['sparse', 6]]);
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
  assert.match(text, /### model-a \(codex\) — 8\.1\/10, too few samples, 2 build\(s\), 0 fix\(es\)/);
  assert.match(text, /build 8\.1 · fix —/);
  assert.match(text, /builds by tier: frontier 1/);
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
  // Both show 9.0; the one with fewer findings comes first, whatever its name.
  const low = { findings: { high: 0, medium: 0, low: 1 } };
  const tie = fixture([...Array(7).fill(low), { findings: { high: 0, medium: 0, low: 2 } }]);
  tie.models.b = { model: 'b', agent: 'codex', summary: '', summaryAt: null, evidence: fixture(Array(8).fill(low)).models['model-a'].evidence };
  assert.deepEqual(scoreAll(tie).map((s) => [s.model, s.score]), [['b', 9], ['model-a', 9]]);
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
  assert.equal(scoreAll(file)[0].score, 7.6);
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

test('a model with few reviews starts where the others stand and ranks after every model with enough', () => {
  const file = fixture(Array(8).fill({ findings: { high: 0, medium: 1, low: 0 } }));
  file.models.fresh = { model: 'fresh', agent: 'codex', summary: '', summaryAt: null, evidence: fixture([{}, {}]).models['model-a'].evidence };
  const [settled, fresh] = scoreAll(file);
  // The fresh one starts between the settled model's rate, (1.2 + 1.08) / 11, and the reference 0.36.
  assert.deepEqual([settled.model, settled.score, settled.status], ['model-a', 8.3, 'settled']);
  // Two clean reviews lift it above the settled model's score, but not above it in the ranking.
  assert.deepEqual([fresh.model, fresh.score, fresh.status], ['fresh', 8.4, 'too few samples']);
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
  // The same findings on bigger changes are a lower rate: (6 + 3·0.36) / (40 + 3) for large, / (80 + 3) for xlarge.
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
  const bad: Partial<Evidence>[] = [{ adoption: 'as-is' }, { job: 'cx-2', adoption: 'merged' as Evidence['adoption'] }, { job: 'cx-3', rounds: 1 }, { job: 'cx-4', adoption: 'partly', rounds: 1 }];
  fs.writeFileSync(notesFile(dir), JSON.stringify(fixture(bad)));
  assert.deepEqual(loadNotes(dir).models['model-a'].evidence.map((e) => e.job), ['cx-4']);
});
