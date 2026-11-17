import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AntigravityAdapter, decide, formAnswer, formQuestions } from '../plugin/bridge/adapters/antigravity.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Job } from '../plugin/bridge/jobs.ts';
import { pickEffort } from '../plugin/bridge/tiers.ts';
import { writeFakeBin } from './fake-bin.ts';

/**
 * An ACP server that records what Crew sends in `log.jsonl` beside it. It offers thinking levels per model as
 * agy 1.5.9 does, and ends each turn with `report`, or with the answer to `form` when one is given.
 */
function server(options: { append?: boolean; form?: unknown } = {}): string {
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
        send({ id, result: { sessionId: 's1', ...config() } });
      }
      else if (method === 'session/resume') send({ id, result: config() });
      else if (method === 'session/set_config_option') {
        if (params.configId === 'model') { model = params.value; if (!levels[model].includes(level)) level = 'medium'; }
        else level = params.value;
        send({ id, result: config() });
      } else if (method === 'session/prompt') {
        promptId = id;
        if (options.form) send({ id: 'form', method: 'elicitation/create', params: { sessionId: 's1', mode: 'form', message: 'The agent has a question.', requestedSchema: options.form } });
        else { send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'report' } } } }); send({ id, result: { stopReason: 'end_turn' } }); }
      } else if (method === 'session/cancel') send({ id: promptId, result: { stopReason: 'cancelled' } });
      else if (id === 'form') {
        send({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: JSON.stringify(message.result) } } } });
        send({ id: promptId, result: { stopReason: 'end_turn' } });
      } else if (id !== undefined && method) send({ id, error: { code: -32601, message: method } });
    });
  `;
}

function harness(t: test.TestContext, source: string, roles: Parameters<typeof resolveConfig>[0]['roles'] = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-agy-test-'));
  const bin = path.join(home, 'agy');
  writeFakeBin(bin, source);
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
    [{ decision: 'approve' }, { action: 'accept', content: { q1_other: 'Yes' } }],
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

for (const report of ['empty', 'message', 'earlier'] as const) test(`a lead decline handles the Antigravity report (${report})`, { timeout: 5000 }, async (t) => {
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
        if (report !== 'empty') text('The original report');
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
  assert.equal(job.report, report === 'empty' ? note : 'The original report');
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
