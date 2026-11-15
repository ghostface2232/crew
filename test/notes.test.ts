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
  assert.equal(score.score, 8);
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

test('build scores use difficulty, self-review weight and prior', () => {
  assert.equal(scoreAll(fixture([{}]))[0].score, 8);
  // (0.5 + 1.4) / 2.5 = 0.76.
  assert.equal(scoreAll(fixture([{ reviewer: 'codex' }]))[0].score, 7.6);
  assert.equal(scoreAll(fixture([{ findings: { high: 1, medium: 0, low: 0 } }]))[0].score, 6.8);
  // d = 1.625; weighted quality = d - 0.35; (1.275 + 1.4) / 3.625.
  assert.equal(scoreAll(fixture([{ tier: 'frontier', size: 'large', findings: { high: 1, medium: 0, low: 0 } }]))[0].score, 7.4);
  assert.equal(scoreAll(fixture([{ findings: { high: 100, medium: 0, low: 0 } }]))[0].score, 4.7);
});

test('fix outcomes score independently and overall combines roles', () => {
  for (const [outcome, expected] of [['root-cause', 8], ['patch', 6.5], ['another-review', 5.5]] as const) {
    const s = scoreAll(fixture([{ role: 'fix', outcome }]))[0];
    assert.equal(s.fix, expected);
    assert.equal(s.build, null);
    assert.equal(s.score, expected);
  }
  const s = scoreAll(fixture([{}, { role: 'fix', outcome: 'patch' }]))[0];
  assert.equal(s.score, 7.4);
  assert.equal(s.buildSamples, 1);
  assert.equal(s.fixSamples, 1);
});

test('calibration uses all builds and starts at five per reviewer', () => {
  const harsh = { reviewer: 'claude' as const, findings: { high: 2, medium: 0, low: 0 } };
  const clean = { reviewer: 'antigravity' as const };
  // Four harsh and four clean: no calibration; (4 * 0.3 + 4 + 1.4) / 10.
  assert.equal(scoreAll(fixture([...Array(4).fill(harsh), ...Array(4).fill(clean)]))[0].score, 6.6);
  // Five each: global mean .35, harsh mean .7 => c clamped to .75.
  assert.equal(scoreAll(fixture([...Array(5).fill(harsh), ...Array(5).fill(clean)]))[0].score, 7.3);
  const file = fixture(Array(5).fill(harsh));
  file.models.other = { model: 'other', agent: 'codex', summary: '', summaryAt: null, evidence: fixture(Array(5).fill(clean)).models['model-a'].evidence };
  assert.equal(scoreAll(file).find((s) => s.model === 'model-a')!.score, 5.4);
  assert.equal(scoreAll(fixture(Array(5).fill({})))[0].score, 9.1);
});

test('sample status thresholds and consolidation follow timestamps', (t) => {
  for (const [n, status] of [[0, 'too few samples'], [2, 'too few samples'], [3, 'on trial'], [7, 'on trial'], [8, 'settled']] as const) {
    assert.equal(scoreAll(fixture(Array(n).fill({})))[0].status, status);
  }
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
  const file = fixture([{ at, text: 'Latest.', job: 'cx-123' }, { at: at - 86400000, text: 'Older.' }]);
  file.models.empty = { model: 'empty', agent: 'claude', summary: '', summaryAt: null, evidence: [] };
  const scores = scoreAll(file);
  const text = renderNotes(scores, file, { models: ['model-a'], evidence: 1 });
  assert.match(text, /### model-a \(codex\)/);
  assert.match(text, /build 8.5 · fix —/);
  assert.match(text, /2026-11-15 cx-123 \(claude reviewed, build, standard\/medium\): Latest\./);
  assert.doesNotMatch(text, /Older/);
  assert.match(renderNotes(scores, file, { agents: ['claude'] }), /—\/10.*No summary yet\./s);
  assert.equal(renderNotes(scores, file, { models: [] }), '');
  assert.equal(renderNotes(scores, file, { models: ['empty'], agents: ['codex'] }), '');
  assert.doesNotMatch(renderNotes(scores, file, { evidence: 0 }), /Latest/);
  scores[0].consolidate = true;
  assert.match(renderNotes(scores, file), /Summary is due: rewrite it from the evidence\./);
});

test('scores sort descending, then by model with null last', () => {
  const file = fixture([{}]);
  for (const model of ['z', 'b', 'empty-z', 'empty-a']) file.models[model] = {
    model, agent: 'codex', summary: '', summaryAt: null,
    evidence: model.startsWith('empty') ? [] : fixture(model === 'z' ? [{ role: 'fix', outcome: 'patch' }] : [{}]).models['model-a'].evidence,
  };
  assert.deepEqual(scoreAll(file).map((s) => s.model), ['b', 'model-a', 'z', 'empty-a', 'empty-z']);
  assert.equal(scoreAll(file).at(-1)!.lastAt, null);
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
  assert.equal(scoreAll(file)[0].score, 8);
});
