import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AntigravityAdapter, decide, formAnswer, formQuestions } from '../plugin/bridge/adapters/antigravity.ts';
import { tokenFile } from '../plugin/bridge/auth.ts';
import { HOME, resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Job } from '../plugin/bridge/jobs.ts';
import { RpcError } from '../plugin/bridge/rpc.ts';
import { pickEffort } from '../plugin/bridge/tiers.ts';
import { writeFakeBin } from './fake-bin.ts';

/**
 * An ACP server that records what Crew sends in `log.jsonl` beside it. It offers thinking levels per model as
 * agy 1.5.9 does, and ends each turn with `report`, or with the answer to `form` when one is given. A session starts in
 * `mode`, and each turn first reports the `updates` given, as tool calls agy ran without asking. `switched` is a mode it
 * reports right after creating the session; `modeDelay` holds its answer to set_mode; `hold` keeps a turn open, and
 * `ignoreCancel` keeps it open past a cancel.
 */
function server(options: { append?: boolean; form?: unknown; mode?: string; refuseMode?: boolean; updates?: unknown[]; after?: unknown[]; switched?: string; modeDelay?: number; hold?: boolean; ignoreCancel?: boolean; usage?: unknown; resumeSwitched?: string; cancelDelay?: number } = {}): string {
  return `
    const fs = require('node:fs');
    const path = require('node:path');
    const options = ${JSON.stringify(options)};
    const log = (entry) => fs.appendFileSync(path.join(__dirname, 'log.jsonl'), JSON.stringify(entry) + '\\n');
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const levels = { 'gemini-4-hydrogen': ['low', 'medium', 'high', 'xhigh'], 'gemini-4-argon': ['low', 'medium', 'high'], plain: [] };
    let model = 'gemini-4-argon', level = 'medium', promptId;
    const config = () => ({ configOptions: [
      { id: 'model', category: 'model', currentValue: model, options: Object.keys(levels).map((value) => ({ value })) },
      ...(levels[model].length ? [{ id: 'thought_level', category: 'thought_level', currentValue: level, options: levels[model].map((value) => ({ value })) }] : []),
    ] });
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const message = JSON.parse(line);
      const { method, id, params } = message;
      if (method) log({ method, params });
      if (method === 'initialize') send({ id, result: { agentCapabilities: { sessionCapabilities: { resume: {}, close: {} }, ...(options.append ? { _meta: { antigravity: { systemPrompt: { append: true } } } } : {}) } } });
      else if (method === 'session/new') {
        model = 'gemini-4-argon'; level = 'medium';
        send({ id, result: { sessionId: 's1', ...config(), ...(options.mode ? { modes: { currentModeId: options.mode } } : {}) } });
        if (options.switched) send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: options.switched } } });
      }
      else if (method === 'session/set_mode') setTimeout(() => send(options.refuseMode ? { id, error: { code: -32602, message: 'no such mode' } } : { id, result: {} }), options.modeDelay ?? 0);
      else if (method === 'session/resume') {
        const answer = { jsonrpc: '2.0', id, result: { ...config(), ...(options.mode ? { modes: { currentModeId: options.mode } } : {}) } };
        // In one write, so Crew reads the switch before it acts on the answer.
        const switched = options.resumeSwitched && { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: options.resumeSwitched } } };
        process.stdout.write([answer, switched].filter(Boolean).map((m) => JSON.stringify(m) + '\\n').join(''));
      }
      else if (method === 'session/set_config_option') {
        if (params.configId === 'model') { model = params.value; if (!levels[model].includes(level)) level = 'medium'; }
        else level = params.value;
        send({ id, result: config() });
      } else if (method === 'session/prompt') {
        promptId = id;
        if (options.form) send({ id: 'form', method: 'elicitation/create', params: { sessionId: 's1', mode: 'form', message: 'The agent has a question.', requestedSchema: options.form } });
        else {
          for (const update of options.updates ?? []) send({ method: 'session/update', params: { sessionId: 's1', update } });
          if (options.hold) return;
          send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } } } });
          send({ id, result: { stopReason: 'end_turn', ...(options.usage ? { usage: options.usage } : {}) } });
          setTimeout(() => { for (const update of options.after ?? []) send({ method: 'session/update', params: { sessionId: 's1', update } }); }, 50);
        }
      } else if (method === 'session/cancel') {
        const cancelled = promptId;
        if (!options.ignoreCancel) setTimeout(() => send({ id: cancelled, result: { stopReason: 'cancelled' } }), options.cancelDelay ?? 0);
      }
      else if (method === 'session/close') send({ id, result: {} });
      else if (id === 'form') {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result) } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else if (id !== undefined && method) send({ id, error: { code: -32601, message: method } });
    });
  `;
}

function harness(t: test.TestContext, source?: string, roles: Parameters<typeof resolveConfig>[0]['roles'] = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-agy-test-'));
  const bin = path.join(home, 'agy');
  if (source) writeFakeBin(bin, source);
  const config = resolveConfig({ notify: false, antigravity: { bin, enabled: true }, roles: { delegate: { agents: ['antigravity'] }, ...roles } });
  const adapter = new AntigravityAdapter(config);
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  t.after(async () => {
    adapter.shutdown();
    await new Promise((resolve) => setImmediate(resolve));
    jobs.flush();
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  });
  const sent = (method: string) => fs.readFileSync(path.join(home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line)).filter((entry) => entry.method === method).map((entry) => entry.params);
  const ended = async (job: Job) => { while (!job.endedAt) await jobs.wait(job.id, job.seq, 1000); return job; };
  const waiting = async (job: Job) => { while (!job.waiting) await jobs.wait(job.id, job.seq, 1000); return job.waiting; };
  return { adapter, home, jobs, sent, ended, waiting };
}

test('an effort is set as the thinking level the model offers, after the model', { timeout: 5000 }, async (t) => {
  const h = harness(t, server());
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', model: 'hydrogen', effort: 'xhigh' }));
  assert.deepEqual(h.sent('session/set_config_option').map((p) => [p.configId, p.value]), [['model', 'gemini-4-hydrogen'], ['thought_level', 'xhigh']]);
  assert.equal(job.resolvedModel, 'gemini-4-hydrogen');
  assert.equal(job.resolvedEffort, 'xhigh');
});

test('an effort the model does not offer runs at the nearest lower level, and none is sent without one', { timeout: 5000 }, async (t) => {
  const h = harness(t, server());
  const capped = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', model: 'argon', effort: 'xhigh' }));
  assert.equal(capped.resolvedEffort, 'high');
  // Without an effort the session's own level stands and is still reported.
  const plain = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', model: 'argon' }));
  assert.equal(plain.resolvedEffort, 'medium');
  for (const effort of ['minimal', 'turbo']) {
    const unchanged = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', model: 'argon', effort }));
    assert.equal(unchanged.resolvedEffort, 'medium');
  }
  // A model without levels is sent none.
  const none = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', model: 'plain', effort: 'high' }));
  assert.equal(none.resolvedEffort, undefined);
  assert.deepEqual(h.sent('session/set_config_option').filter((p) => p.configId === 'thought_level').map((p) => p.value), ['high']);
});

test('a role and a preset can set Antigravity\'s effort', () => {
  const config = resolveConfig({ preset: 'best', presets: { best: { antigravity: { effort: 'high' } } }, roles: { polish: { antigravity: { effort: 'low' } } } });
  assert.equal(config.roles.polish.antigravity?.effort, 'low');
  assert.equal(config.presets.best.antigravity?.effort, 'high');
});

test('pickEffort takes the offered level or the nearest lower, keeping the offered spelling', () => {
  const offered = ['low', 'medium', 'high'].map((value) => ({ value }));
  assert.equal(pickEffort(offered, 'medium'), 'medium');
  assert.equal(pickEffort(offered, 'xhigh'), 'high');
  assert.equal(pickEffort(offered, 'HIGH'), 'high');
  assert.equal(pickEffort([{ value: 'High' }], 'HIGH'), 'High');
  assert.equal(pickEffort([{ value: 'High' }], 'xhigh'), 'High');
  assert.equal(pickEffort(offered, 'minimal'), undefined);
  assert.equal(pickEffort([{ value: 'high' }], 'minimal'), undefined);
  assert.equal(pickEffort(offered, 'turbo'), undefined);
  assert.equal(pickEffort([], 'high'), undefined);
  assert.equal(pickEffort(undefined, 'high'), undefined);
});

