import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { runCheck } from '../plugin/bridge/check.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, CrewEvent, Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { describe, needsLead } from '../plugin/bridge/render.ts';
import { writeFakeBin } from './fake-bin.ts';

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
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const create = (spec = {}) => jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test', lead: 'test-lead', ...spec });
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

  const offer = h.jobs.delivery.offer('test-lead')!;
  h.jobs.delivery.ack('test-lead', offer.receipt);
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
  sibling.targets = ['docs/a.md'];
  assert.deepEqual(h.jobs.siblings(first.id), [{ id: sibling.id, kind: 'delegate', agent: 'codex', title: 'test', files: ['docs/a.md'], asking: false, base: 'abc123' }]);
  // A question to the lead shows, so a neighbor can tell that job is held up; one to the user does not.
  h.workers.get(sibling.id)!.resumed();
  h.jobs.ask(sibling.id, 'which?', undefined);
  assert.equal(h.jobs.siblings(first.id)[0].asking, true);
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

/** `prepare` fills the home before the daemon first reads it; `preload` is a module imported before the daemon's own. */
async function daemon(t: TestContext, prepare?: (home: string) => void, preload?: string) {
  const port = await freePort();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-question-http-'));
  const bin = path.join(home, 'codex');
  writeFakeBin(bin, `
    const fs = require('node:fs');
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const m = JSON.parse(line);
      if (m.method === 'thread/start') {
        const crew = m.params.config.mcp_servers.crew;
        // Renamed into place, so the test never reads it half written.
        const file = __dirname + '/' + crew.env.CREW_JOB_ID + '.json';
        fs.writeFileSync(file + '.tmp', JSON.stringify(crew));
        fs.renameSync(file + '.tmp', file);
        return send({ id: m.id, result: { thread: { id: crew.env.CREW_JOB_ID } } });
      }
      if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'turn' } } });
        // Read after the reply above, so a client that sees it knows the bridge has the turn confirmed.
        return send({ method: 'item/started', params: { threadId: m.params.threadId, item: { type: 'commandExecution', command: 'turn started' } } });
      }
      if (m.method === 'turn/steer') send({ method: 'item/started', params: { threadId: m.params.threadId, item: { type: 'commandExecution', command: 'working independently' } } });
      if (m.method === 'turn/interrupt') send({ method: 'turn/completed', params: { threadId: m.params.threadId, turn: { id: 'turn', status: 'interrupted' } } });
      if (m.method && m.id != null) send({ id: m.id, result: {} });
    });
  `);
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ notify: false, codex: { bin } }));
  // A job's model is read from Codex's own model cache, which a machine without Codex does not have.
  fs.writeFileSync(path.join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-test-sol' }] }));
  const env = { ...process.env, CREW_HOME: home, CREW_PORT: String(port), CLAUDE_PROJECT_DIR: home, CLAUDE_CODE_SESSION_ID: 'test-lead', CREW_AGENTGAUGE_DIR: path.join(home, 'gauge'), CODEX_HOME: home };
  prepare?.(home);
  const args = preload ? ['--import', preload] : [];
  const child = spawn(process.execPath, [...args, path.resolve('plugin/bridge/daemon.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { await stop(child); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
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
  // Codex refuses a cancel or a message until it confirms the turn, which a loaded machine can delay.
  const started = async (id: string) => {
    while (!/turn started/.test((await api('GET', `/api/jobs/${id}`)).body.phase)) await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const create = async () => {
    const { body: job } = await api('POST', '/api/jobs', { kind: 'delegate', cwd: home, project: home, task: 'test', isolation: 'in_place', lead: 'test-lead' });
    await started(job.id);
    return { job, server: JSON.parse(fs.readFileSync(path.join(home, `${job.id}.json`), 'utf8')) };
  };
  const hostStatus = () => new Promise<number>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/api/state', headers: { host: 'evil.invalid' } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode!));
    });
    request.on('error', reject);
  });
  // What a board page holds once it has traded in a ticket.
  const board = async (): Promise<Record<string, string>> => {
    const { ticket } = (await api('POST', '/api/session/ticket', {})).body;
    return { authorization: `Bearer ${(await api('POST', '/api/session', { ticket }, { authorization: '' })).body.credential}` };
  };
  return { home, env, api, create, started, hostStatus, port, secret, board, child };
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
  assert.deepEqual(tools.map((tool: any) => tool.name), ['ask_lead', 'lead_answers', 'browser', 'siblings', 'search', 'recent_changes', 'rate']);
  // Starting a browser outside the sandbox takes the worker's own token.
  assert.equal((await h.api('POST', `${route}/browser`, { token: 'wrong' })).status, 403);
  assert.deepEqual(await worker.request('ping'), {});
  const question = JSON.parse(textOf(await worker.call('ask_lead', { question: 'Which contract?', blocks: 'the API' })));
  assert.match(question.guidance, /Carry on.*lead_answers/);
  let answers = JSON.parse(textOf(await worker.call('lead_answers')));
  assert.deepEqual([answers.answered, answers.open.map((q: any) => [q.question, q.blocks]), answers.answered_earlier], [[], [['Which contract?', 'the API']], 0]);
  const polling = worker.call('lead_answers', { wait_seconds: 10 });
  await pendingAfter(polling);
  const answered = await h.api('POST', `${route}/questions/${question.id}`, { answer: 'The published contract.' });
  assert.equal(answered.status, 200);
  assert.equal(answered.body.state, 'running');
  assert.equal(answered.body.waiting, null);
  answers = JSON.parse(textOf(await polling));
  assert.deepEqual([answers.answered.map((q: any) => q.answer), answers.open, answers.answered_earlier], [['The published contract.'], [], 0]);
  // An answer is handed over once; asking again does not send the history a second time.
  answers = JSON.parse(textOf(await worker.call('lead_answers')));
  assert.deepEqual([answers.answered, answers.open, answers.answered_earlier], [[], [], 1]);
  assert.equal((await h.api('POST', `${route}/questions/${question.id}`, { answer: 'again' })).status, 400);
  assert.equal((await h.api('POST', `${route}/questions/missing`, { answer: 'yes' })).status, 400);
  assert.equal((await h.api('GET', `${route}/questions?token=${token}&wait=NaN`)).status, 400);
  assert.equal((await worker.call('lead_answers', { wait_seconds: -1 })).isError, true);
  assert.equal((await worker.call('unknown')).isError, true);
  // A poll starting after an answer arrives must return it even if a different question stays open.
  await worker.call('ask_lead', { question: 'One more?' });
  const reader = stdio(t, 'worker-mcp.ts', { ...h.env, ...server.env });
  const latest = JSON.parse(textOf(await reader.call('lead_answers', { wait_seconds: 600 })));
  assert.deepEqual([latest.answered[0].id, latest.open[0].question], [question.id, 'One more?']);
  const sibling = await h.create();
  const siblings = JSON.parse(textOf(await worker.call('siblings')));
  assert.deepEqual(siblings.map((s: any) => s.id), [sibling.job.id]);
  assert.deepEqual(Object.keys(siblings[0]).sort(), ['id', 'kind', 'agent', 'title', 'files', 'asking', 'base'].sort());
  assert.equal(JSON.stringify((await h.api('GET', '/api/state')).body).includes(token), false);
  assert.equal(JSON.stringify((await h.api('GET', route)).body).includes(token), false);
  // Shutdown flushes the same job views tested above to disk, then removes daemon.json. jobs.json alone proves
  // nothing: a save scheduled before the answer may have written it already.
  await h.api('POST', '/api/shutdown', {});
  while (fs.existsSync(path.join(h.home, 'daemon.json'))) await new Promise((resolve) => setTimeout(resolve, 10));
  const saved = fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8');
  assert.equal(saved.includes(token), false);
  assert.ok(saved.includes('The published contract.'));
});

