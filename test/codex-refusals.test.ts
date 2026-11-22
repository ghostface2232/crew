import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import type { Job } from '../plugin/bridge/jobs.ts';

function harness() {
  const adapter = new CodexAdapter(resolveConfig({}));
  const refusals: { action: string; reason: string }[] = [];
  const notes: string[] = [];
  const waiting: string[] = [];
  const job = { state: 'running', sandbox: 'workspace-write', sessionId: 'parent', plugins: ['computer-use'] } as Job;
  const ctl = {
    job, mcp: {}, model: () => {}, activity: () => {}, phase: () => {}, progress: () => {}, resumed: () => {}, done: () => {},
    refused: (action: string, reason: string) => refusals.push({ action, reason }),
    note: (text: string) => notes.push(text), waiting: (_type: string, text: string) => waiting.push(text),
  };
  const internal = adapter as any;
  internal.openRun(ctl, 'parent', true);
  const notify = (method: string, params: object) => internal.onNotification(method, { threadId: 'parent', turnId: 'turn', ...params });
  const request = (method: string, params: object) => internal.onRequest(method, { threadId: 'parent', turnId: 'turn', ...params }, 1);
  return { adapter, internal, ctl, job, refusals, notes, waiting, notify, request };
}

test('MCP refusals correlate targetItemId with started input, including child threads', () => {
  const h = harness();
  h.notify('thread/started', { thread: { id: 'child', parentThreadId: 'parent' } });
  const action = { type: 'mcpToolCall', server: 'cua_repl', toolName: 'js' };
  const started = (threadId: string, code: string) => h.notify('item/started', {
    threadId, item: { type: 'mcpToolCall', id: 'same-id', server: 'cua_repl', tool: 'js', arguments: { code }, status: 'inProgress' },
  });
  started('parent', 'parent input \n ');
  started('child', 'child input');
  for (const threadId of ['child', 'parent']) h.notify('item/autoApprovalReview/completed', {
    threadId, targetItemId: 'same-id', action, review: { status: 'denied', rationale: 'policy reason' },
  });
  assert.match(h.refusals[0].action, /child input/);
  assert.doesNotMatch(h.refusals[0].action, /parent input/);
  assert.ok(h.refusals[1].action.includes('parent input \n '), 'input whitespace must survive formatting');
  h.notify('item/autoApprovalReview/completed', { targetItemId: 'missing', action, review: { status: 'denied' } });
  assert.match(h.refusals[2].action, /input missing/i);
  h.notify('turn/completed', { turn: { id: 'turn', status: 'completed' } });
  h.notify('item/autoApprovalReview/completed', { turnId: 'next-turn', targetItemId: 'same-id', action, review: { status: 'denied' } });
  assert.match(h.refusals[3].action, /input missing/i, 'ended turns must not supply stale input');
});

test('execve refusals distinguish working directories and preserve argument boundaries', () => {
  const h = harness();
  for (const cwd of ['/first', '/second']) h.notify('item/autoApprovalReview/completed', {
    action: { type: 'execve', program: '/tools/my tool', argv: ['one argument', '', 'line\nbreak'], cwd }, review: { status: 'denied' },
  });
  assert.match(h.refusals[0].action, /\/first/);
  assert.match(h.refusals[1].action, /\/second/);
  assert.notEqual(h.refusals[0].action, h.refusals[1].action);
  assert.match(h.refusals[0].action, /"one argument"/);
  assert.match(h.refusals[0].action, /""/);
});

test('broken shared links keep their own read rule without preventing thread parameters', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-broken-link-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'deps');
  const missing = path.join(dir, 'removed');
  fs.symlinkSync(missing, link, 'junction');
  const h = harness();
  for (const runsApp of [false, true]) {
    Object.assign(h.job, { cwd: dir, scratch: path.join(dir, 'scratch'), runsApp, worktree: { path: dir, linked: ['deps'] } });
    const params = await h.internal.threadParams(h.ctl, { request: async () => ({}) });
    const rules = params.config.permissions[params.config.default_permissions].filesystem;
    assert.equal(rules[link], 'read');
    assert.equal(rules[missing], undefined);
    assert.equal(rules[dir], 'write');
  }
});

