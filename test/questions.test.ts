import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, CrewEvent, JobCtl } from '../plugin/bridge/jobs.ts';
import { describe, needsLead } from '../plugin/bridge/render.ts';

function harness(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-questions-'));
  const workers = new Map<string, JobCtl>();
  const events: CrewEvent[] = [];
  const adapter: Adapter = {
    start: async (ctl) => { workers.set(ctl.job.id, ctl); ctl.session(ctl.job.id); },
    reply: async (ctl) => { workers.set(ctl.job.id, ctl); },
    answer: async () => {}, cancel: async () => {}, shutdown: () => {},
  };
  const config = resolveConfig({ notify: false });
  const hooks = { onEvent: (e: CrewEvent) => events.push(e), onJob: () => {}, onAttention: () => {} };
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks);
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const create = (spec = {}) => jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test', ...spec });
  return { home, jobs, workers, events, create, restore: () => new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks) };
}

test('lead questions persist, emit progress, and never carry the worker token on a Job', async (t) => {
  const h = harness(t);
  const job = await h.create();
  const worker = h.workers.get(job.id)!;
  const token = worker.mcp.env.CREW_JOB_TOKEN;
  const before = job.seq;
  const question = h.jobs.ask(job.id, 'Contract or test?\nThey disagree.', 'implementing the response');
  assert.equal(job.state, 'running');
  assert.equal(job.waiting, null);
  assert.equal(job.seq, before + 1);
  assert.deepEqual(h.events.at(-1), { ...h.events.at(-1), kind: 'progress', detail: 'asks the lead: Contract or test?' });
  assert.equal(needsLead(job), true);
  assert.match(describe(job), /ASKS YOU:.*Contract or test/);
  assert.ok(describe(job).includes(question.id));
  assert.match(describe(job), /Blocks: implementing the response/);
  assert.match(describe(job), /Call answer/);

  h.jobs.markDelivered(job.id, job.seq);
  worker.progress('working on another file');
  assert.equal(needsLead(job), false);
  assert.equal(h.jobs.workerAuthorized(job.id, token), true);
  assert.equal(h.jobs.workerAuthorized(job.id, ''), false);
  assert.equal(h.jobs.workerAuthorized(job.id, undefined), false);
  assert.equal(h.jobs.workerAuthorized('missing', token), false);
  assert.equal(JSON.stringify(job).includes(token), false);
  h.jobs.flush();
  const saved = fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8');
  assert.equal(saved.includes(token), false);
  assert.deepEqual(JSON.parse(saved).jobs[0].questions, [question]);
  const restored = h.restore();
  assert.deepEqual(restored.get(job.id).questions, [question]);
  assert.equal(restored.workerAuthorized(job.id, token), false);

  h.jobs.answer(job.id, question.id, 'Follow the contract.');
  assert.equal(question.answer, 'Follow the contract.');
  assert.equal(typeof question.answeredAt, 'number');
  assert.equal(job.state, 'running');
  assert.equal(needsLead(job), false);
  assert.equal(describe(job).includes('ASKS YOU'), false);
  assert.equal(describe(job).includes('Contract or test?'), false);
  assert.equal(h.events.at(-1)!.detail, `lead answered ${question.id}`);
  h.jobs.flush();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8')).jobs[0].questions[0].answer, question.answer);
});

