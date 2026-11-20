import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { canonicalPath } from '../plugin/bridge/config.ts';
import { MAX_LABEL, missionDetail, missionPreset, Missions, planText, STAGES, STALE_HELD_MS, STALE_MS, waitsFor } from '../plugin/bridge/missions.ts';
import type { Mission } from '../plugin/bridge/missions.ts';
import type { PullWatch } from '../plugin/bridge/pulls.ts';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
// Canonical already, so stored keys equal these on every platform.
const input = { title: 'Build the feature', project: canonicalPath('/project/worktree'), root: canonicalPath('/project') };

test('plans allow repeats, advance to the next occurrence and insert stages after the current step', (t) => {
  const { home, missions } = harness(t);
  const stages = ['implement', 'self-review', 'fix', 'cross-review', 'fix', 'final'];
  const mission = missions.start({ ...input, stages });
  assert.equal(mission.stage, 'implement');
  assert.equal(mission.stageIndex, 0);
  assert.deepEqual(mission.stages, stages);
  missions.update(mission.id, { stage: 'self-review' });
  missions.update(mission.id, { stage: 'fix' });
  assert.equal(mission.stageIndex, 2);
  // Reporting the current step again, as a resumed lead does, adds no round.
  missions.update(mission.id, { stage: 'fix' });
  assert.equal(mission.stageIndex, 2);
  assert.deepEqual(mission.stages, stages);
  missions.update(mission.id, { stage: 'cross-review' });
  missions.update(mission.id, { stage: 'fix' });
  assert.equal(mission.stageIndex, 4);
  assert.equal(mission.stage, 'fix');
  missions.update(mission.id, { stage: 'cross-review' });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'fix', 'cross-review', 'fix', 'cross-review', 'final']);
  assert.equal(mission.stageIndex, 5);
  missions.flush();
  assert.deepEqual(new Missions(home, () => {}).get(mission.id), mission);
  missions.finish(mission.id);
  assert.equal(mission.stage, 'cross-review');
  assert.equal(mission.stageIndex, 5);
});

test('revising the remainder removes, adds and reorders future steps while preserving the immutable prefix', (t) => {
  const { home, missions } = harness(t);
  const mission = missions.start({ ...input, stages: ['implement', 'self-review', 'polish', 'final'] });
  missions.update(mission.id, { stage: 'self-review' });
  missions.update(mission.id, { stages: ['final'] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'final']);
  assert.equal(mission.stageIndex, 1);
  assert.equal(mission.stage, 'self-review');
  missions.update(mission.id, { stages: ['fix', 'cross-review', 'final'] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'fix', 'cross-review', 'final']);
  missions.update(mission.id, { stages: ['cross-review', 'fix', 'final'] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'cross-review', 'fix', 'final']);
  // Even a list omitting every passed/current step can only replace the future.
  missions.update(mission.id, { stages: ['polish'] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'polish']);
  missions.update(mission.id, { stage: 'fix', stages: ['fix', 'final'] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'fix', 'final']);
  assert.equal(mission.stageIndex, 2);
  missions.update(mission.id, { stages: [] });
  assert.deepEqual(mission.stages, ['implement', 'self-review', 'fix']);
  assert.equal(mission.stageIndex, 2);
  missions.flush();
  assert.deepEqual(new Missions(home, () => {}).get(mission.id), mission);
});

test('plans validate atomically on start and revision and do not alias caller arrays', (t) => {
  const { missions, changes } = harness(t);
  for (const stages of [[], ['unknown'], 'plan', null]) {
    assert.throws(() => missions.start({ ...input, stages }), /stages/);
  }
  assert.equal(missions.list().length, 0);
  const stages = ['cross-review', 'final'];
  const mission = missions.start({ ...input, stages, stage: 'final' });
  assert.equal(mission.stage, 'final');
  assert.equal(mission.stageIndex, 1);
  stages.reverse();
  assert.deepEqual(mission.stages, ['cross-review', 'final']);
  const before = structuredClone(mission);
  const count = changes.length;
  for (const stages of [[42], {}]) {
    assert.throws(() => missions.update(mission.id, { stages, stage: 'fix', title: 'Changed' }), /stages/);
    assert.deepEqual(mission, before);
  }
  assert.equal(changes.length, count);
});

test('legacy missions keep no plan when loaded or advanced and may adopt a remainder', (t) => {
  const { home, missions } = harness(t);
  const legacy = missions.start(input);
  assert.equal(legacy.stages, undefined);
  missions.flush();
  const loaded = new Missions(home, () => {});
  assert.deepEqual(loaded.get(legacy.id), legacy);
  loaded.update(legacy.id, { stage: 'cross-review' });
  assert.equal(loaded.get(legacy.id).stages, undefined);
  loaded.update(legacy.id, { stages: ['fix', 'final'] });
  assert.deepEqual(loaded.get(legacy.id).stages, ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'final']);
  assert.equal(loaded.get(legacy.id).stageIndex, 3);
  loaded.flush();
});