test('lead wait delivers a running question once, ignores further progress, and blocks after answering', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job, server } = await h.create();
  const lead = stdio(t, 'mcp.ts', h.env);
  const init = await lead.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.match(init.instructions, /\(ask_lead\) is yours to answer/);
  assert.ok((await lead.request('tools/list')).tools.some((tool: any) => tool.name === 'answer'));
  const route = `/api/jobs/${job.id}`;
  const waiting = lead.call('wait', { job_ids: [job.id], timeout_seconds: 5 });
  await pendingAfter(waiting);
  const { body: question } = await h.api('POST', `${route}/questions`, { token: server.env.CREW_JOB_TOKEN, text: 'Choose the behavior.', blocks: 'implementation' });
  const shown = textOf(await waiting);
  assert.match(shown, /RUNNING.*test[\s\S]*ASKS YOU/);
  const receipt = shown.match(/Receipt: ([\w-]+)/)![1];
  let current = (await h.api('GET', route)).body;
  assert.ok(current.delivered < current.seq);
  const nextWait = lead.call('wait', { job_ids: [job.id], timeout_seconds: 5, ack: receipt });
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
  const status = textOf(await lead.call('status', { job_id: job.id, ack: answerResult.match(/Receipt: ([\w-]+)/)![1] }));
  assert.ok(status.includes(third.id));
  const timedOut = textOf(await lead.call('wait', { job_ids: [job.id], timeout_seconds: 0.05, ...(status.match(/Receipt: ([\w-]+)/) ? { ack: status.match(/Receipt: ([\w-]+)/)![1] } : {}) }));
  assert.match(timedOut, /Timed out waiting; still running/);
  assert.equal(timedOut.includes('ASKS YOU'), false);
});

test('job tools return at once by default, so the lead can end its turn while the worker runs', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job } = await h.create();
  const lead = stdio(t, 'mcp.ts', h.env);
  const init = await lead.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  assert.match(init.instructions, /end your turn/);
  const replied = textOf(await lead.call('reply', { job_id: job.id, message: 'keep going' }));
  assert.match(replied, /RUNNING[\s\S]*end your turn rather than waiting/);
  assert.equal((await h.api('GET', `/api/jobs/${job.id}`)).body.state, 'running');
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
    child.stdin.end(JSON.stringify({ session_id: 'test-lead', hook_event_name: 'PostToolUse', tool_response: 'result too large' }));
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
  await h.api('POST', '/api/lead/ack', { session: 'test-lead', ack: shown.stderr.match(/Receipt: ([\w-]+)/)![1] });
  const next = wake();
  await h.api('POST', `${route}/reply`, { message: 'independent progress' });
  assert.equal(await Promise.race([next.then(() => false), new Promise((resolve) => setTimeout(() => resolve(true), 1800))]), true);
  const { body: second } = await ask('A new decision');
  const newUpdate = await next;
  assert.equal(newUpdate.code, 2);
  assert.ok(newUpdate.stderr.includes(second.id));
});

test('the daemon answers only requests that carry its secret, or what a board bought with a ticket', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const none = { authorization: '' };
  // Windows has no POSIX file modes.
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(h.home, 'token')).mode & 0o777, 0o600);
  assert.match(h.secret, /^[0-9a-f]{64}$/);

  // Open without it: finding the daemon and the page itself.
  assert.equal((await h.api('GET', '/api/health', undefined, none)).status, 200);
  // Claude's hooks are not: what a prompt hook reports is later shown as the user's own words.
  assert.equal((await h.api('POST', '/api/hooks/claude', { hook_event_name: 'Stop', session_id: 's' }, none)).status, 401);
  assert.equal((await h.api('POST', '/api/hooks/claude', { hook_event_name: 'Stop', session_id: 's' })).status, 200);
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

  // The cookie that once carried the secret is no longer read, and a browser that still sends it is told to drop it.
  const stale = await fetch(`http://127.0.0.1:${h.port}/api/state`, { headers: { cookie: `crew_session=${h.secret}` } });
  assert.equal(stale.status, 401);
  assert.equal(stale.headers.get('set-cookie'), 'crew_session=; Path=/; Max-Age=0');
  // Nor does the secret itself sign a page in: that would put it in an address.
  assert.equal((await h.api('POST', '/api/session', { token: h.secret }, none)).status, 401);
});