test('lead question limits and states reject invalid input without changing the job', async (t) => {
  const h = harness(t);
  const job = await h.create();
  for (const text of ['', ' \n', 1, null, 'x'.repeat(4001)]) {
    assert.throws(() => h.jobs.ask(job.id, text as string), /Question text/);
  }
  assert.throws(() => h.jobs.ask(job.id, 'q', 1 as unknown as string), /blocks must/);
  assert.equal(job.questions, undefined);
  const first = h.jobs.ask(job.id, 'x'.repeat(4000));
  assert.throws(() => h.jobs.answer(job.id, 'missing', 'yes'), /No lead question/);
  for (const answer of ['', ' \n', 1, null]) assert.throws(() => h.jobs.answer(job.id, first.id, answer as string), /Answer must/);
  h.workers.get(job.id)!.waiting('approval', 'user approval');
  const waiting = job.waiting;
  const second = h.jobs.ask(job.id, 'Question while waiting');
  h.jobs.answer(job.id, second.id, 'yes');
  assert.equal(job.waiting, waiting);
  assert.equal(job.state, 'waiting');
  for (let i = 2; i < 20; i++) h.jobs.ask(job.id, `q${i}`);
  assert.throws(() => h.jobs.ask(job.id, '21st'), /20 lead questions/);
  h.jobs.answer(job.id, first.id, 'yes');
  assert.throws(() => h.jobs.answer(job.id, first.id, 'again'), /already answered/);
  assert.throws(() => h.jobs.ask(job.id, '21st even after answers'), /20 lead questions/);

  for (const state of ['done', 'failed', 'cancelled'] as const) {
    const ended = await h.create();
    const q = h.jobs.ask(ended.id, 'Before ending');
    if (state === 'done') h.workers.get(ended.id)!.done('done');
    else if (state === 'failed') h.workers.get(ended.id)!.fail('failed');
    else await h.jobs.cancel(ended.id);
    while (!ended.endedAt) await h.jobs.wait(ended.id, ended.seq, 1000);
    assert.throws(() => h.jobs.ask(ended.id, 'too late'), /running or waiting/);
    h.jobs.answer(ended.id, q.id, 'A record after ending');
    assert.equal(ended.state, state);
    assert.equal(q.answer, 'A record after ending');
  }
});

test('siblings are active jobs of the same mission, or the same project without a mission', async (t) => {
  const h = harness(t);
  const first = await h.create({ mission: 'one' });
  const sibling = await h.create({ mission: 'one', project: '/another/project' });
  await h.create({ mission: 'two' });
  const ended = await h.create({ mission: 'one' });
  await h.jobs.cancel(ended.id);
  h.workers.get(sibling.id)!.waiting('question', 'user question');
  sibling.worktree = { path: '/tree', branch: 'branch', base: 'abc123' };
  assert.deepEqual(h.jobs.siblings(first.id), [{ id: sibling.id, kind: 'delegate', agent: 'codex', title: 'test', phase: 'has a question', base: 'abc123' }]);
  const lone = await h.create();
  const sameProject = h.jobs.siblings(lone.id);
  assert.ok(sameProject.some((j) => j.id === first.id));
  assert.ok(!sameProject.some((j) => j.id === sibling.id || j.id === ended.id || j.id === lone.id));
});

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  child.kill('SIGTERM');
  await exited;
}

function stdio(t: TestContext, file: string, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [path.resolve('plugin/bridge', file)], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  let next = 0;
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line);
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(msg.error.message));
    else waiter.resolve(msg.result);
  });
  child.on('exit', () => {
    for (const waiter of pending.values()) waiter.reject(new Error(`stdio exited: ${stderr}`));
    pending.clear();
  });
  t.after(() => stop(child));
  const request = (method: string, params = {}): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  return { request, call: (name: string, args = {}) => request('tools/call', { name, arguments: args }) };
}