test('the role goes in the system prompt where the server takes an addition, and again on restore', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ append: true }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'the task itself' }));
  const [created] = h.sent('session/new');
  assert.equal(created._meta.antigravity.systemPrompt.append, job.instructions);
  const [first] = h.sent('session/prompt');
  assert.equal(first.prompt[0].text, job.prompt);
  assert.ok(!first.prompt[0].text.includes(job.instructions));
  // A new server process restores the session, and is given the role again.
  h.adapter.shutdown();
  await h.jobs.reply(job.id, { message: 'one more thing' });
  await h.ended(job);
  assert.equal(h.sent('session/resume')[0]._meta.antigravity.systemPrompt.append, job.instructions);
  assert.equal(h.sent('session/prompt')[1].prompt[0].text.includes(job.instructions), false);
});

test('a session that starts in a mode that does not ask is put back in the default mode', { timeout: 5000 }, async (t) => {
  for (const mode of ['default', 'auto']) {
    const h = harness(t, server({ mode }));
    const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
    assert.equal(job.state, 'done');
    assert.deepEqual(h.sent('session/set_mode').map((p) => p.modeId), mode === 'default' ? [] : ['default']);
  }
  const refused = harness(t, server({ mode: 'auto', refuseMode: true }));
  const job = await refused.ended(await refused.jobs.create({ kind: 'delegate', cwd: refused.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /"auto" mode, where it does not ask/);
  assert.equal(refused.sent('session/prompt').length, 0);
});

test('a restored session, and one switched between turns, are put back in the default mode before the next prompt', { timeout: 5000 }, async (t) => {
  const restored = harness(t, server({ mode: 'auto' }));
  const first = await restored.ended(await restored.jobs.create({ kind: 'delegate', cwd: restored.home, isolation: 'in_place', task: 'test' }));
  restored.adapter.shutdown();
  await restored.jobs.reply(first.id, { message: 'one more thing' });
  await restored.ended(first);
  assert.deepEqual(restored.sent('session/set_mode').map((p) => p.modeId), ['default', 'default']);

  const between = harness(t, server({ after: [{ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }] }));
  const job = await between.ended(await between.jobs.create({ kind: 'delegate', cwd: between.home, isolation: 'in_place', task: 'test' }));
  // The switch arrives 50 ms after the turn's reply.
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(between.sent('session/set_mode').length, 0);
  await between.jobs.reply(job.id, { message: 'one more thing' });
  await between.ended(job);
  assert.deepEqual(between.sent('session/set_mode').map((p) => p.modeId), ['default']);
});

test('a switch to another mode during a turn is undone', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ updates: [{ sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' }] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'done');
  assert.deepEqual(h.sent('session/set_mode').map((p) => p.modeId), ['default']);
});

test('a switch reported before the first prompt is undone before it goes out', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ switched: 'auto' }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'done');
  const order = fs.readFileSync(path.join(h.home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  assert.ok(order.indexOf('session/set_mode') >= 0 && order.indexOf('session/set_mode') < order.indexOf('session/prompt'), order.join(', '));
});

test('a switch back that agy refuses during a turn fails it, even when the turn ended first', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ refuseMode: true, updates: [{ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /"auto" mode, where it does not ask.*refused to switch/);
});

test('a cancel or another message while the mode is being put back sends no prompt', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ modeDelay: 300, after: [{ sessionUpdate: 'current_mode_update', currentModeId: 'auto' }] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  await h.jobs.reply(job.id, { message: 'one more thing' });
  await assert.rejects(h.adapter.reply((h.jobs as any).ctl(job), 'and another'), /still starting this turn/);
  await h.jobs.cancel(job.id);
  assert.equal(job.state, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(h.sent('session/prompt').length, 1);
});

test('a violation fails the job at once, and a session that ignores the cancel is closed', { timeout: 10000 }, async (t) => {
  const h = harness(t, server({ hold: true, ignoreCancel: true, updates: ranUnasked('x1', { kind: 'edit', title: 'File b.txt', locations: [{ path: path.join(os.tmpdir(), 'b.txt') }] }) }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /edit outside the workspace.*Crew stopped the turn/);
  const deadline = Date.now() + 8000;
  while (!h.sent('session/close').length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(h.sent('session/close').length, 1);
});

test('an action that ran unasked after a mode switch names the switch, not the user\'s rules', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ updates: [
    { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' },
    ...ranUnasked('x1', { kind: 'edit', title: 'File b.txt', locations: [{ path: path.join(os.tmpdir(), 'b.txt') }] }),
  ] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /because its session had switched to "accept-edits" mode.*could not keep the session in its asking mode/);
});

test('a finished turn closes its session, and a follow-up restores it', { timeout: 5000 }, async (t) => {
  const h = harness(t, server());
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  const deadline = Date.now() + 1000;
  while (!h.sent('session/close').length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(h.sent('session/close').length, 1);
  await h.jobs.reply(job.id, { message: 'one more thing' });
  await h.ended(job);
  assert.equal(job.state, 'done');
  assert.equal(h.sent('session/resume').length, 1);
  assert.equal(h.sent('session/prompt').length, 2);
});

test('the tokens of every prompt add up, and the context window shows how full it is', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({
    updates: [{ sessionUpdate: 'usage_update', used: 9000, size: 1048576 }],
    usage: { inputTokens: 2000, cachedReadTokens: 6700, outputTokens: 300, thoughtTokens: 50, totalTokens: 9000 },
  }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.deepEqual(job.context, { used: 9000, size: 1048576 });
  await h.jobs.reply(job.id, { message: 'one more thing' });
  await h.ended(job);
  assert.equal(job.tokens, 18000);
  assert.deepEqual(job.tokenUse, { input: 17400, cachedInput: 13400, output: 600, turn: 9000 });
});

/** A turn that runs until a second prompt comes. As agy does, that ends the first request and the turn goes on under the second. */
const steerServer = (permission: boolean) => `
  const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
  const update = (update) => send({ method: 'session/update', params: { sessionId: 's1', update } });
  let promptId;
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const { method, id, params } = JSON.parse(line);
    if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
    else if (method === 'session/new') send({ id, result: { sessionId: 's1' } });
    else if (method === 'session/prompt' && promptId === undefined) {
      promptId = id;
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working ' } });
      ${permission ? `send({ id: 'p', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c1', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' } }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });` : ''}
    } else if (method === 'session/prompt') {
      send({ id: promptId, result: { stopReason: 'end_turn' } });
      promptId = id;
      setTimeout(() => {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'and ' + params.prompt[0].text } });
        send({ id, result: { stopReason: 'end_turn', usage: { inputTokens: 10, cachedReadTokens: 0, outputTokens: 5, totalTokens: 15 } } });
      }, 100);
    } else if (method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
  });
`;

test('a message sent during a turn is added to it', { timeout: 5000 }, async (t) => {
  const h = harness(t, steerServer(false));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  while (!h.jobs.eventsFor(job.id, 0).some((e) => e.detail === 'writing' || job.phase === 'writing')) await h.jobs.wait(job.id, job.seq, 200);
  await h.jobs.reply(job.id, { message: 'steered' });
  await h.ended(job);
  assert.equal(job.state, 'done');
  assert.equal(job.report, 'working and steered');
  assert.equal(job.tokens, 15);
});

test('every message added during a turn has its tokens counted once', { timeout: 10000 }, async (t) => {
  const h = harness(t, `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const usage = (n) => ({ inputTokens: n, cachedReadTokens: 0, outputTokens: 0, totalTokens: n });
    let open, count = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1' } });
      else if (method === 'session/prompt') {
        count++;
        if (open !== undefined) send({ id: open, result: { stopReason: 'end_turn', usage: usage(count === 2 ? 10 : 20) } });
        open = id;
        if (count === 1) send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working' } } } });
        if (count === 3) setTimeout(() => send({ id, result: { stopReason: 'end_turn', usage: usage(30) } }), 100);
      }
    });
  `);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  while (job.phase !== 'writing') await h.jobs.wait(job.id, job.seq, 200);
  const ctl = (h.jobs as any).ctl(job);
  await Promise.all([h.adapter.reply(ctl, 'one'), h.adapter.reply(ctl, 'two')]);
  await h.ended(job);
  assert.equal(job.state, 'done');
  assert.equal(job.tokens, 60);
});

test('a message sent while the session is being set up joins the first turn instead of replacing it', { timeout: 5000 }, async (t) => {
  const h = harness(t, `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const fs = require('node:fs');
    const path = require('node:path');
    let held;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id, params } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1', configOptions: [{ id: 'model', category: 'model', currentValue: 'a', options: [{ value: 'a' }, { value: 'b' }] }] } });
      else if (method === 'session/set_config_option') { held = id; fs.writeFileSync(path.join(__dirname, 'held'), ''); }
      else if (method === 'release') send({ id: held, result: {} });
      else if (method === 'session/prompt') {
        fs.appendFileSync(path.join(__dirname, 'prompts'), params.prompt[0].text + '\\n');
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } } } });
        send({ id, result: { stopReason: 'end_turn' } });
      }
    });
  `);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'the original task', model: 'b' });
  while (!fs.existsSync(path.join(h.home, 'held'))) await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(h.adapter.reply((h.jobs as any).ctl(job), 'an extra message'), /still starting this turn/);
  (h.adapter as any).peer.request('release', {}).catch(() => {});
  await h.ended(job);
  assert.equal(job.state, 'done');
  assert.match(fs.readFileSync(path.join(h.home, 'prompts'), 'utf8'), /the original task/);
});