test('a step can carry its own name, which tells two steps of one stage apart', (t) => {
  const { home, missions } = harness(t);
  const mission = missions.start({ ...input, stages: ['plan', 'implement: Sample', '  implement :  The   rest ', 'self-review', 'final'] });
  assert.deepEqual(mission.stages, ['plan', 'implement', 'implement', 'self-review', 'final']);
  assert.deepEqual(mission.labels, [null, 'Sample', 'The rest', null, null]);
  assert.equal(planText(mission, (at) => (at === 0 ? ' (current)' : '')), 'plan (current) → implement: Sample → implement: The rest → self-review → final');
  missions.update(mission.id, { stage: 'implement' });
  assert.equal(mission.stageIndex, 1);
  // The stage alone is the current step again; the next step's name moves on.
  missions.update(mission.id, { stage: 'implement' });
  missions.update(mission.id, { stage: 'implement: sample' });
  assert.equal(mission.stageIndex, 1);
  missions.update(mission.id, { stage: 'implement: The rest' });
  assert.equal(mission.stageIndex, 2);
  // A name the plan does not have is a new step, and a revision keeps the names of what has passed.
  missions.update(mission.id, { stage: 'implement: Boss' });
  assert.deepEqual(mission.labels, [null, 'Sample', 'The rest', 'Boss', null, null]);
  assert.equal(mission.stageIndex, 3);
  missions.update(mission.id, { stages: ['fix: Fox only', 'final'] });
  assert.deepEqual(mission.stages, ['plan', 'implement', 'implement', 'implement', 'fix', 'final']);
  assert.deepEqual(mission.labels, [null, 'Sample', 'The rest', 'Boss', 'Fox only', null]);
  missions.flush();
  assert.deepEqual(new Missions(home, () => {}).get(mission.id), mission);
  // A plan left without names stores none, as one that never had any.
  const plain = missions.start({ ...input, title: 'Plain', stages: ['implement: Sample', 'final'], stage: 'final' });
  assert.deepEqual(plain.labels, ['Sample', null]);
  const none = missions.start({ ...input, title: 'None', stages: ['implement:', 'final'] });
  assert.equal(none.labels, undefined);
  assert.equal('x'.repeat(40).length > MAX_LABEL, true);
  assert.equal(missions.start({ ...input, title: 'Long', stages: [`implement: ${'x'.repeat(40)}`] }).labels?.[0]?.length, MAX_LABEL);
  // A cut that would split a character leaves it out whole: half of one is not valid JSON to the app.
  const cut = missions.start({ ...input, title: 'Emoji', stages: [`implement: ${'x'.repeat(MAX_LABEL - 1)}🎨 more`] }).labels?.[0];
  assert.deepEqual([cut, cut?.isWellFormed()], ['x'.repeat(MAX_LABEL - 1), true]);
  for (const stages of [['sample'], ['Sample: implement'], [': implement']]) assert.throws(() => missions.start({ ...input, stages }), /stages/);
  assert.throws(() => missions.update(mission.id, { stage: 'sample' }), /Invalid mission stage/);
});