async function freePort(): Promise<number> {
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function daemon(t: TestContext) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-question-http-'));
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}
    const fs = require('node:fs');
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'thread/start') {
        const crew = m.params.config.mcp_servers.crew;
        fs.writeFileSync(__dirname + '/' + crew.env.CREW_JOB_ID + '.json', JSON.stringify(crew));
        return send({ id: m.id, result: { thread: { id: crew.env.CREW_JOB_ID } } });
      }
      if (m.method === 'turn/start') return send({ id: m.id, result: { turn: { id: 'turn' } } });
      if (m.method === 'turn/steer') send({ method: 'item/started', params: { threadId: m.params.threadId, item: { type: 'commandExecution', command: 'working independently' } } });
      if (m.method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn', status: 'interrupted' } } });
      if (m.method && m.id != null) send({ id: m.id, result: {} });
    });
  `, { mode: 0o700 });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ notify: false, codex: { bin } }));
  const env = { ...process.env, CREW_HOME: home, CREW_PORT: String(port), CLAUDE_PROJECT_DIR: home, CREW_AGENTGAUGE_DIR: path.join(home, 'gauge') };
  const child = spawn(process.execPath, [path.resolve('plugin/bridge/daemon.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { await stop(child); fs.rmSync(home, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('listening on')) resolve(); });
    child.stderr.on('data', (chunk) => reject(new Error(String(chunk))));
    child.once('exit', (code) => reject(new Error(`daemon exited ${code}`)));
  });
  // The lead's side of every request carries the secret the daemon wrote when it started; `headers` can take it away.
  const secret = fs.readFileSync(path.join(home, 'token'), 'utf8').trim();
  const api = async (method: string, route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}`, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json() as any };
  };
  const create = async () => {
    const { body: job } = await api('POST', '/api/jobs', { kind: 'delegate', cwd: home, project: home, task: 'test', isolation: 'in_place' });
    const file = path.join(home, `${job.id}.json`);
    while (!fs.existsSync(file)) await new Promise((resolve) => setTimeout(resolve, 10));
    return { job, server: JSON.parse(fs.readFileSync(file, 'utf8')) };
  };
  const hostStatus = () => new Promise<number>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.invalid' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    request.on('error', reject);
  });
  return { home, env, api, create, hostStatus, port, secret };
}

const textOf = (result: any): string => {
  assert.equal(result.isError, undefined, result.content[0].text);
  return result.content[0].text;
};
const pendingAfter = async (promise: Promise<unknown>) => assert.equal(await Promise.race([promise.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 100))]), true);

test('worker stdio and all question routes use a private token, with answers waking long-polls', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job, server } = await h.create();
  const token = server.env.CREW_JOB_TOKEN;
  const route = `/api/jobs/${job.id}`;
  for (const bad of [undefined, '', 'wrong']) {
    assert.equal((await h.api('POST', `${route}/questions`, { text: 'q', token: bad })).status, 403);
    for (const action of ['questions', 'siblings']) assert.equal((await h.api('GET', `${route}/${action}${bad === undefined ? '' : `?token=${bad}`}`)).status, 403);
  }
  assert.equal((await h.api('POST', `${route}/questions`, null)).status, 403);
  assert.equal((await h.api('POST', `${route}/questions`, { text: 'q', token }, { origin: 'https://example.invalid' })).status, 403);
  assert.equal(await h.hostStatus(), 403);
  const worker = stdio(t, 'worker-mcp.ts', { ...h.env, ...server.env });
  assert.equal((await worker.request('initialize', { protocolVersion: '2025-11-25' })).serverInfo.name, 'crew-worker');
  const tools = (await worker.request('tools/list')).tools;
  assert.deepEqual(tools.map((tool: any) => tool.name), ['ask_lead', 'lead_answers', 'siblings']);
  assert.deepEqual(await worker.request('ping'), {});
  const question = JSON.parse(textOf(await worker.call('ask_lead', { question: 'Which contract?', blocks: 'the API' })));
  assert.match(question.guidance, /Carry on.*lead_answers/);
  let answers = JSON.parse(textOf(await worker.call('lead_answers'))).questions;
  assert.equal(answers[0].answer, 'not answered yet');
  const polling = worker.call('lead_answers', { wait_seconds: 10 });
  await pendingAfter(polling);
  const answered = await h.api('POST', `${route}/questions/${question.id}`, { answer: 'The published contract.' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.state, 'running');
  assert.equal(answered.body.waiting, null);
  answers = JSON.parse(textOf(await polling)).questions;
  assert.equal(answers[0].answer, 'The published contract.');
  assert.equal((await h.api('POST', `${route}/questions/${question.id}`, { answer: 'again' })).status, 400);
  assert.equal((await h.api('POST', `${route}/questions/missing`, { answer: 'yes' })).status, 400);
  assert.equal((await h.api('GET', `${route}/questions?token=${token}&wait=NaN`)).status, 400);
  assert.equal((await worker.call('lead_answers', { wait_seconds: -1 })).isError, true);
  assert.equal((await worker.call('unknown')).isError, true);
  const sibling = await h.create();
  const siblings = JSON.parse(textOf(await worker.call('siblings')));
  assert.deepEqual(siblings.map((s: any) => s.id), [sibling.job.id]);
  assert.deepEqual(Object.keys(siblings[0]).sort(), ['id', 'kind', 'agent', 'title', 'phase', 'base'].sort());
  assert.equal(JSON.stringify((await h.api('GET', '/api/state')).body).includes(token), false);
  assert.equal(JSON.stringify((await h.api('GET', route)).body).includes(token), false);
  // Shutdown flushes the same job views tested above to disk.
  await h.api('POST', '/api/shutdown', {});
  while (!fs.existsSync(path.join(h.home, 'jobs.json'))) await new Promise((resolve) => setTimeout(resolve, 10));
  const saved = fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8');
  assert.equal(saved.includes(token), false);
  assert.ok(saved.includes('The published contract.'));
});