test('replies to loaded threads with shared links start a turn without resuming', async (t) => {
  const h = harness();
  const calls: string[] = [];
  t.mock.method(h.internal, 'ensure', async () => ({ request: async (method: string) => { calls.push(method); return { turn: { id: 'next' } }; } }));
  t.mock.method(h.internal, 'threadParams', async () => ({}));
  h.internal.loaded.add('parent');
  Object.assign(h.job, { worktree: { linked: ['deps'] } });
  await h.adapter.reply(h.ctl as any, 'again');
  assert.deepEqual(calls, ['turn/start']);
});

test('Codex approvals show bounded action details without protocol ids or environment fields', async () => {
  const h = harness();
  const env = { SECRET_TOKEN: 'never-print-this' };
  const approve = async (method: string, params: object) => {
    const pending = h.request(method, { ...params, env, threadId: 'parent', itemId: 'opaque-id', turnId: 'turn' });
    await h.adapter.answer(h.ctl as any, false);
    await pending;
    const text = h.waiting.at(-1)!;
    assert.doesNotMatch(text, /opaque-id|opaque-turn|SECRET_TOKEN|never-print-this|threadId|itemId|requestedSchema/);
    assert.ok(text.length < 10000);
    return text;
  };
  const command = await approve('item/commandExecution/requestApproval', { command: 'echo exact', cwd: '/work', reason: 'Codex reason', additionalPermissions: { network: { enabled: true }, env } });
  assert.match(command, /^Run:\necho exact/);
  assert.match(command, /Working directory: \/work/);
  assert.match(command, /Reason: Codex reason/);
  h.notify('item/started', { item: { type: 'fileChange', id: 'opaque-id', changes: [{ path: '/work/a.ts', kind: { type: 'update' }, diff: 'patch' }] } });
  const files = await approve('item/fileChange/requestApproval', { grantRoot: '/work', reason: 'allow patch' });
  assert.match(files, /^write files/);
  assert.match(files, /\/work\/a.ts/);
  assert.match(files, /Grant root: \/work/);
  assert.match(files, /Reason: allow patch/);
  const tool = await approve('mcpServer/elicitation/request', {
    serverName: 'cua_repl', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'js' },
    arguments: { code: 'exact input', env, nested: { environment: env, value: 'kept' } },
    requestedSchema: { type: 'object' }, message: 'Codex tool reason',
  });
  assert.match(tool, /^Use the tool cua_repl\.js/);
  assert.match(tool, /exact input/);
  assert.match(tool, /kept/);
  assert.match(tool, /Codex tool reason/);
  const permissions = await approve('item/permissions/requestApproval', {
    permissions: { network: { enabled: true }, fileSystem: { read: ['/read'], write: ['/write'], entries: [{ access: 'deny', path: { type: 'path', path: '/private' } }] }, env }, reason: 'permission reason',
  });
  assert.match(permissions, /^Grant permissions:/);
  for (const part of ['Network: enabled', 'read paths: /read', 'write paths: /write', 'deny: /private', 'Reason: permission reason']) assert.ok(permissions.includes(part));
  const large = await approve('mcpServer/elicitation/request', {
    serverName: 'cua_repl', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'js' }, arguments: { code: 'x'.repeat(20000) }, message: 'y'.repeat(20000),
  });
  assert.match(large, /… \(truncated\)/);
});

