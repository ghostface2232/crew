import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { claudeAdapter } from '../plugin/bridge/adapters/claude.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import type { Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { writeFakeBin } from './fake-bin.ts';

const fakeClaude = `
  const fs = require('node:fs');
  const path = require('node:path');
  const send = (message) => console.log(JSON.stringify(message));
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const config = flag('--mcp-config');
  const mcp = JSON.parse(config.startsWith('{') ? config : fs.readFileSync(config, 'utf8'));
  const instructions = flag('--append-system-prompt') ?? fs.readFileSync(flag('--append-system-prompt-file'), 'utf8');
  const session = flag('--resume') ?? 'claude-session';
  const cwd = process.cwd();
  let turns = 0, prompt, step = 0, hold = false;
  let replies = [];
  const modes = [flag('--permission-mode')];
  let current = modes[0];
  const success = () => send({
    type: 'result', subtype: 'success', is_error: false, session_id: session,
    result: JSON.stringify({ prompt, turns, args, mcp, instructions, replies, cwd, modes }),
    usage: { input_tokens: 3, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 11 },
  });
  const ask = (tool, input) => {
    const id = 'tool-' + step;
    send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: tool, input, id }] } });
    send({ type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input } });
  };
  const local = path.join(cwd, 'inside.txt');
  const outside = path.join(cwd, '..', 'outside.txt');
  const policy = [
    ['Write', { file_path: local, content: 'inside' }],
    ['Write', { file_path: outside, content: 'outside' }],
    ['mcp__crew__siblings', {}],
    ['Bash', { command: 'node -e "0"' }],
    ['Bash', { command: 'node -e "0"' }],
    ['Bash', { command: 'node -e "0"' }],
    ['Bash', { command: 'rm -f x' }],
    ['OtherTool', { file_path: local }],
  ];
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.type === 'control_request' && message.request.subtype === 'set_permission_mode') {
      modes.push(message.request.mode);
      if (fs.existsSync(path.join(cwd, 'mode-error'))) return send({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported mode' } });
      if (!fs.existsSync(path.join(cwd, 'mode-ignore'))) current = message.request.mode;
      return send({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response: { mode: message.request.mode } } });
    }
    if (message.type === 'control_response') {
      const reply = message.response;
      replies.push(reply);
      if (['read-only edit', 'linked edit', 'git edit', 'evidence edit', 'browser', 'granted follow-up'].includes(prompt)) return success();
      if (step === 0 && reply.response.behavior === 'allow') fs.writeFileSync(reply.response.updatedInput.file_path, 'inside');
      if (++step < policy.length) return ask(...policy[step]);
      send({ type: 'system', subtype: 'permission_denied', tool_name: 'Write', decision_reason_type: 'other', decision_reason: '--restricted: path outside the working directory', blocked_path: outside });
      send({ type: 'assistant', message: { content: [{ type: 'text', text: 'Edited inside.' }] } });
      return success();
    }
    if (message.type !== 'user' || message.message.role !== 'user') throw new Error('Expected user turn');
    if (hold) success();
    prompt = message.message.content;
    turns++;
    replies = [];
    step = 0;
    send({ type: 'system', subtype: 'init', session_id: session, model: 'test-model', effort: 'medium', permissionMode: current });
    if (prompt === 'policy') return ask(...policy[0]);
    if (prompt === 'read-only edit') return ask('NotebookEdit', { notebook_path: local });
    if (prompt === 'linked edit') return ask('Edit', { file_path: path.join(cwd, 'link', 'new', 'file.txt') });
    if (prompt === 'git edit') return ask('Write', { file_path: path.join(cwd, '.git', 'config'), content: '' });
    if (prompt === 'evidence edit') return ask('Write', { file_path: path.join(flag('--add-dir'), 'view-after.png'), content: '' });
    if (prompt === 'browser') return ask('mcp__crew__browser', {});
    if (prompt === 'classifier') {
      send({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'git push --force' }, id: 'use-1' }] } });
      send({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'use-1', decision_reason_type: 'classifier', decision_reason: 'Force push not asked for.' });
      // Another kind of denial is the job's limit, not the classifier's judgment, so it is no refusal to send back.
      send({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'use-1', decision_reason_type: 'rule', decision_reason: 'a deny rule matched' });
      return success();
    }
    if (prompt === 'granted follow-up') return ask(...policy[3]);
    if (prompt === '429') return send({ type: 'result', subtype: 'error_during_execution', is_error: true, api_error_status: 429, errors: ['Too many requests'] });
    if (prompt === 'rate event') return send({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
    if (prompt === 'error') return send({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Unexpected error'] });
    if (prompt === 'exit') {
      console.error('Worker disappeared');
      return process.exit(2);
    }
    hold = prompt === 'hold';
    if (!hold) success();
  });
`;