test('a board signs in once with a ticket and may do only what its pages do', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const none = { authorization: '' };
  // Only the user's own program gets a ticket.
  assert.equal((await h.api('POST', '/api/session/ticket', {}, none)).status, 401);
  const issued = await fetch(`http://127.0.0.1:${h.port}/api/session/ticket`, { method: 'POST', headers: { authorization: `Bearer ${h.secret}` } });
  assert.equal(issued.headers.get('cache-control'), 'no-store');
  const { ticket } = await issued.json() as { ticket: string };
  assert.match(ticket, /^[0-9a-f]{64}$/);
  // Two pages sending one ticket at the same moment: one is signed in.
  const both = await Promise.all([0, 1].map(() => h.api('POST', '/api/session', { ticket }, none)));
  assert.deepEqual(both.map((reply) => reply.status).sort(), [200, 401]);
  const { credential, expires } = both.find((reply) => reply.status === 200)!.body;
  assert.equal((await h.api('POST', '/api/session', { ticket }, none)).status, 401);
  for (const bad of [undefined, '', 'wrong', ['x'], {}]) assert.equal((await h.api('POST', '/api/session', { ticket: bad }, none)).status, 401);
  // It is not the secret, it holds for a week, and a changed one is refused.
  assert.equal(credential.includes(h.secret), false);
  assert.ok(Math.abs(expires - (Date.now() + 7 * 24 * 60 * 60 * 1000)) < 60_000);
  const board = { authorization: `Bearer ${credential}` };
  assert.equal((await h.api('GET', '/api/state', undefined, board)).status, 200);
  const later = credential.replace(/^board\.\d+/, `board.${expires + 1}`);
  assert.equal((await h.api('GET', '/api/state', undefined, { authorization: `Bearer ${later}` })).status, 401);

  // What the board's pages send goes through.
  const { job } = await h.create();
  assert.equal((await h.api('POST', '/api/preset', { preset: 'best' }, board)).status, 200);
  assert.equal((await h.api('POST', `/api/jobs/${job.id}/reply`, { message: 'carry on' }, board)).status, 200);
  // What only the lead, the CLI or the app sends does not, and leaves nothing behind.
  const refused = { status: 403, body: { error: 'The board may not do this.' } };
  for (const [route, body] of [
    ['/api/session/ticket', {}], ['/api/hooks/claude', { hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'forged' }],
    ['/api/lead/context', { session: 'test-lead' }], [`/api/jobs/${job.id}/discard`, {}], ['/api/gc', { apply: true }],
    ['/api/desktop/heartbeat', {}], ['/api/missions', { title: 'x', project: h.home }], ['/api/notes', {}], ['/api/shutdown', {}],
  ] as const) assert.deepEqual(await h.api('POST', route, body, board), refused, route);
  assert.deepEqual(await h.api('POST', `/api/jobs/${job.id}/questions/q1`, { answer: 'as the lead' }, board), refused);
  // Nor the parts of its own requests that speak for the user or the lead, or have the daemon read a file.
  const image = path.join(h.home, 'shot.png');
  fs.writeFileSync(image, 'png');
  for (const [route, body] of [
    [`/api/jobs/${job.id}/reply`, { message: 'x', approved_by_user: 'do it' }], [`/api/jobs/${job.id}/reply`, { message: 'x', lead_session: 'test-lead' }],
    [`/api/jobs/${job.id}/reply`, { message: 'x', attachments: [image] }], ['/api/missions/m-000000', { done: true, by: 'lead' }], ['/api/jobs', { kind: 'delegate', cwd: h.home, task: 'x', isolation: 'in_place', lead: 'test-lead' }],
    ['/api/jobs', { kind: 'delegate', cwd: h.home, task: 'x', isolation: 'in_place', check: 'true' }],
  ] as const) assert.deepEqual(await h.api('POST', route, body, board), { status: 403, body: { error: 'The board may not send this.' } }, JSON.stringify(body));
  assert.equal((await h.api('GET', '/api/state')).body.jobs.length, 1);

  // An image element cannot send the credential, so each recorded file's address carries a seal for that file alone.
  const attached = (await h.api('POST', `/api/jobs/${job.id}/reply`, { message: 'see this', attachments: [image] })).body;
  const [item] = attached.evidence;
  assert.match(item.sig, /^[0-9a-f]{64}$/);
  assert.equal((await h.api('GET', `/api/jobs/${job.id}`)).body.evidence[0].sig, item.sig);
  const file = `http://127.0.0.1:${h.port}/api/jobs/${job.id}/evidence/${encodeURIComponent(item.file)}`;
  const sealed = await fetch(`${file}?v=${item.modified}&sig=${item.sig}`);
  assert.equal(sealed.status, 200);
  assert.equal(await sealed.text(), 'png');
  assert.equal((await fetch(file, { headers: board })).status, 200);
  for (const sig of ['', 'wrong', item.sig.replace(/.$/, (last: string) => (last === '0' ? '1' : '0'))]) assert.equal((await fetch(`${file}?sig=${sig}`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/jobs/${job.id}/evidence/%?sig=${item.sig}`)).status, 401);
  // Another job, another file, or a job that does not exist: the seal opens nothing, and says nothing about what exists.
  assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/jobs/cx-000000/evidence/${encodeURIComponent(item.file)}?sig=${item.sig}`)).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${h.port}/api/jobs/${job.id}/evidence/other.png?sig=${item.sig}`)).status, 401);
});

test('a secret made before tickets is replaced once, and a restart keeps the new one', { timeout: 30000 }, async (t) => {
  const h = await daemon(t);
  const { credential } = (await h.api('POST', '/api/session', { ticket: (await h.api('POST', '/api/session/ticket', {})).body.ticket }, { authorization: '' })).body;
  const secret = () => fs.readFileSync(path.join(h.home, 'token'), 'utf8').trim();
  const state = (authorization: string) => fetch(`http://127.0.0.1:${h.port}/api/state`, { headers: { authorization } }).then((res) => res.status);
  let running: ChildProcess | undefined;
  const restart = async () => {
    const stopped = await fetch(`http://127.0.0.1:${h.port}/api/shutdown`, { method: 'POST', headers: { authorization: `Bearer ${secret()}` } });
    assert.equal(stopped.status, 200);
    while (fs.existsSync(path.join(h.home, 'daemon.json'))) await new Promise((resolve) => setTimeout(resolve, 10));
    const child = running = spawn(process.execPath, [path.resolve('plugin/bridge/daemon.ts')], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise<void>((resolve, reject) => {
      child.stdout!.on('data', (chunk) => { if (String(chunk).includes('listening on')) resolve(); });
      child.once('exit', (code) => reject(new Error(`daemon exited ${code}`)));
    });
    return secret();
  };
  try {
    // The same secret after a restart: an open board is still signed in.
    assert.equal(await restart(), h.secret);
    assert.equal(await state(`Bearer ${credential}`), 200);
    // As an earlier version left it: a secret with nothing beside it saying it was made after tickets.
    fs.rmSync(path.join(h.home, 'token.version'));
    const replaced = await restart();
    assert.match(replaced, /^[0-9a-f]{64}$/);
    assert.notEqual(replaced, h.secret);
    assert.equal(fs.readFileSync(path.join(h.home, 'token.version'), 'utf8'), '2\n');
    // The old secret, and everything sealed with it, stops working.
    assert.equal(await state(`Bearer ${h.secret}`), 401);
    assert.equal(await state(`Bearer ${credential}`), 401);
    assert.equal(await state(`Bearer ${replaced}`), 200);
    assert.equal(await restart(), replaced);
  } finally {
    // Before the harness removes the home it saves into.
    if (running) await stop(running);
  }
});

test('mission routes revise only the future, capture job rounds and let the user mark another session mission done', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const mission = (await h.api('POST', '/api/missions', {
    title: 'Repeated review', project: h.home, owner: 'another-session',
    stages: ['implement', 'self-review', 'fix', 'self-review', 'polish', 'final'],
  })).body;
  assert.equal(mission.stageIndex, 0);
  assert.equal(mission.stage, 'implement');
  const route = `/api/missions/${mission.id}`;
  await h.api('POST', route, { stage: 'self-review' });
  const create = () => h.api('POST', '/api/jobs', {
    kind: 'delegate', cwd: h.home, project: h.home, task: 'test', isolation: 'in_place',
    mission: mission.id, missionStep: 99,
  });
  const first = (await create()).body;
  assert.equal(first.missionStep, 1);
  await h.api('POST', route, { stage: 'fix' });
  const advanced = (await h.api('POST', route, { stage: 'self-review' })).body;
  assert.equal(advanced.stageIndex, 3);
  const second = (await create()).body;
  assert.equal(second.missionStep, 3);
  const revised = (await h.api('POST', route, { stages: ['final'] })).body;
  assert.deepEqual(revised.stages, ['implement', 'self-review', 'fix', 'self-review', 'final']);
  assert.equal(revised.stageIndex, 3);
  const state = (await h.api('GET', '/api/state')).body;
  assert.equal(state.jobs.find((job: Job) => job.id === first.id).missionStep, 1);
  assert.equal(state.jobs.find((job: Job) => job.id === second.id).missionStep, 3);
  const stream = await fetch(`http://127.0.0.1:${h.port}/api/stream`, {
    headers: { authorization: `Bearer ${h.secret}` }, signal: AbortSignal.timeout(10000),
  });
  const reader = stream.body!.getReader();
  try {
    await reader.read();
    const before = Date.now();
    await h.started(first.id);
    assert.equal((await h.api('POST', `/api/jobs/${first.id}/cancel`, {})).status, 200);
    let wire = '';
    let frame: RegExpMatchArray | null = null;
    while (!frame) {
      const { value, done } = await reader.read();
      assert.equal(done, false);
      wire += Buffer.from(value!).toString();
      frame = wire.match(/event: mission\ndata: (.+)\n\n/);
    }
    const refreshed = JSON.parse(frame[1]);
    assert.equal(refreshed.id, mission.id);
    assert.ok(refreshed.updatedAt >= before);
  } finally {
    await reader.cancel();
  }
  const body = { done: true, outcome: 'Marked done on the board.' };
  assert.equal((await h.api('POST', route, body, { authorization: '' })).status, 401);
  const closed = await h.api('POST', route, body, await h.board());
  assert.equal(closed.status, 200);
  assert.equal(closed.body.state, 'done');
  assert.equal(closed.body.outcome, body.outcome);
});

