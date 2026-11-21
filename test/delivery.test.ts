import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { addNews, Delivery, HOOK_SECONDS, jsonBytes, LEAD_BYTES, OFFER_MS, PRESENT_MS, textPage, unread, WATCH_MS, WATCH_REPLACE_MS } from '../plugin/bridge/delivery.ts';
import { Pulls } from '../plugin/bridge/pulls.ts';
import { ClaudeSessions } from '../plugin/bridge/claude.ts';
import { leadHook } from '../plugin/bridge/wake.ts';
import type { api } from '../plugin/bridge/client.ts';

function harness(t: TestContext) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-delivery-'));
  const workers = new Map<string, JobCtl>();
  const adapter: Adapter = {
    start: async (ctl) => { workers.set(ctl.job.id, ctl); },
    reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown: () => {},
  };
  const config = resolveConfig({ notify: false });
  const hooks = { onJob: () => {}, onEvent: () => {}, onAttention: () => {} };
  const jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks);
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const create = (lead: string | undefined = 'lead') => jobs.create({ kind: 'delegate', cwd: home, task: 'test', ask: true, lead: lead === 'board' ? undefined : lead });
  return { jobs, home, create, workers, adapter, delivery: jobs.delivery,
    restore: () => new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, hooks) };
}

test('offer then death before output, main tool completion, and context injection do not ACK', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'Pick the contract.');
  const offer = h.delivery.offer('lead', { automatic: true })!;
  const sessions = new ClaudeSessions(300, { onSession() {}, onEvent() {}, onAttention() {} });
  sessions.ingest({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'Read' });
  assert.match(h.delivery.context('lead'), new RegExp(job.id));
  assert.equal(job.ackedSeq, 0);
  assert.equal(job.news![0].offers, 1);
  assert.equal(h.delivery.offer('lead', { automatic: true }), null);
  h.delivery.ack('lead', offer.receipt);
  assert.equal(job.ackedSeq, 1);
  assert.equal(job.delivered, job.seq);
});

test('a surviving watcher recovers an expired offering lease; new receipts do not reset budgets', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'Question');
  const now = Date.now();
  const watcher = h.delivery.watch('lead', now + 100_000, now)!;
  const first = h.delivery.offer('lead', { automatic: true }, now)!;
  assert.equal(h.delivery.offer('lead', { automatic: true, watcher: watcher.generation }, now + 1), null);
  const second = h.delivery.offer('lead', { automatic: true, watcher: watcher.generation }, now + OFFER_MS + 1)!;
  assert.notEqual(first.receipt, second.receipt);
  assert.equal(job.news![0].offers, 2);
  assert.equal(h.delivery.offer('lead', { automatic: true }, now + OFFER_MS * 2 + 2), null);
  const explicit = h.delivery.offer('lead', {}, now + OFFER_MS * 2 + 2)!;
  assert.ok(explicit);
  assert.equal(job.news![0].offers, 2);
  h.delivery.ack('lead', first.receipt);
  assert.equal(job.ackedSeq, 1, 'a receipt remains valid after its offering lease expires');
});

test('watching leases are idempotent, bounded by hook lifetime, and fence old generations', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'q');
  const now = Date.now();
  const first = h.delivery.watch('lead', now + WATCH_MS, now)!;
  assert.equal(h.delivery.watch('lead', now + 100_000, now + 1), null);
  assert.equal(h.delivery.heartbeat('lead', first.generation, now + 1000).expiresAt, first.deadline);
  const near = first.deadline - WATCH_REPLACE_MS;
  const second = h.delivery.watch('lead', near + 100_000, near)!;
  assert.notEqual(first.generation, second.generation);
  assert.throws(() => h.delivery.heartbeat('lead', first.generation, near), /Watcher lease/);
  assert.throws(() => h.delivery.release('lead', first.generation, near), /Watcher lease/);
  assert.throws(() => h.delivery.offer('lead', { watcher: first.generation }, near), /Watcher lease/);
  assert.throws(() => h.delivery.watch('lead', now + (HOOK_SECONDS + 1) * 1000, now), /deadline/);
  const replacement = h.delivery.watch('lead', near + 200_000, second.expiresAt + 1)!;
  assert.ok(replacement, 'a dead watcher does not hold the lease forever');
});