test('Codex refusal notes and automatic actions omit protocol data and bound free-form text', async () => {
  const h = harness();
  const env = { SECRET_TOKEN: 'never-print-this' };
  await h.request('item/commandExecution/requestApproval', { command: 'echo exact', cwd: '/work', reason: 'Codex reason', availableDecisions: ['decline'], env, itemId: 'opaque-id' });
  assert.match(h.notes[0], /echo exact/);
  assert.match(h.notes[0], /\/work/);
  assert.match(h.notes[0], /Codex reason/);
  await h.request('mcpServer/elicitation/request', { serverName: 'other', _meta: { tool_name: 'specific-tool' }, arguments: { code: 'known input', env }, itemId: 'opaque-id' });
  assert.match(h.notes[1], /other\.specific-tool/);
  assert.match(h.notes[1], /known input/);
  await h.request('item/commandExecution/requestApproval', { availableDecisions: ['decline'], reason: 'unknown action', env });
  assert.match(h.notes[2], /exact action unavailable \(input missing\)/);
  for (const action of [
    { type: 'execve', program: '/tool', argv: ['one arg'], cwd: '/work', env, itemId: 'opaque-id' },
    { type: 'applyPatch', files: ['/work/a.ts'], cwd: '/work', env, itemId: 'opaque-id' },
    { type: 'mcpToolCall', server: 'other', toolName: 'call', arguments: { code: 'z'.repeat(20000), env }, env, itemId: 'opaque-id' },
  ]) h.notify('item/autoApprovalReview/completed', { action, review: { status: 'denied', rationale: 'r'.repeat(20000) } });
  for (const text of [...h.notes, ...h.refusals.flatMap(r => [r.action, r.reason])]) {
    assert.doesNotMatch(text, /SECRET_TOKEN|never-print-this|opaque-id|threadId|itemId|"type"/);
    assert.ok(text.length < 10000);
  }
  assert.match(h.refusals[0].action, /Program: \/tool/);
  assert.match(h.refusals[1].action, /write files.*\/work\/a.ts/s);
  assert.match(h.refusals[2].action, /… \(truncated\)/);
  assert.match(h.refusals[2].reason, /… \(truncated\)/);
});

test('plugin tool approvals allowed for the job cover later calls on the same app only, in that job only', async () => {
  const h = harness();
  const asked: { text: string; grant?: string }[] = [];
  const progress: string[] = [];
  Object.assign(h.ctl, { waiting: (_type: string, text: string, grant?: string) => asked.push({ text, grant }), progress: (text: string) => progress.push(text) });
  const tool = (tool_name: string, app: string, threadId = 'parent') => h.internal.onRequest('mcpServer/elicitation/request', {
    threadId, turnId: 'turn', serverName: 'cua_repl', mode: 'form', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name },
    message: `Allow Computer Use to use "${app}"?`, requestedSchema: { type: 'object' },
  }, tool_name);

  const first = tool('get_app_state', 'CrewAuditDark');
  assert.equal(asked.length, 1);
  assert.equal(asked[0].grant, 'Computer Use using "CrewAuditDark"');
  // Queued behind the first, for the same app: the grant settles it too.
  const queued = tool('scroll', 'CrewAuditDark');
  await h.adapter.answer(h.ctl as any, true, undefined, { forJob: true });
  assert.equal((await first).action, 'accept');
  assert.equal((await queued).action, 'accept');

  assert.equal((await tool('click', 'CrewAuditDark')).action, 'accept');
  assert.equal(asked.length, 1, 'a granted app is not asked about again');
  assert.ok(progress.some((line) => /allowed for this job: click · Computer Use using "CrewAuditDark"/.test(line)));

  // Another app in the same job still asks.
  const other = tool('click', 'Finder');
  assert.equal(asked.length, 2);
  assert.equal(asked[1].grant, 'Computer Use using "Finder"');
  await h.adapter.answer(h.ctl as any, false);
  assert.equal((await other).action, 'decline');

  // Another job asks about the same app.
  const otherAsked: string[] = [];
  const otherCtl = { ...h.ctl, job: { ...h.job, sessionId: 'second' }, waiting: (_type: string, text: string) => otherAsked.push(text) };
  h.internal.openRun(otherCtl, 'second', true);
  const elsewhere = tool('click', 'CrewAuditDark', 'second');
  assert.equal(otherAsked.length, 1);
  await h.adapter.answer(otherCtl as any, false);
  assert.equal((await elsewhere).action, 'decline');
});