function harness(t: TestContext) {
  const home = tempDir();
  const changes: Mission[] = [];
  const missions = new Missions(home, (mission) => changes.push({ ...mission }));
  t.after(() => {
    missions.flush();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  return { home, missions, changes };
}

test('a mission carries its normalized title through updates and completion, notifying once per change', (t) => {
  const { missions, changes } = harness(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const mission = missions.start({ ...input, title: '  Build the feature  \r\nMore details' });
  assert.match(mission.id, /^m-[0-9a-f]{6}$/);
  assert.deepEqual(mission, {
    id: mission.id, ...input, stage: 'plan', state: 'active', outcome: '',
    createdAt: now, updatedAt: now, endedAt: null,
  });
  assert.strictEqual(missions.get(mission.id), mission);
  assert.strictEqual(missions.list()[0], mission);
  assert.equal(changes.length, 1);

  now += 100;
  assert.strictEqual(missions.update(mission.id, { stage: 'cross-review', title: `  ${'x'.repeat(130)}\nDetails` }), mission);
  assert.equal(mission.title, 'x'.repeat(120));
  assert.equal(mission.updatedAt, now);
  assert.equal(changes.length, 2);
  now += 100;
  missions.update(mission.id, { stage: 'implement', title: '  Try again  \nDetails' });
  assert.equal(mission.stage, 'implement');
  assert.equal(mission.title, 'Try again');
  assert.equal(mission.updatedAt, now);
  assert.equal(changes.length, 3);

  now += 100;
  assert.strictEqual(missions.finish(mission.id, { outcome: '  Feature shipped  \nDetails' }), mission);
  assert.equal(mission.outcome, 'Feature shipped');
  assert.equal(mission.state, 'done');
  assert.equal(mission.endedAt, now);
  assert.equal(mission.updatedAt, now);
  assert.equal(mission.createdAt, 1_000);
  assert.equal(changes.length, 4);

  const long = missions.start({ ...input, title: `  ${'a'.repeat(119)} rest\nDetails` });
  assert.equal(long.title, 'a'.repeat(119));
  assert.equal(missions.finish(long.id, { outcome: 'b'.repeat(210) }).outcome, 'b'.repeat(200));
  assert.equal(long.record, undefined);

  const recorded = missions.start({ ...input, title: 'With a record' });
  assert.equal(missions.finish(recorded.id, { outcome: 'ok', record: '  Kept the old parser: the new one drops BOMs.\n' }).record, 'Kept the old parser: the new one drops BOMs.');
});

test('invalid stages and empty titles are rejected without changing a mission or notifying', (t) => {
  const { missions, changes } = harness(t);
  const titleError = { message: 'A mission needs a title: the command it carries out.' };
  for (const title of ['', ' \n\t', '  \nSecond line', null, 42]) {
    assert.throws(() => missions.start({ ...input, title: title as string }), titleError);
  }
  assert.deepEqual(missions.list(), []);
  assert.equal(changes.length, 0);
  const mission = missions.start(input);
  const before = { ...mission };
  assert.throws(() => missions.update(mission.id, { stage: 'unknown', title: 'Changed' }), (err: Error) => {
    assert.ok(err instanceof Error);
    for (const stage of STAGES) assert.ok(err.message.includes(stage));
    return true;
  });
  assert.throws(() => missions.update(mission.id, { stage: 'implement', title: ' \n' }), titleError);
  assert.deepEqual(mission, before);
  assert.equal(changes.length, 1);
});

test('updating a finished mission explains its terminal state', (t) => {
  const { missions, changes } = harness(t);
  for (const abandoned of [false, true]) {
    const mission = missions.finish(missions.start(input).id, { abandoned });
    const before = { ...mission };
    const count = changes.length;
    assert.throws(() => missions.update(mission.id, { stage: 'plan' }), {
      message: `Mission ${mission.id} is already ${mission.state}.`,
    });
    assert.deepEqual(mission, before);
    assert.equal(changes.length, count);
  }
});

test('finishing a mission again returns it unchanged without notifying', (t) => {
  const { missions, changes } = harness(t);
  for (const [first, again] of [[false, false], [false, true], [true, true]]) {
    const mission = missions.finish(missions.start(input).id, { abandoned: first, outcome: 'Original result' });
    const before = { ...mission };
    const count = changes.length;
    assert.strictEqual(missions.finish(mission.id, { abandoned: again, outcome: 'Replacement' }), mission);
    assert.deepEqual(mission, before);
    assert.equal(changes.length, count);
  }
});

test('an abandoned mission is marked done only by an explicit reopen, once', (t) => {
  const { missions, changes } = harness(t);
  const mission = missions.finish(missions.start(input).id, { abandoned: true, outcome: 'Superseded by a new mission.' });
  const count = changes.length;
  // A plain done, such as a lead's late one, leaves the user's Stop tracking in place.
  missions.finish(mission.id, { outcome: 'Done by the lead.' });
  assert.equal(mission.state, 'abandoned');
  assert.equal(changes.length, count);
  missions.finish(mission.id, { outcome: 'Marked done in Crew.', reopen: true });
  assert.equal(mission.state, 'done');
  assert.equal(mission.outcome, 'Marked done in Crew.');
  assert.equal(changes.length, count + 1);
  const before = { ...mission };
  missions.finish(mission.id, { abandoned: true, outcome: 'Again' });
  assert.deepEqual(mission, before);
});

test('completion sets the final stage while abandonment keeps the current stage', (t) => {
  const { missions } = harness(t);
  for (const abandoned of [false, true]) {
    const mission = missions.start(input);
    missions.update(mission.id, { stage: 'self-review' });
    if (abandoned) missions.finish(mission.id, { abandoned });
    else missions.finish(mission.id);
    assert.equal(mission.stage, abandoned ? 'self-review' : 'final');
    assert.equal(mission.state, abandoned ? 'abandoned' : 'done');
    assert.equal(mission.outcome, '');
  }
});

test('sweeping abandons only stale non-busy active missions and touching keeps one alive without notifying', (t) => {
  const { missions, changes } = harness(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const stale = missions.start(input);
  const busy = missions.start(input);
  const touched = missions.start(input);
  const done = missions.finish(missions.start(input).id);
  const abandoned = missions.finish(missions.start(input).id, { abandoned: true });
  const doneBefore = { ...done };
  const abandonedBefore = { ...abandoned };
  now += 1;
  const fresh = missions.start(input);
  now = 1_000 + STALE_MS;
  const count = changes.length;
  missions.touch(touched.id);
  missions.touch(done.id);
  missions.touch(abandoned.id);
  missions.touch('missing');
  assert.equal(touched.updatedAt, now);
  assert.equal(changes.length, count);
  const checked: string[] = [];
  assert.deepEqual(missions.sweep(now, (id) => {
    checked.push(id);
    return id === busy.id;
  }), [stale]);
  assert.deepEqual(checked, [stale.id, busy.id]);
  assert.equal(stale.state, 'abandoned');
  assert.equal(stale.stage, 'plan');
  assert.equal(stale.outcome, 'No update for 12 hours.');
  assert.equal(stale.endedAt, now);
  assert.equal(changes.length, count + 1);
  for (const mission of [busy, touched, fresh]) assert.equal(mission.state, 'active');
  assert.deepEqual(done, doneBefore);
  assert.deepEqual(abandoned, abandonedBefore);
});

test('flushing and reloading preserves active missions, activity, finished results, and newest-first order', (t) => {
  const { home, missions } = harness(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const active = missions.start(input);
  missions.update(active.id, { stage: 'fix' });
  now += 100;
  const done = missions.finish(missions.start(input).id, { outcome: 'Shipped' });
  now += 100;
  missions.touch(active.id);
  missions.flush();
  const loaded = new Missions(home, () => assert.fail('Loading must not notify.'));
  assert.deepEqual(loaded.list(), [done, active]);
  assert.equal(loaded.get(active.id).state, 'active');
  assert.equal(loaded.get(active.id).updatedAt, now);
  assert.equal(fs.existsSync(path.join(home, 'missions.json.tmp')), false);
});

test('unparsable and wrongly shaped mission files throw with their path and remain untouched', (t) => {
  const home = tempDir();
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(home, 'missions.json');
  for (const content of ['{ not json', '{}', 'null', '[]', '"text"', '{"missions":{}}', '{"missions":null}']) {
    fs.writeFileSync(file, content);
    assert.throws(() => new Missions(home, () => {}), (err: Error) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(file));
      return true;
    });
    assert.equal(fs.readFileSync(file, 'utf8'), content);
    assert.equal(fs.existsSync(`${file}.tmp`), false);
  }
});

test('saving keeps all active missions and only the hundred most recently ended finished missions', (t) => {
  const { home, missions } = harness(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const active = [missions.start(input)];
  const finished: Mission[] = [];
  for (let i = 0; i < 105; i++) {
    now += 1;
    finished.push(missions.start(input));
    if (i === 50) active.push(missions.start(input));
  }
  for (const mission of finished.toReversed()) {
    now += 1;
    missions.finish(mission.id, { abandoned: now % 2 === 0 });
  }
  missions.flush();
  const loaded = new Missions(home, () => {});
  assert.equal(loaded.list().length, 102);
  // They ended in reverse of creation, so the ones that ended last are the ones created first.
  assert.deepEqual(loaded.list().filter((mission) => mission.state !== 'active'), finished.slice(0, 100).toReversed());
  for (const mission of active) assert.deepEqual(loaded.get(mission.id), mission);
  assert.equal(new Set(missions.list().map((mission) => mission.id)).size, 107);
});

test('getting or changing an unknown mission reports the missing id', (t) => {
  const { missions } = harness(t);
  for (const operation of [() => missions.get('missing'), () => missions.update('missing', {}), () => missions.finish('missing')]) {
    assert.throws(operation, { message: 'No mission with id "missing".' });
  }
});

test('changes and silent touches are saved after the debounce delay', async (t) => {
  const { home, missions, changes } = harness(t);
  const file = path.join(home, 'missions.json');
  const mission = missions.start(input);
  assert.equal(fs.existsSync(file), false);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).missions, [mission]);
  missions.touch(mission.id);
  assert.equal(changes.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).missions, [mission]);
});

test('what is saved keeps the last finished missions of every project, by when they ended', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const missions = new Missions(home, () => {});
  const quiet = [1, 2, 3].map((n) => missions.start({ title: `quiet ${n}`, project: '/quiet', root: '/quiet' }));
  // Ended in reverse of creation: the per-project choice must follow endedAt.
  for (const [i, mission] of [...quiet].reverse().entries()) missions.finish(mission.id).endedAt = 1000 + i;
  for (let n = 0; n < 101; n++) missions.finish(missions.start({ title: `busy ${n}`, project: '/busy', root: '/busy' }).id).endedAt = 5000 + n;
  const open = missions.start({ title: 'still open', project: '/other', root: '/other' });

  const saved = missions.saved();
  assert.ok(saved.includes(open));
  // 100 overall (all from the busy project) plus the two that ended last in the quiet one.
  assert.equal(saved.filter((m) => m.root === canonicalPath('/busy')).length, 100);
  assert.deepEqual(saved.filter((m) => m.root === canonicalPath('/quiet')).map((m) => m.title).sort(), ['quiet 1', 'quiet 2']);
});