test('a stall the agent vouches for and progress are not news; completion remains offerable', async (t) => {
  const h = harness(t);
  h.adapter.probe = async () => ({ verdict: 'working', detail: 'still going' });
  const job = await h.create();
  job.activeAt = 0;
  (h.jobs as any).checkStalls();
  assert.equal(job.stalled, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(job.stalled, false);
  assert.equal(job.newsSeq, 0);
  assert.equal(h.delivery.offer('lead', { automatic: true }), null);
  h.workers.get(job.id)!.progress('working again');
  assert.equal(job.newsSeq, 0);
  h.workers.get(job.id)!.done('finished');
  while (!job.endedAt) await h.jobs.wait(job.id, job.seq, 100);
  assert.equal(job.newsSeq, 1);
  assert.equal(h.delivery.offer('lead', { automatic: true })!.items[0].newsSeq, 1);
});

test('ACK validates session and receipt and never consumes a newer or omitted item', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'old');
  const old = h.delivery.offer('lead')!;
  h.jobs.ask(job.id, 'new');
  assert.throws(() => h.delivery.ack('other', old.receipt), /session/);
  // An unknown id beside a valid one is reported, not allowed to block it.
  assert.deepEqual(h.delivery.ack('lead', [old.receipt, 'unknown']), ['unknown']);
  assert.deepEqual(unread(job).map((n) => n.seq), [2]);
  h.delivery.ack('lead', old.receipt);
  assert.equal(job.ackedSeq, 1);
  const next = h.delivery.offer('lead')!;
  h.delivery.state.receipts[next.receipt].items[0].newsSeq = 999999;
  assert.throws(() => h.delivery.ack('lead', next.receipt), /no longer owns/);
  assert.equal(job.ackedSeq, 1);
});

test('board jobs remain unowned and another session cannot offer the owner news', async (t) => {
  const h = harness(t);
  const board = await h.create('board');
  const owner = await h.create('owner');
  h.jobs.ask(board.id, 'board question');
  h.jobs.ask(owner.id, 'owner question');
  assert.equal(h.delivery.offer('other', { ids: [owner.id, board.id] }), null);
  const offer = h.delivery.offer('owner')!;
  assert.deepEqual(offer.items.map((i) => i.jobId), [owner.id]);
  h.delivery.ack('owner', offer.receipt);
  assert.equal(board.lead, undefined);
  // No lead owns it, so its news is settled at once instead of waiting for an echo that cannot come.
  assert.deepEqual(unread(board), []);
  assert.equal(board.delivered, board.seq);

  // A session that acts on the job through a Crew call takes it over; its next news goes to that session.
  assert.deepEqual(h.delivery.adopt('owner', [board.id, owner.id]), [board.id]);
  h.jobs.ask(board.id, 'after adoption');
  assert.deepEqual(h.delivery.offer('owner', { ids: [board.id] })!.items.map((i) => i.jobId), [board.id]);
  assert.throws(() => h.delivery.adopt('owner', 'cx-1' as never), /job_ids/);
});