test('a mode reported while a switch back is answered is switched back too', { timeout: 5000 }, async (t) => {
  const h = harness(t, `
    const fs = require('node:fs');
    const path = require('node:path');
    const log = (method) => fs.appendFileSync(path.join(__dirname, 'log.jsonl'), JSON.stringify({ method }) + '\\n');
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    let switches = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method) log(method);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1', modes: { currentModeId: 'auto' } } });
      else if (method === 'session/set_mode') {
        if (++switches === 1) send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'current_mode_update', currentModeId: 'accept-edits' } } });
        send({ id, result: {} });
      } else if (method === 'session/prompt') {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } } } });
        send({ id, result: { stopReason: 'end_turn' } });
      }
    });
  `);
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'done');
  const order = fs.readFileSync(path.join(h.home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  assert.deepEqual(order.slice(order.indexOf('session/set_mode')), ['session/set_mode', 'session/set_mode', 'session/prompt']);
});

/** Holds ACP requests so a test can deliver their answers across a turn boundary. */
async function heldSession(t: test.TestContext, options: { model?: string; effort?: string; canClose?: boolean; holdNew?: boolean; holdResume?: boolean } = {}) {
  const h = harness(t);
  const acp = h.adapter as any;
  const calls: { method: string; params: any; resolve: (res: any) => void; reject: (err: Error) => void }[] = [];
  acp.peer = {
    alive: true, close() {},
    request(method: string, params: unknown) {
      const result = Promise.withResolvers<unknown>();
      calls.push({ method, params, ...result });
      if (method === 'session/new' && !options.holdNew) result.resolve({ sessionId: 's1' });
      if (method === 'session/resume' && !options.holdResume) result.resolve({ models: { currentModelId: 'restored' }, modes: { currentModeId: 'default' } });
      return result.promise;
    },
    notify(method: string, params: unknown) { calls.push({ method, params, resolve() {}, reject() {} }); },
  };
  const keepAlive = setInterval(() => {}, 30_000);
  t.after(() => clearInterval(keepAlive));
  acp.canClose = options.canClose ?? true;
  acp.restoreMethod = 'session/resume';
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'first', model: options.model, effort: options.effort });
  const sent = (method: string) => calls.filter((call) => call.method === 'session/' + method);
  const call = async (method: string, index = 0) => {
    const deadline = Date.now() + 8000;
    while (!sent(method)[index] && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(sent(method)[index], `missing session/${method} request ${index + 1}`);
    return sent(method)[index];
  };
  const update = (update: object) => acp.onNotification('session/update', { sessionId: 's1', update });
  const mode = (currentModeId: string) => update({ sessionUpdate: 'current_mode_update', currentModeId });
  const violation = () => update({ sessionUpdate: 'tool_call', toolCallId: 'outside', status: 'completed', kind: 'edit', title: 'edit outside', locations: [{ path: path.join(os.tmpdir(), 'outside') }] });
  const reply = (message: string) => h.jobs.reply(job.id, { message });
  return { ...h, acp, job, sent, call, update, mode, violation, reply };
}

const endTurn = { stopReason: 'end_turn' };
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('a prompt failure holds the session until an outstanding steer settles or close succeeds', async (t) => {
  for (const canClose of [false, true]) {
    const h = await heldSession(t, { canClose });
    const first = await h.call('prompt');
    const steering = h.reply('steer');
    const outstanding = await h.call('prompt', 1);
    first.reject(new Error('first prompt failed'));
    await h.ended(h.job);
    assert.equal(h.job.error?.message, 'first prompt failed');
    if (canClose) {
      (await h.call('close')).resolve({});
    } else {
      await h.reply('too soon');
      assert.equal(h.job.state, 'failed');
      assert.match(h.job.error!.message, /not yet stopped/);
      assert.equal(h.sent('prompt').length, 2);
      outstanding.resolve(endTurn);
      await steering;
    }
    await h.reply('next');
    assert.equal((await h.call('prompt', 2)).params.prompt[0].text, 'next');
    outstanding.resolve(endTurn);
    await steering;
  }
});

test('cancelling a restore ignores replayed usage and tool calls', async (t) => {
  const h = await heldSession(t, { holdResume: true });
  (await h.call('prompt')).resolve(endTurn);
  (await h.call('close')).resolve({});
  await h.reply('restore');
  const restore = await h.call('resume');
  const cancel = h.jobs.cancel(h.job.id);
  await h.call('cancel');
  h.update({ sessionUpdate: 'usage_update', used: 789, size: 999 });
  h.violation();
  restore.resolve({});
  await cancel;
  assert.equal(h.sent('prompt').length, 1);
  assert.equal(h.job.context, undefined);
  assert.deepEqual(h.job.notes, []);
});

test('overlapping steers wait for refusal or handover before sending the next message', async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const rejected = assert.rejects(h.reply('one'), /first steer refused/);
  const steer = await h.call('prompt', 1);
  const accepted = h.reply('two');
  await tick();
  const beforeRefusal = h.sent('prompt').length;
  steer.reject(new Error('first steer refused'));
  await rejected;
  const next = await h.call('prompt', 2);
  first.resolve(endTurn);
  next.reject(new RpcError(-32603, 'quota exhausted'));
  await accepted;
  await h.ended(h.job);
  assert.equal(beforeRefusal, 2);
  assert.deepEqual(h.job.error, { message: 'quota exhausted', limit: true });
});

test('a stopped turn refuses a queued steer before agy answers the previous one', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const sent = h.reply('one');
  const pending = await h.call('prompt', 1);
  const queued = assert.rejects(h.reply('two'), /ending this turn/);
  h.violation();
  await queued;
  assert.equal(h.sent('prompt').length, 2);
  first.resolve(endTurn);
  pending.resolve(endTurn);
  (await h.call('close')).resolve({});
  await sent;
});

test('a cancelled job closes the session created by a late answer', async (t) => {
  const h = await heldSession(t, { holdNew: true });
  const creating = await h.call('new');
  await h.jobs.cancel(h.job.id);
  creating.resolve({ sessionId: 'late' });
  await tick();
  assert.deepEqual(h.sent('close').map((call) => call.params.sessionId), ['late']);
  h.sent('close')[0].resolve({});
  assert.equal(h.sent('prompt').length, 0);
  assert.equal(h.job.sessionId, null);
});

test('a drained turn releases its session if the job ends during its final mode check', async (t) => {
  const h = await heldSession(t, { canClose: false });
  const first = await h.call('prompt');
  h.mode('auto');
  const mode = await h.call('set_mode');
  first.resolve(endTurn);
  await tick();
  (h.jobs as any).ctl(h.job).fail('job ended externally');
  await h.ended(h.job);
  const follow = h.reply('continue');
  h.mode('default');
  mode.resolve({});
  await follow;
  assert.equal(h.job.state, 'running');
  assert.equal((await h.call('prompt', 1)).params.prompt[0].text, 'continue');
});

test('an accepted steer that fails during generation fails the turn with its limit', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const steering = h.reply('continue').then(() => undefined, (err) => err);
  const next = await h.call('prompt', 1);
  first.resolve(endTurn);
  h.update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'partial answer' } });
  next.reject(new RpcError(-32603, '429 quota exhausted during generation'));
  await h.ended(h.job);
  assert.equal(h.job.state, 'failed');
  assert.equal(await steering, undefined);
  assert.deepEqual(h.job.error, { message: '429 quota exhausted during generation', limit: true });
});

test('a refused steer is reported once as soon as agy answers it', { timeout: 6000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const refusal = new RpcError(-32603, "Can't add this prompt while a question is waiting");
  const early = assert.rejects(h.reply('one'), /waiting/);
  (await h.call('prompt', 1)).reject(refusal);
  await early;
  assert.deepEqual(h.job.notes, []);
  await h.reply('two');
  (await h.call('prompt', 2)).reject(refusal);
  await tick();
  assert.deepEqual(h.job.notes, [`A message sent during the turn did not reach Antigravity: ${refusal.message}`]);
  first.resolve(endTurn);
  await h.ended(h.job);
  assert.equal(h.job.state, 'done');
  assert.equal(h.job.notes.length, 1);
});

