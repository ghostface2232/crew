import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { followUpTitle, missionDetail, missionHead, Missions, NAME_THE_MISSION, normalizeTitle } from '../plugin/bridge/missions.ts';
import { TIERS } from '../plugin/bridge/tiers.ts';
import { checkArguments } from '../plugin/bridge/arguments.ts';
import { ClaudeSessions } from '../plugin/bridge/claude.ts';
import { assignHint, canonicalPath, defaultHolder, disabledAgents, LEAD, PRESET_NAMES, projectSettings, ROLE_INFO, WORKERS } from '../plugin/bridge/config.ts';
import { addNews, clipped, Delivery, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, REPORT_PAGE_BYTES, textPage, unread } from '../plugin/bridge/delivery.ts';
import type { Job } from '../plugin/bridge/jobs.ts';
import { describe, needsLead, summarize } from '../plugin/bridge/render.ts';
import type { PullWatch } from '../plugin/bridge/pulls.ts';

/**
 * The mission half of mcp.ts run against the real mission store, standing in for the daemon. Each call starts a
 * server of its own (`fresh` says whether it has dealt with a mission yet), all sharing one store.
 */
function missionServer(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-mcp-'));
  const missions = new Missions(home, () => {});
  t.after(() => { missions.flush(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const code = stripTypeScriptTypes(source.slice(source.indexOf('/** This session\'s missions in this project, the open ones oldest first'), source.indexOf('function describeJob'))
    + source.slice(source.indexOf('/** The follow-up mission being opened'), source.indexOf('async function followOne')));
  const calls: { method: string; route: string; body: any }[] = [];
  const pulls: unknown[] = [];
  let clock = 0;
  const api = async (method: string, route: string, body: any = {}) => {
    calls.push({ method, route, body: JSON.parse(JSON.stringify(body)) });
    if (route === '/api/state') return { missions: missions.list(), jobs: [], pulls };
    if (route === '/api/missions') {
      const opened = missions.start({ ...body, root: body.project });
      // Opened in the same millisecond otherwise, and the list is ordered by when each was created.
      opened.createdAt = ++clock;
      return opened;
    }
    if (route === '/api/jobs') return { id: 'cx-1', mission: body.mission, taskId: body.taskId };
    if (route.startsWith('/api/route')) return { assignee: 'claude', reason: route, fallback: [] };
    const id = /^\/api\/missions\/([\w-]+)/.exec(route)![1];
    if (route.endsWith('/pulls')) {
      const watch = { id: 'pr-abc123', repo: 'o/r', number: 7, mission: id, state: 'open', checks: 'pending', review: '', conflict: false, told: { head: 'h', checks: [] }, checkedAt: Date.now() };
      pulls.push(watch);
      return { watch, resumed: false, summary: 'o/r#7 · open · checks pending' };
    }
    if (body.done || body.abandoned) return missions.finish(id, { outcome: body.outcome, record: body.record, summary: body.summary, abandoned: Boolean(body.abandoned), byLead: body.by === 'lead' });
    return missions.update(id, body);
  };
  let projects: Record<string, object> = {};
  const server = (session: string | null = 'lead', fresh = false) => {
    const context: Record<string, any> = {
      missionHead, missionDetail, NAME_THE_MISSION, normalizeTitle, followUpTitle, SESSION: session ?? undefined, host: 'codex', PROJECT: canonicalPath('/project'), missionId: null, closedElsewhere: null,
      costMission: null, lastDone: null, fresh, openedHere: new Set<string>(), SUPERSEDED: 'Superseded by a new mission.', currentPolicy: () => 'policy', globalPreset: () => null,
      describeJob: (job: Job) => `job ${job.id}`, api, loadConfig: () => ({ projects }), projectSettings,
    };
    return { context, ...vm.runInNewContext(`${code}; ({ reportMission, runJob, jobMission })`, context) as {
      reportMission(args: object): Promise<string>; runJob(spec: object, background: boolean, ctx: object, wanted?: string): Promise<string>; jobMission(wanted?: string): Promise<string | undefined> } };
  };
  return { missions, calls, server, setProjects: (value: Record<string, object>) => { projects = value; } };
}

test('a mission says autonomy is on only for a project the user turned it on for, and takes its wrap-up with done', async (t) => {
  const { missions, calls, server, setProjects } = missionServer(t);
  const { reportMission } = server();
  assert.doesNotMatch(await reportMission({ title: 'Ship it', stages: ['implement', 'final'] }), /Autonomy/);
  setProjects({ [canonicalPath('/project')]: { autonomy: true } });
  assert.match(await reportMission({ stage: 'final' }), /Autonomy is on for this project[^]*only once the work is finished, every outgoing commit has had a review[^]*Never merge, close, or deploy it\./);
  const posts = () => calls.filter((call) => call.method === 'POST').length;
  const before = posts();
  await assert.rejects(reportMission({ stage: 'final', summary: 'Too early.' }), /summary goes with done/);
  assert.equal(posts(), before);
  const ended = await reportMission({ done: true, outcome: 'Shipped.', summary: 'Changed the board.' });
  assert.equal(missions.list()[0].summary, 'Changed the board.');
  // A finished mission has nothing left to push.
  assert.doesNotMatch(ended, /Autonomy/);
});

test('remembered decisions reach the mission on every path, the call that ends it included', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission } = server();
  // The call that opens the mission keeps the decisions it carries.
  await reportMission({ title: 'Screens', stages: ['implement', 'final'], remember: [{ key: 'size', text: 'Cards stay compact.' }] });
  assert.deepEqual(missions.list()[0].memory?.map((entry) => entry.key), ['size']);
  await reportMission({ title: 'Screens', remember: [{ key: 'buttons', text: 'Buttons follow sample A.' }] });
  assert.match(await reportMission({ remember: [{ key: 'copy', text: 'Text follows B.' }] }), /Decisions remembered \(3 of/);
  await reportMission({ forget: ['copy', 'size'], done: true, outcome: 'Done.' });
  assert.deepEqual(missions.list()[0].memory?.map((entry) => entry.key), ['buttons']);
  assert.deepEqual(calls.filter((call) => call.body.forget).map((call) => call.body.forget), [['copy', 'size']]);
});

test('mission forwards plans on start, revision, repeated titles and reattachment', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission } = server();
  const stages = ['cross-review', 'fix', 'final'];
  const report = await reportMission({ title: 'Review', stages });
  assert.match(report, /step 1 of 3/);
  assert.deepEqual(calls.at(-1)?.body.stages, stages);
  assert.equal(missions.list()[0].lead, 'codex');
  const id = missions.list()[0].id;
  for (const args of [{ stages: ['fix', 'final'] }, { stage: 'cross-review', stages: ['fix', 'final'] }]) {
    assert.match(await reportMission(args), /Plan: cross-review \(current\) → fix → final/);
    assert.equal(calls.at(-1)?.route, `/api/missions/${id}`);
  }
  // A resumed lead resending its starting call must not append its whole plan again.
  const posts = () => calls.filter((call) => call.method === 'POST').length;
  const before = posts();
  await reportMission({ title: 'Review', stages });
  assert.equal(posts(), before);
  await reportMission({ title: 'Review', stage: 'fix', stages });
  assert.deepEqual(calls.at(-1)?.body, { stage: 'fix', lead: 'lead' });
  // A preset the user names reaches the mission on every path, and one left out changes nothing.
  await reportMission({ title: 'Review', preset: 'economy' });
  assert.deepEqual(calls.at(-1)?.body, { preset: 'economy', lead: 'lead' });
  await reportMission({ preset: null });
  assert.deepEqual(calls.at(-1)?.body, { preset: null, lead: 'lead' });
  // A server started again knows nothing; the daemon's list is enough to carry on, with or without the title.
  const restarted = server('lead', true);
  assert.match(await restarted.reportMission({ title: 'Review', stage: 'final', stages }), /final \(step 3 of 3\)/);
  assert.equal(calls.at(-1)?.route, `/api/missions/${id}`);
  assert.equal(await server('lead', true).jobMission(), id);
  assert.equal(missions.list().length, 1);
  // Another session using the same title is carrying out its own command.
  await server('other').reportMission({ title: 'Review', stages });
  assert.equal(missions.list().length, 2);
});