test('restart recovery produces persisted failure news and preserves receipts and attempt budgets', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'before restart');
  const first = h.delivery.offer('lead', { automatic: true })!;
  const watch = h.delivery.watch('lead', Date.now() + 100_000)!;
  const restored = h.restore();
  const recovered = restored.get(job.id);
  assert.equal(recovered.state, 'failed');
  assert.equal(recovered.newsSeq, 2);
  assert.equal(recovered.news![0].offers, 1);
  assert.throws(() => restored.delivery.heartbeat('lead', watch.generation), /Watcher lease/);
  restored.delivery.ack('lead', first.receipt);
  assert.equal(recovered.ackedSeq, 1);
  assert.deepEqual(unread(recovered).map((n) => n.kind), ['failed']);
  const saved = JSON.parse(fs.readFileSync(path.join(h.home, 'jobs.json'), 'utf8'));
  assert.equal(saved.jobs[0].newsSeq, 2);
});

test('save failures never claim a successful offer or ACK and rollback attempt counts', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'question');
  let failing = true;
  const delivery = new Delivery(() => h.jobs.list(), () => { if (failing) throw new Error('disk full'); });
  assert.throws(() => delivery.offer('lead', { automatic: true }), /disk full/);
  assert.equal(job.news![0].offers, 0);
  assert.equal(Object.keys(delivery.state.receipts).length, 0);
  assert.equal(Object.keys(delivery.state.offering).length, 0);
  failing = false;
  const offer = delivery.offer('lead', { automatic: true })!;
  failing = true;
  assert.throws(() => delivery.ack('lead', offer.receipt), /disk full/);
  assert.equal(job.ackedSeq, 0);
  assert.equal(job.news![0].acked, false);
  assert.equal(delivery.state.receipts[offer.receipt].acknowledged, undefined);
  failing = false;
  delivery.ack('lead', offer.receipt);
  assert.equal(job.ackedSeq, 1);
});

test('Jobs persistence errors propagate through offers and ACKs without changing the saved ledger', async (t) => {
  const h = harness(t);
  const job = await h.create('__proto__');
  h.jobs.ask(job.id, 'persist me');
  const file = path.join(h.home, 'jobs.json');
  const before = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => h.delivery.offer('__proto__', { automatic: true }), /EISDIR/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  fs.rmdirSync(`${file}.tmp`);
  const offer = h.delivery.offer('__proto__')!;
  const offered = fs.readFileSync(file, 'utf8');
  fs.mkdirSync(`${file}.tmp`);
  assert.throws(() => h.delivery.ack('__proto__', offer.receipt), /EISDIR/);
  assert.equal(job.ackedSeq, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), offered);
  fs.rmdirSync(`${file}.tmp`);
  h.delivery.ack('__proto__', offer.receipt);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).jobs[0].ackedSeq, 1);
});

test('digests bound serialized bytes and count; only rendered news is offered and acknowledged', async (t) => {
  const h = harness(t);
  const job = await h.create();
  for (let i = 0; i < 20; i++) h.jobs.ask(job.id, `${i} "\\\n한😀`.repeat(80));
  const offer = h.delivery.offer('lead', { automatic: true, bytes: 1800 })!;
  assert.ok(jsonBytes(offer.text) <= 1800);
  assert.ok(offer.items.length > 0 && offer.items.length < 20 && offer.items.length <= 8);
  assert.equal(job.news!.filter((n) => n.offers === 1).length, offer.items.length);
  h.delivery.ack('lead', offer.receipt);
  assert.equal(unread(job).length, 20 - offer.items.length);
  assert.ok(jsonBytes({ content: [{ type: 'text', text: offer.text }] }) < LEAD_BYTES);
});

test('a new turn cannot rewrite the previous news snapshot', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.workers.get(job.id)!.session('worker-session');
  h.workers.get(job.id)!.fail('first failure');
  const before = structuredClone(job.news![0]);
  await h.jobs.reply(job.id, { message: 'try again' });
  assert.equal(job.state, 'running');
  assert.equal(job.error, null);
  assert.deepEqual(job.news![0], before);
  assert.match(h.delivery.offer('lead')!.text, /FAILED.*first failure/);
});