test('lead wait delivers a running question once, ignores further progress, and blocks after answering', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job, server } = await h.create();
  const lead = stdio(t, 'mcp.ts', h.env);
  const init = await lead.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.match(init.instructions, /ask_lead mid-task/);
  assert.ok((await lead.request('tools/list')).tools.some((tool: any) => tool.name === 'answer'));
  const route = `/api/jobs/${job.id}`;
  const waiting = lead.call('wait', { job_ids: [job.id], timeout_seconds: 5 });
  await pendingAfter(waiting);
  const { body: question } = await h.api('POST', `${route}/questions`, { token: server.env.CREW_JOB_TOKEN, text: 'Choose the behavior.', blocks: 'implementation' });
  assert.match(textOf(await waiting), /RUNNING.*test[\s\S]*ASKS YOU/);
  let current = (await h.api('GET', route)).body;
  assert.equal(current.delivered, current.seq);
  const nextWait = lead.call('wait', { job_ids: [job.id], timeout_seconds: 5 });
  await h.api('POST', `${route}/reply`, { message: 'work on the independent part' });
  await pendingAfter(nextWait);
  textOf(await lead.call('answer', { job_id: job.id, question_id: question.id, answer: 'Follow the contract.' }));
  await pendingAfter(nextWait);
  current = (await h.api('GET', route)).body;
  assert.equal(current.state, 'running');
  assert.equal(current.turns, 1);
  const { body: second } = await h.api('POST', `${route}/questions`, { token: server.env.CREW_JOB_TOKEN, text: 'Another decision?' });
  const result = textOf(await nextWait);
  assert.ok(result.includes(second.id));
  assert.equal(result.includes(question.id), false);
  const { body: third } = await h.api('POST', `${route}/questions`, { token: server.env.CREW_JOB_TOKEN, text: 'One more decision?' });
  const answerResult = textOf(await lead.call('answer', { job_id: job.id, question_id: second.id, answer: 'yes' }));
  assert.ok(answerResult.includes(third.id));
  const status = textOf(await lead.call('status', { job_id: job.id }));
  assert.ok(status.includes(third.id));
  const timedOut = textOf(await lead.call('wait', { job_ids: [job.id], timeout_seconds: 0.05 }));
  assert.match(timedOut, /Timed out waiting; still running/);
  assert.equal(timedOut.includes('ASKS YOU'), false);
});

