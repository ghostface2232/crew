import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cardHtml, cardView } from '../plugin/bridge/card.ts';
import type { Mission } from '../plugin/bridge/missions.ts';
import type { JobView } from '../plugin/bridge/render.ts';

const mission = (over: Partial<Mission>): Mission => ({
  id: 'm-1', title: 'Arrival motion', project: '/p', root: '/p', stage: 'cross-review', stages: ['plan', 'implement', 'cross-review', 'polish'], stageIndex: 2,
  state: 'active', outcome: '', createdAt: 1, updatedAt: 1, endedAt: null, ...over,
});
const job = (over: Partial<JobView>): JobView => ({ id: 'j', agent: 'codex', title: 'Build', state: 'running', createdAt: 100, endedAt: null, project: '/p', ...over } as JobView);

test('the card shows a mission\'s track and its jobs, those under way first', () => {
  const view = cardView([mission({ labels: [null, 'Sample', null, null] })], [
    job({ id: 'a', title: 'Old', state: 'done', createdAt: 10, endedAt: 50, mission: 'm-1' }),
    job({ id: 'b', title: 'Review', agent: 'antigravity', state: 'waiting', createdAt: 60, mission: 'm-1' }),
    job({ id: 'c', title: 'Elsewhere', mission: 'm-2' }),
  ], 1000);
  assert.equal(view.asOf, 1000);
  assert.deepEqual(view.missions[0].steps, [{ stop: 0, label: null }, { stop: 1, label: 'Sample' }, { stop: 2, label: null }, { stop: 4, label: null }]);
  assert.equal(view.missions[0].at, 2);
  assert.deepEqual(view.missions[0].jobs.map((j) => j.title), ['Review', 'Old']);
  assert.deepEqual(view.jobs, []);
});

test('a finished mission shows every stop passed, and without missions the card lists the jobs under way', () => {
  assert.equal(cardView([mission({ state: 'done', endedAt: 5 })], []).missions[0].at, 4);
  // The original full track, for missions opened before plans.
  assert.equal(cardView([mission({ stages: undefined, stageIndex: undefined, stage: 'fix' })], []).missions[0].steps.length, 6);
  const loose = cardView([], [job({ id: 'a' }), job({ id: 'b', state: 'done', endedAt: 200 })]);
  assert.deepEqual(loose.jobs.map((j) => j.state), ['running']);
});

test('the card page carries the board\'s marks in the text color and a script that parses', () => {
  const html = cardHtml();
  for (const agent of ['claude', 'codex', 'antigravity']) assert.match(html, new RegExp(`<symbol id="mark-${agent}" viewBox="[^"]+">`));
  assert.doesNotMatch(html, /fill="white"/);
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(script, /\/\^ko\\b\/i/);
});
