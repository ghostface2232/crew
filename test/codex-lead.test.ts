import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexLeads, note } from '../plugin/bridge/codex-lead.ts';
import { addNews, Delivery, OFFER_MS } from '../plugin/bridge/delivery.ts';
import type { DeliveryState } from '../plugin/bridge/delivery.ts';
import type { Job } from '../plugin/bridge/jobs.ts';

const job = (id: string, lead: string) => ({ id, lead, seq: 1, delivered: 0, state: 'done', turns: 1 } as Job);

test('a Codex lead is queued a one-line note under the automatic offer budget', async () => {
  const jobs = [job('cx-aaaaaa', 'codex-thread'), job('cx-bbbbbb', 'claude-session')];
  for (const item of jobs) addNews(item, 'done', 'Finished: "quoted" 100%\nsecond line');
  let saved: DeliveryState | undefined;
  const delivery = new Delivery(() => jobs, () => { saved = structuredClone(delivery.state); });
  const queued: [string, string][] = [];
  const leads = new CodexLeads(delivery, async (thread, message) => { queued.push([thread, message]); });

  // A session is woken through Codex only once it said Codex hosts it; a Claude session wakes itself.
  await leads.pass(0);
  assert.deepEqual(queued, []);
  delivery.host('codex-thread', 'codex');
  assert.deepEqual(Object.keys(saved?.hosts ?? {}), ['codex-thread']);

  await leads.pass(1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'codex-thread');
  assert.match(queued[0][1], /cx-aaaaaa/);
  assert.doesNotMatch(queued[0][1], /["%\r\n]/);
  assert.doesNotMatch(queued[0][1], /cx-bbbbbb/);

  // Within the offer lease nothing is queued again, and the pass waits for the lease to end.
  assert.equal(await leads.pass(OFFER_MS - 5_000), 5_001);
  assert.equal(queued.length, 1);
  // A queued note waits in Codex, so it is not sent again after the lease: the news waits for the lead's status call.
  await leads.pass(OFFER_MS + 2);
  await leads.pass(2 * OFFER_MS + 3);
  assert.equal(queued.length, 1);
  assert.equal(jobs[0].news![0].offers, 2);

  // Acknowledged news is not waiting any more.
  const receipt = delivery.offer('codex-thread', {}, 2 * OFFER_MS + 4)!.receipt;
  delivery.ack('codex-thread', receipt);
  assert.deepEqual(delivery.codexWaiting(), []);
});

test('failed queue commands back off and keep the news offerable until Codex takes a note', async () => {
  const jobs = [job('cx-cccccc', 'thread')];
  addNews(jobs[0], 'failed', 'Broke.');
  const delivery = new Delivery(() => jobs, () => {});
  delivery.host('thread', 'codex', 0);
  let tries = 0;
  const leads = new CodexLeads(delivery, async () => { if (++tries <= 2) throw new Error('codex queue failed'); });
  await leads.pass(1);
  assert.equal(jobs[0].news![0].offers, 0);
  // Backing off: 30 s after the first failure, then 60 s after the second.
  assert.equal(await leads.pass(OFFER_MS / 2), OFFER_MS / 2 + 1);
  assert.equal(tries, 1);
  await leads.pass(OFFER_MS + 1);
  assert.equal(tries, 2);
  await leads.pass(2 * OFFER_MS + 1);
  assert.equal(tries, 2);
  await leads.pass(3 * OFFER_MS + 2);
  assert.equal(tries, 3);
  assert.deepEqual([jobs[0].news![0].offers, jobs[0].news![0].acked], [2, false]);
});

test('a session inside a turn is queued no note until the turn ends, and keeps its offer budget', async () => {
  const jobs = [job('cx-111111', 'thread')];
  addNews(jobs[0], 'done', 'Done.');
  const delivery = new Delivery(() => jobs, () => {});
  delivery.host('thread', 'codex', 0);
  const queued: string[] = [];
  let busy = true;
  const leads = new CodexLeads(delivery, async (_thread, message) => { queued.push(message); }, () => busy);
  await leads.pass(1);
  assert.deepEqual(queued, []);
  assert.equal(jobs[0].news![0].offers, 0);
  busy = false;
  await leads.pass(2);
  assert.equal(queued.length, 1);
});

test('a note settles every snapshot it named, so none is queued again', async () => {
  const jobs = [job('cx-eeeeee', 'thread')];
  addNews(jobs[0], 'question', 'First.');
  addNews(jobs[0], 'done', 'Second.');
  const delivery = new Delivery(() => jobs, () => {});
  delivery.host('thread', 'codex', 0);
  const queued: string[] = [];
  const leads = new CodexLeads(delivery, async (_thread, message) => { queued.push(message); });
  await leads.pass(1);
  assert.deepEqual(jobs[0].news!.map((news) => news.offers), [2, 2]);
  await leads.pass(OFFER_MS + 2);
  assert.equal(queued.length, 1);
});

test('a Codex session keeps its record between its hello and its first job, and old idle records go', () => {
  const jobs: Job[] = [job('cx-dddddd', 'leading')];
  const delivery = new Delivery(() => jobs, () => {});
  const DAY = 86_400_000;
  delivery.restore({ receipts: {}, offering: {}, hosts: { leading: { host: 'codex', at: 0 }, stale: { host: 'codex', at: 0 }, bad: 'codex' as never } });
  assert.deepEqual(Object.keys(delivery.state.hosts!), ['leading', 'stale']);
  // A said hello and has yet to start a job when B says hello: A stays, so its first job can wake it.
  delivery.host('a', 'codex', 8 * DAY);
  delivery.host('b', 'codex', 8 * DAY + 1);
  assert.deepEqual(Object.keys(delivery.state.hosts!).sort(), ['a', 'b', 'leading']);
  jobs.push(job('cx-ffffff', 'a'));
  addNews(jobs[1], 'done', 'Done.');
  assert.deepEqual(delivery.codexWaiting(), ['a']);
  // A desktop thread stays known as one across later hellos, which need not say it again.
  assert.equal(delivery.desktopOf('a'), false);
  delivery.host('a', 'codex', 8 * DAY + 2, true);
  delivery.host('a', 'codex', 8 * DAY + 3);
  assert.equal(delivery.desktopOf('a'), true);
  assert.equal(delivery.desktopOf('b'), false);
});

test('the note names each subject once', () => {
  assert.equal(note({ receipt: 'r', text: '', items: [{ jobId: 'cx-1', newsSeq: 1 }, { jobId: 'cx-1', newsSeq: 2 }, { jobId: 'pr-2', newsSeq: 1 }] }),
    'Crew has news for cx-1, pr-2. Call the Crew status tool to read it, then act on it.');
});