test('a worker that cannot run commands can search its tree and see what was just written, and nothing outside', { timeout: 15000 }, async (t) => {
  const tree = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-tree-')));
  t.after(() => fs.rmSync(tree, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: tree, encoding: 'utf8' });
  git('init', '-q');
  fs.mkdirSync(path.join(tree, 'docs'));
  fs.writeFileSync(path.join(tree, 'docs', 'a.md'), 'The status board shows jobs.\n');
  fs.writeFileSync(path.join(tree, 'app.ts'), 'const label = "Status Board";\n');
  git('add', '-A'); git('commit', '-q', '-m', 'first');
  fs.writeFileSync(path.join(tree, 'docs', 'a.md'), 'The status board shows jobs.\nIt also shows usage.\n');
  git('add', '-A'); git('commit', '-q', '-m', 'mention usage');
  fs.writeFileSync(path.join(tree, 'untracked.md'), 'status board, not yet added\n');

  const worker = stdio(t, 'worker-mcp.ts', { ...process.env, CREW_JOB_ID: 'cx-000000', CREW_JOB_TOKEN: 'x', CREW_PORT: '1', CREW_JOB_CWD: tree });
  const call = async (name: string, args = {}) => {
    const result = await worker.call(name, args);
    return result.isError ? { error: result.content[0].text } : JSON.parse(textOf(result));
  };
  const everywhere = await call('search', { pattern: 'status board', ignore_case: true });
  assert.equal(everywhere.matches, 3);
  assert.match(everywhere.text, /^app\.ts:1:/m);
  assert.match(everywhere.text, /^untracked\.md:1:/m);
  assert.deepEqual(await call('search', { pattern: 'status board', path: 'docs' }), { matches: 1, text: 'docs/a.md:1:The status board shows jobs.' });
  assert.deepEqual(await call('search', { pattern: 'no such thing' }), { matches: 0, text: 'No match.' });
  // A pattern that looks like an option is still a pattern.
  assert.equal((await call('search', { pattern: '--open-files-in-pager=touch pwned' })).matches, 0);
  assert.equal(fs.existsSync(path.join(tree, 'pwned')), false);

  const changes = await call('recent_changes', { path: 'docs/a.md' });
  assert.match(changes.commits, /mention usage[\s\S]*first/);
  assert.match(changes.latest_diff, /^\+It also shows usage\.$/m);
  assert.ok(!changes.latest_diff.includes('Status Board'));
  assert.deepEqual(await call('recent_changes', { path: 'untracked.md' }), { commits: 'No commit touches that path.' });

  for (const outside of ['..', '../x', '/etc', path.join(tree, '..', 'elsewhere')]) {
    assert.match((await call('search', { pattern: 'x', path: outside })).error, /inside your working tree/);
    assert.match((await call('recent_changes', { path: outside })).error, /inside your working tree/);
  }
  assert.match((await call('search', { pattern: '' })).error, /non-empty/);
});

