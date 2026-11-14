import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { AntigravityAdapter } from '../plugin/bridge/adapters/antigravity.ts';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { CrewEvent, Job, WorkerAgent } from '../plugin/bridge/jobs.ts';
import { writeFakeBin } from './fake-bin.ts';

// Exercise the public Jobs API over the same executable boundary as adapters.test.ts.
function harness(t: TestContext, source: string, agent: WorkerAgent = 'codex') {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-contract-')));
  const bin = path.join(home, 'agent');
  writeFakeBin(bin, source);
  const config = resolveConfig({
    notify: false,
    codex: { bin, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', plugins: [] },
    antigravity: { bin, enabled: true },
    roles: { delegate: { agent } },
  });
  const events: CrewEvent[] = [];
  const attention: string[] = [];
  const adapters: (CodexAdapter | AntigravityAdapter)[] = [];
  const stores: Jobs[] = [];
  const store = () => {
    const adapter = agent === 'codex' ? new CodexAdapter(config) : new AntigravityAdapter(config);
    adapters.push(adapter);
    const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, {
      onEvent: (event) => events.push(event), onJob: () => {},
      onAttention: (_job, kind, detail) => { if (kind === 'waiting') attention.push(detail); },
    });
    stores.push(jobs);
    return { jobs, adapter };
  };
  const first = store();
  t.after(async () => {
    for (const adapter of adapters) adapter.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    for (const jobs of stores) jobs.flush();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const wire = (): any[] => fs.existsSync(path.join(home, 'wire.jsonl'))
    ? fs.readFileSync(path.join(home, 'wire.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { ...first, home, events, attention, wire, restore: store,
    create: (cwd = home, isolation: 'in_place' | 'worktree' = 'in_place') => first.jobs.create({ kind: 'delegate', cwd, isolation, task: 'test the adapter contract' }),
  };
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'fake worker did not reach the expected protocol boundary');
    await delay(10);
  }
}

const prelude = `
  const fs = require('node:fs');
  const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  const notify = (method, params) => send({ method, params });
  const barrier = () => send({ id: 'barrier', method: 'contract/barrier', params: { threadId: 'parent' } });
`;

function codex(turn: string, other = ''): string {
  return `${prelude}
    let cwd;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      fs.appendFileSync(__dirname + '/wire.jsonl', line + '\\n');
      if (msg.method === 'thread/start') {
        cwd = msg.params.cwd;
        return send({ id: msg.id, result: { thread: { id: 'parent' } } });
      }
      if (msg.method === 'turn/start') { ${turn}; return; }
      ${other}
      if (msg.method === 'turn/interrupt') {
        send({ id: msg.id, result: {} });
        notify('turn/completed', { threadId: 'parent', turn: { id: 'turn', status: 'interrupted' } });
        return;
      }
      if (msg.method && msg.id != null) send({ id: msg.id, result: {} });
    });
  `;
}

function acp(prompt: string, other = ''): string {
  return `${prelude}
    let promptId;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      fs.appendFileSync(__dirname + '/wire.jsonl', line + '\\n');
      ${other}
      if (msg.method === 'initialize') return send({ id: msg.id, result: { agentCapabilities: {} } });
      if (msg.method === 'session/new') return send({ id: msg.id, result: { sessionId: 'parent' } });
      if (msg.method === 'session/prompt') { promptId = msg.id; ${prompt}; return; }
      if (msg.method && msg.id != null) send({ id: msg.id, result: {} });
    });
  `;
}

const accepted = `send({ id: msg.id, result: { turn: { id: 'turn' } } });`;
const completed = `notify('turn/completed', { threadId: 'parent', turn: { id: 'turn', status: 'completed' } });`;
const approval = (id: string, threadId = 'parent') => `send({ id: '${id}', method: 'item/commandExecution/requestApproval', params: {
  threadId: '${threadId}', turnId: 'turn', command: 'echo exact command', cwd: __dirname,
} });`;
const permission = (id: string) => `send({ id: '${id}', method: 'session/request_permission', params: {
  sessionId: 'parent', toolCall: { kind: 'execute', title: 'Run command', rawInput: 'echo exact command' },
  options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }],
} });`;
const terminalEvents = (events: CrewEvent[], job: Job) => events.filter((event) => event.job_id === job.id && ['done', 'error', 'limit', 'cancelled'].includes(event.kind));

test('Codex lost turn/start acknowledgement fails clearly instead of remaining active', { timeout: 8000 }, async (t) => {
  const h = harness(t, codex(''));
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const job = await h.create();
    await until(() => h.wire().some((msg) => msg.method === 'turn/start'));
    t.mock.timers.tick(30_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.state, 'failed', `state=${job.state}; notes=${job.notes.join('; ')}`);
    assert.match(job.error!.message, /turn\/start.*timed out/);
    assert.equal(job.waiting, null);
    assert.equal(terminalEvents(h.events, job).length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

// ACP session/prompt is the entire turn, not a separate dispatch acknowledgement.
// Its setup boundary is session/new, which must still time out without a response.
test('Antigravity lost session setup acknowledgement fails clearly', { timeout: 8000 }, async (t) => {
  const h = harness(t, acp('', "if (msg.method === 'session/new') return;"), 'antigravity');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const job = await h.create();
    await until(() => h.wire().some((msg) => msg.method === 'session/new'));
    t.mock.timers.tick(30_001);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.state, 'failed');
    assert.match(job.error!.message, /session\/new.*timed out/);
    assert.equal(job.waiting, null);
    assert.equal(terminalEvents(h.events, job).length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test('Codex tolerates completed-before-started items and duplicate turn completion exactly once', { timeout: 8000 }, async (t) => {
  const h = harness(t, codex(`
    ${accepted}
    const params = { threadId: 'parent', turnId: 'turn', item: { id: 'file', type: 'fileChange', status: 'completed', changes: [{ path: __dirname + '/edited.ts' }] } };
    notify('item/completed', params);
    notify('item/completed', params);
    notify('item/started', params);
    notify('item/completed', { threadId: 'parent', item: { id: 'report', type: 'agentMessage', text: 'one report' } });
    ${completed}
    ${completed}
    barrier();
  `));
  const job = await h.create();
  await until(() => job.endedAt !== null && h.wire().some((msg) => msg.id === 'barrier'));
  assert.equal(job.state, 'done');
  assert.equal(job.report, 'one report');
  assert.deepEqual(job.result?.files, ['edited.ts']);
  assert.deepEqual(terminalEvents(h.events, job).map((event) => event.kind), ['done']);
});

test('Antigravity tolerates tool updates before calls and duplicate prompt results exactly once', { timeout: 8000 }, async (t) => {
  const h = harness(t, acp(`
    const update = (value) => notify('session/update', { sessionId: 'parent', update: value });
    const finished = { sessionUpdate: 'tool_call_update', toolCallId: 'file', kind: 'edit', status: 'completed', locations: [{ path: __dirname + '/edited.ts' }] };
    update(finished);
    update(finished);
    update({ sessionUpdate: 'tool_call', toolCallId: 'file', kind: 'edit', title: 'Edit file' });
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'one report' } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    send({ id: promptId, result: { stopReason: 'end_turn' } });
    barrier();
  `), 'antigravity');
  const job = await h.create();
  await until(() => job.endedAt !== null && h.wire().some((msg) => msg.id === 'barrier'));
  assert.equal(job.state, 'done');
  assert.equal(job.report, 'one report');
  assert.deepEqual(job.result?.files, ['edited.ts']);
  assert.deepEqual(terminalEvents(h.events, job).map((event) => event.kind), ['done']);
});

test('Codex parentThreadId routes a child approval to the user and returns its answer to the child', { timeout: 8000 }, async (t) => {
  const h = harness(t, codex(`
    ${accepted}
    notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
    notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    ${approval('child-approval', 'child')}
  `, `
    if (msg.id === 'child-approval') {
      notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
      ${completed}
      barrier();
      return;
    }
  `));
  const job = await h.create();
  await until(() => job.waiting !== null);
  assert.equal(job.state, 'waiting');
  assert.equal(job.waiting!.type, 'approval');
  assert.match(job.waiting!.reason, /^Sub-agent request\n/);
  assert.match(job.waiting!.reason, /echo exact command/);
  assert.deepEqual(h.attention, [job.waiting!.reason]);
  await h.jobs.reply(job.id, { decision: 'approve', request_id: job.waiting!.id });
  await until(() => job.endedAt !== null && h.wire().some((msg) => msg.id === 'barrier'));
  assert.deepEqual(h.wire().find((msg) => msg.id === 'child-approval').result, { decision: 'accept' });
  assert.equal(job.state, 'done');
  assert.equal(job.waiting, null);
  assert.equal(terminalEvents(h.events, job).length, 1);
});

// The child edits only after the parent's turn/completed has been sent; the result must still include it.
test('Codex parent completion must not finalize a worktree while its child can still edit it', { timeout: 10000 }, async (t) => {
  const h = harness(t, codex(`
    ${accepted}
    notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
    notify('turn/started', { threadId: 'child', turn: { id: 'child-turn' } });
    const gate = setInterval(() => {
      if (!fs.existsSync(__dirname + '/release-child')) return;
      clearInterval(gate);
      fs.writeFileSync(cwd + '/late-child.ts', 'export const late = true;\\n');
      notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
      barrier();
    }, 10);
    ${completed}
  `));
  const repo = path.join(h.home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial', '--allow-empty'], { cwd: repo });
  const job = await h.create(repo, 'worktree');
  await until(() => /sub-agent/.test(job.phase));
  assert.equal(job.state, 'running', 'the job waits for the sub-agent instead of finishing');
  assert.equal(fs.existsSync(path.join(job.cwd, 'late-child.ts')), false);
  fs.writeFileSync(path.join(h.home, 'release-child'), 'go');
  await until(() => job.endedAt !== null);
  assert.equal(job.state, 'done');
  assert.ok(job.result?.files.includes('late-child.ts'), 'the sub-agent\'s edit is part of the result');
});

for (const type of ['approval', 'question'] as const) test(`Codex cancellation clears pending ${type} and queued approvals without allowing any`, { timeout: 8000 }, async (t) => {
  const request = type === 'approval' ? approval('pending-first') : `send({ id: 'pending-first', method: 'item/tool/requestUserInput', params: {
    threadId: 'parent', turnId: 'turn', itemId: 'question', questions: [{ id: 'q', question: 'Which option?' }],
  } });`;
  const h = harness(t, codex(`${accepted} ${request} ${approval('pending-queued')}`, `
    if (msg.method === 'turn/interrupt') {
      send({ id: msg.id, result: {} });
      ${approval('pending-late')}
      notify('turn/completed', { threadId: 'parent', turn: { id: 'turn', status: 'interrupted' } });
      barrier();
      return;
    }
  `));
  const job = await h.create();
  await until(() => job.waiting !== null);
  const requestId = job.waiting!.id;
  assert.equal(job.waiting!.type, type);
  await h.jobs.cancel(job.id);
  await until(() => h.wire().some((msg) => msg.id === 'barrier'));
  assert.equal(job.state, 'cancelled');
  assert.equal(job.waiting, null);
  await assert.rejects(h.jobs.reply(job.id, { decision: 'approve', request_id: requestId }), /no longer pending/);
  const answers = h.wire().filter((msg) => String(msg.id).startsWith('pending-'));
  assert.equal(answers.length, 3);
  assert.deepEqual(answers.find((msg) => msg.id === 'pending-first').result, type === 'question' ? { answers: {} } : { decision: 'cancel' });
  for (const answer of answers.filter((msg) => msg.id !== 'pending-first')) assert.deepEqual(answer.result, { decision: 'cancel' });
  assert.deepEqual(terminalEvents(h.events, job).map((event) => event.kind), ['cancelled']);
});

test('Antigravity cancellation clears pending and late permissions and never selects allow', { timeout: 8000 }, async (t) => {
  const h = harness(t, acp(`${permission('pending-first')} ${permission('pending-queued')}`, `
    if (msg.method === 'session/cancel') { ${permission('pending-late')} return; }
    if (String(msg.id).startsWith('pending-')) {
      globalThis.answers = (globalThis.answers || 0) + 1;
      if (globalThis.answers === 3) {
        send({ id: promptId, result: { stopReason: 'cancelled' } });
        barrier();
      }
      return;
    }
  `), 'antigravity');
  const job = await h.create();
  await until(() => job.waiting !== null);
  const requestId = job.waiting!.id;
  await h.jobs.cancel(job.id);
  await until(() => h.wire().some((msg) => msg.id === 'barrier'));
  assert.equal(job.state, 'cancelled');
  assert.equal(job.waiting, null);
  await assert.rejects(h.jobs.reply(job.id, { decision: 'approve', request_id: requestId }), /no longer pending/);
  const answers = h.wire().filter((msg) => String(msg.id).startsWith('pending-'));
  assert.equal(answers.length, 3);
  for (const answer of answers) assert.deepEqual(answer.result, { outcome: { outcome: 'cancelled' } });
  assert.deepEqual(terminalEvents(h.events, job).map((event) => event.kind), ['cancelled']);
});

for (const agent of ['codex', 'antigravity'] as const) {
  for (const state of ['running', 'waiting'] as const) test(`${agent} restart fails a persisted ${state} job without reviving its request or worker`, { timeout: 8000 }, async (t) => {
    const source = agent === 'codex' ? codex(`${accepted} ${state === 'waiting' ? approval('pending-restart') : 'barrier();'}`)
      : acp(state === 'waiting' ? permission('pending-restart') : 'barrier();');
    const h = harness(t, source, agent);
    const job = await h.create();
    await until(() => state === 'waiting' ? job.waiting !== null : h.wire().some((msg) => msg.id === 'barrier'));
    assert.equal(job.state, state);
    const requestId = job.waiting?.id ?? 'expired-request';
    h.jobs.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8')).jobs[0];
    assert.equal(saved.state, state);
    assert.deepEqual(saved.waiting, job.waiting);
    // Snapshot before shutting down the old process: a new daemon reads the crash record.
    h.adapter.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    const wireBeforeRestart = h.wire();
    const restored = h.restore();
    const recovered = restored.jobs.get(job.id);
    assert.equal(recovered.state, 'failed');
    assert.equal(recovered.phase, 'failed');
    assert.equal(recovered.waiting, null);
    assert.ok(recovered.endedAt);
    assert.match(recovered.error!.message, /bridge restarted while this job was running/);
    assert.equal(recovered.sessionId, 'parent');
    await assert.rejects(restored.jobs.reply(job.id, { decision: 'approve', request_id: requestId }), /no longer pending/);
    restored.jobs.flush();
    assert.deepEqual(h.wire(), wireBeforeRestart, 'load and a stale answer must not start or contact an agent');
    const persisted = JSON.parse(fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8')).jobs[0];
    assert.equal(persisted.state, 'failed');
    assert.equal(persisted.waiting, null);
  });
}