test('a cancelled prompt keeps its outcome when an outstanding steer is refused', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const refused = assert.rejects(h.reply('extra'), /no active turn/);
  const next = await h.call('prompt', 1);
  const cancel = h.jobs.cancel(h.job.id);
  await h.call('cancel');
  first.resolve({ stopReason: 'cancelled' });
  next.reject(new Error('no active turn'));
  await Promise.all([refused, cancel]);
  assert.equal(h.job.state, 'cancelled');
});

test('a cancelled follow-up waiting on a close cannot take the next turn', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  (await h.call('prompt')).resolve(endTurn);
  const close = await h.call('close');
  const b = h.reply('B');
  await tick();
  await h.jobs.cancel(h.job.id);
  const c = h.reply('C');
  close.resolve({});
  await Promise.all([b, c]);
  assert.equal((await h.call('prompt', 1)).params.prompt[0].text, 'C');
  assert.equal(h.sent('resume').length, 1);
  assert.equal(h.job.state, 'running');
});

test('a refused close holds a stopped session until its prompt settles', { timeout: 15000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  h.violation();
  const follow = h.reply('try again');
  (await h.call('close')).reject(new Error('close refused'));
  await follow;
  assert.equal(h.job.state, 'failed');
  assert.match(h.job.error!.message, /not yet stopped/);
  assert.equal(h.sent('prompt').length, 1);
  first.resolve({ stopReason: 'cancelled' });
  (await h.call('close', 1)).resolve({});
  await h.reply('now continue');
  assert.equal((await h.call('prompt', 1)).params.prompt[0].text, 'now continue');
});

test('an older turn cannot send its lead decline into a follow-up', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const request = h.acp.onRequest('session/request_permission', { sessionId: 's1', toolCall: { kind: 'execute', title: 'ls', rawInput: 'ls' }, options: [{ kind: 'reject_once', optionId: 'no' }] });
  await h.jobs.reply(h.job.id, { decision: 'decline', message: 'Use the existing notes', request_id: h.job.waiting!.id });
  await request;
  h.violation();
  const follow = h.reply('next task');
  await tick();
  first.resolve(endTurn);
  await tick();
  assert.equal(h.sent('prompt').length, 1);
  (await h.call('close')).resolve({});
  await follow;
  assert.equal((await h.call('prompt', 1)).params.prompt[0].text, 'next task');
});

test('a failed cancel enforces the violation that completed during it', { timeout: 10000 }, async (t) => {
  const h = await heldSession(t, { canClose: false });
  const first = await h.call('prompt');
  const cancel = assert.rejects(h.jobs.cancel(h.job.id), /did not confirm/);
  await h.call('cancel');
  h.violation();
  assert.match(h.job.notes.join(' '), /edit outside/);
  assert.equal(h.job.state, 'running');
  await cancel;
  first.resolve(endTurn);
  await tick();
  assert.equal(h.job.state, 'failed');
  assert.match(h.job.error!.message, /edit outside/);
});

test('a violation held during cancel fails the job if agy refuses to close', { timeout: 10000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const cancel = assert.rejects(h.jobs.cancel(h.job.id), /close refused/);
  await h.call('cancel');
  h.violation();
  (await h.call('close')).reject(new Error('close refused'));
  await cancel;
  assert.equal(h.job.state, 'failed');
  assert.match(h.job.error!.message, /edit outside/);
  first.resolve(endTurn);
  await tick();
  assert.equal(h.job.state, 'failed');
});

test('a turn that continues after a failed cancel restores the mode reported during cancellation', { timeout: 10000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  const cancel = assert.rejects(h.jobs.cancel(h.job.id), /close refused/);
  await h.call('cancel');
  h.mode('auto');
  (await h.call('close')).reject(new Error('close refused'));
  await cancel;
  (await h.call('set_mode')).resolve({});
  first.resolve(endTurn);
  await h.ended(h.job);
  assert.equal(h.job.state, 'done');
});

test('mode changes are serialized and a finishing turn waits for the last switch back', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const prompt = await h.call('prompt');
  h.mode('auto');
  const first = await h.call('set_mode');
  prompt.resolve(endTurn);
  await tick();
  h.mode('accept-edits');
  await tick();
  assert.equal(h.sent('set_mode').length, 1);
  first.resolve({});
  const second = await h.call('set_mode', 1);
  assert.equal(h.job.state, 'running');
  second.reject(new Error('last switch refused'));
  await h.ended(h.job);
  assert.match(h.job.error!.message, /last switch refused/);
});

test('unasked actions keep the mode in force when each started', { timeout: 5000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  h.mode('auto');
  const [start, finish] = ranUnasked('one', { kind: 'execute', title: 'first', rawInput: 'ls' });
  h.update(start);
  (await h.call('set_mode')).resolve({});
  await tick();
  h.update(finish);
  for (const update of ranUnasked('two', { kind: 'execute', title: 'second', rawInput: 'ls' })) h.update(update);
  assert.match(h.job.notes[0], /switched to "auto".*first/);
  assert.match(h.job.notes[1], /user's Antigravity settings.*second/);
  first.resolve(endTurn);
  await h.ended(h.job);
});

test('force-closing a turn invalidates its mode restore and its waiting steer', { timeout: 10000 }, async (t) => {
  const h = await heldSession(t);
  const first = await h.call('prompt');
  h.mode('auto');
  const mode = await h.call('set_mode');
  const steering = h.reply('old message').catch(() => {});
  await tick();
  const cancel = h.jobs.cancel(h.job.id);
  (await h.call('close')).resolve({});
  await cancel;
  await h.reply('fresh');
  const next = await h.call('prompt', 1);
  mode.reject(new Error('old mode refused'));
  await tick();
  assert.equal(h.job.state, 'running');
  assert.equal(h.sent('cancel').length, 1);
  assert.equal(h.sent('prompt').length, 2);
  await steering;
  first.resolve({ ...endTurn, usage: { totalTokens: 100 } });
  next.resolve({ ...endTurn, usage: { totalTokens: 20 } });
  await h.ended(h.job);
  assert.equal(h.job.tokens, 20);
  assert.equal(h.job.tokenUse?.turn, 20);
});

for (const option of ['model', 'thought_level']) test(`a late ${option} setup answer belongs to the force-closed turn`, { timeout: 10000 }, async (t) => {
  const h = await heldSession(t, { model: 'chosen', effort: 'high' });
  const options = { configOptions: [
    { id: 'model', currentValue: 'old' },
    { id: 'thought_level', currentValue: 'low', options: [{ value: 'high' }] },
  ] };
  let setup = await h.call('set_config_option');
  if (option === 'thought_level') {
    setup.resolve(options);
    setup = await h.call('set_config_option', 1);
  }
  const cancel = h.jobs.cancel(h.job.id);
  (await h.call('close')).resolve({});
  await cancel;
  await h.reply('fresh');
  await h.call('prompt');
  setup.resolve(options);
  await tick();
  assert.equal(h.sent('set_config_option').length, option === 'model' ? 1 : 2);
  assert.equal(h.job.resolvedModel, 'restored');
});

test('a message is refused while Antigravity waits for an approval', { timeout: 5000 }, async (t) => {
  const h = harness(t, steerServer(true));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  await h.waiting(job);
  await assert.rejects(h.adapter.reply((h.jobs as any).ctl(job), 'steered'), /waiting for an approval or an answer/);
  await h.jobs.cancel(job.id);
});

test('a switch reported right after a restore is not overwritten by the restore\'s own answer', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ mode: 'default', resumeSwitched: 'auto' }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  await h.jobs.reply(job.id, { message: 'one more thing' });
  await h.ended(job);
  const order = fs.readFileSync(path.join(h.home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  assert.deepEqual(order.slice(order.indexOf('session/resume'), order.indexOf('session/resume') + 3), ['session/resume', 'session/set_mode', 'session/prompt']);
});

test('a cancelled turn that ends late does not close the session a follow-up restored', { timeout: 20000 }, async (t) => {
  const h = harness(t, server({ hold: true, cancelDelay: 6000 }));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  while (job.phase !== 'working' || !fs.existsSync(path.join(h.home, 'log.jsonl')) || !h.sent('session/prompt').length) await new Promise((resolve) => setTimeout(resolve, 20));
  // Unconfirmed after five seconds, the cancel closes the session itself.
  await h.jobs.cancel(job.id);
  assert.equal(h.sent('session/close').length, 1);
  await h.jobs.reply(job.id, { message: 'start over' });
  while (h.sent('session/prompt').length < 2) await new Promise((resolve) => setTimeout(resolve, 20));
  // The first prompt's late answer arrives about a second later.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(h.sent('session/close').length, 1);
  assert.equal(job.state, 'running');
});

test('a follow-up waits for a stopped turn to end and starts a turn of its own', { timeout: 20000 }, async (t) => {
  const h = harness(t, server({ hold: true, ignoreCancel: true, updates: ranUnasked('x1', { kind: 'edit', title: 'File b.txt', locations: [{ path: path.join(os.tmpdir(), 'b.txt') }] }) }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'failed');
  await h.jobs.reply(job.id, { message: 'try again within the workspace' });
  const methods = () => fs.readFileSync(path.join(h.home, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).method);
  const deadline = Date.now() + 8000;
  while (methods().filter((m) => m === 'session/prompt').length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
  const order = methods();
  // The fake server runs the same unasked edit again, so the new turn is stopped in its turn; it was still a turn of its own.
  assert.deepEqual(order.slice(order.indexOf('session/close'), order.indexOf('session/close') + 3), ['session/close', 'session/resume', 'session/prompt']);
});

// agy runs commands the user's own allow rules cover, and reads its Non-Workspace Access setting permits, without asking.
const ranUnasked = (toolCallId: string, call: Record<string, unknown>) => [
  { sessionUpdate: 'tool_call', toolCallId, status: 'in_progress', ...call },
  { sessionUpdate: 'tool_call_update', toolCallId, status: 'completed' },
];

test('an engineer\'s command that ran under the user\'s Antigravity rules is reported, and the turn goes on', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ updates: [
    ...ranUnasked('c1', { kind: 'execute', title: 'git branch', rawInput: { CommandLine: 'git branch' } }),
    ...ranUnasked('r1', { kind: 'read', title: 'File note.txt', locations: [{ path: path.join(os.tmpdir(), 'note.txt') }] }),
  ] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'done');
  assert.equal(job.report, 'report');
  assert.deepEqual(job.notes, ['Antigravity ran an action without asking Crew, because a rule in the user\'s Antigravity settings allows it: execute: git branch']);
  assert.equal(h.sent('session/cancel').length, 0);
});

test('an action outside the role that ran without asking stops the turn', { timeout: 5000 }, async (t) => {
  for (const [name, call, ask] of [
    ['a command in a read-only job', { kind: 'execute', title: 'git push origin main', rawInput: { CommandLine: 'git push origin main' } }, true],
    ['an edit outside the workspace', { kind: 'edit', title: 'File b.txt', locations: [{ path: path.join(os.tmpdir(), 'b.txt') }] }, false],
    ['a read of the Crew token', { kind: 'read', title: 'File token', locations: [{ path: tokenFile(HOME) }] }, false],
  ] as const) {
    const h = harness(t, server({ updates: ranUnasked('x1', call) }));
    const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', ask }));
    assert.equal(job.state, 'failed', name);
    assert.match(job.error!.message, /without asking Crew .*Crew stopped the turn/, name);
    // The job fails at once; the cancel reaches the server just after.
    const deadline = Date.now() + 1000;
    while (!h.sent('session/cancel').length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.sent('session/cancel').length, 1, name);
  }
});

test('a tool call is judged on its final fields, and Crew\'s own tools and failed calls are not reported', { timeout: 5000 }, async (t) => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-agy-work-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const h = harness(t, server({ updates: [
    { sessionUpdate: 'tool_call', toolCallId: 'e1', status: 'pending', kind: 'edit', title: 'Edit', locations: [] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'e1', locations: [{ path: path.join(work, 'a.txt') }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'e1', status: 'completed' },
    ...ranUnasked('m1', { kind: 'other', title: 'mcp_crew_ask_lead' }),
    { sessionUpdate: 'tool_call', toolCallId: 'f1', status: 'in_progress', kind: 'execute', title: 'git push', rawInput: { CommandLine: 'git push' } },
    { sessionUpdate: 'tool_call_update', toolCallId: 'f1', status: 'failed' },
  ] }));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: work, isolation: 'in_place', task: 'test' }));
  assert.equal(job.state, 'done');
  assert.deepEqual(job.notes ?? [], []);
});