test('a stored record that is not a mission is refused, since records are rendered on the board', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(home, 'missions.json');
  const good = { id: 'm-000001', title: 't', project: '/p', root: '/p', stage: 'plan', state: 'active', outcome: '', createdAt: 1, updatedAt: 1, endedAt: null };
  for (const bad of [{ ...good, createdAt: '1" onmouseover="x' }, { ...good, stage: 'nope' }, { ...good, stages: [] }, { ...good, stages: ['plan'], stageIndex: 1 }, { ...good, stages: ['plan'], stageIndex: 0.5 }, { ...good, stageIndex: 0 }, { ...good, stages: ['unknown'] }, { ...good, endedAt: 'soon' }, { ...good, title: 5 }, null]) {
    const content = JSON.stringify({ missions: [good, bad] });
    fs.writeFileSync(file, content);
    assert.throws(() => new Missions(home, () => {}), /holds a record that is not a mission/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  fs.writeFileSync(file, JSON.stringify({ missions: [good] }));
  assert.equal(new Missions(home, () => {}).list().length, 1);
  // A daemon from before names changed this plan and left the names behind: the missions load, without the names.
  fs.writeFileSync(file, JSON.stringify({ missions: [good, { ...good, id: 'm-000002', stage: 'implement', stages: ['plan', 'implement', 'final'], stageIndex: 1, labels: [null, 'Sample'] }] }));
  const kept = new Missions(home, () => {}).list();
  assert.deepEqual([kept.length, kept.find((m) => m.id === 'm-000002')?.labels], [2, undefined]);
});

test('a mission remembers the session that opened it, and only as a string', (t) => {
  const { missions, home } = harness(t);
  const mine = missions.start({ ...input, owner: 'session-a' });
  assert.equal(mine.owner, 'session-a');
  assert.ok(!('owner' in missions.start({ ...input, title: 'Unowned' })));
  missions.flush();
  const file = path.join(home, 'missions.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.missions.find((m: Mission) => m.id === mine.id).owner, 'session-a');
  saved.missions[0].owner = 7;
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.throws(() => new Missions(home, () => {}), /holds a record that is not a mission/);
});

test('a note is pinned to an open mission, saved with it, and refused where it would add nothing', (t) => {
  const { home, missions, changes } = harness(t);
  const mission = missions.start(input);
  changes.length = 0;

  const noted = missions.note(mission.id, '  The API key rotates on Friday.  ');
  assert.deepEqual(noted.notes?.map((n) => n.text), ['The API key rotates on Friday.']);
  assert.equal(noted.stage, 'plan');
  assert.equal(changes.length, 1);
  assert.throws(() => missions.note(mission.id, '   '), /needs some text/);
  assert.throws(() => missions.note('m-none', 'x'), /No mission/);

  missions.flush();
  const reloaded = new Missions(home, () => {});
  assert.deepEqual(reloaded.get(mission.id).notes?.map((n) => n.text), ['The API key rotates on Friday.']);

  for (let i = 1; i < 20; i++) missions.note(mission.id, `note ${i}`);
  assert.throws(() => missions.note(mission.id, 'one too many'), /already has 20 notes/);
  missions.finish(mission.id);
  assert.throws(() => missions.note(mission.id, 'late'), /already done/);
});

test('jumping ahead drops the skipped steps, and a plan has at most thirty steps', (t) => {
  const { missions } = harness(t);
  const mission = missions.start({ ...input, stages: ['implement', 'self-review', 'polish', 'final'] });
  missions.update(mission.id, { stage: 'final' });
  assert.deepEqual(mission.stages, ['implement', 'final']);
  assert.equal(mission.stageIndex, 1);
  assert.throws(() => missions.start({ ...input, title: 'Too long', stages: Array(31).fill('fix') }), /at most 30/);
  // An inserted starting stage counts too; a 31-step plan would not load again.
  assert.throws(() => missions.start({ ...input, title: 'Too long', stages: Array(30).fill('plan'), stage: 'fix' }), /at most 30/);
  const full = missions.start({ ...input, title: 'Full', stages: Array(30).fill('fix') });
  assert.throws(() => missions.update(full.id, { stage: 'polish' }), /at most 30/);
  assert.equal(full.stages!.length, 30);
});

test('saved missions get canonical project keys when they load', (t) => {
  const { home, missions } = harness(t);
  const mission = missions.start({ ...input, project: '/project/x/../worktree/', root: '/project/' });
  assert.equal(mission.project, canonicalPath('/project/worktree'));
  assert.equal(mission.root, canonicalPath('/project'));
  missions.flush();
  const file = path.join(home, 'missions.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.missions[0].project = '/project/worktree/';
  fs.writeFileSync(file, JSON.stringify(saved));
  assert.equal(new Missions(home, () => {}).get(mission.id).project, canonicalPath('/project/worktree'));
});

test('a mission keeps the preset it was given until it is changed or cleared, and refuses one that is not a preset', (t) => {
  const { home, missions } = harness(t);
  const mission = missions.start({ ...input, preset: 'economy' });
  assert.equal(mission.preset, 'economy');
  assert.equal(missionPreset(mission, 'best'), 'economy');
  // Left out means unchanged, as when a step is reported.
  assert.equal(missions.update(mission.id, { stage: 'implement' }).preset, 'economy');
  assert.equal(missions.update(mission.id, { preset: 'best' }).preset, 'best');
  assert.equal(Object.hasOwn(missions.update(mission.id, { preset: null }), 'preset'), false);
  assert.equal(missionPreset(missions.get(mission.id), 'balanced'), 'balanced');
  assert.throws(() => missions.update(mission.id, { preset: 'cheap' }), /preset must be one of: economy, balanced, best, or null/);
  assert.throws(() => missions.start({ ...input, preset: 'cheap' }), /preset must be one of/);
  missions.update(mission.id, { preset: 'economy' });
  missions.flush();
  // Kept across a restart.
  assert.equal(new Missions(home, () => {}).get(mission.id).preset, 'economy');
});

test('a lead whose latest mission ended done is reminded to open one for more work', (t) => {
  const { missions } = harness(t);
  const first = missions.start({ ...input, title: '역할 정리', owner: 'lead' });
  assert.equal(missions.followUpHint('lead'), '', 'an open mission needs no reminder');
  missions.finish(first.id, { byLead: true });
  assert.match(missions.followUpHint('lead'), /"역할 정리" is done[^]*"후속 작업: 역할 정리"/);
  assert.equal(missions.followUpHint('other'), '', 'only the session that finished it is reminded');
  assert.equal(missions.followUpHint('lead', first.endedAt! + STALE_MS), '', 'a mission done long ago is left alone');
  const next = missions.start({ ...input, title: 'Next', owner: 'lead' });
  next.createdAt = first.createdAt + 1;
  assert.equal(missions.followUpHint('lead'), '');
  missions.finish(next.id, { abandoned: true });
  assert.equal(missions.followUpHint('lead'), '', 'a dropped command opens nothing');
  // Marked done on the board, or reopened as done there after the sweep: the lead carries on without a new mission.
  const board = missions.start({ ...input, title: 'Board', owner: 'lead' });
  board.createdAt = first.createdAt + 2;
  missions.finish(board.id, { outcome: 'Marked done on the board.' });
  assert.equal(missions.followUpHint('lead'), '');
  const swept = missions.start({ ...input, title: 'Swept', owner: 'lead' });
  swept.createdAt = first.createdAt + 3;
  missions.finish(swept.id, { abandoned: true, outcome: 'No update for 12 hours.' });
  missions.finish(swept.id, { reopen: true });
  assert.equal(swept.state, 'done');
  assert.equal(missions.followUpHint('lead'), '');
  // A newer mission done while an older one is still open, as after a restart of the MCP server: the open one stands.
  const older = missions.start({ ...input, title: 'Older', owner: 'lead' });
  older.createdAt = first.createdAt + 4;
  const newer = missions.start({ ...input, title: 'Newer', owner: 'lead' });
  newer.createdAt = first.createdAt + 5;
  missions.finish(newer.id, { byLead: true });
  assert.equal(missions.followUpHint('lead'), '');
  missions.finish(older.id, { abandoned: true });
  // The reminder follows the mission that ended last, and here that is the dropped one. Both can end within one
  // millisecond, so the order is pinned.
  older.endedAt = newer.endedAt! + 1;
  assert.equal(missions.followUpHint('lead'), '');
  older.endedAt = newer.endedAt! - 1;
  assert.match(missions.followUpHint('lead'), /"Newer" is done/);
});

test('tasks are laid over the mission by id, and a list that does not hold together changes nothing', (t) => {
  const { home, missions } = harness(t);
  const mission = missions.start({ ...input, tasks: [{ id: 'api', title: 'Add the route' }, { id: 'ui', title: 'Show it\nsecond line', after: ['api'] }] });
  assert.deepEqual(mission.tasks, [{ id: 'api', title: 'Add the route', state: 'todo' }, { id: 'ui', title: 'Show it', state: 'todo', after: ['api'] }]);
  // An update names only what changed; the rest of the task, and the other tasks, stay.
  missions.update(mission.id, { tasks: [{ id: 'api', state: 'done', result: 'npm test passed' }, { id: 'docs', title: 'Write it up', after: ['ui', 'ui'] }] });
  assert.deepEqual(mission.tasks, [
    { id: 'api', title: 'Add the route', state: 'done', result: 'npm test passed' },
    { id: 'ui', title: 'Show it', state: 'todo', after: ['api'] },
    { id: 'docs', title: 'Write it up', state: 'todo', after: ['ui'] },
  ]);
  const before = structuredClone(mission.tasks);
  for (const [tasks, reason] of [
    [[{ id: 'api', after: ['docs'] }], /circle: api → docs → ui → api/],
    [[{ id: 'ui', after: ['ui'] }], /circle/],
    [[{ id: 'ui', after: ['nope'] }], /waits for "nope", which is not a task/],
    [[{ id: 'new' }], /needs a title/],
    [[{ id: 'bad id', title: 'x' }], /task id is/],
    [[{ id: 'api', state: 'finished' }], /use one of: todo, doing, done, dropped/],
    [[{ id: 'docs', state: 'done' }, { id: 'ui', after: 'api' }], /after is a list/],
    ['api', /tasks is a list/],
  ] as const) {
    assert.throws(() => missions.update(mission.id, { tasks }), reason);
    assert.deepEqual(mission.tasks, before, 'a refused list leaves every task as it was');
  }
  // Clearing after and result, and a plan with nothing but a stage change keeps the tasks.
  missions.update(mission.id, { tasks: [{ id: 'docs', after: [], result: '' }] });
  assert.deepEqual(mission.tasks!.at(-1), { id: 'docs', title: 'Write it up', state: 'todo' });
  missions.update(mission.id, { stage: 'implement' });
  assert.equal(mission.tasks!.length, 3);
  assert.throws(() => missions.update(mission.id, { tasks: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, title: 'more' })) }), /at most 40 tasks/);
  missions.flush();
  assert.deepEqual(new Missions(home, () => {}).get(mission.id).tasks, mission.tasks);
});