test('a mission takes its difficulty only on the call that starts it', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission } = server();
  assert.match(await reportMission({ title: 'Port', stages: ['implement', 'final'], difficulty: 'hard' }), /Plan: implement \(current\) → final · difficulty: hard/);
  assert.equal(calls.at(-1)?.body.difficulty, 'hard');
  const [mission] = missions.list();
  const posts = () => calls.filter((call) => call.method === 'POST').length;
  const before = posts();
  // A later call, or the same title with another difficulty, is refused before anything is sent.
  for (const args of [{ stage: 'final', difficulty: 'routine' }, { id: mission.id, difficulty: 'hard' }, { done: true, difficulty: 'hard' }]) {
    await assert.rejects(reportMission(args), /difficulty is set only on the call that starts a mission/);
  }
  await assert.rejects(reportMission({ title: 'Port', difficulty: 'routine' }), /was started as hard, which cannot change/);
  assert.equal(posts(), before);
  assert.equal(mission.state, 'active');
  // A resumed lead resending its whole starting call resumes it.
  assert.match(await reportMission({ title: 'Port', stages: ['implement', 'final'], difficulty: 'hard' }), /difficulty: hard/);
});

test('only a restarted server takes a closed mission of this session for one it lost track of', async (t) => {
  const { missions, calls, server } = missionServer(t);
  await server().reportMission({ title: 'Fix X' });
  const [first] = missions.list();
  missions.finish(first.id, { abandoned: true, outcome: 'Dismissed on the board.' });
  const restarted = server('lead', true);
  assert.match(await restarted.reportMission({ title: 'Fix X' }), /closed outside this session/);
  assert.equal(restarted.context.costMission, first.id);
  assert.equal(missions.list().length, 1);
  // A server that saw the mission end opens a new one when asked, as when the lead abandoned its own.
  const live = server();
  await live.reportMission({ title: 'Fix X' });
  assert.equal(calls.at(-1)?.route, '/api/missions');
  assert.equal(live.context.costMission, missions.list()[0].id);
  // Closed from outside while this server was tracking it: said once, and the work goes on under its preset.
  missions.finish(live.context.costMission, { abandoned: true, outcome: 'Dismissed on the board.' });
  assert.match(await live.reportMission({ stage: 'implement' }), /closed outside this session \(Dismissed on the board\.\)/);
  await assert.rejects(live.reportMission({ stage: 'implement' }), /no open mission/);
  assert.equal(await live.jobMission(), live.context.costMission);
});

test('a second command opens beside the first, and with two open every call names its mission', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission, runJob, jobMission, context } = server();
  await reportMission({ title: 'First', stages: ['plan', 'implement', 'final'], preset: 'economy' });
  const first = missions.list()[0];
  const opened = await reportMission({ title: 'Second', stages: ['implement', 'final'] });
  const second = missions.list().find((mission) => mission.title === 'Second')!;
  assert.equal(first.state, 'active', 'the first command is still under way');
  assert.match(opened, new RegExp(`Still open in this session: ${first.id} "First" \\(plan\\)\\. With more than one open, name the mission`));
  // Nothing is guessed: a call that would change a mission, start a job or pick a preset is refused untouched.
  const posts = () => calls.filter((call) => call.method === 'POST').length;
  const before = posts();
  for (const args of [{ stage: 'implement' }, { stages: ['final'] }, { done: true }, { abandoned: true }, { preset: 'best' }, { tasks: [{ id: 'a', title: 'A' }] }, { pr: '7' }]) {
    await assert.rejects(reportMission(args), new RegExp(`2 missions open: .*${first.id} "First".*Pass id.*Nothing was changed`));
  }
  await assert.rejects(runJob({ kind: 'delegate', task: 'x' }, true, { jobs: [] }), /Pass mission to say which one/);
  await assert.rejects(jobMission(), /Pass mission/);
  assert.equal(posts(), before);
  assert.equal(first.stage, 'plan');
  // With no argument it shows both, oldest first.
  const both = await reportMission({});
  assert.match(both, /2 missions open/);
  assert.ok(both.indexOf(`Mission ${first.id}`) > 0 && both.indexOf(`Mission ${first.id}`) < both.indexOf(`Mission ${second.id}`));
  // Named, each goes its own way, and a job runs under the mission it names.
  assert.match(await reportMission({ id: first.id, stage: 'implement' }), new RegExp(`Mission ${first.id} · implement \\(step 2 of 3\\)`));
  assert.equal(second.stage, 'implement');
  await runJob({ kind: 'delegate', task: 'x' }, true, { jobs: [] }, first.id);
  assert.equal(calls.at(-1)?.body.mission, first.id);
  assert.equal(await jobMission(second.id), second.id);
  // The same title finds its mission among the open ones (A, B, then A again).
  assert.match(await reportMission({ title: 'First', stage: 'final' }), new RegExp(`Mission ${first.id} · final`));
  assert.equal(missions.list().length, 2);
  await assert.rejects(reportMission({ id: 'm-nope', stage: 'final' }), /is not a mission this session opened/);
  const theirs = missions.start({ title: 'Theirs', project: canonicalPath('/project'), root: canonicalPath('/project'), owner: 'other' });
  await assert.rejects(reportMission({ id: theirs.id, done: true }), /is not a mission this session opened/);
  await assert.rejects(runJob({ kind: 'delegate', task: 'x' }, true, { jobs: [] }, theirs.id), /is not a mission this session opened/);
  // Finishing one by id leaves the other as the one unaddressed calls go to.
  assert.match(await reportMission({ id: second.id, done: true, outcome: 'ok' }), new RegExp(`Still open in this session: ${first.id} "First" \\(final\\)\\. Calls that name no mission now go to it`));
  assert.equal(await jobMission(), first.id);
  assert.match(await runJob({ kind: 'delegate', task: 'x' }, true, { jobs: [] }), /^job cx-1$/, 'no follow-up mission while one is open');
  await assert.rejects(reportMission({ id: second.id, stage: 'final' }), new RegExp(`Mission ${second.id} is already done \\(ok\\)\\. Open: ${first.id}`));
  await reportMission({ done: true });
  assert.equal(first.state, 'done');
  assert.equal(context.costMission, null);
});

