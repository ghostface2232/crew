import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import { STAGES, normalizeTitle } from '../plugin/bridge/missions.ts';
import type { Mission } from '../plugin/bridge/missions.ts';
import { TIERS } from '../plugin/bridge/tiers.ts';
import { defaultHolder, disabledAgents } from '../plugin/bridge/config.ts';
import { addNews, clipped, Delivery, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, REPORT_PAGE_BYTES, textPage, unread } from '../plugin/bridge/delivery.ts';
import type { Job } from '../plugin/bridge/jobs.ts';

test('mission forwards plans on start, revision, repeated titles and reattachment', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function describeMission('), source.indexOf('function describeJob'));
  let current: Mission | null = null;
  let saved: Mission[] = [];
  const calls: { method: string; route: string; body: any }[] = [];
  const run = vm.runInNewContext(`${stripTypeScriptTypes(handler)}; reportMission`, {
    STAGES, normalizeTitle, SESSION: 'lead', PROJECT: '/project', missionId: null, closedElsewhere: null, costMission: null, fresh: false,
    SUPERSEDED: 'Superseded by a new mission.', currentPolicy: () => 'policy', globalPreset: () => null,
    ownMission: async () => current,
    api: async (method: string, route: string, body: any) => {
      calls.push({ method, route, body });
      if (method === 'GET') return { missions: saved };
      return { id: 'm', stage: 'cross-review', stages: body.stages, state: 'active', title: 'Review' };
    },
  });
  const stages = ['cross-review', 'fix', 'final'];
  const report = await run({ title: 'Review', stages });
  assert.match(report, /step 1 of 3/);
  assert.deepEqual(calls.at(-1)?.body.stages, stages);
  current = { id: 'm', title: 'Review' } as Mission;
  for (const args of [{ stages }, { stage: 'fix', stages }]) {
    const update = await run(args);
    assert.match(update, /Plan: cross-review \(current\) → fix → final/);
    assert.equal(calls.at(-1)?.route, '/api/missions/m');
    assert.deepEqual(calls.at(-1)?.body.stages, stages);
  }
  // A resumed lead resending its starting call must not append its whole plan again.
  const before = calls.length;
  await run({ title: 'Review', stages });
  assert.equal(calls.length, before);
  await run({ title: 'Review', stage: 'fix', stages });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)?.body)), { stage: 'fix' });
  // A preset the user names reaches the mission on every path, and one left out changes nothing.
  await run({ title: 'Review', preset: 'economy' });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)?.body)), { preset: 'economy' });
  await run({ preset: null });
  assert.deepEqual({ ...calls.at(-1)?.body }, { stage: undefined, stages: undefined, preset: null });
  current = null;
  saved = [{ id: 'lost', title: 'Review', owner: 'lead', project: '/project', state: 'active' } as Mission];
  await run({ title: 'Review', stage: 'fix', stages });
  assert.equal(calls.at(-1)?.route, '/api/missions/lost');
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1)?.body)), { stage: 'fix' });
  saved = [];
  await run({ title: 'Cheap', stages, preset: 'economy' });
  assert.equal(calls.at(-1)?.body.preset, 'economy');
  const describe = vm.runInNewContext(`${stripTypeScriptTypes(handler.slice(0, handler.indexOf('async function reportMission')))}; describeMission`, { STAGES, currentPolicy: () => 'policy', globalPreset: () => null });
  assert.match(describe({ id: 'm', title: 'Review', state: 'active', stage: 'self-review', stageIndex: 2,
    stages: ['self-review', 'fix', 'self-review'] }), /Plan: self-review → fix → self-review \(current\)/);
});