test('the detail shows each task with what it waits for and the jobs done for it, read from the jobs', (t) => {
  const { missions } = harness(t);
  const mission = missions.start({ ...input, tasks: [
    { id: 'a', title: 'First', state: 'done', result: 'checked by hand' }, { id: 'b', title: 'Second', state: 'doing' },
    { id: 'c', title: 'Third', after: ['a', 'b'] }, { id: 'd', title: 'Fourth', after: ['a'] }, { id: 'e', title: 'Fifth' },
    { id: 'x', title: 'Dropped', state: 'dropped' }, { id: 'y', title: 'Blocked', after: ['x'] },
  ] });
  assert.deepEqual(waitsFor(mission.tasks!, mission.tasks![2]).map((task) => task.id), ['b']);
  const job = (id: string, state: string, createdAt: number, exit?: number | null): any => ({ id, mission: mission.id, taskId: 'b', state, createdAt,
    ...(exit === undefined ? {} : { receipts: [{ turn: 1, head: null, at: 0, check: { command: 'npm test', exit, timedOut: false, output: '', ms: 1, sandboxed: true } }] }) });
  const text = missionDetail(mission, [job('cx-1', 'done', 1, 0), job('cx-2', 'failed', 2, 1), job('cx-3', 'running', 3), { ...job('cx-9', 'running', 4), mission: 'other' }], []);
  assert.match(text, /^Tasks \(1 of 6 done\):/);
  assert.match(text, /- \[done\] a: First — checked by hand$/m);
  // The older success is left out: the job that ended last failed, and one is still running.
  assert.match(text, /- \[doing\] b: Second · cx-3 running$/m);
  assert.match(text, /- \[todo\] c: Third · waits for b$/m);
  assert.match(text, /- \[todo\] d: Fourth · ready$/m);
  assert.match(text, /- \[todo\] y: Blocked · waits for x \(dropped: take it out of after\)$/m);
  assert.match(text, /^d, e wait for nothing: those that touch different files can go at the same time\.$/m);
  assert.match(missionDetail(mission, [job('cx-1', 'done', 1, 0), job('cx-2', 'failed', 2, 1)], []), /b: Second · cx-2 failed, check failed with exit 1$/m);
  assert.match(missionDetail(mission, [job('cx-1', 'done', 1, null)], []), /cx-1 done, check stopped$/m);
  const pull = { id: 'pr-abc123', repo: 'o/r', number: 7, mission: mission.id, state: 'open', checks: 'failing', review: 'changes_requested', conflict: true, held: true,
    told: { head: 'h', checks: ['CI / test'] }, checkedAt: 1_000 } as PullWatch;
  assert.match(missionDetail(mission, [], [pull, { ...pull, id: 'pr-other', mission: 'other' }], 1_000 + 5 * 60_000),
    /Pull requests:\n- pr-abc123 o\/r#7 open · checks failing \(CI \/ test\) · changes requested · conflicts with its base · check failures held back[^\n]* · checked 5m ago$/);
  assert.match(missionDetail(mission, [], [{ ...pull, state: 'merged', ended: true }]), /- pr-abc123 o\/r#7 merged · no longer watched$/);
  assert.equal(missionDetail(missions.start({ ...input, title: 'Bare' }), [], []), '');
});

test('a session that starts again is shown its open missions with their tasks, and no one else\'s', (t) => {
  const { missions } = harness(t);
  assert.equal(missions.resumeText('lead', [], []), '');
  const first = missions.start({ ...input, title: 'First', owner: 'lead', stages: ['plan', 'implement'], tasks: [{ id: 'a', title: 'Alpha' }] });
  missions.start({ ...input, title: 'Theirs', owner: 'other' });
  const one = missions.resumeText('lead', [], []);
  assert.match(one, /^Crew: this session has a mission open, as recorded\./);
  assert.match(one, new RegExp(`Mission ${first.id} · plan \\(step 1 of 2\\) — First\\nPlan: plan \\(current\\) → implement\\nTasks \\(0 of 1 done\\):\\n- \\[todo\\] a: Alpha · ready`));
  assert.doesNotMatch(one, /Theirs|name the mission/);
  const second = missions.start({ ...input, title: 'Second', owner: 'lead' });
  second.createdAt = first.createdAt + 1;
  const two = missions.resumeText('lead', [], []);
  assert.match(two, /has 2 missions open[^]*name the mission each call is for/);
  assert.ok(two.indexOf('First') < two.indexOf('Second'), 'oldest first, as the work began');
  // A finished mission is not listed, but its pull request is still this session's to hear about.
  missions.finish(first.id, { byLead: true });
  missions.finish(second.id, { byLead: true });
  const pull = { id: 'pr-abc123', repo: 'o/r', number: 7, mission: first.id, state: 'open' } as PullWatch;
  assert.equal(missions.resumeText('lead', [], [{ ...pull, ended: true }]), '');
  assert.match(missions.resumeText('lead', [], [pull]), new RegExp(`^Crew still watches o/r#7 \\(pr-abc123, mission ${first.id}, done\\)`));
  // Bounded, however much a session left open.
  for (let i = 0; i < 12; i++) missions.start({ ...input, title: `Long ${i}`, owner: 'lead', tasks: Array.from({ length: 30 }, (_, n) => ({ id: `t${n}`, title: 'x'.repeat(100) })) });
  assert.ok(missions.resumeText('lead', [], []).length < 6200);
  assert.match(missions.resumeText('lead', [], []), /… \(cut; call mission with an id for the rest\)$/);
});

test('a mission with an open task or a watched pull request is waited for longer before it is swept', (t) => {
  const { missions } = harness(t);
  let now = 1_000;
  t.mock.method(Date, 'now', () => now);
  const plain = missions.start(input);
  const tasked = missions.start({ ...input, title: 'Tasked', tasks: [{ id: 'a', title: 'Alpha' }] });
  const finished = missions.start({ ...input, title: 'All done', tasks: [{ id: 'a', title: 'Alpha', state: 'done' }, { id: 'b', title: 'Beta', state: 'dropped' }] });
  const watched = missions.start({ ...input, title: 'Watched' });
  const held = (id: string) => id === watched.id;
  now = 1_000 + STALE_MS;
  assert.deepEqual(missions.sweep(now, () => false, held), [plain, finished]);
  assert.equal(plain.outcome, 'No update for 12 hours.');
  now = 1_000 + STALE_HELD_MS;
  assert.deepEqual(missions.sweep(now, () => false, held), [tasked, watched]);
  assert.equal(tasked.outcome, 'No update for 72 hours.');
});

test('the same title from the same session is one card, and the reminder follows the mission that ended last', (t) => {
  const { missions } = harness(t);
  const first = missions.start({ ...input, title: 'Same', owner: 'lead' });
  assert.equal(missions.start({ ...input, title: 'Same', owner: 'lead' }), first, 'a retry or a batch opens no second card');
  assert.notEqual(missions.start({ ...input, title: 'Same', owner: 'other' }), first);
  assert.notEqual(missions.start({ ...input, title: 'Same' }), missions.start({ ...input, title: 'Same' }), 'sessions that name no owner cannot be told apart');
  assert.notEqual(missions.start({ ...input, title: 'Same', owner: 'lead', project: canonicalPath('/elsewhere') }), first);
  // Opened later but ended first: the hint is about the one that ended last.
  const { missions: own } = harness(t);
  const long = own.start({ ...input, title: 'Long one', owner: 'lead' });
  const short = own.start({ ...input, title: 'Short one', owner: 'lead' });
  short.createdAt = long.createdAt + 1;
  own.finish(short.id, { byLead: true });
  short.endedAt = long.createdAt + 2;
  assert.equal(own.followUpHint('lead'), '', 'the long one is still open');
  own.finish(long.id, { byLead: true });
  long.endedAt = long.createdAt + 3;
  assert.match(own.followUpHint('lead', long.createdAt + 4), /"Long one" is done/);
});