test('report pages reconstruct escaped Unicode text without splitting surrogate pairs', () => {
  const text = '"\\\n한😀'.repeat(5000);
  let restored = '';
  while (restored.length < text.length) {
    const page = textPage(text, restored.length, 2800);
    assert.ok(page.length > 0);
    assert.ok(jsonBytes(page) <= 2800);
    assert.ok(!/[\uD800-\uDBFF]$/.test(page));
    restored += page;
  }
  assert.equal(restored, text);
});

test('watch hook adopts the jobs its Crew call showed, waits after losing an offer, and releases on exit', async () => {
  const calls: string[] = [];
  let polls = 0;
  const request = (async (_method: string, route: string, body: any) => {
    assert.equal(body.session, 'lead');
    calls.push(route);
    if (route.endsWith('/watch')) return { watch: { generation: 'g' } };
    if (route.endsWith('/offer')) return { offer: ++polls === 1 ? null : { text: 'news' } };
    return {};
  }) as typeof api;
  const adopted: unknown[] = [];
  const recording = (async (method: 'GET' | 'POST', route: string, body: any) => {
    if (route.endsWith('/adopt')) adopted.push(body.job_ids);
    return request(method, route, body);
  }) as typeof api;
  // A started job is taken over; an id the response only quotes is not, since another session may own it.
  const result = await leadHook({ session_id: 'lead', hook_event_name: 'PostToolUse', tool_name: 'mcp__plugin_crew_crew__review',
    tool_response: [{ type: 'text', text: '[cx-0a1b2c] Codex · review · DONE\n[cx-0a1b2c] again, [ag-ffffff]' }] }, 'watch', recording);
  assert.deepEqual(result, { code: 2, stderr: 'news' });
  assert.deepEqual(adopted, [['cx-0a1b2c']]);
  assert.equal(polls, 2);
  assert.equal(calls.at(-1), '/api/lead/release');
  assert.ok(!calls.some((call) => call.includes('ack')));
});

test('sync Stop guards continuation; subagents never arm a lead watcher; context is not an offer', async () => {
  const calls: string[] = [];
  const bodies: any[] = [];
  const request = (async (_method: string, route: string, body: unknown) => { calls.push(route); bodies.push(body); return { text: 'news ids' }; }) as typeof api;
  assert.deepEqual(await leadHook({ session_id: 'lead', stop_hook_active: true }, 'stop', request), { code: 0 });
  assert.deepEqual(await leadHook({ session_id: 'lead', agent_id: 'child' }, 'watch', request), { code: 0 });
  assert.deepEqual(calls, []);
  const context = await leadHook({ session_id: 'lead', hook_event_name: 'UserPromptSubmit' }, 'context', request);
  assert.equal(JSON.parse(context.stdout!).hookSpecificOutput.additionalContext, 'news ids');
  assert.deepEqual(calls, ['/api/lead/context']);
  // The daemon adds the follow-up reminder only for this event.
  assert.equal(bodies[0].event, 'UserPromptSubmit');
});