test('lead answer polling waits for an open answer, times out, and caps waits at 600 seconds', async (t) => {
  const h = harness(t);
  const job = await h.create();
  assert.deepEqual(await h.jobs.leadAnswers(job.id, 600), []);
  const answered = h.jobs.ask(job.id, 'Already answered');
  h.jobs.answer(job.id, answered.id, 'yes');
  assert.deepEqual(await h.jobs.leadAnswers(job.id, 600), [answered]);
  const open = h.jobs.ask(job.id, 'Still open');
  for (const seconds of [-1, NaN, Infinity]) await assert.rejects(h.jobs.leadAnswers(job.id, seconds), /non-negative/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let finished = false;
  const polling = h.jobs.leadAnswers(job.id, 1000).then((questions) => { finished = true; return questions; });
  t.mock.timers.tick(599_999);
  await Promise.resolve();
  assert.equal(finished, false);
  t.mock.timers.tick(1);
  assert.deepEqual(await polling, [answered, open]);
  t.mock.timers.reset();
});

test('wake reports a running question and never wakes again for progress on the same question', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job, server } = await h.create();
  const wake = () => {
    const child = spawn(process.execPath, [path.resolve('plugin/bridge/wake.ts')], { env: h.env, stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once('exit', (code) => resolve({ code, stderr })));
    child.stdin.end(JSON.stringify({ tool_response: `[${job.id}]` }));
    t.after(() => stop(child));
    return exited;
  };
  const first = wake();
  await pendingAfter(first);
  const route = `/api/jobs/${job.id}`;
  const ask = (text: string) => h.api('POST', `${route}/questions`, { token: server.env.CREW_JOB_TOKEN, text });
  const { body: question } = await ask('A lead decision');
  const shown = await first;
  assert.equal(shown.code, 2);
  assert.ok(shown.stderr.includes(question.id));
  assert.match(shown.stderr, /RUNNING[\s\S]*ASKS YOU/);
  const next = wake();
  await h.api('POST', `${route}/reply`, { message: 'independent progress' });
  assert.equal(await Promise.race([next.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 1800))]), true);
  const { body: second } = await ask('A new decision');
  const newUpdate = await next;
  assert.equal(newUpdate.code, 2);
  assert.ok(newUpdate.stderr.includes(second.id));
});

test('the daemon answers only requests that carry its secret, as a header or as the board cookie', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const none = { authorization: '' };
  assert.equal(fs.statSync(path.join(h.home, 'token')).mode & 0o777, 0o600);
  assert.match(h.secret, /^[0-9a-f]{64}$/);

  // Open without it: finding the daemon, the page itself, Claude's hooks.
  assert.equal((await h.api('GET', '/api/health', undefined, none)).status, 200);
  assert.equal((await h.api('POST', '/api/hooks/claude', { hook_event_name: 'Stop', session_id: 's' }, none)).status, 200);
  // Everything else is refused, read or write, and refused work leaves nothing behind.
  for (const [method, route, body] of [['GET', '/api/state'], ['GET', '/api/usage'], ['GET', '/api/instructions'], ['POST', '/api/jobs', { kind: 'delegate', cwd: h.home, task: 'x', isolation: 'in_place' }], ['POST', '/api/preset', { preset: 'best' }], ['POST', '/api/shutdown', {}]] as const) {
    assert.deepEqual(await h.api(method, route, body, none), { status: 401, body: { error: 'unauthorized' } }, `${method} ${route}`);
    assert.equal((await h.api(method, route, body, { authorization: 'Bearer wrong' })).status, 401);
  }
  assert.deepEqual((await h.api('GET', '/api/state')).body.jobs, []);
  const stream = await fetch(`http://127.0.0.1:${h.port}/api/stream`);
  assert.equal(stream.status, 401);

  // The lead's answer route needs the secret too: a worker with the network open cannot answer as the lead.
  const { job, server } = await h.create();
  const question = (await h.api('POST', `/api/jobs/${job.id}/questions`, { text: 'which?', token: server.env.CREW_JOB_TOKEN }, none)).body;
  assert.equal((await h.api('POST', `/api/jobs/${job.id}/questions/${question.id}`, { answer: 'forged' }, none)).status, 401);
  assert.equal((await h.api('POST', `/api/jobs/${job.id}/questions/${question.id}`, { answer: 'real' })).status, 200);

  // The board signs in with the token once and holds a cookie after that.
  assert.equal((await h.api('POST', '/api/session', { token: 'wrong' }, none)).status, 401);
  const signIn = await fetch(`http://127.0.0.1:${h.port}/api/session`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: h.secret }) });
  assert.equal(signIn.status, 200);
  const cookie = signIn.headers.get('set-cookie')!;
  assert.match(cookie, /^crew_session=[0-9a-f]{64}; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+$/);
  assert.equal((await h.api('GET', '/api/state', undefined, { authorization: '', cookie: cookie.split(';')[0] })).status, 200);
  assert.equal((await h.api('GET', '/api/state', undefined, { authorization: '', cookie: 'crew_session=wrong' })).status, 401);
});