test('plugin tool approvals without a parsed target cannot be allowed for the job', async () => {
  const h = harness();
  const grants: (string | undefined)[] = [];
  Object.assign(h.ctl, { waiting: (_type: string, _text: string, grant?: string) => grants.push(grant) });
  const pending = h.request('mcpServer/elicitation/request', {
    serverName: 'cua_repl', _meta: { codex_approval_kind: 'mcp_tool_call', tool_name: 'js' }, message: 'Run this script?',
  });
  assert.deepEqual(grants, [undefined]);
  await assert.rejects(h.adapter.answer(h.ctl as any, true, undefined, { forJob: true }), /cannot be allowed for the whole job/);
  await h.adapter.answer(h.ctl as any, true);
  assert.equal((await pending).action, 'accept');
  assert.equal(h.internal.runs.get('parent').grants.size, 0);
});

test('a rerouted turn records the model it moved to and tells the lead', () => {
  const h = harness();
  const models: (string | undefined)[][] = [];
  Object.assign(h.ctl, { model: (name?: string, effort?: string) => models.push([name, effort]) });
  h.job.resolvedEffort = 'high';
  h.notify('model/rerouted', { fromModel: 'gpt-a', toModel: 'gpt-b', reason: 'highRiskCyberActivity' });
  assert.deepEqual(models, [['gpt-b', 'high']]);
  assert.match(h.notes[0], /from gpt-a to gpt-b \(highRiskCyberActivity\)/);
});

test('a turn ended for too many denials fails apart from other errors, pointing at the refusals', () => {
  for (const refused of [true, false]) {
    const h = harness();
    const failures: [string, unknown][] = [];
    Object.assign(h.ctl, { fail: (message: string, opts?: unknown) => failures.push([message, opts]) });
    h.job.turns = 2;
    h.job.refusals = refused ? [{ action: 'rm -rf build', reason: 'destructive', turn: 2 }] : [{ action: 'old', reason: 'old', turn: 1 }];
    h.notify('turn/completed', { turn: { id: 'turn', status: 'failed', error: { message: 'too many denials', codexErrorInfo: 'tooManyDenials' } } });
    assert.equal(failures.length, 1);
    assert.match(failures[0][0], /too many of its actions were refused \(too many denials\)/);
    assert.equal(/listed with the job/.test(failures[0][0]), refused);
    assert.equal(failures[0][1], undefined, 'a denial stop is not a usage limit');
  }
});

test('the context window shows how much the latest request filled', () => {
  const h = harness();
  const context: number[][] = [];
  Object.assign(h.ctl, { tokens: () => {}, context: (used: number, size: number) => context.push([used, size]) });
  const usage = (modelContextWindow: number | null) => h.notify('thread/tokenUsage/updated', { tokenUsage: {
    total: { totalTokens: 50_000, inputTokens: 45_000, cachedInputTokens: 30_000, outputTokens: 5_000 },
    last: { totalTokens: 21_000 }, modelContextWindow,
  } });
  usage(258_400);
  usage(null);
  assert.deepEqual(context, [[21_000, 258_400]]);
});

test('a running turn\'s diff is passed on only for the current turn', () => {
  const h = harness();
  const diffs: string[] = [];
  Object.assign(h.ctl, { diff: (text: string) => diffs.push(text) });
  h.notify('turn/started', { turn: { id: 'turn' } });
  h.notify('turn/diff/updated', { diff: 'diff --git a/x b/x' });
  h.notify('turn/diff/updated', { turnId: 'old-turn', diff: 'stale' });
  assert.deepEqual(diffs, ['diff --git a/x b/x']);
});