test('a daemon that loses the race for the port writes no token and leaves running jobs alone', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { body: job } = await h.api('POST', '/api/jobs', { kind: 'delegate', cwd: h.home, project: h.home, task: 'a question', ask: true });
  assert.ok(fs.existsSync(job.scratch));
  // As at a first start: no token yet. Whichever daemon holds the port must be the only one to make it.
  fs.rmSync(path.join(h.home, 'token'));
  const loser = spawn(process.execPath, [path.resolve('plugin/bridge/daemon.ts')], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  loser.stdout.on('data', (chunk) => { out += chunk; });
  assert.equal(await new Promise((resolve) => loser.once('exit', resolve)), 0);
  assert.match(out, /already in use/);
  assert.equal(fs.existsSync(path.join(h.home, 'token')), false);
  assert.ok(fs.existsSync(job.scratch), 'the running job keeps its scratch directory');
  assert.equal((await h.api('GET', `/api/jobs/${job.id}`)).body.state, 'running');
});

test('a daemon whose ports are free still yields to the daemon running on another port', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { body: job } = await h.api('POST', '/api/jobs', { kind: 'delegate', cwd: h.home, project: h.home, task: 'a question', ask: true });
  // As when the running daemon took a fallback port and the system has since freed the ports before it.
  const port = await freePort();
  const later = spawn(process.execPath, [path.resolve('plugin/bridge/daemon.ts')], { env: { ...h.env, CREW_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  // A daemon that does not yield keeps running; it must not outlive the test.
  t.after(() => { if (later.exitCode === null) later.kill(); });
  let out = '';
  later.stdout.on('data', (chunk) => { out += chunk; });
  assert.equal(await new Promise((resolve) => later.once('exit', resolve)), 0);
  assert.match(out, new RegExp(`port ${h.port} is already in use by the running daemon`));
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'daemon.json'), 'utf8')).port, h.port);
  assert.ok(fs.existsSync(job.scratch), 'the running job keeps its scratch directory');
  assert.equal((await h.api('GET', `/api/jobs/${job.id}`)).body.state, 'running');
});

test('a client replacing an outdated daemon is refused while a job is active', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job } = await h.create();
  const { pid } = (await h.api('GET', '/api/health')).body;
  const refused = await h.api('POST', '/api/shutdown', { ifIdle: true });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /1 job\(s\) are active/);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await h.api('GET', '/api/health')).body.pid, pid);
  assert.equal((await h.api('GET', `/api/jobs/${job.id}`)).body.state, 'running');
  // Idle again, it goes.
  assert.equal((await h.api('POST', `/api/jobs/${job.id}/cancel`, {})).body.state, 'cancelled');
  assert.equal((await h.api('POST', '/api/shutdown', { ifIdle: true })).status, 200);
});

test('idle shutdown waits for a mutating POST still reading its body', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const request = http.request({ host: '127.0.0.1', port: h.port, path: '/api/jobs', method: 'POST', headers: {
    authorization: `Bearer ${h.secret}`, 'content-type': 'application/json', expect: '100-continue',
  } });
  const response = new Promise<any>((resolve, reject) => {
    request.on('error', reject);
    request.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    });
  });
  // Keep a failed assertion from leaving an unhandled socket error during cleanup.
  response.catch(() => {});
  t.after(() => request.destroy());
  const reading = new Promise<void>((resolve) => request.once('continue', resolve));
  request.flushHeaders();
  await reading;
  const refused = await h.api('POST', '/api/shutdown', { ifIdle: true });
  assert.equal(refused.status, 409);
  request.end(JSON.stringify({ kind: 'delegate', cwd: h.home, task: 'test', isolation: 'in_place' }));
  const created = await response;
  assert.equal(created.status, 200);
  await h.started(created.body.id);
  assert.equal((await h.api('POST', `/api/jobs/${created.body.id}/cancel`, {})).status, 200);
  assert.equal((await h.api('POST', '/api/shutdown', { ifIdle: true })).status, 200);
});

test('a stalled POST without the secret does not hold off an idle shutdown', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const stalled = http.request({ host: '127.0.0.1', port: h.port, path: '/api/session', method: 'POST', headers: { 'content-type': 'application/json', expect: '100-continue' } });
  stalled.on('error', () => {});
  t.after(() => stalled.destroy());
  const reading = new Promise<void>((resolve) => stalled.once('continue', resolve));
  stalled.flushHeaders();
  await reading;
  assert.equal((await h.api('POST', '/api/shutdown', { ifIdle: true })).status, 200);
});

test('restart stops a daemon that does not take the token in the file, and says so when it cannot', { timeout: 30000 }, async (t) => {
  const h = await daemon(t);
  const health = async () => fetch(`http://127.0.0.1:${h.port}/api/health`).then((res) => res.json() as any, () => null);
  const old = (await health()).pid;
  // What two daemons starting at once used to leave behind: the file holds a token the listener never had.
  const token = 'f'.repeat(64);
  fs.writeFileSync(path.join(h.home, 'token'), `${token}\n`);
  const cli = (...args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [path.resolve('plugin/bridge/cli.ts'), ...args], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('exit', (code) => resolve({ code, out }));
  });
  // Up, but deaf to this client: that is not "running".
  const started = await cli('daemon', 'start');
  assert.equal(started.code, 1);
  assert.match(started.out, /refused this request/);
  assert.doesNotMatch(started.out, /running at/);

  try {
    const restarted = await cli('daemon', 'restart');
    assert.deepEqual([restarted.code, restarted.out.trim()], [0, `running at http://127.0.0.1:${h.port}`]);
    assert.notEqual((await health()).pid, old);
    const state = await fetch(`http://127.0.0.1:${h.port}/api/state`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(state.status, 200);
    // A number from the port alone is never signalled: it has to be the process this home's daemon recorded.
    const { pid } = await health();
    fs.writeFileSync(path.join(h.home, 'token'), `${'e'.repeat(64)}\n`);
    fs.writeFileSync(path.join(h.home, 'daemon.json'), JSON.stringify({ pid: pid + 1 }));
    const stuck = await cli('daemon', 'stop');
    assert.equal(stuck.code, 1);
    assert.match(stuck.out, new RegExp(`process ${pid}\\) is still running`));
    assert.equal((await health()).pid, pid);
    fs.writeFileSync(path.join(h.home, 'token'), `${token}\n`);
  } finally {
    // The CLI's daemon is detached; it has to go while its home is still there to save into.
    assert.equal((await cli('daemon', 'stop')).out.trim(), 'stopped');
  }
});