test('a title on a call that ends a mission picks the open mission of that title, and ends no other', async (t) => {
  const { missions, server } = missionServer(t);
  const { reportMission } = server();
  await reportMission({ title: 'Refactor billing', stages: ['implement', 'final'] });
  const billing = missions.list()[0];
  for (const end of [{ done: true, outcome: 'Typo fixed.' }, { abandoned: true }]) {
    await assert.rejects(reportMission({ title: 'Fix typo in README', stages: ['implement'], ...end }),
      new RegExp(`No open mission is titled "Fix typo in README".*Open: ${billing.id} "Refactor billing" \\(implement\\)\\. Pass id`));
  }
  assert.equal(missions.list().length, 1);
  assert.equal(billing.state, 'active');
  // Among several open, the title is as good as the id.
  await reportMission({ title: 'Fix typo in README', stages: ['implement'] });
  const typo = missions.list().find((mission) => mission.title === 'Fix typo in README')!;
  assert.match(await reportMission({ title: ' Fix typo in README\n', done: true, outcome: 'Typo fixed.' }), new RegExp(`^Mission ${typo.id} · done[^]*Still open in this session: ${billing.id} `));
  assert.equal(billing.state, 'active');
  // Two open missions can share a title once one is renamed on the board; the title then picks neither.
  await reportMission({ title: 'Second', stages: ['implement'] });
  const second = missions.list().find((mission) => mission.title === 'Second')!;
  second.title = 'Refactor billing';
  await assert.rejects(reportMission({ title: 'Refactor billing', done: true }), /2 missions open:[^]*Pass id/);
  assert.deepEqual([billing.state, second.state], ['active', 'active']);
  await reportMission({ id: second.id, abandoned: true });
  assert.match(await reportMission({ title: 'Refactor billing', done: true }), new RegExp(`^Mission ${billing.id} · done`));
  // With none open there is nothing a title could be mistaken for.
  await assert.rejects(reportMission({ title: 'Fix typo in README', done: true }), /no open mission/);
});

test('tasks and a pull request reach the mission, and come back in its reply', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission, runJob } = server();
  const opened = await reportMission({ title: 'Ship it', stages: ['implement', 'final'], tasks: [{ id: 'api', title: 'Add the route' }, { id: 'ui', title: 'Show it', after: ['api'] }] });
  assert.match(opened, /Tasks \(0 of 2 done\):\n- \[todo\] api: Add the route · ready\n- \[todo\] ui: Show it · waits for api\npolicy/);
  const mission = missions.list()[0];
  assert.match(await reportMission({ tasks: [{ id: 'api', state: 'done', result: 'npm test passed' }] }), /- \[done\] api: Add the route — npm test passed\n- \[todo\] ui: Show it · ready/);
  await assert.rejects(reportMission({ tasks: [{ id: 'api', after: ['ui'] }] }), /circle/);
  await runJob({ kind: 'delegate', task: 'x', taskId: 'ui' }, true, { jobs: [] });
  assert.deepEqual({ mission: calls.at(-1)?.body.mission, taskId: calls.at(-1)?.body.taskId }, { mission: mission.id, taskId: 'ui' });
  const linked = await reportMission({ pr: 'https://github.com/o/r/pull/7' });
  assert.equal(calls.at(-1)?.route, `/api/missions/${mission.id}/pulls`);
  assert.match(linked, /Pull requests:\n- pr-abc123 o\/r#7 open · checks pending · checked just now\npolicy\nLinked o\/r#7 · open · checks pending\. Crew reads it while this session is open[^]*never merge, close or deploy/);
});

test('a call that ends a mission applies its tasks and pull request first, and ends nothing when one is refused', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission } = server();
  await reportMission({ title: 'Ship it', stages: ['final'], tasks: [{ id: 'api', title: 'Add the route' }] });
  const route = `/api/missions/${missions.list()[0].id}`;
  await assert.rejects(reportMission({ abandoned: true, pr: '7' }), /abandoned mission's pull request is not watched/);
  await assert.rejects(reportMission({ done: true, pr: '7', tasks: [{ id: 'api', after: ['api'] }] }), /circle/);
  assert.equal(missions.list()[0].state, 'active');
  const before = calls.length;
  const done = await reportMission({ done: true, outcome: 'Shipped', pr: '7', tasks: [{ id: 'api', state: 'done', result: 'npm test passed' }] });
  assert.deepEqual(calls.slice(before).filter((call) => call.method === 'POST').map((call) => [call.route, Object.keys(call.body)[0]]), [[route, 'tasks'], [`${route}/pulls`, 'pr'], [route, 'done']]);
  assert.equal(missions.list()[0].state, 'done');
  assert.match(done, /- \[done\] api: Add the route — npm test passed[^]*Linked o\/r#7 · open · checks pending\./);
  // A done mission takes a pull request and nothing else: linking again is how held check news resumes.
  assert.match(await reportMission({ id: missions.list()[0].id, pr: '7' }), /^Mission \S+ · done[^]*Pull requests:\n- pr-abc123 o\/r#7[^]*Linked o\/r#7/);
  assert.deepEqual([calls.at(-1)?.route, missions.list()[0].state], [`${route}/pulls`, 'done']);
  await assert.rejects(reportMission({ id: missions.list()[0].id, pr: '7', stage: 'final' }), /is already done/);
});

test('work started after a done mission opens a follow-up mission named after it', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission, runJob, context } = server();
  assert.equal(followUpTitle('Fix the toolbar'), 'Follow-up: Fix the toolbar');
  assert.equal(followUpTitle('후속 작업: 역할 정리'), '후속 작업: 역할 정리');
  assert.equal(followUpTitle('Follow-up: 역할 정리'), '후속 작업: 역할 정리');
  const finish = async () => {
    for (const mission of missions.list()) if (mission.state === 'active') await reportMission({ id: mission.id, abandoned: true });
    await reportMission({ title: '역할 정리' });
    await reportMission({ done: true, outcome: 'ok' });
  };
  await finish();
  // The daemon tells the lead's own done from the board's by this, and reminds only after the lead's.
  assert.equal(calls.at(-1)?.body.by, 'lead');
  const first = await runJob({ kind: 'delegate', task: 'more' }, true, { jobs: [] });
  assert.match(first, /^Opened mission m-[0-9a-f]{6} "후속 작업: 역할 정리"/);
  assert.deepEqual(calls.findLast((call) => call.route === '/api/missions')?.body.stages, ['implement', 'final']);
  assert.equal(calls.findLast((call) => call.route === '/api/missions')?.body.lead, 'codex');
  assert.equal(calls.at(-1)?.body.mission, context.costMission);
  // Jobs started together open one follow-up, and a job that fails still tells the lead of the mission it opened.
  await finish();
  const opens = calls.filter((call) => call.route === '/api/missions').length;
  const together = await Promise.all([runJob({ kind: 'delegate', task: 'a' }, true, { jobs: [] }), runJob({ kind: 'delegate', task: 'b' }, true, { jobs: [] })]);
  assert.equal(calls.filter((call) => call.route === '/api/missions').length, opens + 1);
  assert.equal(together.filter((text: string) => text.startsWith('Opened mission')).length, 1);
  await finish();
  const api = context.api;
  context.api = async (method: string, route: string, body: any) => {
    if (route === '/api/jobs') throw new Error('Another job is running.');
    return api(method, route, body);
  };
  await assert.rejects(runJob({ kind: 'delegate', task: 'alone', exclusive: true }, true, { jobs: [] }), /^Error: Opened mission m-[0-9a-f]{6}[^]*Another job is running\./);
  context.api = api;
  // Further work joins it, and an abandoned mission or one the lead opens itself needs none.
  assert.doesNotMatch(await runJob({ kind: 'delegate', task: 'again' }, true, { jobs: [] }), /Opened mission/);
  await reportMission({ abandoned: true });
  assert.doesNotMatch(await runJob({ kind: 'delegate', task: 'after abandon' }, true, { jobs: [] }), /Opened mission/);
});

