import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AntigravityAdapter } from '../plugin/bridge/adapters/antigravity.ts';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { WorkerAgent } from '../plugin/bridge/jobs.ts';

const command = 'echo first\necho ' + 'a'.repeat(160) + '\necho last';
const stub = `
const readline = require('node:readline');
const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
const notify = (method, params) => send({ method, params });
const ask = (id, threadId, command) => send({
  id, method: 'item/commandExecution/requestApproval',
  params: { threadId, turnId: threadId + '-turn', cwd: '/tmp', command },
});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'parent-turn' } } });
    notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
    ask('a', 'child', ${JSON.stringify(command)});
    ask('b', 'parent', 'echo second');
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'parent' } } });
    return;
  }
  if (msg.method && msg.id != null) send({ id: msg.id, result: {} });
  if (msg.id === 'a') {
    notify('serverRequest/resolved', { threadId: 'child', requestId: 'a' });
    notify('item/started', { threadId: 'parent', item: { type: 'commandExecution', command: 'echo progress' } });
    notify('turn/completed', { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } });
  }
  if (msg.id === 'b') {
    notify('item/completed', { threadId: 'parent', item: { type: 'agentMessage', text: msg.result.decision } });
    notify('turn/completed', { threadId: 'parent', turn: { id: 'parent-turn', status: 'completed' } });
  }
});
`;

function harness(source: string, agent: WorkerAgent = 'codex') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-codex-test-'));
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const config = {
    stallSeconds: 300, notify: false, notifyOnDone: false,
    codex: { bin, approvalPolicy: 'on-request' as const },
    antigravity: { bin, enabled: true },
  };
  const adapter = agent === 'codex' ? new CodexAdapter(config) : new AntigravityAdapter(config);
  const jobs = new Jobs(home, config, { codex: adapter, antigravity: adapter }, {
    onEvent: () => {}, onJob: () => {}, onAttention: () => {},
  });
  return { adapter, bin, home, jobs };
}

test('routes a child approval and preserves overlapping approvals and the full command', { timeout: 5000 }, async (t) => {
  const { adapter, home, jobs } = harness(stub);
  t.after(() => { adapter.shutdown(); jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const job = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test' });
  const waiting = async () => {
    while (!job.waiting) await jobs.wait(job.id, job.seq, 1000);
    return job.waiting;
  };
  const first = await waiting();
  assert.ok(first.reason.includes(command));
  assert.ok(first.reason.includes('/tmp'));
  await jobs.reply(job.id, { decision: 'approve', request_seq: first.seq });
  const second = await waiting();
  assert.match(second.reason, /echo second/);
  await assert.rejects(jobs.reply(job.id, { decision: 'approve', request_seq: first.seq }), /no longer pending/);
  assert.equal(job.waiting, second);
  await jobs.reply(job.id, { decision: 'deny', request_seq: second.seq });
  while (!job.endedAt) await jobs.wait(job.id, job.seq, 1000);
  assert.equal(job.report, 'decline');
});

test('a hung initialize fails the job and the next job can start a fresh server', { timeout: 5000 }, async (t) => {
  const { adapter, bin, home, jobs } = harness('process.stdin.resume();');
  t.after(() => { adapter.shutdown(); jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const job = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test' });
  t.mock.timers.tick(30_001);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /initialize.*timed out/);
  t.mock.timers.reset();
  fs.writeFileSync(bin, `#!${process.execPath}\n${stub}`);
  const next = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test' });
  while (!next.waiting) await jobs.wait(next.id, next.seq, 1000);
  assert.equal(next.sessionId, 'parent');
});

test('Antigravity uses the advertised restore method and waits for cancellation', { timeout: 5000 }, async (t) => {
  const { adapter, home, jobs } = harness(`
    let promptId;
    const result = (id, result) => console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') result(id, { agentCapabilities: { loadSession: true } });
      else if (method === 'session/new') result(id, { sessionId: 'saved' });
      else if (method === 'session/load') result(id, {});
      else if (method === 'session/prompt') promptId = id;
      else if (method === 'session/cancel') setTimeout(() => result(promptId, { stopReason: 'cancelled' }), 50);
      else console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: method } }));
    });
  `, 'antigravity');
  t.after(async () => {
    adapter.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    jobs.flush();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const job = await jobs.create({ kind: 'polish', cwd: home, isolation: 'in_place', targets: ['README.md'] });
  while (job.phase === 'starting') await jobs.wait(job.id, job.seq, 1000);
  const cancelling = jobs.cancel(job.id);
  assert.equal(job.state, 'running');
  await cancelling;
  assert.equal(job.state, 'cancelled');
  adapter.shutdown();
  await jobs.reply(job.id, { message: 'resume after restart' });
  assert.equal(job.state, 'running', job.error?.message);
  await jobs.cancel(job.id);
  assert.equal(job.state, 'cancelled');
});