test('gc requires the user secret and the CLI prints a readable dry run', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  assert.equal((await h.api('POST', '/api/gc', {}, { authorization: '' })).status, 401);
  assert.equal((await h.api('POST', '/api/gc', {}, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await h.api('POST', '/api/gc', { apply: 'yes' })).status, 400);
  const dry = await h.api('POST', '/api/gc', {});
  assert.equal(dry.status, 200);
  assert.match(dry.body.text, /dry run; nothing will be changed/);
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, [path.resolve('plugin/bridge/cli.ts'), 'gc', ...args], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => stop(child));
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    child.once('exit', (code) => resolve({ code, out }));
  });
  const printed = await cli([]);
  assert.equal(printed.code, 0);
  assert.match(printed.out, /^Crew gc: dry run/);
  assert.doesNotMatch(printed.out, /\{"text"/);
  const applied = await cli(['--apply', '--branches']);
  assert.equal(applied.code, 0);
  assert.match(applied.out, /^Crew gc: applying cleanup/);
  assert.equal((await cli(['--unknown'])).code, 1);
});

test('model notes take a job\'s own model, refuse a model it did not run, and reach the state and the lead\'s view', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const { job } = await h.create();
  const ran = (await h.api('GET', `/api/jobs/${job.id}`)).body;
  const model = ran.resolvedModel ?? ran.model;
  assert.ok(model, 'the fake worker reports a model');
  const noted = await h.api('POST', '/api/notes', { job: job.id, reviewer: 'claude', size: 'small', findings: { medium: 1 }, text: 'one edge case' });
  assert.equal(noted.status, 200, JSON.stringify(noted.body));
  assert.deepEqual([noted.body.model, noted.body.agent, noted.body.samples], [model, 'codex', 1]);
  assert.match((await h.api('POST', '/api/notes', { job: job.id, model: 'other-model', reviewer: 'claude', size: 'small', text: 'x' })).body.error, /ran on .*, not other-model/);
  assert.match((await h.api('POST', '/api/notes', { job: 'cx-none', reviewer: 'claude', size: 'small', text: 'x' })).body.error, /No job with id/);
  // A review built nothing, so it cannot be noted as a build, nor a build as a review; a summary must be text.
  const review = (await h.api('POST', '/api/jobs', { kind: 'review', cwd: h.home, project: h.home, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } })).body;
  assert.match((await h.api('POST', '/api/notes', { job: review.id, role: 'build', reviewer: 'claude', size: 'small', text: 'x' })).body.error, /builds nothing/);
  assert.match((await h.api('POST', '/api/notes', { job: job.id, role: 'review', of_model: 'm', size: 'small', text: 'x' })).body.error, /is not a review/);
  assert.match((await h.api('POST', '/api/notes', { job: review.id, size: 'small', text: 'x' })).body.error, /of \(the work the review covered/);
  assert.match((await h.api('POST', '/api/notes', { job: review.id, of_job: review.id, size: 'small', text: 'x' })).body.error, /built nothing a review could cover/);
  assert.match((await h.api('POST', '/api/notes', { model: model, summary: null })).body.error, /summary must be text/);
  // Noting the job again corrects its line, and its tier stays the job's own whatever the call says.
  assert.equal((await h.api('POST', '/api/notes', { job: job.id, reviewer: 'claude', size: 'small', tier: 'frontier', text: 'one edge case' })).body.samples, 1);
  const line = JSON.parse(fs.readFileSync(path.join(h.home, 'model-notes.json'), 'utf8')).models[model].evidence[0];
  assert.equal(line.tier, ran.tier);
  // How the lead took a job's work is the lead's word; its follow-up rounds are the job's own record.
  const adopted = (await h.api('POST', '/api/notes', { job: job.id, reviewer: 'claude', size: 'xlarge', adoption: 'after-reply', text: 'one edge case' })).body;
  assert.deepEqual(adopted.adoption, { judged: 1, asIs: 0, afterReply: 1, partly: 0, rejected: 0, rounds: ran.turns - 1 });
  assert.match((await h.api('POST', '/api/notes', { model: 'claude-test', reviewer: 'codex', size: 'small', adoption: 'as-is', text: 'x' })).body.error, /delegated job/);
  // Work done in the lead's session names its own model and is the lead's.
  const own = (await h.api('POST', '/api/notes', { model: 'claude-test', role: 'fix', outcome: 'root-cause', reviewer: 'codex', size: 'medium', text: 'fixed at the cause' })).body;
  assert.deepEqual([own.agent, own.fixSamples], ['claude', 1]);
  assert.equal((await h.api('POST', '/api/notes', { model: 'claude-test', summary: 'Fixes at the cause.' })).body.summary, 'Fixes at the cause.');
  assert.deepEqual((await h.api('GET', '/api/state')).body.modelScores.map((s: any) => s.model).sort(), ['claude-test', model].sort());
  const view = (await h.api('GET', '/api/notes?agents=claude&evidence=1')).body.text;
  assert.match(view, /### claude-test \(claude\)[^]*Fixes at the cause\.[^]*fixed at the cause/);
  assert.doesNotMatch(view, /one edge case/);
  // An unreadable file is set aside, and noting starts afresh.
  fs.writeFileSync(path.join(h.home, 'model-notes.json'), '{broken');
  assert.deepEqual((await h.api('GET', '/api/state')).body.modelScores, []);
  assert.ok(fs.readdirSync(h.home).some((name) => name.startsWith('model-notes.json.unreadable-')));
  assert.equal((await h.api('POST', '/api/notes', { model: 'claude-test', reviewer: 'codex', size: 'small', text: 'after' })).status, 200);
});

