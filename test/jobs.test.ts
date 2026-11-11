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
  return { adapter, jobs, calls, events, attention, home };
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
  assert.equal(job.worktree?.branch, `crew-${job.id}`);
  // The main tree is untouched until the lead merges.
  assert.equal(fs.existsSync(path.join(repo, 'new.js')), false);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo }).toString(), '');

  // Outside the repository, so tools that walk the repo never see the copy.
  const worktree = job.worktree!.path;
  assert.equal(worktree.startsWith(repo), false);
  await jobs.discard(job.id);
  assert.equal(fs.existsSync(worktree), false);
});

test('gitignored files listed in .worktreeinclude are copied into the worktree, and stay out of the commit', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
  fs.writeFileSync(path.join(repo, '.worktreeinclude'), '# deps and secrets\nnode_modules/\n.env\nnotes.txt\n');
  execFileSync('git', ['add', '-A'], { cwd: repo });
  execFileSync('git', ['commit', '-qm', 'ignore'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(repo, '.env'), 'KEY=1\n');
  // Listed but not gitignored: copying it would put it in the worker's commit.
  fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');

  let seen: string[] = [];
  const { jobs } = harness((ctl) => {
    seen = ['node_modules/pkg/index.js', '.env', 'notes.txt'].filter((f) => fs.existsSync(path.join(ctl.job.cwd, f)));
    ctl.done('ok');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  assert.deepEqual(seen, ['node_modules/pkg/index.js', '.env']);
  assert.deepEqual(job.result?.files, []);
  assert.match(job.notes.join(' '), /Copied from \.worktreeinclude: .*node_modules/);
});

test('an edit the worker reports outside its worktree is listed as out of scope', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    ctl.touched(path.join(ctl.job.cwd, 'README.md'));
    ctl.touched(path.join(repo, 'app.js'));
    ctl.done('done');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'] }));
  assert.deepEqual(job.result?.outOfScope, [path.join(repo, 'app.js')]);
});

test('a job belongs to the project of the session that started it', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => ctl.done('ok'));
  const review = { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const };
  const own = await jobs.create({ kind: 'review', cwd: repo, project: '/work/site', review });
  const fallback = await jobs.create({ kind: 'review', cwd: repo, review });
  assert.equal(own.project, '/work/site');
  assert.equal(fallback.project, repo);
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
  await waiting.jobs.reply(job.id, { decision: 'approve', request_id: job.waiting!.id });
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

test('a worktree job can be continued as soon as its result is published', async () => {
  const repo = tempRepo();
  let worker!: JobCtl;
  const { jobs, calls } = harness((ctl) => { worker = ctl; });
  const job = await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' });
  const published = jobs.wait(job.id, job.seq, 2000);
  worker.done('first report');
  await published;
  assert.equal(job.state, 'done');
  await jobs.reply(job.id, { message: 'follow up' });
  await settled(jobs, job);
  assert.deepEqual(calls, ['reply:follow up']);
});

test('jobs left running by a previous bridge are restored as failed but resumable', async () => {
  const repo = tempRepo();
  const first = harness(() => {});
  const job = await first.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } });
  await first.jobs.wait(job.id, 0, 100);
  first.jobs.flush();
  // As saved by a bridge from before jobs recorded their project.
  const file = path.join(first.home, 'jobs.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.jobs[0].project;
  fs.writeFileSync(file, JSON.stringify(saved));

  const second = new Jobs(first.home, config, {} as never, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  const restored = second.get(job.id);
  assert.equal(restored.state, 'failed');
  assert.equal(restored.sessionId, 'session-1');
  assert.equal(restored.project, repo);
});