test('notification routes require authentication; hook ingestion cannot ACK; shutdown fences delayed delivery', async (t) => {
  const h = harness(t);
  const job = await h.create();
  h.jobs.ask(job.id, 'question');
  const receipt = h.delivery.offer('lead')!.receipt;
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function isOpen('), source.indexOf('\nlet stopping = false;'));
  let reads = 0;
  let ingested = 0;
  const appeared: string[] = [];
  const context = vm.createContext({
    URL, PORT: 0, stopping: false, guard: () => {}, signedIn: (req: any) => req.auth,
    WORKER_ROUTE: /^\/api\/jobs\/[\w-]+\/(?:questions|siblings|browser)$/,
    HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
    readJson: async (req: any) => { reads++; if (req.stopDuringBody) context.stopping = true; return req.body; },
    jobs: h.jobs, view: (job: unknown) => job, broadcast: () => {},
    claude: { sessions: new Map(), ingest: () => { ingested++; } }, locate: () => {},
    missions: { followUpHint: (session: string) => `hint for ${session}`, resumeText: (session: string) => `plan of ${session}`, finish: (id: string, input: unknown) => ({ id, input }) },
    pulls: { list: () => [], tick: async (session: string) => { appeared.push(session); } },
  });
  const route = vm.runInContext(`${stripTypeScriptTypes(handler)}; route`, context);
  for (const action of ['context', 'watch', 'heartbeat', 'release', 'offer', 'ack']) {
    await assert.rejects(route({ method: 'POST', url: `/api/lead/${action}`, body: { session: 'lead', ack: receipt } }, {}), /unauthorized/);
  }
  assert.equal(reads, 0, 'authentication happens before reading a notification body');
  // Only a user's prompt carries the follow-up reminder, after any news.
  assert.match((await route({ method: 'POST', url: '/api/lead/context', auth: true, body: { session: 'lead', event: 'UserPromptSubmit' } }, {})).text, new RegExp(`${job.id}[^]*\\nhint for lead$`));
  // A session that starts, resumes or is compacted is shown its open missions again; a prompt is not.
  const started = (await route({ method: 'POST', url: '/api/lead/context', auth: true, body: { session: 'lead', event: 'SessionStart' } }, {})).text;
  assert.match(started, new RegExp(`${job.id}[^]*\\nplan of lead$`));
  assert.doesNotMatch(started, /hint/);
  assert.doesNotMatch((await route({ method: 'POST', url: '/api/lead/context', auth: true, body: { session: 'lead', event: 'UserPromptSubmit' } }, {})).text, /plan of/);
  // Its pull requests are read when it appears, not again with each of its calls.
  assert.deepEqual(appeared, ['lead']);
  await route({ method: 'POST', url: '/api/hooks/claude', auth: true, body: { session_id: 'lead', hook_event_name: 'SessionEnd' } }, {});
  assert.equal(h.delivery.present('lead'), false);
  await route({ method: 'POST', url: '/api/lead/context', auth: true, body: { session: 'lead' } }, {});
  assert.deepEqual(appeared, ['lead', 'lead']);
  ingested = 0;
  // Only the lead's own done marks a mission done by the lead; the board's does not.
  assert.equal((await route({ method: 'POST', url: '/api/missions/m-1', auth: true, body: { done: true, by: 'lead' } }, {})).input.byLead, true);
  assert.equal((await route({ method: 'POST', url: '/api/missions/m-1', auth: true, body: { done: true } }, {})).input.byLead, false);
  // A hook's report is taken as the user's own words, so it needs the secret like the rest.
  await assert.rejects(route({ method: 'POST', url: '/api/hooks/claude', body: { session_id: 'lead', ack: receipt } }, {}), /unauthorized/);
  assert.equal(ingested, 0);
  await route({ method: 'POST', url: '/api/hooks/claude', auth: true, body: { session_id: 'lead', ack: receipt } }, {});
  assert.equal(ingested, 1);
  assert.equal(job.ackedSeq, 0);
  await assert.rejects(route({ method: 'POST', url: '/api/lead/ack', auth: true, body: { session: 'other', ack: receipt } }, {}), /session/);
  await assert.rejects(route({ method: 'POST', url: '/api/lead/ack', auth: true, stopDuringBody: true, body: { session: 'lead', ack: receipt } }, {}), /shutting down/);
  assert.equal(job.ackedSeq, 0);
  context.stopping = false;
  await route({ method: 'POST', url: '/api/lead/ack', auth: true, body: { session: 'lead', ack: receipt } }, {});
  assert.equal(job.ackedSeq, 1);
});

test('the receipt store stays bounded, dropping acknowledged receipts before recent unacknowledged ones', () => {
  const job = { id: 'cx-1', lead: 'lead', seq: 1, delivered: 0, state: 'done', turns: 1 } as Job;
  addNews(job, 'done', 'finished');
  const delivery = new Delivery(() => [job], () => {});
  const now = Date.now();
  for (let i = 0; i < 600; i++) {
    delivery.state.receipts[`old-${i}`] = { session: 'lead', items: [], text: '', acknowledged: i % 2 === 0, at: now - 1000 * (600 - i) };
  }
  const offer = delivery.offer('lead', { ids: ['cx-1'] }, now)!;
  const kept = Object.keys(delivery.state.receipts);
  assert.ok(kept.includes(offer.receipt));
  assert.equal(kept.length, 500);
  // Only acknowledged receipts were dropped, oldest first; every unacknowledged one is still there to echo.
  assert.equal(kept.filter((id) => id.startsWith('old-') && !delivery.state.receipts[id].acknowledged).length, 300);
  assert.ok(!kept.includes('old-0') && kept.includes('old-598'));
});

test('a watcher with no daemon to talk to ends at once instead of living out its hook', async () => {
  let calls = 0;
  const down = (async () => { calls++; throw new Error('connect ECONNREFUSED 127.0.0.1:47615'); }) as typeof api;
  const started = Date.now();
  assert.deepEqual(await leadHook({ session_id: 'lead', hook_event_name: 'Stop' }, 'watch', down, Date.now() + 60_000), { code: 0 });
  assert.ok(Date.now() - started < 1000);
  assert.equal(calls, 1);
});

test('a watcher that died without releasing is replaced once it stops beating', () => {
  const delivery = new Delivery(() => [], () => {});
  const now = Date.now();
  const first = delivery.watch('lead', now + 3_600_000, now)!;
  assert.equal(delivery.watch('lead', now + 3_600_000, now + 10_000), null, 'a live watcher is not duplicated');
  const second = delivery.watch('lead', now + 3_600_000, now + 30_000);
  assert.ok(second && second.generation !== first.generation);
  assert.throws(() => delivery.heartbeat('lead', first.generation, now + 31_000), /expired or replaced/);
});

test('a watcher whose long poll was cut off is replaced at once, as after its session process was ended', async (t) => {
  const h = harness(t);
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('function isOpen('), source.indexOf('\nlet stopping = false;'));
  const context = vm.createContext({
    URL, AbortController, PORT: 0, stopping: false, guard: () => {}, signedIn: () => true, WORKER_ROUTE: /^$/,
    HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
    readJson: async (req: any) => req.body, jobs: h.jobs, view: (job: unknown) => job, broadcast: () => {}, pulls: { tick: async () => {} },
  });
  const route = vm.runInContext(`${stripTypeScriptTypes(handler)}; route`, context);
  const lead = (action: string, body: object, res: object = {}) => route({ method: 'POST', url: `/api/lead/${action}`, body: { session: 'lead', ...body } }, res);
  const deadline = Date.now() + 3_600_000;
  const { watch } = await lead('watch', { deadline });
  assert.equal((await lead('watch', { deadline })).watch, null, 'a live watcher is not duplicated');
  // The app ending the lead's process closes the watcher's connection mid-poll; the lease used to block for 25 s.
  const res = new EventEmitter();
  const poll = lead('offer', { automatic: true, generation: watch.generation, wait: true }, res);
  // Close once the poll is waiting, after the body has been read.
  await new Promise((resolve) => setImmediate(resolve));
  res.emit('close');
  assert.equal((await poll).offer, null);
  const resumed = (await lead('watch', { deadline })).watch;
  assert.ok(resumed && resumed.generation !== watch.generation);
  await assert.rejects(lead('heartbeat', { generation: watch.generation }), /expired or replaced/);
  // A poll cut off for a watcher that lives on costs it nothing while no one replaced it.
  const other = new EventEmitter();
  const cut = lead('offer', { automatic: true, generation: resumed.generation, wait: true }, other);
  await new Promise((resolve) => setImmediate(resolve));
  other.emit('close');
  await cut;
  assert.ok((await lead('heartbeat', { generation: resumed.generation })).watch);
});