test('only a restarted server takes a closed mission of this session for one it lost track of', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function describeMission('), source.indexOf('function describeJob'));
  const saved = [{ id: 'm0', title: 'Fix X', owner: 'lead', project: '/project', state: 'abandoned', outcome: 'Dismissed on the board.', createdAt: 1, stage: 'plan' }];
  const start = (fresh: boolean) => {
    const calls: string[] = [];
    const context = {
      STAGES, normalizeTitle, SESSION: 'lead', PROJECT: '/project', missionId: null, closedElsewhere: null, costMission: null, fresh,
      SUPERSEDED: 'Superseded by a new mission.', currentPolicy: () => 'policy', globalPreset: () => null, ownMission: async () => null,
      api: async (method: string, route: string, body: any) => {
        calls.push(`${method} ${route}`);
        return method === 'GET' ? { missions: saved } : { id: 'm1', title: body.title, stage: 'plan', state: 'active' };
      },
    };
    return { run: vm.runInNewContext(`${stripTypeScriptTypes(handler)}; reportMission`, context), calls, context };
  };
  const restarted = start(true);
  assert.match(await restarted.run({ title: 'Fix X' }), /closed outside this session/);
  assert.equal(restarted.context.costMission, 'm0');
  // A server that saw the mission end opens a new one when asked, as when the lead abandoned its own.
  const live = start(false);
  await live.run({ title: 'Fix X' });
  assert.ok(live.calls.includes('POST /api/missions'));
  assert.equal(live.context.costMission, 'm1');
});

test('polish advertises the shared model option and forwards it to the job', async () => {
  // Evaluate just the schema and handler case, without starting the stdio server or a daemon.
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const modelProps = vm.runInNewContext(`(${source.match(/const modelProps = (\{[^]*?\n\});/)![1]})`, { TIERS });
  const schema = source.slice(source.indexOf("    name: 'polish',"), source.indexOf("    name: 'debate',"));
  const tool = vm.runInNewContext(`({${schema.slice(0, schema.lastIndexOf('\n  },'))}})`, {
    holder: () => 'Antigravity', worktreeProps: {}, skillsProp: {}, common: {}, modelProps, agentProp: {},
  });
  assert.deepEqual(tool.inputSchema.properties.model, modelProps.model);
  assert.deepEqual([...tool.inputSchema.properties.tier.enum], [...TIERS]);
  const body = source.split("    case 'polish':")[1].split("    case 'mission':")[0];
  const run = vm.runInNewContext(`(async (args) => { const cwd = '/project', ctx = {}; ${body} })`, { runJob: (spec: unknown) => spec });
  assert.equal((await run({ targets: ['README.md'], model: 'selected-model' })).model, 'selected-model');
  assert.equal((await run({ targets: ['README.md'] })).model, undefined);
  assert.equal((await run({ targets: ['README.md'], tier: 'frontier' })).tier, 'frontier');
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
    AbortController, inFlight: new Map(), ensureDaemon: async () => {}, SESSION: 'lead',
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
    const text = page.slice(page.indexOf('\n') + 1, page.lastIndexOf('\n'));
    restored += text;
    offset += text.length;
    assert.ok(jsonBytes(page) < REPORT_PAGE_BYTES + 500);
  }
  assert.equal(restored, report);
  assert.match(await run({ job_id: job.id, report_offset: 0, turn: 1 }), /first answer/);
  await assert.rejects(run({ job_id: job.id, report_offset: 0, turn: 99 }), /not retained/);
});

test('a role the lead holds starts no worker, and a pick outside the holders is refused', () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/mcp.ts', import.meta.url), 'utf8');
  const code = source.slice(source.indexOf('/** What the lead does with a role it holds itself'), source.indexOf('async function callTool'));
  const roles = { review: { agents: ['codex', 'claude'] }, polish: { agents: ['claude'] } };
  const pick = vm.runInNewContext(`const holderName = (a) => a === 'claude' ? 'you, Claude' : a; const holder = (r, t) => t[r].agents.join(' or '); ${stripTypeScriptTypes(code)}; pickHolder`, {
    roles, LEAD: 'claude', loadConfig: () => ({ roles, antigravity: { enabled: true } }), defaultHolder, disabledAgents,
  });
  assert.deepEqual({ ...pick('review', undefined) }, { agent: 'codex' });
  assert.match(pick('review', 'claude').yours, /no worker was started\. Run the crew:self-reviewer subagent[^]*other holders: codex/);
  assert.match(pick('polish', undefined).yours, /^polish is yours/);
  assert.throws(() => pick('review', 'antigravity'), /antigravity does not hold review; its holders are codex or claude/);
});