test('peer ratings: a worker rates through its own tool, the review line gives the rating its target, and the switch stops it', { timeout: 20000 }, async (t) => {
  const h = await daemon(t);
  const { job, server } = await h.create();
  assert.equal(server.env.CREW_JOB_RATES, 'delegate');
  const route = `/api/jobs/${job.id}/rating`;
  assert.equal((await h.api('POST', route, { findings: 4, fact: 'x', token: 'wrong' })).status, 403);
  // An engineer rates the review it got back, never its own work.
  const worker = stdio(t, 'worker-mcp.ts', { ...h.env, ...server.env });
  await worker.request('initialize', { protocolVersion: '2025-11-25' });
  assert.deepEqual(JSON.parse(textOf(await worker.call('rate', { findings: 4, fact: 'The race was real.' }))), { kept: { findings: 4 } });
  assert.match((await worker.call('rate', { correctness: 5, fact: 'x' })).content[0].text, /at least one of findings/);
  // An item the job may not rate refuses the whole rating, rather than being dropped from it.
  for (const brief of [99, null]) assert.match((await h.api('POST', route, { findings: 4, brief, fact: 'x', token: server.env.CREW_JOB_TOKEN })).body.error, /at least one of findings/);
  const review = (await h.api('POST', '/api/jobs', { kind: 'review', cwd: h.home, project: h.home, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } })).body;
  // The builder's line carries the lead's rating of it; the review's line names the work, and so the builder's rating of the review.
  const built = await h.api('POST', '/api/notes', { job: job.id, reviewer: 'codex', size: 'small', text: 'One race, fixed after a reply.', rating: { correctness: 4, brief: 5 } });
  assert.equal(built.status, 200, JSON.stringify(built.body));
  const reviewed = (await h.api('POST', '/api/notes', { job: review.id, of_job: job.id, size: 'small', findings: { high: 1 }, text: 'Found the race.', rating: { findings: 5 } })).body;
  assert.deepEqual([reviewed.reviewSamples, reviewed.items.findings !== null], [1, true]);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'model-notes.json'), 'utf8'));
  assert.deepEqual([saved.version, saved.ratings.map((r: any) => [r.byJob, r.items])], [2, [[job.id, { findings: 4 }]]]);
  assert.deepEqual(saved.models[reviewed.model].evidence.find((e: any) => e.role === 'review').of, { job: job.id, model: reviewed.model });
  // Off: the scores are the evidence alone, a rating on a line is not kept, and a new job is not asked to rate.
  assert.equal((await h.api('GET', '/api/state')).body.peerRatings, true);
  assert.match((await h.api('POST', '/api/peer-ratings', { enabled: 'no' })).body.error, /true or false/);
  assert.deepEqual((await h.api('POST', '/api/peer-ratings', { enabled: false })).body, { peerRatings: false });
  const off = (await h.api('GET', '/api/state')).body;
  assert.deepEqual([off.peerRatings, off.modelScores[0].ratings], [false, 0]);
  const dropped = (await h.api('POST', '/api/notes', { job: job.id, reviewer: 'codex', size: 'small', text: 'One race.', rating: { correctness: 1 } })).body;
  assert.equal(dropped.ratingDropped, true);
  // The rating sent while off is not kept; the one the line already had stays.
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.home, 'model-notes.json'), 'utf8')).models[dropped.model].evidence.find((e: any) => e.role === 'build').rating, { correctness: 4, brief: 5 });
  const later = await h.create();
  assert.equal(later.server.env.CREW_JOB_RATES, undefined);
  assert.match((await h.api('POST', `/api/jobs/${later.job.id}/rating`, { findings: 4, fact: 'x', token: later.server.env.CREW_JOB_TOKEN })).body.error, /not asked to rate/);
  // On again is the default, so the key leaves the file.
  assert.deepEqual((await h.api('POST', '/api/peer-ratings', { enabled: true })).body, { peerRatings: true });
  const config = JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8'));
  assert.equal('peerRatings' in config, false);
  // A fix starts from a review of someone else's work, so it is not asked to rate one.
  fs.writeFileSync(path.join(h.home, 'config.json'), JSON.stringify({ ...config, roles: { fix: { agents: ['codex'] } } }));
  const fix = (await h.api('POST', '/api/jobs', { kind: 'delegate', role: 'fix', cwd: h.home, project: h.home, task: 'fix', isolation: 'in_place', lead: 'test-lead' })).body;
  await h.started(fix.id);
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, `${fix.id}.json`), 'utf8')).env.CREW_JOB_RATES, undefined);
});

test('a hook report reaches the daemon with the secret the hook reads from the token file', { timeout: 15000 }, async (t) => {
  const h = await daemon(t);
  const report = (env: NodeJS.ProcessEnv, session: string) => spawnSync(process.execPath, [path.resolve('plugin/bridge/report.ts')], {
    env, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: session, cwd: h.home, prompt: '한글 프롬프트' }),
  });
  assert.equal(report(h.env, 'typed').status, 0);
  // Without the token file the report is refused, and the hook still does not fail Claude's turn.
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-no-token-'));
  t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
  assert.equal(report({ ...h.env, CREW_HOME: elsewhere }, 'forged').status, 0);
  const sessions = (await h.api('GET', '/api/state')).body.claude.map((session: { id: string }) => session.id);
  assert.deepEqual([sessions.includes('typed'), sessions.includes('forged')], [true, false]);
});

test('a job ledger the daemon cannot read is set aside whole, and the daemon starts without it', { timeout: 15000 }, async (t) => {
  const broken = '{"seq":7,"jobs":[{"id":"cx-kept","title":"work the user still wants"';
  const h = await daemon(t, (home) => fs.writeFileSync(path.join(home, 'jobs.json'), broken));
  assert.deepEqual((await h.api('GET', '/api/state')).body.jobs, []);
  const aside = fs.readdirSync(h.home).filter((name) => name.startsWith('jobs.json.unreadable-'));
  assert.equal(aside.length, 1);
  assert.equal(fs.readFileSync(path.join(h.home, aside[0]), 'utf8'), broken);
  // The new ledger starts beside it, not over it.
  await h.create();
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8')).jobs.length, 1);
  assert.equal(fs.readFileSync(path.join(h.home, aside[0]), 'utf8'), broken);
});

