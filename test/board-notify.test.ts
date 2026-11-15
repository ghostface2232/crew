import assert from 'node:assert/strict';
import { test } from 'node:test';
import { planNotifications } from '../plugin/board/src/notify.ts';
import type { BoardJob, ClaudeSession, Snapshot } from '../plugin/board/src/types.ts';

const options = { onDone: true };
const job = (values: Partial<BoardJob> = {}) => ({
  id: 'cx-1', agent: 'codex', title: 'Build the board', state: 'running', turns: 1, waiting: null, ...values,
}) as BoardJob;
const snapshot = (jobs: BoardJob[] = [], claude: ClaudeSession[] = []) => ({ jobs, claude }) as Snapshot;
const waiting = (id: string) => job({ state: 'waiting', waiting: { id, type: 'question', reason: 'Which branch?', since: 1 } });

test('the first snapshot and newly discovered completed jobs do not replay completions', () => {
  const first = planNotifications({}, snapshot([job({ state: 'done' })]), options);
  assert.deepEqual(first.show, []);
  const next = planNotifications(first.memory, snapshot([job({ state: 'done' }), job({ id: 'cx-old', state: 'done' })]), options);
  assert.deepEqual(next.show, []);
});

test('a newly completed job shows once and its notice never expires', () => {
  const first = planNotifications({}, snapshot([job()]), options);
  const done = planNotifications(first.memory, snapshot([job({ state: 'done' })]), options);
  assert.deepEqual(done.show, [{ key: 'done:cx-1:1', title: 'Codex finished', body: 'Build the board', jobId: 'cx-1' }]);
  assert.equal(first.memory.done?.size, 0);
  const repeat = planNotifications(done.memory, snapshot([job({ state: 'done' })]), options);
  assert.deepEqual(repeat.show, []);
  assert.deepEqual(planNotifications(repeat.memory, snapshot(), options).expire, []);
  const resumed = planNotifications(repeat.memory, snapshot([job()]), options);
  assert.deepEqual(planNotifications(resumed.memory, snapshot([job({ state: 'done' })]), options).show, []);
  const nextTurn = planNotifications(repeat.memory, snapshot([job({ state: 'done', turns: 2 })]), options);
  assert.equal(nextTurn.show[0].key, 'done:cx-1:2');
});

test('completion tracking advances even while done notifications are disabled', () => {
  const first = planNotifications({}, snapshot([job()]), options);
  const done = planNotifications(first.memory, snapshot([job({ state: 'done' })]), { onDone: false });
  assert.deepEqual(done.show, []);
  assert.deepEqual(planNotifications(done.memory, snapshot([job({ state: 'done' })]), options).show, []);
});

test('waiting requests show once, change with request id, and expire when answered', () => {
  const first = planNotifications({}, snapshot([waiting('a')]), options);
  assert.deepEqual(first.show, [{ key: 'cx-1:a', title: 'Codex needs your input', body: 'Which branch?', jobId: 'cx-1' }]);
  const repeat = planNotifications(first.memory, snapshot([waiting('a')]), options);
  assert.deepEqual(repeat.show, []);
  const next = planNotifications(repeat.memory, snapshot([waiting('b')]), options);
  assert.equal(next.show[0].key, 'cx-1:b');
  assert.deepEqual(next.expire, ['cx-1:a']);
  const answered = planNotifications(next.memory, snapshot([job()]), options);
  assert.deepEqual(answered.expire, ['cx-1:b']);
  assert.equal(answered.memory.waiting?.size, 0);
  assert.equal(planNotifications(answered.memory, snapshot([waiting('b')]), options).show.length, 1);
});

test('waiting sessions use their id and reason, fall back to title, and expire', () => {
  const session = { id: 'lead', state: 'waiting', waitingFor: 'Approve?', title: 'Lead session' } as ClaudeSession;
  const first = planNotifications({}, snapshot([], [session]), options);
  assert.deepEqual(first.show, [{ key: 'session:lead:Approve?', title: 'Claude needs your input', body: 'Approve?', jobId: 'session:lead' }]);
  assert.deepEqual(planNotifications(first.memory, snapshot([], [session]), options).show, []);
  const next = planNotifications(first.memory, snapshot([], [{ ...session, waitingFor: null }]), options);
  assert.deepEqual(next.expire, ['session:lead:Approve?']);
  assert.deepEqual(next.show, [{ key: 'session:lead:', title: 'Claude needs your input', body: 'Lead session', jobId: 'session:lead' }]);
  assert.deepEqual(planNotifications(next.memory, snapshot([], [{ ...session, state: 'idle' }]), options).expire, ['session:lead:']);
});