test('a call that ends with the user\'s cancel is not taken for a violation', { timeout: 5000 }, async (t) => {
  const h = harness(t, `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const update = (update) => send({ method: 'session/update', params: { sessionId: 's1', update } });
    let promptId;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1' } });
      else if (method === 'session/prompt') {
        promptId = id;
        update({ sessionUpdate: 'tool_call', toolCallId: 'c1', status: 'in_progress', kind: 'execute', title: 'git status', rawInput: { CommandLine: 'git status' } });
      } else if (method === 'session/cancel') {
        send({ id: 'p', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c2', kind: 'execute', title: 'ls', rawInput: { CommandLine: 'ls' } }, options: [{ kind: 'allow_once', optionId: 'yes' }] } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'c2', status: 'failed' });
        send({ id: promptId, result: { stopReason: 'cancelled' } });
      }
    });
  `);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', ask: true });
  while (!h.jobs.eventsFor(job.id, 0).some((e) => e.detail === 'git status')) await h.jobs.wait(job.id, job.seq, 1000);
  await h.jobs.cancel(job.id);
  await h.ended(job);
  assert.equal(job.state, 'cancelled');
  assert.ok(!job.error);
  // What ran is still on record.
  assert.match(job.notes.join('\n'), /outside the read-only engineer role without asking Crew \(execute: git status\)/);
});

test('a tool call that came to Crew as a permission request is not checked again when it finishes', { timeout: 5000 }, async (t) => {
  const h = harness(t, `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const update = (update) => send({ method: 'session/update', params: { sessionId: 's1', update } });
    let promptId;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1' } });
      else if (method === 'session/prompt') {
        promptId = id;
        update({ sessionUpdate: 'tool_call', toolCallId: 'c1', status: 'in_progress', kind: 'execute', title: 'npm test' });
        send({ id: 'p', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 'c1', kind: 'execute', title: 'npm test', rawInput: { CommandLine: 'npm test' } }, options: [{ kind: 'allow_once', optionId: 'yes' }] } });
      } else if (id === 'p') {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed' });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      }
    });
  `);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  await h.jobs.reply(job.id, { decision: 'approve', request_id: (await h.waiting(job)).id });
  await h.ended(job);
  assert.equal(job.state, 'done');
  assert.deepEqual(job.notes ?? [], []);
});

test('the role travels with the first prompt when the server takes no addition', { timeout: 5000 }, async (t) => {
  const h = harness(t, server());
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'the task itself' }));
  assert.equal(h.sent('session/new')[0]._meta, undefined);
  assert.equal(h.sent('session/prompt')[0].prompt[0].text, `${job.instructions}\n\n${job.prompt}`);
});

const FORM = {
  type: 'object',
  properties: {
    q1: { type: 'string', title: 'Which color should the banner be?', oneOf: [{ const: '1', title: 'Red' }, { const: '2', title: 'Blue' }] },
    q1_other: { type: 'string', title: 'Other' },
  },
};

test('a question form waits for the user and takes a choice, their own words, or no answer', { timeout: 10000 }, async (t) => {
  for (const [reply, expected] of [
    [{ message: 'blue' }, { action: 'accept', content: { q1: '2' } }],
    [{ message: '1' }, { action: 'accept', content: { q1: '1' } }],
    [{ message: 'Green, with a border' }, { action: 'accept', content: { q1_other: 'Green, with a border' } }],
    [{ decision: 'deny' }, { action: 'decline' }],
    // A quick approval is no answer to a form that does not offer Yes, and a deny stays a deny whatever it says.
    [{ decision: 'approve' }, { action: 'decline' }],
    [{ decision: 'deny', message: 'blue' }, { action: 'decline' }],
  ] as const) {
    const h = harness(t, server({ form: FORM }));
    const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
    const request = await h.waiting(job);
    assert.equal(request.type, 'question');
    assert.equal(request.reason, 'Which color should the banner be?\n1. Red\n2. Blue');
    await assert.rejects(h.jobs.reply(job.id, { decision: 'decline', message: 'Outside the task', request_id: request.id }), /Only an approval can be declined/);
    assert.equal(job.waiting, request);
    await h.jobs.reply(job.id, { ...reply, request_id: request.id });
    await h.ended(job);
    assert.equal(job.state, 'done');
    assert.deepEqual(JSON.parse(job.report!), expected);
  }
});

