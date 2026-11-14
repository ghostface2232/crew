import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { addNews, Delivery, HOOK_SECONDS, jsonBytes, LEAD_BYTES, OFFER_MS, textPage, unread, WATCH_MS, WATCH_REPLACE_MS } from '../plugin/bridge/delivery.ts';
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
  t.after(() => { jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  const create = (lead: string | undefined = 'lead') => jobs.create({ kind: 'delegate', cwd: home, task: 'test', ask: true, lead: lead === 'board' ? undefined : lead });
  return { jobs, home, create, workers, delivery: jobs.delivery,
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

test('stalls and progress are not news; completion remains offerable', async (t) => {
  const h = harness(t);
  const job = await h.create();
  job.activeAt = 0;
  (h.jobs as any).checkStalls();
  assert.equal(job.stalled, true);
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
  assert.throws(() => h.delivery.ack('lead', [old.receipt, 'unknown']), /receipt/);
  assert.equal(job.ackedSeq, 0);
  h.delivery.ack('lead', old.receipt);
  assert.deepEqual(unread(job).map((n) => n.seq), [2]);
  h.delivery.ack('lead', old.receipt);
  assert.equal(job.ackedSeq, 1);
  const next = h.delivery.offer('lead')!;
  h.delivery.state.receipts[next.receipt].items[0].newsSeq = 999999;
  assert.throws(() => h.delivery.ack('lead', next.receipt), /revision/);
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
  assert.equal(board.ackedSeq, 0);
  assert.ok(board.seq > board.delivered);
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

test('watch hook ignores tool output, waits after losing an offer, and releases on exit', async () => {
  const calls: string[] = [];
  let polls = 0;
  const request = (async (_method: string, route: string, body: any) => {
    assert.equal(body.session, 'lead');
    calls.push(route);
    if (route.endsWith('/watch')) return { watch: { generation: 'g' } };
    if (route.endsWith('/offer')) return { offer: ++polls === 1 ? null : { text: 'news' } };
    return {};
  }) as typeof api;
  const result = await leadHook({ session_id: 'lead', hook_event_name: 'PostToolUse' }, 'watch', request);
  assert.deepEqual(result, { code: 2, stderr: 'news' });
  assert.equal(polls, 2);
  assert.equal(calls.at(-1), '/api/lead/release');
  assert.ok(!calls.some((call) => call.includes('ack')));
});

test('sync Stop guards continuation; subagents never arm a lead watcher; context is not an offer', async () => {
  const calls: string[] = [];
  const request = (async (_method: string, route: string) => { calls.push(route); return { text: 'news ids' }; }) as typeof api;
  assert.deepEqual(await leadHook({ session_id: 'lead', stop_hook_active: true }, 'stop', request), { code: 0 });
  assert.deepEqual(await leadHook({ session_id: 'lead', agent_id: 'child' }, 'watch', request), { code: 0 });
  assert.deepEqual(calls, []);
  const context = await leadHook({ session_id: 'lead', hook_event_name: 'UserPromptSubmit' }, 'context', request);
  assert.equal(JSON.parse(context.stdout!).hookSpecificOutput.additionalContext, 'news ids');
  assert.deepEqual(calls, ['/api/lead/context']);
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
  const context = vm.createContext({
    URL, PORT: 0, stopping: false, guard: () => {}, signedIn: (req: any) => req.auth,
    WORKER_ROUTE: /^\/api\/jobs\/[\w-]+\/(?:questions|siblings|browser)$/,
    HttpError: class extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } },
    readJson: async (req: any) => { reads++; if (req.stopDuringBody) context.stopping = true; return req.body; },
    jobs: h.jobs, view: (job: unknown) => job, broadcast: () => {},
    claude: { sessions: new Map(), ingest: () => { ingested++; } }, locate: () => {},
  });
  const route = vm.runInContext(`${stripTypeScriptTypes(handler)}; route`, context);
  for (const action of ['context', 'watch', 'heartbeat', 'release', 'offer', 'ack']) {
    await assert.rejects(route({ method: 'POST', url: `/api/lead/${action}`, body: { session: 'lead', ack: receipt } }, {}), /unauthorized/);
  }
  assert.equal(reads, 0, 'authentication happens before reading a notification body');
  await route({ method: 'POST', url: '/api/hooks/claude', body: { session_id: 'lead', ack: receipt } }, {});
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