test('polish advertises the shared model option and forwards it to the job', async () => {
  // Evaluate just the schema and handler case, without starting the stdio server or a daemon.
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const modelProps = vm.runInNewContext(`(${source.match(/const modelProps = (\{[^]*?\n\});/)![1]})`, { TIERS });
  const schema = source.slice(source.indexOf("    name: 'polish',"), source.indexOf("    name: 'debate',"));
  const tool = vm.runInNewContext(`({${schema.slice(0, schema.lastIndexOf('\n  },'))}})`, {
    holder: () => 'Antigravity', worktreeProps: {}, skillsProp: {}, common: {}, modelProps, agentProp: () => ({}),
  });
  assert.deepEqual(tool.inputSchema.properties.model, modelProps.model);
  assert.deepEqual([...tool.inputSchema.properties.tier.enum], [...TIERS]);
  const body = source.split("    case 'polish':")[1].split("    case 'mission':")[0];
  const run = vm.runInNewContext(`(async (args) => { const cwd = '/project', ctx = {}; ${body} })`, { runJob: (spec: unknown) => spec });
  assert.equal((await run({ targets: ['README.md'], model: 'selected-model' })).model, 'selected-model');
  assert.equal((await run({ targets: ['README.md'] })).model, undefined);
  assert.equal((await run({ targets: ['README.md'], tier: 'frontier' })).tier, 'frontier');
  // The brief and its criteria go where delegate takes them.
  assert.deepEqual(Object.keys(tool.inputSchema.properties).filter((key) => ['task', 'done_when', 'guidance', 'effort'].includes(key)), ['task', 'done_when', 'effort']);
  const briefed = await run({ targets: ['README.md'], task: 'Reword the footnote.', done_when: 'Only the footnote changed.', effort: 'high' });
  assert.deepEqual([briefed.task, briefed.done_when, briefed.effort], ['Reword the footnote.', 'Only the footnote changed.', 'high']);
});

test('the wake hook follows every tool that can leave a job running, answer included', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  const wake = (hooks.PostToolUse as any[]).find((entry) => entry.hooks.some((hook: any) => hook.asyncRewake));
  const matcher = new RegExp(`^(?:${wake.matcher})$`);
  // answer used to be missing, so a lead that answered a question and ended its turn was never woken again.
  for (const tool of ['delegate', 'debate', 'review', 'polish', 'reply', 'wait', 'answer', 'cancel', 'mission', 'status']) assert.ok(matcher.test(`mcp__plugin_crew_crew__${tool}`), tool);
  assert.ok(hooks.Stop.some((entry: any) => entry.hooks.some((hook: any) => hook.asyncRewake)));
  assert.ok(hooks.PostToolUseFailure.some((entry: any) => entry.hooks.some((hook: any) => hook.asyncRewake)));
});

test('a resumed lead process arms a watcher before any prompt, Stop, or Crew call', () => {
  const hooks = JSON.parse(fs.readFileSync(new URL('../plugin/hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  // The desktop app ends idle sessions under memory pressure and resumes them later; the watcher dies with the
  // old process. Without this, news that arrived after the resume waited for the user's next message.
  const sources = ['startup', 'resume', 'clear'];
  for (const source of sources) {
    assert.ok((hooks.SessionStart as any[]).some((entry) => new RegExp(`^(?:${entry.matcher ?? '.*'})$`).test(source)
      && entry.hooks.some((hook: any) => hook.asyncRewake && hook.args?.at(-1) === 'watch')), source);
  }
});

test('MCP bounds a multi-job response and ACKs only echoed receipts before making a new offer', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handle('), source.indexOf('readline.createInterface'));
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `cx-${i}`, lead: 'lead', seq: 1, delivered: 0, state: 'done', turns: 1 } as Job));
  for (const job of jobs) addNews(job, 'done', '"\\\n한😀'.repeat(50));
  // Owned by another session: the call that shows it takes it over and carries its news at once. One the bounded
  // response cuts off stays with its owner.
  jobs[0].lead = 'other';
  jobs[11].lead = 'other';
  const delivery = new Delivery(() => jobs, () => {});
  const replies: any[] = [];
  const order: string[] = [];
  const handle = vm.runInNewContext(`${stripTypeScriptTypes(handler)}; handle`, {
    AbortController, inFlight: new Map(), ensureDaemon: async () => {}, checkArguments, TOOLS: [], argumentHint: () => undefined, SESSION: 'lead', host: 'claude', carriesCard: () => false,
    clipped, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, send: (msg: unknown) => replies.push(msg),
    imageContent: () => [{ type: 'image', data: 'x'.repeat(900_000), mimeType: 'image/png' }],
    api: async (_method: string, route: string, body: any) => {
      order.push(route);
      if (route === '/api/lead/ack') return delivery.ack(body.session, body.ack);
      if (route === '/api/lead/adopt') return { adopted: delivery.adopt(body.session, body.job_ids) };
      assert.equal(route, '/api/lead/offer');
      return { offer: delivery.offer(body.session, { ids: body.job_ids, bytes: body.bytes }) };
    },
    callTool: async (_name: string, args: any, ctx: any) => {
      order.push('tool');
      ctx.jobs.push(...jobs);
      if (args.listing) ctx.adopt = false;
      return `[cx-0] done\n${'"\\\n한😀'.repeat(150_000)}\n[cx-11] done`;
    },
  });
  const call = (args = {}) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'wait', arguments: args } });
  await call();
  // The text is bounded; evidence images travel beside it, as before.
  assert.ok(jsonBytes(replies[0].result.content[0].text) <= LEAD_BYTES);
  assert.equal(replies[0].result.content[1].type, 'image');
  const receipt = replies[0].result.content[0].text.match(/Receipt: ([\w-]+)/)[1];
  const items = delivery.state.receipts[receipt].items;
  assert.equal(jobs[0].lead, 'lead');
  assert.equal(jobs[11].lead, 'other', 'a job cut from the response is not taken over');
  assert.ok(items.some((item) => item.jobId === 'cx-0'));
  assert.ok(items.length > 0 && items.length <= 8);
  assert.ok(jobs.every((job) => job.ackedSeq === 0));
  assert.ok(jobs.every((job) => job.news![0].offers === 0), 'explicit reads do not spend automatic attempts');
  addNews(jobs[0], 'failed', 'newer failure');
  order.length = 0;
  await call({ ack: receipt });
  assert.deepEqual(order, ['/api/lead/ack', 'tool', '/api/lead/adopt', '/api/lead/offer']);
  assert.deepEqual(unread(jobs[0]).map((news) => news.seq), [2]);
  assert.ok(jobs.slice(items.length).every((job) => job.ackedSeq === 0), 'omitted jobs were never acknowledged');
  assert.ok(jsonBytes(replies[1].result.content[0].text) <= LEAD_BYTES);
  order.length = 0;
  await call({ ack: 'unknown' });
  assert.deepEqual(order, ['/api/lead/ack', 'tool', '/api/lead/adopt', '/api/lead/offer'], 'a bad echo does not block the call it rode on');
  assert.equal(replies[2].result.isError, undefined);
  assert.match(replies[2].result.content[0].text, /ack not applied: Unknown receipt/);
  // A listing shows another session's job without taking it over.
  jobs[0].lead = 'other';
  await call({ listing: true });
  assert.equal(jobs[0].lead, 'other');
  // However long a bad echo, the call it rode on still succeeds.
  await call({ ack: ['x'.repeat(30_000)] });
  assert.equal(replies.at(-1).result.isError, undefined);
});