test('quick form decisions select Yes or No only when every question offers that choice', { timeout: 10000 }, async (t) => {
  const first = { type: 'string', title: 'Use the cache?', oneOf: [{ const: 'y', title: 'Yes' }, { const: 'n', title: 'No' }] };
  const second = { type: 'string', title: 'Keep the fallback?', oneOf: [{ const: '1', title: 'Yes' }, { const: '0', title: 'No' }] };
  for (const [q2, decision, expected] of [
    [second, 'deny', { action: 'accept', content: { q1: 'n', q2: '0' } }],
    [second, 'approve', { action: 'accept', content: { q1: 'y', q2: '1' } }],
    [{ type: 'string', title: second.title }, 'deny', { action: 'decline' }],
  ] as const) {
    const h = harness(t, server({ form: { properties: { q1: first, q2 } } }));
    const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
    const request = await h.waiting(job);
    await h.jobs.reply(job.id, { decision, request_id: request.id });
    await h.ended(job);
    assert.deepEqual(JSON.parse(job.report!), expected);
    assert.match(request.reason, /^Your answer applies to every question\.\n/);
    assert.ok(request.reason.includes(first.title) && request.reason.includes(second.title));
    assert.deepEqual(job.notes, []);
  }
});

test('a form that cannot be answered is declined before asking the user', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ form: { properties: { q1: FORM.properties.q1, q2: { type: 'boolean', title: 'Use the cache?' } } } }));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  while (!job.waiting && !job.endedAt) await h.jobs.wait(job.id, job.seq, 1000);
  assert.equal(job.waiting, null);
  assert.deepEqual(JSON.parse(job.report!), { action: 'decline' });
  assert.ok(!h.jobs.eventsFor(job.id, 0).some((e) => e.kind === 'waiting'));
  assert.match(job.notes.join('\n'), /could not show[^]*Use the cache\?/i);
});

test('a form with an unusable answer records the question and answer', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ form: { properties: { q1: FORM.properties.q1 } } }));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const request = await h.waiting(job);
  await h.jobs.reply(job.id, { message: 'Green with a border', request_id: request.id });
  await h.ended(job);
  assert.deepEqual(JSON.parse(job.report!), { action: 'decline' });
  assert.match(job.notes.join('\n'), /could not use[^]*Which color should the banner be\?[^]*Green with a border/i);
});

test('a question still open when the job is cancelled is answered as cancelled', { timeout: 5000 }, async (t) => {
  const h = harness(t, server({ form: FORM }));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  await h.waiting(job);
  await h.jobs.cancel(job.id);
  assert.equal(job.state, 'cancelled');
  assert.equal(job.waiting, null);
});

test('formQuestions reads choices, lists, and written answers; formAnswer fills them', () => {
  const questions = formQuestions({ properties: {
    one: FORM.properties.q1, one_other: { type: 'string' },
    many: { type: 'array', title: 'Which files?', items: { anyOf: [{ const: 'a', title: 'a.ts' }, { const: 'b', title: 'b.ts' }] } },
    free: { type: 'string', title: 'Why?' },
  } });
  assert.deepEqual(questions.map((q) => [q.key, q.choices.length, q.many, q.other]), [['one', 2, false, 'one_other'], ['many', 2, true, undefined], ['free', 0, false, 'free']]);
  assert.deepEqual(formAnswer(questions.slice(0, 1), 'Red'), { one: '1' });
  assert.deepEqual(formAnswer(questions.slice(1, 2), 'b.ts'), { many: ['b'] });
  assert.deepEqual(formAnswer(questions.slice(1, 2), '1, 2'), { many: ['a', 'b'] });
  assert.deepEqual(formAnswer(questions.slice(1, 2), 'a.ts, b.ts'), { many: ['a', 'b'] });
  assert.deepEqual(formAnswer(questions, '1'), { one: '1', many: ['a'], free: '1' });
  assert.deepEqual(formAnswer(questions.slice(2), 'because'), { free: 'because' });
  assert.equal(formAnswer(questions.slice(1, 2), 'neither'), undefined);
  assert.equal(formAnswer(questions.slice(1, 2), '1, missing'), undefined);
  const withWritten = [{ ...questions[1], other: 'many_other' }];
  assert.deepEqual(formAnswer(withWritten, '1, b.ts'), { many: ['a', 'b'] });
  assert.deepEqual(formAnswer(withWritten, '1, missing'), { many_other: '1, missing' });
  const enumerated = formQuestions({ properties: { size: { type: 'string', enum: ['Small', 'Large'] } } });
  assert.deepEqual(enumerated[0].choices, [{ value: 'Small', title: 'Small' }, { value: 'Large', title: 'Large' }]);
  assert.deepEqual(formAnswer(enumerated, 'large'), { size: 'Large' });
  assert.equal(formAnswer(enumerated, 'medium'), undefined);
  for (const type of ['boolean', 'integer', 'number']) {
    const unsupported = formQuestions({ properties: { field: { type, title: 'Only a typed answer' } } });
    assert.equal(unsupported[0].title, 'Only a typed answer');
    assert.equal(formAnswer(unsupported, '1'), undefined);
  }
  assert.deepEqual(formQuestions(undefined), []);
});

test('a command under any of agy\'s field names is not taken for a Crew tool call', () => {
  for (const field of ['command', 'CommandLine', 'command_line', 'commandLine']) {
    assert.notEqual(decide('review', '/work', { kind: 'other', title: 'mcp_crew_ask_lead', rawInput: { [field]: 'rm -rf .' } }), 'allow');
  }
  assert.equal(decide('review', '/work', { kind: 'other', title: 'mcp_crew_ask_lead', rawInput: { question: 'why' } }), 'allow');
});

function commandServer(batches: unknown[][]): string {
  return `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const batches = ${JSON.stringify(batches)};
    const update = (update) => send({ method: 'session/update', params: { sessionId, update } });
    const options = ['allow_always', 'allow_once', 'reject_once'].map((kind) => ({ kind, optionId: kind }));
    let sessions = 0, sessionId, promptId, batch, remaining, answers;
    const next = () => {
      const calls = batches[batch++];
      if (!calls) {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(answers) } });
        return send({ id: promptId, result: { stopReason: 'end_turn' } });
      }
      remaining = calls.length;
      calls.forEach((toolCall, i) => send({ id: 'command-' + batch + '-' + i, method: 'session/request_permission',
        params: { sessionId, toolCall, options } }));
      update({ sessionUpdate: 'tool_call', title: 'Batch ' + batch + ' sent' });
    };
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id, params, result } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's' + ++sessions } });
      else if (method === 'session/prompt') {
        sessionId = params.sessionId; promptId = id; batch = 0; answers = {};
        next();
      } else if (typeof id === 'string' && id.startsWith('command-')) {
        answers[id] = result.outcome.optionId;
        if (--remaining === 0) next();
      }
    });
  `;
}

const command = (CommandLine: string, Cwd?: string, kind = 'execute') => ({
  kind, rawInput: { CommandLine, ...(Cwd === undefined ? {} : { Cwd }) },
});

// Job grants are offered only where commands run in a POSIX shell.
const posixOnly = process.platform === 'win32' ? 'job grants assume a POSIX shell' : false;

function commandDirectory(t: test.TestContext): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-agy-command-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a command grant covers queued and later requests for the same program, subcommand, and directory', { timeout: 5000, skip: posixOnly }, async (t) => {
  const work = commandDirectory(t);
  const elsewhere = commandDirectory(t);
  const h = harness(t, commandServer([
    [command('npm test', work), command('node test.js', work), command('npm test --watch', work)],
    [
      command('npm test --watch', work), command('npm run lint', work), command('npm test', elsewhere),
      command('npm test', work, 'other'),
      { ...command('npm test', work), locations: [{ path: tokenFile(HOME) }] },
      command('npm test && npm run lint', work),
    ],
  ]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const request = await h.waiting(job);
  assert.equal(request.grant, `running "npm test" in ${work}`);
  while (!h.jobs.eventsFor(job.id, 0).some((e) => e.detail.includes('Batch 1 sent'))) await h.jobs.wait(job.id, job.seq, 1000);
  await h.jobs.reply(job.id, { decision: 'allow_for_job', request_id: request.id });
  const denyRemaining = async () => {
    for (const label of [`running "node test.js" in ${work}`, `running "npm run" in ${work}`, `running "npm test" in ${elsewhere}`, undefined, undefined]) {
      const next = await h.waiting(job);
      assert.equal(next.grant, label);
      await h.jobs.reply(job.id, { decision: 'deny', request_id: next.id });
    }
    await h.ended(job);
  };
  await denyRemaining();
  const expected = {
    'command-1-0': 'allow_once', 'command-1-1': 'reject_once', 'command-1-2': 'allow_once',
    'command-2-0': 'allow_once', 'command-2-1': 'reject_once', 'command-2-2': 'reject_once',
    'command-2-3': 'reject_once', 'command-2-4': 'reject_once', 'command-2-5': 'reject_once',
  };
  assert.deepEqual(JSON.parse(job.report!), expected);
  assert.equal(h.jobs.eventsFor(job.id, 0).filter((e) => e.detail === `allowed for this job: ${request.grant}`).length, 2);

  await h.jobs.reply(job.id, { message: 'Run again' });
  await denyRemaining();
  assert.deepEqual(JSON.parse(job.report!), expected);

  const another = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test again' });
  assert.equal((await h.waiting(another)).grant, request.grant);
});