test('the wake hook takes over only the jobs a call named, never those a listing showed', async () => {
  const adopted: unknown[] = [];
  const request = (async (_method: string, route: string, body: any) => {
    if (route.endsWith('/adopt')) adopted.push(body.job_ids);
    if (route.endsWith('/watch')) return { watch: null };
    return {};
  }) as typeof api;
  const list = [{ type: 'text', text: 'Active:\n[cx-111111] Codex · delegate · running\nRecent:\n[ag-222222] Antigravity · polish · done' }];
  await leadHook({ session_id: 'lead', tool_name: 'mcp__plugin_crew_crew__status', tool_input: {}, tool_response: list }, 'watch', request);
  await leadHook({ session_id: 'lead', tool_name: 'mcp__plugin_crew_crew__wait', tool_input: { job_ids: ['cx-333333', 'not an id'] }, tool_response: list }, 'watch', request);
  await leadHook({ session_id: 'lead', tool_name: 'mcp__plugin_crew_crew__reply', tool_input: { job_id: 'cx-444444' }, tool_response: list }, 'watch', request);
  assert.deepEqual(adopted, [['cx-333333'], ['cx-444444']]);
});

test('a watched pull request\'s news is offered, acknowledged and saved beside the jobs\', and names its mission', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-delivery-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const adapter: Adapter = { start: async () => {}, reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown: () => {} };
  const config = resolveConfig({ notify: false });
  let now = 1_000_000;
  let view = { url: 'https://github.com/o/r/pull/7', number: 7, title: 'T', state: 'OPEN', headRefOid: 'a'.repeat(40), mergeable: 'MERGEABLE', reviewDecision: '',
    author: { login: 'me' }, statusCheckRollup: [] as object[], reviews: [] };
  const start = () => {
    const pulls: Pulls = new Pulls({
      gh: async () => JSON.stringify(view), mission: () => ({ state: 'done', owner: 'lead', root: home }), present: (session) => jobs.delivery.present(session, now),
      save: () => jobs.flush(), changed: () => jobs.delivery.changed(), now: () => now,
    });
    const jobs: Jobs = new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, { onJob: () => {}, onEvent: () => {}, onAttention: () => {}, pulls });
    return { pulls, jobs };
  };
  const { pulls, jobs } = start();
  const { watch } = await pulls.link('m-1', '7');
  const job = await jobs.create({ kind: 'delegate', cwd: home, task: 'test', ask: true, lead: 'lead', mission: 'm-2' });
  jobs.ask(job.id, 'Which one?');
  // Nothing is read for a session that is not open; once its hooks call, it is, for a while.
  view = { ...view, statusCheckRollup: [{ __typename: 'CheckRun', name: 'test', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE' }] };
  now += 600_000;
  await pulls.tick();
  assert.equal(unread(watch).length, 0);
  assert.equal(jobs.delivery.touch('lead', now), true);
  assert.equal(jobs.delivery.touch('lead', now + 1), false, 'only its appearing is news');
  await pulls.tick('lead');
  assert.equal(unread(watch).length, 1);
  assert.equal(jobs.delivery.present('lead', now + PRESENT_MS + 1), false);
  const offer = jobs.delivery.offer('lead')!;
  assert.match(offer.text, new RegExp(`\\[${job.id}\\] news 1 · RUNNING · turn 1 · mission m-2 · question`));
  assert.match(offer.text, new RegExp(`\\[${watch.id}\\] news 1 · PR o/r#7 · mission m-1 · checks: o/r#7 at aaaaaaa failed checks: CI / test\\.`));
  assert.match(jobs.delivery.context('lead'), new RegExp(`${watch.id}#1`));
  // The receipt, the job's news and the watch's are one snapshot: a restart before the ACK offers both again.
  const again = start();
  assert.deepEqual(again.pulls.list().map((kept) => [kept.id, unread(kept).length]), [[watch.id, 1]]);
  assert.deepEqual(again.jobs.delivery.ack('lead', offer.receipt), []);
  assert.equal(unread(again.pulls.list()[0]).length, 0);
  assert.equal(again.jobs.get(job.id).ackedSeq, 1);
  assert.equal(start().pulls.list()[0].news![0].acked, true, 'the ACK reached the snapshot');
  // Another session can neither be offered a watch's news nor take it over as it would a job.
  assert.equal(again.jobs.delivery.offer('other'), null);
  assert.deepEqual(again.jobs.delivery.adopt('other', [watch.id]), []);
});

test('a mixed receipt survives restart after its watch news is acknowledged and more news arrives', async (t) => {
  const h = harness(t);
  const pulls = new Pulls({
    gh: async () => JSON.stringify({ url: 'https://github.com/o/r/pull/7', number: 7, title: 'T', state: 'OPEN',
      headRefOid: 'abc', mergeable: 'MERGEABLE', reviewDecision: '' }),
    mission: () => ({ state: 'active', owner: 'lead', root: '/project' }),
    present: () => true, save: () => {}, changed: () => {},
  });
  const { watch } = await pulls.link('m-1', '7');
  const job = await h.create();
  const delivery = new Delivery(() => [job], () => {}, () => pulls.list());
  addNews(job, 'done', 'job finished');
  addNews(watch, 'checks', 'first failure');
  const mixed = delivery.offer('lead')!;
  assert.equal(delivery.state.receipts[mixed.receipt].items.length, 2);
  for (let i = 0; i <= 20; i++) {
    if (i) addNews(watch, 'checks', `later failure ${i}`);
    const watchOnly = delivery.offer('lead', { ids: [watch.id] })!;
    assert.deepEqual(delivery.ack('lead', watchOnly.receipt), []);
  }

  pulls.restore(JSON.parse(JSON.stringify(pulls.saved(new Set([watch.id, job.id])))));
  const restored = new Delivery(() => [job], () => {}, () => pulls.list());
  restored.restore(JSON.parse(JSON.stringify(delivery.state)));
  assert.deepEqual(restored.ack('lead', mixed.receipt), []);
  assert.equal(unread(job).length, 0);
});

test('job creation validates a task against its mission before detaching ended missions', async () => {
  const source = fs.readFileSync(new URL('../plugin/bridge/daemon.ts', import.meta.url), 'utf8');
  const route = source.slice(source.indexOf("    if (pathname === '/api/jobs')"), source.indexOf("    if (pathname.startsWith('/api/lead/'))"));
  const mission = { id: 'm-1', state: 'done', tasks: [{ id: 'build' }] };
  const create = vm.runInNewContext(stripTypeScriptTypes(`(async (req: any) => { const pathname = '/api/jobs'; ${route} })`), {
    HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
    readJson: async (req: unknown) => req, missions: { list: () => [mission] },
    missionPreset: () => 'economy', liveConfig: () => ({}),
    jobs: { create: async (spec: unknown) => spec }, view: (job: unknown) => job,
  });
  await assert.rejects(create({ taskId: 'build' }), { status: 400, message: /task_id.*mission/ });
  await assert.rejects(create({ mission: mission.id, taskId: 'missing' }), { status: 400, message: /has no task "missing"/ });
  const ended = await create({ mission: mission.id, taskId: 'build', notes: ['prior note'] });
  assert.equal(ended.mission, undefined);
  assert.equal(ended.taskId, undefined);
  assert.equal(ended.preset, 'economy');
  assert.match(ended.notes.join('\n'), /prior note\n.*shown on its own\.\n.*task "build" was dropped/);
  mission.state = 'active';
  const active = await create({ mission: mission.id, taskId: 'build' });
  assert.equal(active.mission, mission.id);
  assert.equal(active.taskId, 'build');
});