test('the card goes with mission calls, under Codex only with those that move a mission, and its own refresh reads news of nothing', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function handle('), source.indexOf('readline.createInterface'));
  const rule = source.slice(source.indexOf('const carriesCard ='), source.indexOf('function toolList()'));
  const replies: any[] = [];
  const routes: string[] = [];
  let failCard = false;
  let switchedOn = true;
  const handle = (showsCards: boolean, host = 'claude') => vm.runInNewContext(`${stripTypeScriptTypes(rule + handler)}; handle`, {
    loadConfig: () => ({ progressCards: switchedOn }),
    AbortController, inFlight: new Map(), ensureDaemon: async () => {}, checkArguments, TOOLS: [], argumentHint: () => undefined, SESSION: 'lead', host,
    showsCards, CARD_URI: 'ui://crew/progress.html', CARD_MIME: 'text/html;profile=mcp-app', cardHtml: () => '<html>', codexSession: async () => {},
    clipped, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, send: (msg: unknown) => replies.push(msg), imageContent: () => [],
    api: async (_method: string, route: string) => { routes.push(route); return {}; },
    callTool: async (name: string) => `${name} text`,
    progressCard: async () => { if (failCard) throw new Error('daemon away'); return { asOf: 1, missions: [], jobs: [] }; },
  });
  const call = async (on: boolean, name: string, args: object = {}, host = 'claude') => {
    await handle(on, host)({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(host === 'codex' ? { _meta: { sessionId: 'lead' } } : {}) } });
    return replies.at(-1).result;
  };
  const shown = (result: any) => JSON.stringify([result.structuredContent, result._meta]);
  assert.equal(shown(await call(true, 'mission', { tasks: [] })), JSON.stringify([{ asOf: 1, missions: [], jobs: [] }, { ui: { resourceUri: 'ui://crew/progress.html' } }]));
  assert.equal((await call(true, 'status')).structuredContent, undefined);
  assert.equal((await call(false, 'mission', { stage: 'fix' })).structuredContent, undefined);
  // Codex draws the card a result names, so only a call that starts, moves or ends a mission carries one.
  assert.equal((await call(true, 'mission', { tasks: [] }, 'codex')).structuredContent, undefined);
  for (const args of [{ title: 'x' }, { stage: 'fix' }, { done: true }, { abandoned: true }]) assert.ok((await call(true, 'mission', args, 'codex')).structuredContent);
  // The user's switch holds from the next call.
  switchedOn = false;
  assert.equal((await call(true, 'mission', { stage: 'fix' }, 'codex')).structuredContent, undefined);
  assert.equal((await call(true, 'mission', { stage: 'fix' })).structuredContent, undefined);
  switchedOn = true;
  // A card that cannot be built leaves the call's own answer as it was.
  failCard = true;
  assert.equal(JSON.stringify(await call(true, 'mission', { stage: 'fix' })), JSON.stringify({ content: [{ type: 'text', text: 'mission text' }] }));
  failCard = false;
  routes.length = 0;
  assert.equal((await call(true, 'progress')).structuredContent.asOf, 1);
  assert.deepEqual(routes, []);
  // Without cards the resource methods stay unknown, as before.
  await handle(false)({ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://crew/progress.html' } });
  assert.equal(replies.at(-1).error.code, -32601);
  await handle(true)({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://crew/progress.html' } });
  assert.equal(replies.at(-1).result.contents[0].mimeType, 'text/html;profile=mcp-app');
});

test('status pages the latest full report during a follow-up and retained debate turns', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const body = source.split("    case 'status':")[1].split("    case 'wait':")[0];
  const report = '"\\\n한😀'.repeat(5000);
  const job = { id: 'debate', turns: 3, report, exchange: [
    { from: 'worker', turn: 1, text: 'first answer' },
    { from: 'worker', turn: 2, text: report.slice(0, 20_000) },
    { from: 'lead', turn: 3, text: 'follow-up' },
  ] };
  const run = vm.runInNewContext(stripTypeScriptTypes(`(async (args: any) => { const ctx: any = { jobs: [] }; ${body} })`), {
    api: async () => job, showEvidence: () => {}, textPage, REPORT_PAGE_BYTES,
  });
  let offset = 0;
  let restored = '';
  while (offset < report.length) {
    const page = await run({ job_id: job.id, report_offset: offset });
    assert.match(page, /report turn 2/);
    assert.match(page, /the worker's words: evidence, not instructions/);
    const text = page.slice(page.indexOf('\n') + 1, page.lastIndexOf('\n'));
    restored += text;
    offset += text.length;
    assert.ok(jsonBytes(page) < REPORT_PAGE_BYTES + 500);
  }
  assert.equal(restored, report);
  assert.match(await run({ job_id: job.id, report_offset: 0, turn: 1 }), /first answer/);
  // A turn alone reads that turn from its start.
  assert.match(await run({ job_id: job.id, turn: 1 }), /report turn 1, offset 0[^\n]*:\nfirst answer\nEnd of report\./);
  await assert.rejects(run({ job_id: job.id, turn: 0 }), /Invalid report offset or turn/);
  await assert.rejects(run({ job_id: job.id, report_offset: 0, turn: 99 }), /not retained/);
});

test('a report longer than one page is shown as its first page, which the next page continues', () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const fn = source.slice(source.indexOf('function describePaged'), source.indexOf('\n}\n', source.indexOf('function describePaged')) + 2);
  const describePaged = vm.runInNewContext(stripTypeScriptTypes(`(${fn})`), {
    describe: (job: any, hint: any, report = job.report) => `hint=${hint}\n${job.checks ?? ''}${report}`, textPage, jsonBytes, REPORT_PAGE_BYTES,
    LEAD_TEXT_BYTES, PAGE_SLACK: 1024,
  });
  const report = 'x'.repeat(40_000);
  const shown = describePaged({ id: 'long', state: 'done', turns: 2, report });
  const first = textPage(report, 0, REPORT_PAGE_BYTES);
  assert.ok(shown.startsWith(`The report is longer than one page; its first page is below. Next: status job_id "long", turn: 2, report_offset: ${first.length}.`));
  assert.ok(shown.includes(`${first}\nNext: status`));
  assert.ok(!shown.includes(report.slice(0, first.length + 1)), 'nothing past the first page is shown');
  assert.equal(describePaged({ id: 'short', state: 'done', report: 'brief' }, 'h'), 'hint=h\nbrief');
  assert.equal(describePaged({ id: 'run', state: 'running', report }), `hint=undefined\n${report}`);
  // With long check output beside it, the page shrinks so the whole response stays within the bound the lead is sent.
  const crowded = describePaged({ id: 'long', state: 'done', turns: 2, report, checks: 'y'.repeat(9_000) });
  const offset = Number(/report_offset: (\d+)/.exec(crowded)![1]);
  assert.ok(offset < first.length);
  assert.ok(jsonBytes(crowded) <= LEAD_TEXT_BYTES, 'nothing is cut from the end');
  assert.ok(crowded.includes(`${report.slice(0, offset)}\nNext: status`));
  // A job after others in one wait response gets only the room they left, and none left means reading from the start.
  assert.ok(jsonBytes(describePaged({ id: 'long', state: 'done', turns: 2, report }, undefined, 9_000)) <= 9_000);
  assert.match(describePaged({ id: 'long', state: 'done', turns: 2, report }, undefined, 500), /report_offset: 0\./);
});

test('a wait that returns two long reports shows only what fits, and each Next line continues where its page stopped', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));
  // The real wait case, render, and paging, around stubs for the daemon.
  const code = `${between('function render(', '\n/** What the lead does')}\n${between('/** A report longer than one page', '\n/** The roles, usage')}
    async function wait(args, ctx) { switch ('wait') { ${between("case 'wait': {", "\n    case ")} } }`;
  // Numbered lines, so a skipped or repeated stretch cannot match by accident.
  const report = (id: string) => Array.from({ length: 2_000 }, (_, i) => `${id} line ${String(i).padStart(5, '0')}`).join('\n');
  const jobs = ['cx-long1', 'cx-long2'].map((id) => ({ id, kind: 'review', agent: 'codex', state: 'done', outcome: 'done', turns: 1, report: report(id), news: [], notes: [], questions: [], requests: [] }));
  const wait = vm.runInNewContext(`${stripTypeScriptTypes(code)}; wait`, {
    describe, needsLead, summarize, unread, textPage, jsonBytes, LEAD_TEXT_BYTES, REPORT_PAGE_BYTES,
    failed: new Map(), dismissed: new Set(), canElicit: true, showEvidence: () => {}, DEFAULT_WAIT_SECONDS: 1,
    follow: async () => jobs,
  });
  // As handle() sends it: cut from its end to the bound.
  const shown = clipped(await wait({ job_ids: jobs.map((job) => job.id) }, { jobs: [], progress: () => {} }), LEAD_TEXT_BYTES);
  assert.doesNotMatch(shown, /\(truncated\)/);
  for (const job of jobs) {
    const offset = Number(new RegExp(`job_id "${job.id}", turn: 1, report_offset: (\\d+)\\.`).exec(shown)![1]);
    assert.ok(offset > 0, `${job.id}: part of the report is shown`);
    assert.ok(shown.includes(`${job.report.slice(0, offset)}\nNext: status job_id "${job.id}"`), `${job.id}: the first page arrived whole`);
    // status pages on from the offset, as its report_offset path does.
    let rest = '';
    for (let at = offset; at < job.report.length; at += textPage(job.report, at, REPORT_PAGE_BYTES).length) rest += textPage(job.report, at, REPORT_PAGE_BYTES);
    assert.equal(job.report.slice(0, offset) + rest, job.report, `${job.id}: the pages join into the whole report`);
  }
});