test('worker polls stay below the header timeout and share one 600-second deadline', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-worker-polls-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { ...process.env, CREW_HOME: home, CREW_PORT: String(await freePort()), CREW_JOB_ID: 'job', CREW_JOB_TOKEN: 'test' };
  const script = `
    let elapsed = 0;
    Date.now = () => elapsed * 1000;
    globalThis.fetch = async (url) => {
      const wait = Number(new URL(url).searchParams.get('wait'));
      if (wait >= 300) throw new Error('response headers timed out');
      if (!(wait > 0) || elapsed + wait > 600) throw new Error('invalid remaining wait');
      if (elapsed === 0) elapsed += 0.25; // Request overhead leaves a fractional final slice.
      elapsed += wait;
      const answer = elapsed > 300 && process.env.ANSWER === '1' ? 'yes' : undefined;
      return Response.json({ questions: [{ id: 'q', text: 'ready?', answer }] });
    };
    process.on('exit', () => console.error(elapsed));
    await import(${JSON.stringify(new URL('../plugin/bridge/worker-mcp.ts', import.meta.url).href)});
  `;
  for (const answer of [true, false]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...env, ANSWER: answer ? '1' : '0' }, encoding: 'utf8', timeout: 5000,
      input: JSON.stringify({ jsonrpc: '2.0', method: 'tools/call', id: 1, params: { name: 'lead_answers', arguments: { wait_seconds: 600 } } }) + '\n',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const received = JSON.parse(textOf(JSON.parse(result.stdout).result));
    assert.deepEqual(received.answered.map((q: any) => q.answer), answer ? ['yes'] : []);
    const elapsed = Number(result.stderr.trim());
    assert.ok(answer ? elapsed > 300 && elapsed < 600 : elapsed === 600, `elapsed ${elapsed}`);
  }
});

test('job detail keeps the original task and the same failed-check outcome and seals as state', async (t) => {
  const h = await daemon(t, (home) => fs.writeFileSync(path.join(home, 'jobs.json'), JSON.stringify({ seq: 1, jobs: [{
    id: 'cx-test', kind: 'delegate', agent: 'codex', cwd: home, state: 'done', outcome: 'done', endedAt: Date.now(), turns: 1,
    prompt: 'original task', instructions: 'worker instructions', receipts: [{ turn: 1, check: { exit: 1 } }],
    evidence: [{ file: 'result.png', modified: 1 }], news: [],
  }] })));
  const summary = (await h.api('GET', '/api/state')).body.jobs[0];
  const { body: detail } = await h.api('GET', '/api/jobs/cx-test');
  assert.equal(summary.outcomeContradiction, 'the bridge check failed');
  assert.equal(summary.prompt, undefined);
  assert.ok(summary.evidence[0].sig);
  assert.deepEqual(detail, { ...summary, prompt: 'original task', instructions: 'worker instructions' });
});

for (const failed of ['jobs', 'missions']) {
  test(`shutdown logs a failed ${failed} flush, saves the other store and exits with failure`, async (t) => {
    const h = await daemon(t);
    let logs = '';
    h.child.stdout.on('data', (chunk) => { logs += chunk; });
    const blockedFile = path.join(h.home, failed + '.json.tmp');
    fs.mkdirSync(blockedFile);
    try {
      const exited = once(h.child, 'close', { signal: AbortSignal.timeout(4000) });
      await h.api('POST', '/api/shutdown', {});
      assert.equal((await exited)[0], 1);
      assert.match(logs, new RegExp(failed + '.*(EISDIR|EPERM|EACCES)', 's'));
      assert.ok(fs.existsSync(path.join(h.home, (failed === 'jobs' ? 'missions' : 'jobs') + '.json')));
      assert.equal(fs.existsSync(path.join(h.home, 'daemon.json')), false);
    } finally {
      fs.rmdirSync(blockedFile);
    }
  });
}

test('shutdown signals the process group of every running check', async (t) => {
  // In a nested sandbox the launcher cannot run. Stand in for it and record signals without starting any processes.
  const preload = `
    import childProcess from 'node:child_process';
    import { EventEmitter } from 'node:events';
    import { syncBuiltinESMExports } from 'node:module';
    import fs from 'node:fs';
    import path from 'node:path';
    import { runCheck } from ${JSON.stringify(new URL('../plugin/bridge/check.ts', import.meta.url).href)};
    const spawn = childProcess.spawn;
    let id = 1000000000;
    childProcess.spawn = (...args) => args[0] === '/usr/bin/sandbox-exec'
      ? Object.assign(new EventEmitter(), { pid: ++id, stdout: new EventEmitter(), stderr: new EventEmitter() })
      : spawn(...args);
    syncBuiltinESMExports();
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid >= 0) return kill(pid, signal);
      fs.appendFileSync(path.join(process.env.CREW_HOME, 'signals'), pid + ' ' + signal + '\\n');
      return true;
    };
    for (let i = 0; i < 2; i++) void runCheck('true', process.env.CREW_HOME, process.env.CREW_HOME, [], { platform: 'darwin' });
  `;
  const h = await daemon(t, undefined, 'data:text/javascript,' + encodeURIComponent(preload));
  const exited = once(h.child, 'close', { signal: AbortSignal.timeout(4000) });
  await h.api('POST', '/api/shutdown', {});
  assert.equal((await exited)[0], 0);
  assert.deepEqual(fs.readFileSync(path.join(h.home, 'signals'), 'utf8').trim().split('\n'), ['-1000000001 SIGKILL', '-1000000002 SIGKILL']);
});

test('daemon shutdown closes a live sandboxed check and its descendants', {
  skip: !['darwin', 'win32'].includes(process.platform),
  timeout: 30000,
}, async (t) => {
  if (process.platform === 'win32') {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-check-probe-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const probe = await runCheck('true', tmp, tmp, []);
    if (probe.skipped) return t.skip(probe.skipped);
    assert.equal(probe.exit, 0, probe.output);
  }
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  const connected = once(listener, 'connection', { signal: AbortSignal.timeout(20000) });
  t.after(() => listener.close());
  // This descendant holds its socket until it is killed, the test closes it, or its own safety timeout fires.
  const command = `node -e "const s = require('node:net').connect(${port}, '127.0.0.1'); s.setTimeout(25000, () => s.destroy()); s.resume()"`;
  const preload = `import { runCheck } from ${JSON.stringify(new URL('../plugin/bridge/check.ts', import.meta.url).href)};
    void runCheck(${JSON.stringify(command)}, process.env.CREW_HOME, process.env.CREW_HOME + '/scratch-check', []);`;
  const h = await daemon(t, (home) => fs.mkdirSync(path.join(home, 'scratch-check')), 'data:text/javascript,' + encodeURIComponent(preload));
  const [socket] = await connected;
  try {
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(4000) });
    await h.api('POST', '/api/shutdown', {});
    await closed.catch((err) => { if (err.code !== 'ECONNRESET') throw err; });
  } finally {
    socket.destroy();
  }
});