test('a git status grant does not cover an invocation that starts with an option', { timeout: 5000, skip: posixOnly }, async (t) => {
  const h = harness(t, commandServer([
    [command('git status')],
    [command('git status -s'), command('git -c alias.x=y x')],
  ]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const request = await h.waiting(job);
  await h.jobs.reply(job.id, { decision: 'allow_for_job', request_id: request.id });
  while (!job.waiting && !job.endedAt) await h.jobs.wait(job.id, job.seq, 1000);
  assert.ok(job.waiting, 'git -c should still ask for approval');
  assert.match(job.waiting.reason, /git -c alias\.x=y x/);
  assert.equal(job.waiting.grant, undefined);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting.id });
  await h.ended(job);
  assert.equal(request.grant, 'running "git status" in the job workspace');
  assert.deepEqual(JSON.parse(job.report!), {
    'command-1-0': 'allow_once', 'command-2-0': 'allow_once', 'command-2-1': 'reject_once',
  });
});

test('only simple commands offer a job grant', { timeout: 5000, skip: posixOnly }, async (t) => {
  const commands = [
    'npm test && npm run build', 'npm test | tee log', 'npm test $(whoami)', 'sh -c "npm test"',
    'npm test; npm run build', 'npm test || true', 'npm test &', 'npm test `whoami`',
    'npm test > log', 'npm test < input', 'npm test\nnpm run build',
    '/usr/bin/sudo npm test', 'env npm test', 'xargs npm', 'bash -lc "npm test"', 'eval npm test', 'exec npm test',
    'PATH=/tmp/bin npm test', 'NODE_OPTIONS=--require=x npm test', 'nohup npm test', 'timeout 60 npm test',
  ];
  const h = harness(t, commandServer([...commands.map((line) => [command(line)]), [command('./node_modules/.bin/tsc build')]]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  for (const [i, line] of commands.entries()) {
    const request = await h.waiting(job);
    assert.ok(request.reason.includes(JSON.stringify(line)));
    assert.equal(request.grant, undefined);
    if (i === 0) {
      await assert.rejects(h.adapter.answer(h.jobs['ctl'](job), true, undefined, { forJob: true }),
        { message: 'This request cannot be allowed for the whole job. Approve or deny it.' });
      assert.equal(job.waiting?.id, request.id);
    }
    await h.jobs.reply(job.id, { decision: 'approve', request_id: request.id });
  }
  const request = await h.waiting(job);
  assert.equal(request.grant, 'running "./node_modules/.bin/tsc build" in the job workspace');
  await h.jobs.reply(job.id, { decision: 'approve', request_id: request.id });
  await h.ended(job);
  assert.equal(Object.values(JSON.parse(job.report!)).length, commands.length + 1);
});

test('dispatchers, ambiguous arguments and input, and non-execute tools offer no grant', { timeout: 5000 }, async (t) => {
  const calls = [
    ...[
      'zsh -c "echo hi"', 'dash -c "echo hi"', 'git -c alias.x=y x', 'find . -name x -print',
      'perl -e 1', 'osascript -e 1', 'ssh host echo hi', 'busybox echo hi', 'arch -arm64 echo hi',
      'flock lockfile echo hi', 'cmd /c echo hi', 'powershell -EncodedCommand ZQBjAGgAbwAgAGgAaQA=', 'pwsh -Command echo',
      'CMD.EXE /c echo hi', 'pwsh.exe -Command echo',
      'sh script.sh', 'bash script.sh', 'zsh script.sh', 'dash script.sh', 'ksh script.sh', 'fish script.fish',
      'csh script.csh', 'tcsh script.csh', 'script transcript', 'find src -print', 'OSASCRIPT.EXE script.scpt',
      'CMD.EXE help', 'pwsh.exe script.ps1', 'POWERSHELL.EXE script.ps1', '/usr/bin/SSH.EXE host echo hi',
      'npm', 'npm .', 'npm /x', 'npm --version', 'git --exec-path', 'npm "test"', 'npm test/path',
    ].map((line) => command(line)),
    command('npm test', undefined, 'other'),
    { ...command('npm test'), _meta: { mcpServerName: 'example', mcpToolName: 'execute' } },
    { kind: 'execute', rawInput: { CommandLine: 'npm test', directory: '/elsewhere' } },
    { kind: 'execute', rawInput: { CommandLine: 'npm test', unknownFlag: true } },
    { kind: 'execute', rawInput: { CommandLine: 'npm test', unknownNumber: 1 } },
    { kind: 'execute', rawInput: { CommandLine: 'npm test', command: 'npm test' } },
    { kind: 'execute', rawInput: { CommandLine: 'npm test', Cwd: '/work', cwd: '/elsewhere' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd /work && npm test', Cwd: '/elsewhere' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd ~ && npm test' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd - && npm test' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd /work && cd /tmp && npm test' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd /work && npm test', WaitMsBeforeAsync: '5000' } },
    { kind: 'execute', rawInput: { CommandLine: 'cd /work && npm test', toolSummary: 1 } },
  ];
  const h = harness(t, commandServer([...calls.map((call) => [call]), [command('NPM.EXE test')]]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const unexpectedGrants = [];
  for (const call of calls) {
    const request = await h.waiting(job);
    if (request.grant !== undefined) unexpectedGrants.push({ ...call, grant: request.grant });
    await h.jobs.reply(job.id, { decision: 'approve', request_id: request.id });
  }
  const request = await h.waiting(job);
  await h.jobs.reply(job.id, { decision: 'approve', request_id: request.id });
  await h.ended(job);
  assert.deepEqual(unexpectedGrants, []);
  assert.equal(request.grant, posixOnly ? undefined : 'running "NPM.EXE test" in the job workspace');
  assert.deepEqual(Object.values(JSON.parse(job.report!)), Array(calls.length + 1).fill('allow_once'));
});

test('agy\'s own request shape, `cd <dir> && <command>` with its summary fields, gets a grant for that directory', { timeout: 5000, skip: posixOnly }, async (t) => {
  // As agy 1.5 sent it in a live job on 2026-11-21.
  const work = commandDirectory(t);
  const live = (line: string) => ({ kind: 'execute', rawInput: { CommandLine: `cd ${work} && ${line}`, WaitMsBeforeAsync: 5000, toolSummary: `Run ${line}` } });
  const h = harness(t, commandServer([[live('npm test')], [live('npm test --watch'), live('npm test --prefix=/x'), live('npm test ../x'), command('npm test', work)]]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const first = await h.waiting(job);
  assert.equal(first.grant, `running "npm test" in ${work}`);
  await h.jobs.reply(job.id, { decision: 'allow_for_job', request_id: first.id });
  for (const arg of ['--prefix=/x', '../x']) {
    while (!job.waiting && !job.endedAt) await h.jobs.wait(job.id, job.seq, 1000);
    assert.ok(job.waiting, `Expected approval for ${arg}`);
    assert.ok(job.waiting.reason.includes(arg));
    assert.equal(job.waiting.grant, undefined);
    await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting.id });
  }
  await h.ended(job);
  assert.deepEqual(JSON.parse(job.report!), {
    'command-1-0': 'allow_once', 'command-2-0': 'allow_once', 'command-2-1': 'reject_once',
    'command-2-2': 'reject_once', 'command-2-3': 'allow_once',
  });
});

test('command grants require an unambiguous directory and arguments', { timeout: 5000 }, async (t) => {
  const work = commandDirectory(t);
  const elsewhere = commandDirectory(t);
  fs.mkdirSync(path.join(work, 'x'));
  fs.symlinkSync(elsewhere, path.join(work, 'link'));
  fs.writeFileSync(path.join(work, 'file'), '');
  const calls = [
    command('cd repo && npm test'),
    command('cd repo && npm test', 'repo'),
    command('npm test', 'repo'),
    ...[`${work}/link/..`, `${work}/./x`, `${work}/.`, `${work}//x`, `${work}/missing`, `${work}/file`].flatMap((dir) => [
      command(`cd ${dir} && npm test`), command('npm test', dir),
    ]),
    command(`cd ${work} && make test -C /elsewhere`),
    command(`cd ${work} && cd tmp`),
    command('pushd tmp'),
    command('popd 1'),
    command('npm test "--prefix=/x"'),
    command('npm test fixtures/../x'),
    command('npm test ../x'),
    command('make test -C/elsewhere'),
    command("npm test '.'./x"),
    // The shell expands these into paths the literal text does not show.
    command('npm test "$HOME/x"'),
    command('npm test ${HOME}'),
    command('npm test ~/x'),
    command('npm test --prefix=~'),
    command('npm test x{,/elsewhere}'),
    command('npm test x{..,y}'),
  ];
  const h = harness(t, commandServer(calls.map((call) => [call])));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const unexpectedGrants = [];
  for (const call of calls) {
    const request = await h.waiting(job);
    if (request.grant !== undefined) unexpectedGrants.push({ ...call.rawInput, grant: request.grant });
    await h.jobs.reply(job.id, { decision: 'deny', request_id: request.id });
  }
  await h.ended(job);
  assert.deepEqual(unexpectedGrants, []);
});

test('a directory grant does not follow a retargeted symlink', { timeout: 5000, skip: posixOnly }, async (t) => {
  const work = commandDirectory(t);
  const original = commandDirectory(t);
  const replacement = commandDirectory(t);
  const link = path.join(work, 'link');
  const child = path.join(original, 'child');
  fs.mkdirSync(child);
  fs.symlinkSync(child, path.join(work, 'hop'));
  fs.symlinkSync('hop/..', link);
  const h = harness(t, commandServer([
    [command(`cd ${link} && npm test`)],
    [command('npm test', original), command('node test.js', work)],
    [command(`cd ${link} && npm test --watch`)],
  ]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const first = await h.waiting(job);
  assert.equal(first.grant, `running "npm test" in ${link}`);
  await h.jobs.reply(job.id, { decision: 'allow_for_job', request_id: first.id });
  const alias = await h.waiting(job);
  const matchedOriginal = alias.grant === `running "node test.js" in ${work}`;
  if (!matchedOriginal) await h.jobs.reply(job.id, { decision: 'deny', request_id: alias.id });
  const pause = await h.waiting(job);
  assert.equal(pause.grant, `running "node test.js" in ${work}`);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: pause.id });
  while (!job.waiting && !job.endedAt) await h.jobs.wait(job.id, job.seq, 1000);
  assert.ok(job.waiting, 'The retargeted symlink should ask for approval');
  assert.equal(job.waiting.grant, first.grant);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting.id });
  await h.ended(job);
  assert.deepEqual(JSON.parse(job.report!), {
    'command-1-0': 'allow_once', 'command-2-0': 'allow_once', 'command-2-1': 'reject_once', 'command-3-0': 'reject_once',
  });
});

test('granting a queued command compares directories at the time of approval', { timeout: 5000, skip: posixOnly }, async (t) => {
  const work = commandDirectory(t);
  const original = commandDirectory(t);
  const replacement = commandDirectory(t);
  const link = path.join(work, 'link');
  fs.symlinkSync(original, link);
  const h = harness(t, commandServer([
    [command('npm test', original), command(`cd ${link} && npm test`)],
    [command('npm test --watch', original)],
  ]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const first = await h.waiting(job);
  while (!h.jobs.eventsFor(job.id, 0).some((e) => e.detail.includes('Batch 1 sent'))) await h.jobs.wait(job.id, job.seq, 1000);
  fs.unlinkSync(link);
  fs.symlinkSync(replacement, link);
  await h.jobs.reply(job.id, { decision: 'allow_for_job', request_id: first.id });
  while (!job.waiting && !job.endedAt) await h.jobs.wait(job.id, job.seq, 1000);
  assert.ok(job.waiting, 'The queued request now points to a different directory');
  assert.equal(job.waiting.grant, `running "npm test" in ${link}`);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: job.waiting.id });
  await h.ended(job);
  assert.deepEqual(JSON.parse(job.report!), {
    'command-1-0': 'allow_once', 'command-1-1': 'reject_once', 'command-2-0': 'allow_once',
  });
});

test('on Windows no command offers a job grant', { timeout: 5000, skip: process.platform !== 'win32' }, async (t) => {
  const h = harness(t, commandServer([[command('npm test')]]));
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const request = await h.waiting(job);
  assert.equal(request.grant, undefined);
  await h.jobs.reply(job.id, { decision: 'deny', request_id: request.id });
  await h.ended(job);
});

test('a read-only Antigravity job refuses commands without offering a grant', { timeout: 5000 }, async (t) => {
  const h = harness(t, commandServer([[command('npm test'), command('npm run lint')]]));
  const job = await h.ended(await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test', ask: true }));
  assert.deepEqual(JSON.parse(job.report!), { 'command-1-0': 'reject_once', 'command-1-1': 'reject_once' });
  assert.ok(!h.jobs.eventsFor(job.id, 0).some((e) => e.kind === 'waiting' || e.detail.startsWith('allowed for this job:')));
});

for (const report of ['empty', 'narration', 'message', 'earlier'] as const) test(`a lead decline handles the Antigravity report (${report})`, { timeout: 5000 }, async (t) => {
  // agy 1.5.9 refuses a prompt while a permission is open and ends a rejected turn with no text.
  const h = harness(t, `
    const send = (message) => console.log(JSON.stringify({ jsonrpc: '2.0', ...message }));
    const report = ${JSON.stringify(report)};
    const update = (update) => send({ method: 'session/update', params: { sessionId: 's1', update } });
    const text = (text) => update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    let promptId, open = false, prompts = 0;
    require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
      const { method, id, params, result } = JSON.parse(line);
      if (method === 'initialize') send({ id, result: { agentCapabilities: {} } });
      else if (method === 'session/new') send({ id, result: { sessionId: 's1' } });
      else if (method === 'session/prompt') {
        if (open) return send({ id, error: { code: -32603, message: 'the running prompt is waiting for a permission or question answer' } });
        if (++prompts === 1) {
          promptId = id; open = true;
          if (report === 'narration') {
            text('I will deploy now.');
            update({ sessionUpdate: 'tool_call', title: 'Deploy' });
          }
          send({ id: 'p', method: 'session/request_permission', params: { sessionId: 's1', toolCall: { kind: 'execute', title: 'Deploy', rawInput: { CommandLine: 'make deploy' } }, options: [{ kind: 'allow_once', optionId: 'yes' }, { kind: 'reject_once', optionId: 'no' }] } });
          if (report === 'empty') {
            send({ id: 'form', method: 'elicitation/create', params: { sessionId: 's1', mode: 'form', requestedSchema: ${JSON.stringify(FORM)} } });
            update({ sessionUpdate: 'tool_call', title: 'Both requests are open' });
          }
        } else {
          text(params.prompt[0].text);
          send({ id, result: { stopReason: 'end_turn' } });
        }
      } else if (id === 'p') {
        open = false;
        if (report === 'message' || report === 'earlier') text('The original report');
        if (report === 'earlier') update({ sessionUpdate: 'tool_call', title: 'Read the result' });
        send({ id: promptId, result: { stopReason: result.outcome.optionId === 'no' ? 'end_turn' : 'refusal' } });
      }
    });
  `);
  const job = await h.jobs.create({ kind: 'delegate', cwd: h.home, isolation: 'in_place', task: 'test' });
  const request = await h.waiting(job);
  if (report === 'empty') {
    const queued = () => h.jobs.eventsFor(job.id, 0).some((e) => e.detail.includes('Both requests are open'));
    while (!queued()) await h.jobs.wait(job.id, job.seq, 1000);
  }
  await assert.rejects(h.jobs.reply(job.id, { decision: 'decline', request_id: request.id }), /message with the reason/);
  await h.jobs.reply(job.id, { decision: 'decline', message: 'Deploying is outside the task. Report the build result instead.', request_id: request.id });
  await h.ended(job);
  const note = `The lead declined an action: ${request.reason}\nReason: Deploying is outside the task. Report the build result instead.\nDo it another way within the task, or report what could not be done.`;
  assert.equal(job.state, 'done');
  assert.equal(job.report, report === 'message' || report === 'earlier' ? 'The original report' : note);
  assert.equal(job.waiting, null);
  if (report === 'empty') {
    const events = h.jobs.eventsFor(job.id, 0);
    const question = events.findIndex((e) => e.kind === 'waiting' && e.detail.includes('Which color'));
    const resumed = events.findIndex((e) => e.kind === 'progress' && e.detail === 'resumed');
    const ended = events.findIndex((e) => e.kind === 'done');
    assert.ok(question >= 0 && resumed > question && ended > resumed);
  }
  assert.equal(job.turns, 1);
  assert.equal(job.declinedTurn, job.turns);
  assert.deepEqual(job.notes, [note]);
});
