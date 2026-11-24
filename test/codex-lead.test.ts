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
  assert.deepEqual(saved?.hosts, { 'codex-thread': 'codex' });

  await leads.pass(1);
  assert.equal(queued.length, 1);
  assert.equal(queued[0][0], 'codex-thread');
  assert.match(queued[0][1], /cx-aaaaaa/);
  assert.doesNotMatch(queued[0][1], /["%\r\n]/);
  assert.doesNotMatch(queued[0][1], /cx-bbbbbb/);

  // Within the offer lease nothing is queued again, and the pass waits for the lease to end.
  assert.equal(await leads.pass(OFFER_MS - 5_000), 5_001);
  assert.equal(queued.length, 1);
  // One retry after the lease, then the budget is spent and the news waits for the lead's next call.
  await leads.pass(OFFER_MS + 2);
  await leads.pass(2 * OFFER_MS + 3);
  assert.equal(queued.length, 2);

  // Acknowledged news is not waiting any more.
  const receipt = delivery.offer('codex-thread', {}, 2 * OFFER_MS + 4)!.receipt;
  delivery.ack('codex-thread', receipt);
  assert.deepEqual(delivery.codexWaiting(), []);
});

test('a failed queue command leaves the news for a later wake', async () => {
  const jobs = [job('cx-cccccc', 'thread')];
  addNews(jobs[0], 'failed', 'Broke.');
  const delivery = new Delivery(() => jobs, () => {});
  delivery.host('thread', 'codex');
  let tries = 0;
  const leads = new CodexLeads(delivery, async () => { tries++; throw new Error('codex queue failed'); });
  await leads.pass(0);
  await leads.pass(OFFER_MS + 1);
  assert.equal(tries, 2);
  assert.equal(jobs[0].news![0].acked, false);
});

test('the Codex lead hosts survive a restart, and the note names each subject once', () => {
  const delivery = new Delivery(() => [], () => {});
  delivery.restore({ receipts: {}, offering: {}, hosts: { thread: 'codex' } });
  assert.deepEqual({ ...delivery.state.hosts }, { thread: 'codex' });
  assert.equal(note({ receipt: 'r', text: '', items: [{ jobId: 'cx-1', newsSeq: 1 }, { jobId: 'cx-1', newsSeq: 2 }, { jobId: 'pr-2', newsSeq: 1 }] }),
    'Crew has news for cx-1, pr-2. Call the Crew status tool to read it, then act on it.');
});