test('a call with an argument its tool does not take is refused before it reaches the daemon, naming where the brief goes', async (t) => {
  // No initialize, and a port nothing listens on: a call that got past the check would try to reach a daemon.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-args-'));
  const child = spawn(process.execPath, [path.resolve('plugin/bridge/mcp.ts')], { env: { ...process.env, CREW_HOME: home, CREW_PORT: '9' }, stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => { child.kill(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const replies = new Map<number, (result: any) => void>();
  readline.createInterface({ input: child.stdout! }).on('line', (line) => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg.result); });
  let id = 0;
  const call = (name: string, args: object) => new Promise<any>((resolve) => {
    replies.set(++id, resolve);
    child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
  const text = async (name: string, args: object) => {
    const result = await call(name, args);
    assert.equal(result.isError, true);
    return result.content[0].text as string;
  };
  // The polish brief used to be guidance; a brief sent under delegate's name was dropped and the job started without one.
  assert.match(await text('polish', { targets: ['README.md'], guidance: 'Reword it.' }), /^polish does not take `guidance`, so nothing was done\. polish takes its brief in `task`\. Its arguments: targets, task, done_when, /);
  assert.match(await text('review', { task: 'Check the race.' }), /review takes its brief in `focus`/);
  assert.match(await text('debate', { topic: 'x', position: 'y', task: 'z' }), /debate takes its brief in `topic` and `position`/);
  assert.match(await text('mission', { mission_id: 'm-1', stage: 'final' }), /^mission does not take `mission_id`[^]*names the mission with `id`/);
  assert.match(await text('polish', { targets: ['a.md'], exclusive: true }), /An editor only changes wording/);
  // A nested name is checked too, by its path.
  assert.match(await text('mission', { tasks: [{ id: 't1', owner: 'me' }] }), /^mission does not take `tasks\[0\]\.owner`/);
});

test('a role the lead holds starts no worker, and a pick outside the holders is refused', () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('/** What the lead does with a role it holds itself'), source.indexOf('async function callTool'));
  const roles = { review: { agents: ['codex', 'claude'] }, polish: { agents: ['claude'] } };
  const pick = vm.runInNewContext(`const holderName = (a) => a === 'claude' ? 'you, Claude' : a; const holder = (r, t) => t[r].agents.join(' or '); ${stripTypeScriptTypes(code)}; pickHolder`, {
    roles, LEAD: 'claude', loadConfig: () => ({ roles, antigravity: { enabled: true } }), defaultHolder, disabledAgents, assignHint, selfReviewer: () => 'the crew:self-reviewer subagent', host: 'claude',
  });
  assert.deepEqual({ ...pick('review', undefined) }, { agent: 'codex' });
  assert.match(pick('review', 'claude').yours, /no worker was started\. Run the crew:self-reviewer subagent[^]*other holders: codex/);
  assert.match(pick('polish', undefined).yours, /^polish is yours/);
  assert.throws(() => pick('review', 'antigravity'), /antigravity does not hold review; its holders are codex or claude\. To use another agent, ask the user to add it under Settings, Roles, Cross-review[^]*roles\.review\.agents/);
  // Under a Codex lead the roles turn around: Codex's are the lead's own, and Claude's start a Claude worker.
  const codexRoles = { ...roles, delegate: { agents: ['codex'] } };
  const codexPick = vm.runInNewContext(`const holderName = (a) => a === 'codex' ? 'you, Codex' : a; const holder = (r, t) => t[r].agents.join(' or '); ${stripTypeScriptTypes(code)}; pickHolder`, {
    roles: codexRoles, LEAD: 'claude', loadConfig: () => ({ roles: codexRoles, antigravity: { enabled: true } }), defaultHolder, disabledAgents, assignHint, selfReviewer: () => 'a subagent', host: 'codex',
  });
  assert.deepEqual({ ...codexPick('review', undefined) }, { agent: 'claude' });
  assert.match(codexPick('review', 'codex').yours, /^review is yours: no worker was started\.[^]*other holders: claude/);
  assert.deepEqual({ ...codexPick('polish', undefined) }, { agent: 'claude' });
  assert.match(codexPick('delegate', undefined).yours, /^delegate is yours[^]*other holders: none/);
});

test('model notes are appended to an answer, and a daemon that cannot give them leaves it as it was', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('async function withNotes('), source.indexOf('async function callTool('));
  const routes: string[] = [];
  let reply: unknown = { text: 'codex-model: 7.0/10' };
  const withNotes = vm.runInNewContext(`${stripTypeScriptTypes(handler)}; withNotes`, {
    api: async (_method: string, route: string) => {
      routes.push(route);
      if (reply instanceof Error) throw reply;
      return reply;
    },
  });
  assert.match(await withNotes('Started.', ['codex'], 2), /^Started\.\n\nModel notes[^]*codex-model: 7\.0\/10$/);
  assert.equal(routes[0], '/api/notes?agents=codex&evidence=2');
  assert.equal(await withNotes('Started.', [], 2), 'Started.');
  reply = { text: '' };
  assert.equal(await withNotes('Started.', ['codex'], 2), 'Started.');
  // A job's answer repeats no notes the session has already been shown; `route` asks without `once`.
  reply = { text: 'codex-model: 7.0/10' };
  routes.length = 0;
  assert.equal(await withNotes('Started.', ['codex'], 2, true), 'Started.');
  assert.match(await withNotes('Started.', ['codex', 'antigravity'], 2, true), /Model notes/);
  assert.deepEqual(routes, ['/api/notes?agents=antigravity&evidence=2']);
  assert.match(await withNotes('Route.', ['codex'], 2), /Model notes/);
  reply = new Error('old daemon');
  assert.equal(await withNotes('Started.', ['codex'], 2), 'Started.');
});

