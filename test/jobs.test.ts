import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { Jobs, outOfScope } from '../plugin/bridge/jobs.ts';
import type { Adapter, CrewEvent, Job, JobCtl } from '../plugin/bridge/jobs.ts';

const config = { stallSeconds: 300, notify: false, notifyOnDone: false, codex: { bin: 'codex', approvalPolicy: 'never' as const }, antigravity: { bin: 'agy', enabled: true } };

function tempRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-test-')));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  fs.writeFileSync(path.join(dir, 'app.js'), 'export const x = 1;\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  return dir;
}

/** Adapter whose behavior each test scripts through `onStart`. */
function harness(onStart: (ctl: JobCtl) => void) {
  const calls: string[] = [];
  const adapter: Adapter = {
    start: async (ctl) => {
      ctl.session('session-1');
      onStart(ctl);
    },
    reply: async (ctl, message) => {
      calls.push(`reply:${message}`);
      ctl.done('second report');
    },
    answer: async (ctl, approve) => {
      calls.push(`answer:${approve}`);
      ctl.resumed();
      ctl.done('after decision');
    },
    cancel: async () => {
      calls.push('cancel');
    },
    shutdown: () => {},
  };
  const events: CrewEvent[] = [];
  const attention: string[] = [];
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  const jobs = new Jobs(home, config, { codex: adapter, antigravity: adapter }, {
    onEvent: (e) => events.push(e),
    onJob: () => {},
    onAttention: (_job, kind) => attention.push(kind),
  });
  return { jobs, calls, events, attention, home };
}

async function settled(jobs: Jobs, job: Job): Promise<Job> {
  while (job.state === 'running') await jobs.wait(job.id, job.seq, 2000);
  return job;
}

test('delegate runs in a worktree and commits the result on its branch', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'new.js'), 'export const y = 2;\n');
    ctl.done('built it');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'Add y' }));

  assert.equal(job.state, 'done');
  assert.equal(job.report, 'built it');
  assert.deepEqual(job.result?.files, ['new.js']);
  assert.ok(job.result?.commit);
  assert.equal(job.worktree?.branch, `crew/${job.id}`);
  // The main tree is untouched until the lead merges.
  assert.equal(fs.existsSync(path.join(repo, 'new.js')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString(), '');

  await jobs.discard(job.id);
  assert.equal(fs.existsSync(path.join(repo, '.crew', 'worktrees', job.id)), false);
});

test('polish reports files changed outside the allowed targets', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'Hello.\n');
    fs.writeFileSync(path.join(ctl.job.cwd, 'app.js'), 'export const x = 2;\n');
    ctl.done('polished');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'] }));
  assert.deepEqual(job.result?.outOfScope, ['app.js']);
});

test('a waiting job resumes on a decision and reports the limit kind on failure', async () => {
  const repo = tempRepo();
  const waiting = harness((ctl) => ctl.waiting('approval', 'run: npm install'));
  const job = await waiting.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } });
  await waiting.jobs.wait(job.id, 0, 2000);
  assert.equal(job.state, 'waiting');
  assert.deepEqual(waiting.attention, ['waiting']);
  await waiting.jobs.reply(job.id, { decision: 'approve' });
  await settled(waiting.jobs, job);
  assert.equal(job.state, 'done');
  assert.deepEqual(waiting.calls, ['answer:true']);

  const limited = harness((ctl) => ctl.fail('usage limit reached', { limit: true }));
  const failed = await settled(limited.jobs, await limited.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.equal(failed.state, 'failed');
  assert.equal(limited.events.at(-1)?.kind, 'limit');
});

test('a finished job can be continued, and delivery is claimed once', async () => {
  const repo = tempRepo();
  const { jobs, calls } = harness((ctl) => ctl.done('first report'));
  const job = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.equal(jobs.markDelivered(job.id, job.seq), true);
  assert.equal(jobs.markDelivered(job.id, job.seq), false);

  await jobs.reply(job.id, { message: 'also check the tests' });
  await settled(jobs, job);
  assert.deepEqual(calls, ['reply:also check the tests']);
  assert.equal(job.report, 'second report');
  assert.equal(job.turns, 2);
});

test('jobs left running by a previous bridge are restored as failed but resumable', async () => {
  const repo = tempRepo();
  const first = harness(() => {});
  const job = await first.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } });
  await first.jobs.wait(job.id, 0, 100);
  first.jobs.flush();

  const second = new Jobs(first.home, config, {} as never, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  const restored = second.get(job.id);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.sessionId, 'session-1');
});

test('delegate outside a git repository explains how to proceed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-plain-'));
  const { jobs } = harness(() => {});
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: dir, task: 'x' }), /in_place/);
});

test('outOfScope accepts exact files, directories, and globs', () => {
  const files = ['docs/a.md', 'src/ui/strings.ts', 'src/core/logic.ts'];
  assert.deepEqual(outOfScope(files, ['docs', 'src/ui/strings.ts']), ['src/core/logic.ts']);
  assert.deepEqual(outOfScope(files, ['**/*.md', 'src/ui/']), ['src/core/logic.ts']);
  assert.deepEqual(outOfScope(files, []), []);
});
