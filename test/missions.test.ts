import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Missions, STAGES, STALE_MS } from '../plugin/bridge/missions.ts';
import type { Mission } from '../plugin/bridge/missions.ts';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
const input = { title: 'Build the feature', project: '/project/worktree', root: '/project' };

function harness(t: TestContext) {
  const home = tempDir();
  const changes: Mission[] = [];
  const missions = new Missions(home, (mission) => changes.push({ ...mission }));
  t.after(() => {
    missions.flush();
    fs.rmSync(home, { recursive: true, force: true });
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
  for (const abandoned of [false, true]) {
    const mission = missions.finish(missions.start(input).id, { abandoned, outcome: 'Original result' });
    const before = { ...mission };
    const count = changes.length;
    assert.strictEqual(missions.finish(mission.id, { abandoned: !abandoned, outcome: 'Replacement' }), mission);
    assert.deepEqual(mission, before);
    assert.equal(changes.length, count);
  }
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
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
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
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const missions = new Missions(home, () => {});
  const quiet = [1, 2, 3].map((n) => missions.start({ title: `quiet ${n}`, project: '/quiet', root: '/quiet' }));
  // Ended in reverse of creation: the per-project choice must follow endedAt.
  for (const [i, mission] of [...quiet].reverse().entries()) missions.finish(mission.id).endedAt = 1000 + i;
  for (let n = 0; n < 101; n++) missions.finish(missions.start({ title: `busy ${n}`, project: '/busy', root: '/busy' }).id).endedAt = 5000 + n;
  const open = missions.start({ title: 'still open', project: '/other', root: '/other' });

  const saved = missions.saved();
  assert.ok(saved.includes(open));
  // 100 overall (all from the busy project) plus the two that ended last in the quiet one.
  assert.equal(saved.filter((m) => m.root === '/busy').length, 100);
  assert.deepEqual(saved.filter((m) => m.root === '/quiet').map((m) => m.title).sort(), ['quiet 1', 'quiet 2']);
});

test('a stored record that is not a mission is refused, since records are rendered on the board', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-missions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'missions.json');
  const good = { id: 'm-000001', title: 't', project: '/p', root: '/p', stage: 'plan', state: 'active', outcome: '', createdAt: 1, updatedAt: 1, endedAt: null };
  for (const bad of [{ ...good, createdAt: '1" onmouseover="x' }, { ...good, stage: 'nope' }, { ...good, endedAt: 'soon' }, { ...good, title: 5 }, null]) {
    const content = JSON.stringify({ missions: [good, bad] });
    fs.writeFileSync(file, content);
    assert.throws(() => new Missions(home, () => {}), /holds a record that is not a mission/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
  fs.writeFileSync(file, JSON.stringify({ missions: [good] }));
  assert.equal(new Missions(home, () => {}).list().length, 1);
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