test('the session instructions fit what Claude Code keeps of them', () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const text = source.slice(source.indexOf('const holderName ='), source.indexOf('\nconst common = {'));
  // The longest they get: every role held by every agent, and a preset set.
  const everyone = Object.fromEntries(ROLE_INFO.map((info) => [info.role, { agents: [...Object.keys(WORKERS), LEAD] }]));
  for (const host of ['claude', 'codex']) {
    const instructions: string = vm.runInNewContext(`${stripTypeScriptTypes(text)}; instructions()`, {
      LEAD, WORKERS, ROLE_INFO, PRESET_NAMES, roles: everyone, started: { preset: 'balanced' }, loadConfig: () => ({}), host, path, PLUGIN_ROOT: '/plugin',
    });
    // Claude Code cuts a server's instructions at 4,096 characters; what follows never reaches the lead. Codex is held to the same.
    assert.ok(instructions.length <= 4096, `${host}: ${instructions.length} characters`);
    for (const role of ROLE_INFO) assert.ok(instructions.includes(`\`${role.role}\``), role.role);
    assert.match(instructions, /The global one is "balanced"/);
    assert.match(instructions, host === 'codex' ? /Picking yourself \(`codex`\)[^\n]*a role held by Claude runs as a Claude worker[\s\S]*the crew:run skill/ : /Picking yourself \(`claude`\)[\s\S]*\/crew:run/);
    // Each host sees its own agent as itself and every other holder as a worker.
    assert.match(instructions, host === 'codex' ? /you, Codex[\s\S]*Claude \(a Claude worker\)/ : /you, Claude/);
  }
});

test('a preset gives its Claude subagent models only to a Claude lead', () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('/** What a preset asks of the lead'), source.indexOf('/** The preset policy as the config on disk'));
  const economy = { codex: { effort: 'low' }, subagentModel: 'haiku', subagentMax: 'sonnet', maxTier: 'standard' };
  const policy = (host: string) => vm.runInNewContext(`${stripTypeScriptTypes(code)}; presetPolicy('economy', preset, '')`, { host, preset: economy }) as string;
  assert.match(policy('claude'), /crew:self-reviewer\) with model "haiku", or "sonnet"/);
  assert.doesNotMatch(policy('codex'), /haiku|sonnet/);
  assert.match(policy('codex'), /Your own subagents stay on your model\. Worker models are capped at the standard tier/);
});

test('concurrent mission reports without a session id resume the same title', async (t) => {
  const { missions, server } = missionServer(t);
  const { reportMission } = server(null);
  await Promise.all([
    reportMission({ title: 'Same command', stages: ['plan', 'implement', 'final'] }),
    reportMission({ title: 'Same command', stage: 'implement' }),
  ]);
  assert.equal(missions.list().length, 1);
  assert.equal(missions.list()[0].stage, 'implement');
});

test('a task job without a mission cannot open a follow-up', async (t) => {
  const { missions, calls, server } = missionServer(t);
  const { reportMission, runJob } = server();
  await reportMission({ title: 'Finished command' });
  await reportMission({ done: true });
  const before = calls.length;
  await assert.rejects(runJob({ kind: 'delegate', task: 'x', taskId: 'ui' }, true, { jobs: [] }), /task_id.*mission/);
  assert.equal(missions.list().length, 1);
  assert.ok(calls.slice(before).every(({ method }) => method === 'GET'));
});