function harness(t: test.TestContext, prompt: string, options: Partial<Job> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-claude-test-'));
  const cwd = fs.realpathSync.native(fs.mkdirSync(path.join(root, 'job'), { recursive: true })!);
  const bin = path.join(root, 'claude');
  writeFakeBin(bin, fakeClaude);
  const adapter = claudeAdapter(resolveConfig({ claude: { bin } }));
  const job = {
    id: 'job', cwd, prompt, instructions: 'First line.\nSay "hello" and check 100%.', kind: 'delegate',
    sandbox: 'workspace-write', sessionId: null, tokens: null, ...options,
  } as Job;
  const changes = new EventEmitter();
  const events: Record<string, unknown[][]> = {};
  const log = (name: string) => (...args: unknown[]) => {
    (events[name] ??= []).push(args);
    changes.emit('change');
  };
  const ctl: JobCtl = {
    job, mcp: { command: process.execPath, args: ['worker-mcp.ts'], env: { CREW_JOB_TOKEN: 'fake-token' } },
    activity: log('activity'), phase: log('phase'), progress: log('progress'), model: log('model'),
    touched: log('touched'), note: log('note'), refused: log('refused'), context: log('context'), diff: log('diff'),
    waiting: log('waiting'), resumed: log('resumed'), done: log('done'), fail: log('fail'),
    cancelled: log('cancelled'), capabilities: log('capabilities'),
    session: (id) => { job.sessionId = id; log('session')(id); },
    tokens: (total, parts) => {
      job.tokens = total;
      if (parts) job.tokenUse = { ...parts, turn: total };
      log('tokens')(total, parts);
    },
  };
  t.after(async () => {
    await adapter.release!(ctl);
    adapter.shutdown();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  async function event(name: string, index = 0): Promise<unknown[]> {
    const signal = AbortSignal.timeout(5_000);
    while (!events[name]?.[index]) await once(changes, 'change', { signal });
    return events[name][index];
  }
  async function report(index = 0) {
    return JSON.parse(String((await event('done', index))[0]));
  }
  return { adapter, ctl, root, cwd, events, event, report };
}

function flag(args: string[], name: string): string | undefined {
  return args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
}

for (const kind of ['delegate', 'polish', 'review', 'ask', 'debate'] as const) {
  test(`Claude Code starts a restricted ${kind} job with the matching tool list`, async (t) => {
    const writable = kind === 'delegate' || kind === 'polish';
    const h = harness(t, 'first task', {
      kind: kind === 'ask' || kind === 'debate' ? 'delegate' : kind,
      sandbox: writable ? 'workspace-write' : 'read-only',
      ...(kind === 'debate' ? { debate: { rounds: 2 } } : {}),
      ...(writable ? { model: 'requested-model', effort: 'medium' } : {}),
    });
    if (writable) h.ctl.job.scratch = path.join(h.root, 'scratch');
    await h.adapter.start(h.ctl);
    const result = await h.report();
    const { args } = result;
    for (const option of ['-p', '--verbose', '--restricted', '--strict-mcp-config']) assert.ok(args.includes(option), option);
    assert.equal(flag(args, '--input-format'), 'stream-json');
    assert.equal(flag(args, '--output-format'), 'stream-json');
    assert.equal(flag(args, '--permission-mode'), writable ? 'auto' : 'default');
    assert.equal(flag(args, '--permission-prompt-tool'), 'stdio');
    assert.equal(flag(args, '--tools'), writable ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Glob,Grep,Bash');
    assert.equal(flag(args, '--model'), writable ? 'requested-model' : undefined);
    assert.equal(flag(args, '--effort'), writable ? 'medium' : undefined);
    assert.equal(flag(args, '--resume'), undefined);
    assert.equal(result.instructions, h.ctl.job.instructions);
    assert.deepEqual(result.mcp, { mcpServers: { crew: { type: 'stdio', ...h.ctl.mcp } } });
    assert.equal(result.cwd, h.cwd);
    assert.equal(result.prompt, h.ctl.job.prompt);
    assert.deepEqual(await h.event('session'), ['claude-session']);
    assert.deepEqual(await h.event('model'), ['test-model', 'medium']);
    const configArg = flag(args, '--mcp-config')!;
    // The MCP config holds the job's token, so it is a private file on every platform, never an argument.
    assert.ok(path.isAbsolute(configArg));
    assert.ok(!args.some((arg: string) => arg.includes('fake-token')));
    if (writable) assert.equal(path.dirname(path.dirname(configArg)), h.ctl.job.scratch);
    if (process.platform !== 'win32') assert.equal(fs.statSync(configArg).mode & 0o777, 0o600);
    const promptFile = flag(args, '--append-system-prompt-file');
    if (process.platform === 'win32') assert.ok(promptFile);
    else assert.equal(flag(args, '--append-system-prompt'), h.ctl.job.instructions);
    await h.adapter.release!(h.ctl);
    assert.equal(fs.existsSync(configArg), false);
    if (promptFile) assert.equal(fs.existsSync(promptFile), false);
  });
}

test('Claude Code edit policy, single and whole-job approvals, denials, and tokens', async (t) => {
  const h = harness(t, 'policy');
  await h.adapter.start(h.ctl);
  const command = 'node -e "0"';
  assert.deepEqual(await h.event('waiting'), ['approval', `Bash: ${command}`, command]);
  await h.adapter.answer(h.ctl, true);
  assert.deepEqual(await h.event('waiting', 1), ['approval', `Bash: ${command}`, command]);
  await h.adapter.answer(h.ctl, true, undefined, { forJob: true });
  assert.deepEqual(await h.event('waiting', 2), ['approval', 'Bash: rm -f x', 'rm -f x']);
  await h.adapter.answer(h.ctl, false, 'Leave x in place.');
  assert.deepEqual(await h.event('waiting', 3), ['approval', `OtherTool: ${path.join(h.cwd, 'inside.txt')}`, undefined]);
  await h.adapter.answer(h.ctl, false, 'Use the ordinary editor.', { by: 'lead' });
  const { replies } = await h.report();
  assert.deepEqual(replies.slice(1).map((reply: any) => [reply.subtype, reply.request_id, reply.response.behavior]), [
    ['success', 'tool-1', 'deny'], ['success', 'tool-2', 'allow'],
    ['success', 'tool-3', 'allow'], ['success', 'tool-4', 'allow'], ['success', 'tool-5', 'allow'],
    ['success', 'tool-6', 'deny'], ['success', 'tool-7', 'deny'],
  ]);
  assert.equal(replies[1].response.message, 'Edit paths must be inside the job workspace.');
  assert.equal(replies[6].response.message, 'Leave x in place.');
  assert.equal(replies[7].response.message, 'Use the ordinary editor.');
  assert.equal(fs.existsSync(path.join(h.root, 'outside.txt')), false);
  assert.deepEqual(await h.event('tokens'), [26, { input: 15, cachedInput: 7, output: 11 }]);
  assert.ok(h.events.activity.length);
  assert.ok(h.events.phase.some(([phase]) => phase === 'writing response'));
  assert.ok(h.events.progress.some(([detail]) => detail === 'Edited inside.'));
  assert.ok(h.events.note.some(([note]) => String(note).includes('Claude Code refused Write')));
  assert.ok(h.events.note.some(([note, opts]) => String(note).includes('The user declined an action') && (opts as { declined: boolean }).declined));
  assert.ok(h.events.note.some(([note]) => String(note).includes('The lead declined an action')));
  assert.equal(h.events.waiting.length, 4);
  await h.adapter.release!(h.ctl);
  await h.adapter.reply(h.ctl, 'granted follow-up');
  assert.equal((await h.report(1)).replies[0].response.behavior, 'allow');
  assert.equal(h.events.waiting.length, 4);
  assert.deepEqual(replies[0], {
    subtype: 'success', request_id: 'tool-0',
    response: { behavior: 'allow', updatedInput: { file_path: path.join(h.cwd, 'inside.txt'), content: 'inside' } },
  });
  assert.equal(fs.readFileSync(path.join(h.cwd, 'inside.txt'), 'utf8'), 'inside');
  assert.deepEqual(h.events.touched, [[path.join(h.cwd, 'inside.txt')]]);
});

test('Claude Code refuses a notebook edit in a read-only job', async (t) => {
  const h = harness(t, 'read-only edit', { kind: 'review', sandbox: 'read-only' });
  await h.adapter.start(h.ctl);
  const { replies } = await h.report();
  assert.deepEqual(replies[0].response, { behavior: 'deny', message: 'This job is read-only.' });
  assert.equal(h.events.waiting, undefined);
  assert.equal(h.events.touched, undefined);
});

test('Claude Code refuses edits through a link to a directory outside the job', async (t) => {
  const h = harness(t, 'linked edit');
  const outside = path.join(h.root, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(h.cwd, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await h.adapter.start(h.ctl);
  const { replies } = await h.report();
  assert.deepEqual(replies[0].response, { behavior: 'deny', message: 'Edit paths must be inside the job workspace.' });
  assert.equal(h.events.touched, undefined);
});

test('Claude Code queues an in-flight reply, reuses an idle process, and resumes after release', async (t) => {
  const h = harness(t, 'hold');
  await h.adapter.start(h.ctl);
  await h.event('session');
  assert.equal((await h.adapter.probe!(h.ctl)).verdict, 'working');
  await h.adapter.reply(h.ctl, 'live reply');
  const live = await h.report();
  assert.equal(live.prompt, 'live reply');
  assert.equal(live.turns, 2);
  assert.equal((await h.adapter.probe!(h.ctl)).verdict, 'unknown');
  await h.adapter.reply(h.ctl, 'idle reply');
  assert.equal((await h.report(1)).turns, 3);
  await h.adapter.release!(h.ctl);
  assert.equal((await h.adapter.probe!(h.ctl)).verdict, 'ended');
  await h.adapter.reply(h.ctl, 'resumed reply');
  const resumed = await h.report(2);
  assert.equal(resumed.prompt, 'resumed reply');
  assert.equal(resumed.turns, 1);
  assert.equal(flag(resumed.args, '--resume'), 'claude-session');
  assert.deepEqual(await h.event('tokens', 3), [104, { input: 60, cachedInput: 28, output: 44 }]);
});

for (const [prompt, message, limit] of [
  ['429', /Too many requests/, true],
  ['rate event', /rate limit/, true],
  ['error', /Unexpected error/, false],
  ['exit', /exited during a turn \(2\): Worker disappeared/, false],
] as const) {
  test(`Claude Code reports failure after ${prompt}`, async (t) => {
    const h = harness(t, prompt);
    await h.adapter.start(h.ctl);
    const [detail, opts] = await h.event('fail');
    assert.match(String(detail), message);
    assert.deepEqual(opts, limit ? { limit: true } : undefined);
    assert.equal(h.events.done, undefined);
  });
}

test('Claude Code cancel stops an open turn without failure', async (t) => {
  const h = harness(t, 'hold');
  await h.adapter.start(h.ctl);
  await h.event('session');
  await h.adapter.cancel(h.ctl);
  assert.deepEqual(h.events.cancelled, [[]]);
  assert.equal((await h.adapter.probe!(h.ctl)).verdict, 'ended');
  assert.equal(h.events.fail, undefined);
  assert.equal(h.events.done, undefined);
});

test('Claude Code shutdown drains an open process', async (t) => {
  const h = harness(t, 'hold');
  await h.adapter.start(h.ctl);
  await h.event('session');
  h.adapter.shutdown();
  await h.adapter.release!(h.ctl);
  assert.equal((await h.adapter.probe!(h.ctl)).verdict, 'ended');
  assert.equal(h.events.fail, undefined);
  await assert.rejects(h.adapter.reply(h.ctl, 'after shutdown'), /shutting down/);
});

test('Claude Code reaches its evidence directory and saves screenshots there unasked, even in a read-only job', async (t) => {
  const h = harness(t, 'evidence edit', { sandbox: 'read-only' });
  h.ctl.job.evidenceDir = fs.mkdirSync(path.join(h.root, 'evidence'), { recursive: true }) && fs.realpathSync.native(path.join(h.root, 'evidence'));
  await h.adapter.start(h.ctl);
  const result = await h.report();
  assert.equal(flag(result.args, '--add-dir'), h.ctl.job.evidenceDir);
  assert.equal(result.replies[0].response.behavior, 'allow');
});

test("Claude Code's automatic mode refusals reach the lead, and a second retry turn is the user's to answer", async (t) => {
  const h = harness(t, 'classifier');
  await h.adapter.start(h.ctl);
  await h.report();
  assert.deepEqual(h.events.refused, [['Bash: git push --force', 'Force push not asked for.']]);
  assert.ok(h.events.note.some(([note]) => String(note) === 'Claude Code refused Bash (a deny rule matched).'));
  h.ctl.job.asksUser = true;
  await h.adapter.reply(h.ctl, 'retry');
  assert.deepEqual((await h.report(1)).modes, ['auto', 'default']);
  h.ctl.job.asksUser = false;
  await h.adapter.reply(h.ctl, 'next');
  assert.deepEqual((await h.report(2)).modes, ['auto', 'default', 'auto']);
});

test('A turn whose manual mode Claude Code does not confirm never runs', async (t) => {
  for (const marker of ['mode-error', 'mode-ignore']) {
    const h = harness(t, 'first');
    await h.adapter.start(h.ctl);
    await h.report();
    fs.writeFileSync(path.join(h.cwd, marker), '');
    h.ctl.job.asksUser = true;
    await h.adapter.reply(h.ctl, 'retry');
    const [message] = await h.event('fail');
    assert.match(String(message), marker === 'mode-error' ? /could not switch to default permissions: Unsupported mode/ : /started the turn in auto permissions, not default/);
    assert.equal(h.events.done.length, 1);
  }
});

test('A session relaunched for a turn the user answers starts in the manual mode', async (t) => {
  const h = harness(t, 'first', { asksUser: true, sessionId: 'saved' });
  await h.adapter.reply(h.ctl, 'retry');
  assert.deepEqual((await h.report()).modes, ['default']);
});

test('Claude Code may not edit .git, and the browser tool asks the user', async (t) => {
  const git = harness(t, 'git edit');
  fs.mkdirSync(path.join(git.cwd, '.git'), { recursive: true });
  await git.adapter.start(git.ctl);
  assert.deepEqual((await git.report()).replies[0].response, { behavior: 'deny', message: 'Edit paths must be inside the job workspace.' });
  const browser = harness(t, 'browser', { sandbox: 'read-only' });
  await browser.adapter.start(browser.ctl);
  assert.deepEqual(await browser.event('waiting'), ['approval', 'mcp__crew__browser', undefined]);
});