test('the history limit does not hide old worktrees or undelivered jobs after a restart', async () => {
  const repo = tempRepo();
  const first = harness((ctl) => ctl.done('ok'));
  const job = await settled(first.jobs, await first.jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const worktree = job.worktree!;
  first.jobs.markDelivered(job.id, job.seq);
  first.jobs.jobs.set('unread', { ...job, id: 'unread', worktree: null, delivered: 0 });
  for (let i = 0; i < 201; i++) {
    const id = `history-${i}`;
    first.jobs.jobs.set(id, { ...job, id, worktree: null, createdAt: job.createdAt + i + 1 });
  }
  first.jobs.flush();
  const second = new Jobs(first.home, config, {} as never, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  assert.equal(second.list().length, 202);
  assert.equal(second.get('unread').delivered, 0);
  await second.discard(job.id);
  assert.equal(fs.existsSync(worktree.path), false);
  assert.equal(execFileSync('git', ['branch', '--list', worktree.branch], { cwd: repo }).toString(), '');
});

test('an approval from before a restart cannot settle a new request at the same event sequence', async () => {
  const repo = tempRepo();
  let worker!: JobCtl;
  const first = harness((ctl) => { worker = ctl; });
  const job = await first.jobs.create({ kind: 'delegate', cwd: repo, isolation: 'in_place', task: 'x' });
  first.jobs.flush();
  worker.progress('checking');
  worker.waiting('approval', 'echo before restart');
  const stale = job.waiting!;
  const adapter = { ...first.adapter, reply: async (ctl: JobCtl) => ctl.waiting('approval', 'echo after restart') };
  const second = new Jobs(first.home, config, { codex: adapter, antigravity: adapter }, {
    onEvent: () => {}, onJob: () => {}, onAttention: () => {},
  });
  const resumed = await second.reply(job.id, { message: 'continue' });
  assert.equal(resumed.seq, job.seq);
  await assert.rejects(second.reply(job.id, { decision: 'approve', request_id: stale.id }), /no longer pending/);
  assert.equal(resumed.state, 'waiting');
  await second.reply(job.id, { decision: 'deny', request_id: resumed.waiting!.id });
  assert.deepEqual(first.calls, ['answer:false']);
  first.jobs.flush();
  second.flush();
});

test('discard can resume after worktree removal succeeds and branch removal fails', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => ctl.done('ok'));
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const worktree = job.worktree!;
  const lock = path.join(repo, '.git', 'refs', 'heads', `${worktree.branch}.lock`);
  fs.writeFileSync(lock, '');
  try {
    await assert.rejects(jobs.discard(job.id), /git branch/);
    assert.equal(fs.existsSync(worktree.path), false);
    assert.equal(job.worktree, worktree);
  } finally {
    fs.unlinkSync(lock);
  }
  await jobs.discard(job.id);
  assert.equal(job.worktree, null);
  assert.equal(execFileSync('git', ['branch', '--list', worktree.branch], { cwd: repo }).toString(), '');
});

test('a worktree can be created when the repository already has a branch named crew', async () => {
  const repo = tempRepo();
  execFileSync('git', ['branch', 'crew'], { cwd: repo });
  const { jobs } = harness((ctl) => ctl.done('ok'));
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  assert.equal(job.state, 'done');
});

test('the bridge commit works without a git identity and ignores signing settings', async () => {
  const repo = tempRepo();
  execFileSync('git', ['config', '--unset', 'user.name'], { cwd: repo });
  execFileSync('git', ['config', '--unset', 'user.email'], { cwd: repo });
  // Signing would need a key and a passphrase prompt; with useConfigOnly, git refuses to guess an identity.
  execFileSync('git', ['config', 'commit.gpgsign', 'true'], { cwd: repo });
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.useConfigOnly', GIT_CONFIG_VALUE_0: 'true' };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const { jobs } = harness((ctl) => {
      fs.writeFileSync(path.join(ctl.job.cwd, 'new.js'), 'export const y = 2;\n');
      ctl.done('ok');
    });
    const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
    assert.equal(job.state, 'done', job.error?.message);
    assert.ok(job.result?.commit);
    const author = execFileSync('git', ['log', '-1', '--format=%an <%ae>', job.worktree!.branch], { cwd: repo }).toString().trim();
    assert.equal(author, 'Crew <crew@localhost>');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
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