test('status and mission explicitly read this session\'s watch news without any jobs', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const tool = source.slice(source.indexOf('async function callTool('), source.indexOf('// --- MCP stdio transport'));
  const handler = source.slice(source.indexOf('async function handle('), source.indexOf('readline.createInterface'));
  const standing = source.slice(source.indexOf('/** This session\'s missions in this project, the open ones oldest first'), source.indexOf('function describeJob'));
  const watches = ['lead', 'other'].map((lead, index) => ({ id: `pr-${index}`, lead, repo: 'o/r', number: index + 7, mission: 'm-1', state: 'open' } as PullWatch));
  for (const watch of watches) {
    addNews(watch, 'checks', 'test failed');
    watch.news![0].offers = 2;
  }
  const delivery = new Delivery(() => [], () => {}, () => watches);
  const replies: any[] = [];
  const missions: object[] = [];
  const offered: (string[] | undefined)[] = [];
  const sessions = new ClaudeSessions(300, { onSession() {}, onEvent() {}, onAttention() {} });
  const context = vm.createContext({
    Date, AbortController, inFlight: new Map(), ensureDaemon: async () => {}, checkArguments, TOOLS: [], argumentHint: () => undefined, SESSION: 'lead', host: 'claude', PROJECT: '/project', projectUnknown: false, carriesCard: () => false,
    fresh: false, missionId: null, costMission: null, closedElsewhere: null, lastFooter: { text: '', at: 0 }, FOOTER_MS: 30 * 60_000,
    codexSession: async () => {},
    missionHead: () => 'Current mission', missionDetail: () => '', currentPolicy: () => '', globalPreset: () => null,
    clipped, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, send: (msg: unknown) => replies.push(msg),
    imageContent: () => [], baseUrl: () => 'board', summarize: () => '',
    api: async (_method: string, route: string, body: any) => {
      const url = new URL(route, 'http://localhost');
      if (url.pathname === '/api/state') return { jobs: [], pulls: watches.map(({ news, ...pull }) => pull), missions, limits: {},
        leadHooks: sessions.leadHookState(url.searchParams.get('lead_session') ?? '') };
      assert.equal(route, '/api/lead/offer');
      // A listing offers all of the session's news; other calls only that of what they show.
      offered.push(body.job_ids && Array.from(body.job_ids));
      assert.equal(body.bytes, 4000);
      assert.equal(body.tool_response, true);
      return { offer: delivery.offer(body.session, { ids: body.job_ids, bytes: body.bytes }) };
    },
  });
  const handle = vm.runInContext(`${stripTypeScriptTypes(standing + tool + handler)}; handle`, context);
  const call = async (name: string, args = {}, sessionId?: string) => {
    await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, _meta: { sessionId } } });
    return replies.at(-1).result;
  };
  const status = await call('status');
  assert.match(status.content[0].text, /Watched pull requests:\n\[pr-0\] o\/r#7 · open/);
  assert.match(status.content[0].text, /\[pr-0\] news 1/);
  assert.doesNotMatch(status.content[0].text, /pr-1|o\/r#8/);
  assert.match(status.content[0].text, /Board: board/);
  // The next list leaves out what has not changed since.
  const again = await call('status');
  assert.match(again.content[0].text, /Roles, usage and board: unchanged since the last list\./);
  assert.doesNotMatch(again.content[0].text, /Board: board/);
  const mission = await call('mission');
  assert.equal(mission.isError, true);
  assert.match(mission.content[0].text, /no open mission[^]*\[pr-0\] news 1/);
  missions.push({ id: 'm-1', state: 'active', project: '/project', owner: 'lead' });
  const current = await call('mission', { id: 'm-1' });
  assert.equal(current.isError, undefined);
  assert.match(current.content[0].text, /Current mission[^]*\[pr-0\] news 1/);
  assert.equal(unread(watches[0])[0].offers, 2);
  assert.deepEqual(offered, [undefined, undefined, ['pr-0'], ['pr-0']]);

  await t.test('status repeats the footer after compaction, with a time fallback only without hooks', async () => {
    const full = /Board: board/;
    const unchanged = /Roles, usage and board: unchanged since the last list\./;
    const hook = (session_id: string, hook_event_name: string, extra: object = {}) => sessions.ingest({ session_id, hook_event_name, ...extra });
    t.mock.timers.tick(30 * 60_000);
    assert.match((await call('status')).content[0].text, full, 'no hooks heard, so the age fallback applies');
    hook('lead', 'SessionStart', { source: 'resume' });
    hook('other', 'SessionStart', { source: 'compact' });
    t.mock.timers.tick(31 * 60_000);
    assert.match((await call('status')).content[0].text, unchanged, 'recent hooks and another session’s compaction do not resend it');
    hook('lead', 'SessionStart', { source: 'compact' });
    hook('lead', 'SessionEnd');
    hook('lead', 'SessionStart', { source: 'resume' });
    assert.match((await call('status')).content[0].text, full);
    assert.match((await call('status')).content[0].text, unchanged);

    context.host = 'codex';
    assert.match((await call('status', {}, 'thread')).content[0].text, full, 'a new session gets its own footer');
    assert.match((await call('status', {}, 'thread')).content[0].text, unchanged);
    t.mock.timers.tick(500);
    hook('thread', 'PreCompact', { host: 'codex' });
    assert.match((await call('status', {}, 'thread')).content[0].text, full);
    assert.match((await call('status', {}, 'thread')).content[0].text, unchanged);
  });
});

test('a Codex session says hello once, retries a failed hello or one with no folder, refuses a call naming no session, and starts a new session fresh', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const code = source.slice(source.indexOf('/** The hello for the Codex session'), source.indexOf('/** How a mission ended'));
  const hellos: string[] = [];
  let forgotten = 0;
  let answer: () => Promise<any> = async () => ({ cwd: '/work/repo' });
  const context: Record<string, any> = {
    SESSION: undefined, PROJECT: '/plugin', projectUnknown: true, forgetMissions: () => { forgotten++; }, canonicalPath: (p: string) => `canon:${p}`,
    api: async (_method: string, route: string, body: any) => { hellos.push(`${route} ${body.session} ${body.host}${body.desktop ? ' desktop' : ''}`); return answer(); },
  };
  const codexSession = vm.runInNewContext(`${stripTypeScriptTypes(code)}; codexSession`, context);
  // Calls arriving together wait on one hello, and none runs before the project is known.
  await Promise.all([codexSession({ sessionId: 'root' }), codexSession({ sessionId: 'root' })]);
  assert.deepEqual(hellos, ['/api/lead/hello root codex']);
  assert.deepEqual([context.SESSION, context.PROJECT, context.projectUnknown], ['root', 'canon:/work/repo', false]);
  assert.equal(forgotten, 0);
  // A call without a session is refused rather than acting as the last one.
  await assert.rejects(codexSession(undefined), /named no session/);
  await assert.rejects(codexSession({ threadId: 'root' }), /named no session/);
  assert.deepEqual([hellos.length, context.SESSION], [1, 'root']);
  // A failed hello fails the call and is tried again; a thread with no folder leaves the project unknown.
  answer = async () => { throw new Error('daemon stopping'); };
  await assert.rejects(codexSession({ sessionId: 'next' }), /could not register this Codex session.*daemon stopping/);
  answer = async () => ({ cwd: null });
  await codexSession({ sessionId: 'next' });
  assert.deepEqual([hellos.length, context.SESSION, context.projectUnknown, forgotten], [3, 'next', true, 1]);
  // Without a folder the next call asks again: the daemon may have failed to read it just then. A folder the lead
  // passed meanwhile stays until one is read.
  context.projectUnknown = false;
  context.PROJECT = '/lead/cwd';
  await codexSession({ sessionId: 'next' });
  assert.deepEqual([hellos.length, context.projectUnknown, context.PROJECT], [4, false, '/lead/cwd']);
  answer = async () => ({ cwd: '/work/next' });
  await codexSession({ sessionId: 'next' });
  await codexSession({ sessionId: 'next' });
  assert.deepEqual([hellos.length, context.PROJECT, forgotten], [5, 'canon:/work/next', 1]);
  // A desktop thread says so, whether Codex sends its turn metadata as an object or as JSON; anything else does not.
  await codexSession({ sessionId: 'app', 'x-codex-turn-metadata': { client_type: 'desktop_app' } });
  await codexSession({ sessionId: 'app-json', 'x-codex-turn-metadata': JSON.stringify({ client_type: 'desktop_app' }) });
  await codexSession({ sessionId: 'tui', 'x-codex-turn-metadata': '{not json' });
  assert.deepEqual(hellos.slice(-3), ['/api/lead/hello app codex desktop', '/api/lead/hello app-json codex desktop', '/api/lead/hello tui codex']);
});
