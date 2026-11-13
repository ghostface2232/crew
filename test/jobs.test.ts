import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveConfig } from '../plugin/bridge/config.ts';
import type { Config } from '../plugin/bridge/config.ts';
import { leadContext } from '../plugin/bridge/instructions.ts';
import { Jobs, outOfScope } from '../plugin/bridge/jobs.ts';
import type { Adapter, CrewEvent, Job, JobCtl, JobSpec, ReviewTarget } from '../plugin/bridge/jobs.ts';
import { describe } from '../plugin/bridge/render.ts';

const config = resolveConfig({ notify: false, codex: { bin: 'codex', approvalPolicy: 'never', approvalsReviewer: 'auto_review' } });

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
function harness(onStart: (ctl: JobCtl) => void, readConfig: () => Config = () => config) {
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
  const jobs = new Jobs(home, readConfig, { codex: adapter, antigravity: adapter }, {
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

for (const type of ['uncommittedChanges', 'baseBranch', 'commit'] as const) {
  test(`Antigravity refreshes ${type} review diffs on reply, including after a restart`, async () => {
    const repo = tempRepo();
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo }).toString().trim();
    git('branch', 'review-base');
    fs.writeFileSync(path.join(repo, 'README.md'), 'first change\n');
    if (type !== 'uncommittedChanges') {
      git('commit', '-qam', 'first change');
    }
    const target: ReviewTarget = type === 'baseBranch' ? { type, branch: 'review-base' }
      : type === 'commit' ? { type, sha: git('rev-parse', 'HEAD') } : { type };
    const reviewConfig = resolveConfig({ roles: { review: { agent: 'antigravity' } } });
    let worker!: JobCtl;
    const h = harness((ctl) => { worker = ctl; }, () => reviewConfig);
    const job = await h.jobs.create({ kind: 'review', cwd: repo, review: { target, mode: 'adversarial' } });
    const firstFile = path.join(h.home, 'reviews', `${job.id}.diff`);
    assert.match(fs.readFileSync(firstFile, 'utf8'), /\+first change/);
    let previousFile = firstFile;
    let expected = 'second change';
    h.adapter.reply = async (ctl, message) => {
      assert.match(message, /^Review again\.\n\n/);
      const file = /refreshed at `([^`]+)`/.exec(message)?.[1];
      assert.ok(file, message);
      assert.notEqual(file, previousFile);
      // Give cleanup from the previous turn a chance to run before reading the new artifact.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const diff = fs.readFileSync(file, 'utf8');
      assert.ok(diff.includes(`+${type === 'commit' ? 'first change' : expected}`), diff);
      if (type === 'commit') assert.ok(!diff.includes(expected), diff);
      previousFile = file;
      ctl.done('reviewed');
    };
    fs.writeFileSync(path.join(repo, 'README.md'), `${expected}\n`);
    if (type !== 'uncommittedChanges') git('commit', '-qam', expected);
    worker.done('first report');
    await h.jobs.reply(job.id, { message: 'Review again.' });
    assert.equal(job.state, 'done');
    h.jobs.flush();

    // The saved job keeps its original target and agent even if role assignments change.
    const restored = new Jobs(h.home, () => config, { codex: h.adapter, antigravity: h.adapter }, {
      onEvent: () => {}, onJob: () => {}, onAttention: () => {},
    });
    assert.deepEqual(restored.get(job.id).reviewTarget, target);
    assert.equal(restored.get(job.id).agent, 'antigravity');
    expected = 'third change';
    fs.writeFileSync(path.join(repo, 'README.md'), `${expected}\n`);
    if (type !== 'uncommittedChanges') git('commit', '-qam', expected);
    await restored.reply(job.id, { message: 'Review again.' });
    assert.equal(restored.get(job.id).state, 'done');
    assert.equal(restored.get(job.id).turns, 3);
    restored.flush();
  });
}

test('an unavailable review target fails before sending a follow-up, and old jobs require a new review', async () => {
  const repo = tempRepo();
  execFileSync('git', ['branch', 'review-base'], { cwd: repo });
  const h = harness((ctl) => ctl.done('reviewed'), () => resolveConfig({ roles: { review: { agent: 'antigravity' } } }));
  const job = await h.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'baseBranch', branch: 'review-base' }, mode: 'adversarial' } });
  execFileSync('git', ['branch', '-D', 'review-base'], { cwd: repo });
  await h.jobs.reply(job.id, { message: 'Review again.' });
  assert.equal(job.state, 'failed');
  assert.match(job.error!.message, /git diff:/);
  assert.deepEqual(h.calls, []);

  delete job.reviewTarget;
  h.jobs.flush();
  const restored = new Jobs(h.home, () => config, { codex: h.adapter, antigravity: h.adapter }, {
    onEvent: () => {}, onJob: () => {}, onAttention: () => {},
  });
  await assert.rejects(restored.reply(job.id, { message: 'Review again.' }), /Start a new review instead/);
  assert.equal(restored.get(job.id).state, 'failed');
  assert.deepEqual(h.calls, []);
});

test('preparing a review diff rejects overlapping replies and cancellation prevents the follow-up', async () => {
  const repo = tempRepo();
  const h = harness((ctl) => ctl.done('reviewed'), () => resolveConfig({ roles: { review: { agent: 'antigravity' } } }));
  const job = await h.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } });
  const pending = h.jobs.reply(job.id, { message: 'Review again.' });
  await assert.rejects(h.jobs.reply(job.id, { message: 'Another review.' }), /preparing its review diff/);
  await h.jobs.cancel(job.id);
  await pending;
  assert.equal(job.state, 'cancelled');
  assert.deepEqual(h.calls, ['cancel']);
  assert.equal(fs.existsSync(path.join(h.home, 'reviews', `${job.id}-2.diff`)), false);
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

  const second = new Jobs(first.home, () => config, {} as never, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
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
  const second = new Jobs(first.home, () => config, {} as never, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
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
  const second = new Jobs(first.home, () => config, { codex: adapter, antigravity: adapter }, {
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
    await jobs.round(job.id, 1, 'undo');
    assert.deepEqual(job.result!.files, []);
    await jobs.round(job.id, 1, 'keep');
    assert.deepEqual(job.result!.files, ['new.js']);
    await jobs.discard(job.id);
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

test('each role goes to the agent the role table names, with the model set for that role, and edits apply to the next job', async () => {
  const repo = tempRepo();
  let current = config;
  const { jobs } = harness((ctl) => ctl.done('ok'), () => current);

  const before = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'] }));
  assert.equal(before.agent, 'antigravity');
  assert.match(before.id, /^ag-/);

  current = resolveConfig({ roles: { polish: { agent: 'codex', model: 'small', effort: 'low' }, review: { agent: 'antigravity' } } });
  const polish = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'] }));
  assert.equal(polish.agent, 'codex');
  assert.match(polish.id, /^cx-/);
  assert.equal(polish.model, 'small');
  assert.equal(polish.effort, 'low');
  assert.match(polish.instructions, /Role: UX writing/);

  // A per-job override wins over the role's model.
  const override = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'], model: 'large' }));
  assert.equal(override.model, 'large');

  // Only Codex has a native review mode, so another reviewer gets the prompted review.
  const review = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'standard' } }));
  assert.equal(review.agent, 'antigravity');
  assert.equal(review.nativeReview, null);
  assert.equal(review.sandbox, 'read-only');
});

test('a role assigned to a disabled or unknown agent fails with the reason, and an unreadable config fails the job', async () => {
  const repo = tempRepo();
  let read = (): Config => resolveConfig({ antigravity: { bin: 'agy', enabled: false }, roles: { delegate: { agent: 'antigravity' } } });
  const { jobs } = harness((ctl) => ctl.done('ok'), () => read());
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }), /delegate is assigned to Antigravity, which is disabled/);

  assert.throws(() => resolveConfig({ roles: { review: { agent: 'cursor' as never } } }), /roles\.review\.agent is "cursor"; use one of: codex, antigravity/);
  // Unset roles keep their defaults.
  assert.deepEqual(resolveConfig({ roles: { polish: { model: 'm' } } }).roles, { delegate: { agent: 'codex' }, review: { agent: 'codex' }, polish: { agent: 'antigravity', model: 'm' } });

  // A table that is not exactly right must not quietly fall back to the defaults.
  const bad = (roles: unknown) => () => resolveConfig({ roles: roles as never });
  assert.throws(bad('codex'), /roles must be an object/);
  assert.throws(bad({ delegate: 'antigravity' }), /roles\.delegate must be an object/);
  assert.throws(bad({ delegate: null }), /roles\.delegate must be an object/);
  assert.throws(bad({ reviewer: { agent: 'codex' } }), /roles\.reviewer is not a role; use one of: delegate, review, polish/);
  assert.throws(bad({ review: { agent: 'codex', model: 5 } }), /roles\.review\.model must be a string/);
  assert.throws(bad({ review: { agnt: 'codex' } }), /roles\.review\.agnt is not a setting/);

  read = () => {
    throw new Error('Invalid config.json: bad');
  };
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }), /Invalid config\.json/);
  assert.equal(jobs.list().length, 0);
});

test('shared instructions reach every worker after its role, global then project, and name their sources', async () => {
  const repo = tempRepo();
  const { jobs, home } = harness((ctl) => ctl.done('ok'));

  const none = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.ok(!none.instructions.includes('Shared instructions'));
  assert.deepEqual(none.shared, []);

  const globalFile = path.join(home, 'instructions.md');
  const projectFile = path.join(repo, '.crew', 'instructions.md');
  fs.writeFileSync(globalFile, 'Prefer small diffs.\n');
  fs.mkdirSync(path.dirname(projectFile));
  // Not committed: the worktree does not contain it, yet the job must still be given it.
  fs.writeFileSync(projectFile, '\nUse tabs in this repository.\n');

  for (const spec of [
    { kind: 'delegate' as const, cwd: repo, task: 'x' },
    { kind: 'review' as const, cwd: repo, review: { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const } },
    { kind: 'polish' as const, cwd: repo, targets: ['README.md'] },
  ]) {
    const job = await settled(jobs, await jobs.create(spec));
    const text = job.instructions;
    const order = ['# Role:', '# Shared instructions', 'do not widen what the role allows', '## From the user, for every project\nPrefer small diffs.', '## From this repository (`.crew/instructions.md`)\nUse tabs in this repository.'].map((part) => text.indexOf(part));
    assert.ok(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1])), `${spec.kind}: ${text}`);
    assert.deepEqual(job.shared, [globalFile, projectFile]);
    // The assignment itself is unchanged; instructions travel on their own channel.
    assert.ok(!job.prompt.includes('Prefer small diffs'));
  }

  // An empty file is the same as none.
  fs.writeFileSync(globalFile, '  \n');
  const projectOnly = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  assert.deepEqual(projectOnly.shared, [projectFile]);
  assert.ok(!projectOnly.instructions.includes('for every project'));

  // A job started inside a linked worktree is given the main tree's file, which the worktree does not contain.
  const wt = path.join(home, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
  const fromWorktree = await settled(jobs, await jobs.create({ kind: 'review', cwd: wt, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.deepEqual(fromWorktree.shared, [projectFile]);
  // So is one started from a subdirectory.
  fs.mkdirSync(path.join(repo, 'sub'));
  const fromSub = await settled(jobs, await jobs.create({ kind: 'review', cwd: path.join(repo, 'sub'), review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.deepEqual(fromSub.shared, [projectFile]);
});

test('instructions that exist but cannot be read fail the job before anything is created', async () => {
  const repo = tempRepo();
  const { jobs, home } = harness((ctl) => ctl.done('ok'));
  fs.mkdirSync(path.join(home, 'instructions.md'));
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }), /Could not read .*instructions\.md/);
  assert.equal(jobs.list().length, 0);
  assert.equal(execFileSync('git', ['branch', '--list', 'crew-*'], { cwd: repo }).toString(), '');

  // A `.crew` that is a file holds no instructions; that is "none", not an error.
  fs.rmdirSync(path.join(home, 'instructions.md'));
  fs.writeFileSync(path.join(repo, '.crew'), 'not a directory');
  assert.deepEqual((await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }))).shared, []);
});

test('a Claude session is given each shared file whole, or told where it is, never a cut-off copy', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-project-'));
  assert.equal(leadContext(home, project), '');

  const globalFile = path.join(home, 'instructions.md');
  const projectFile = path.join(project, '.crew', 'instructions.md');
  fs.mkdirSync(path.dirname(projectFile));
  fs.writeFileSync(globalFile, 'Prefer small diffs.');
  const short = leadContext(home, project);
  assert.ok(short.includes('## From the user, for every project\nPrefer small diffs.') && short.includes('apply to this session too'), short);

  // Only the part that does not fit is replaced by its path; the short one still arrives whole.
  fs.writeFileSync(projectFile, 'x'.repeat(9_500));
  const mixed = leadContext(home, project);
  assert.ok(mixed.length < 9_000 && mixed.includes('Prefer small diffs.') && mixed.includes(`Too long to include here. The complete text is in ${projectFile}`) && !mixed.includes('xxxx'), mixed);
  fs.writeFileSync(projectFile, 'y'.repeat(8_000));
  assert.ok(leadContext(home, project).includes('y'.repeat(8_000)));

  // With the home directory as the project, the one file is given once.
  const asHome = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-user-'));
  fs.mkdirSync(path.join(asHome, '.crew'));
  fs.writeFileSync(path.join(asHome, '.crew', 'instructions.md'), 'ONCE');
  assert.equal(leadContext(path.join(asHome, '.crew'), asHome).match(/ONCE/g)?.length, 1);

  fs.rmSync(globalFile);
  fs.mkdirSync(globalFile);
  assert.match(leadContext(home, project), /could not load the shared instructions for this session\. Could not read .*instructions\.md/);
});

test('the session hook prints context for the event it was called for, from the main tree, and reports its own failures', () => {
  const repo = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  fs.mkdirSync(path.join(repo, '.crew'));
  fs.writeFileSync(path.join(repo, '.crew', 'instructions.md'), 'Use tabs.');
  const wt = path.join(home, 'wt');
  execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: repo });
  const hook = (stdin: string, env: Record<string, string> = {}) => {
    const out = execFileSync(process.execPath, [path.resolve('plugin/bridge/context.ts')], { input: stdin, env: { ...process.env, CREW_HOME: home, ...env } }).toString();
    return out ? JSON.parse(out).hookSpecificOutput : null;
  };

  const session = hook(JSON.stringify({ hook_event_name: 'SessionStart', source: 'compact', cwd: wt }));
  assert.equal(session.hookEventName, 'SessionStart');
  assert.ok(session.additionalContext.includes('Use tabs.'));
  assert.equal(hook(JSON.stringify({ hook_event_name: 'SubagentStart', cwd: path.join(repo, '.crew') })).hookEventName, 'SubagentStart');

  // Outside a repository, the session's project directory is used rather than wherever the cwd has moved to.
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-plain-'));
  fs.mkdirSync(path.join(plain, '.crew'));
  fs.mkdirSync(path.join(plain, 'sub'));
  fs.writeFileSync(path.join(plain, '.crew', 'instructions.md'), 'No repo here.');
  assert.ok(hook(JSON.stringify({ hook_event_name: 'SessionStart', cwd: path.join(plain, 'sub') }), { CLAUDE_PROJECT_DIR: plain }).additionalContext.includes('No repo here.'));

  // Nothing to say is silence; a broken call is said, with a valid event name.
  assert.equal(hook(JSON.stringify({ hook_event_name: 'SessionStart', cwd: os.tmpdir() }), { CLAUDE_PROJECT_DIR: os.tmpdir() }), null);
  const broken = hook('not json');
  assert.equal(broken.hookEventName, 'SessionStart');
  assert.match(broken.additionalContext, /could not load the shared instructions/);
});

test('a job carries its mission and starting notes, and is kept with a mission that is still kept', async () => {
  const repo = tempRepo();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-home-'));
  const adapter: Adapter = { start: async (ctl) => ctl.done('ok'), reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown: () => {} };
  const kept = new Set(['m-kept']);
  const make = () => new Jobs(home, () => config, { codex: adapter, antigravity: adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {}, keepsMission: (id) => kept.has(id) });
  const jobs = make();
  const review = { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const };

  const first = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review, mission: 'm-kept', notes: ['started under a mission'] }));
  assert.equal(first.mission, 'm-kept');
  assert.deepEqual(first.notes, ['started under a mission']);
  const dropped = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review, mission: 'm-gone' }));
  // Notes that are not a list of strings must not stop the job.
  const odd = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review, notes: 'not a list' as never }));
  assert.deepEqual(odd.notes, []);
  for (const job of [first, dropped, odd]) jobs.markDelivered(job.id, job.seq);

  // Push both past the history limit with newer finished jobs.
  for (let i = 0; i < 201; i++) {
    const job = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review }));
    jobs.markDelivered(job.id, job.seq);
  }
  jobs.flush();
  const reloaded = make();
  assert.ok(reloaded.jobs.has(first.id), 'the job of a kept mission survives the history limit');
  assert.ok(!reloaded.jobs.has(dropped.id));
});

test('a job that runs alone is refused while others are active, and holds off every other start until it ends', async () => {
  const repo = tempRepo();
  const running: JobCtl[] = [];
  const { jobs } = harness((ctl) => { running.push(ctl); });
  const review = { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const };
  const start = (exclusive?: boolean) => jobs.create({ kind: 'delegate', cwd: repo, task: 'measure', exclusive });
  const until = async (job: Job, state: Job['state']) => { while (job.state !== state) await jobs.wait(job.id, job.seq, 1000); };

  // Only an engineer can measure; the refusal comes before anything is created.
  await assert.rejects(jobs.create({ kind: 'review', cwd: repo, review, exclusive: true }), /A review job cannot run alone/);
  await assert.rejects(jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'], exclusive: true }), /A polish job cannot run alone/);
  assert.equal(jobs.list().length, 0);

  const ordinary = await start();
  await assert.rejects(start(true), new RegExp(`cannot start while 1 other job\\(s\\) are active: ${ordinary.id} \\(running\\)\\. Wait for a running job with wait`));
  // One that waits on the user will not end by waiting, and the refusal says so.
  running[0].waiting('approval', 'run tests?');
  await assert.rejects(start(true), new RegExp(`${ordinary.id} \\(waiting on the user\\)`));
  running[0].resumed();
  running[0].done('ok');
  await until(ordinary, 'done');

  // A start that fails gives its place back.
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: path.join(repo, 'missing'), task: 'x' }), /cwd does not exist/);

  // Two starts at once: the check happens before either is registered, yet only one gets through.
  const both = await Promise.allSettled([start(true), start()]);
  assert.deepEqual(both.map((r) => r.status), ['fulfilled', 'rejected']);
  const alone = (both[0] as PromiseFulfilledResult<Job>).value;
  assert.equal(alone.exclusive, true);
  assert.match(alone.instructions, /# Measurement\nThis job has the machine to itself/);
  assert.match(String((both[1] as PromiseRejectedResult).reason), /must run alone is starting right now\. Try again in a moment/);

  await assert.rejects(start(), new RegExp(`Job ${alone.id} \\(running\\) is measuring and has the machine to itself`));
  // A follow-up to a finished job would set its worker running again, so it waits too.
  await assert.rejects(jobs.reply(ordinary.id, { message: 'one more thing' }), /is measuring and has the machine to itself/);
  assert.equal(ordinary.state, 'done');

  running.at(-1)!.done('measured');
  await until(alone, 'done');
  const after = await start();
  assert.equal(after.exclusive, undefined);
  assert.ok(!after.instructions.includes('# Measurement'));
  // And the measuring job cannot take another turn while something else is active.
  await assert.rejects(jobs.reply(alone.id, { message: 'measure again' }), /cannot start while 1 other job/);
});

test('every worker is given the shared-machine rules, and a review is told to stay static in its instructions', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => ctl.done('ok'));
  const target = { type: 'uncommittedChanges' as const };

  const delegate = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const polish = await settled(jobs, await jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'] }));
  const prompted = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target, mode: 'adversarial' } }));
  // Codex's built-in review is sent no prompt, so what it must know has to be in the instructions.
  const native = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target, mode: 'standard' } }));
  assert.ok(native.nativeReview);
  for (const job of [delegate, polish, prompted, native]) {
    const text = job.instructions;
    // After the role, so the role still comes first, and saying that the role still decides.
    assert.ok(text.indexOf('# Role:') === 0 && text.indexOf('# This machine is shared') > 0, job.kind);
    assert.ok(text.includes('they allow nothing the role forbids'));
    assert.equal(text.includes('# Static review\nReview by reading, and by running checks that end by themselves'), job.kind === 'review', job.kind);
    assert.ok(!job.prompt.includes('Static review'));
  }

  // A reviewer that cannot run commands is not told to run checks.
  const reader = resolveConfig({ roles: { review: { agent: 'antigravity' } } });
  const other = harness((ctl) => ctl.done('ok'), () => reader);
  const handed = await settled(other.jobs, await other.jobs.create({ kind: 'review', cwd: repo, review: { target, mode: 'adversarial' } }));
  assert.match(handed.instructions, /# Static review\nReview by reading\. You cannot run anything in this role/);
  assert.ok(!handed.instructions.includes('Run only checks that end by themselves'));
});

test('a review that runs the app gets a snapshot of the change and leaves nothing behind', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const x = 2;\n');
  fs.mkdirSync(path.join(repo, 'lib'));
  fs.writeFileSync(path.join(repo, 'lib', 'new.js'), 'export const y = 3;\n');
  // The user's own diff settings must not change the patch the snapshot is built from.
  execFileSync('git', ['config', 'diff.noprefix', 'true'], { cwd: repo });
  const seen: Record<string, string> = {};
  const gone = async (job: Job) => {
    for (let tries = 0; job.worktree; tries++) {
      assert.ok(tries < 300, 'the snapshot was not removed');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const { jobs, adapter, calls } = harness((ctl) => {
    seen.cwd = ctl.job.cwd;
    seen.app = fs.readFileSync(path.join(ctl.job.cwd, 'app.js'), 'utf8');
    seen.untracked = fs.readFileSync(path.join(ctl.job.cwd, 'lib', 'new.js'), 'utf8');
    // Whatever the reviewer writes stays in the snapshot.
    fs.writeFileSync(path.join(ctl.job.cwd, 'scratch.txt'), 'x');
    ctl.done('reviewed');
  });
  const review = { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const };
  const job = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review, runsApp: true }));

  assert.notEqual(seen.cwd, repo);
  assert.equal(seen.app, 'export const x = 2;\n');
  assert.equal(seen.untracked, 'export const y = 3;\n');
  assert.equal(job.sandbox, 'workspace-write');
  assert.equal(job.result, null);
  assert.match(job.instructions, /# Running the app\n[^]*snapshot of the change/);
  assert.ok(!job.instructions.includes('# Static review'));
  await gone(job);
  assert.ok(!fs.existsSync(seen.cwd));
  assert.ok(!fs.existsSync(path.join(repo, 'scratch.txt')));
  assert.equal(execFileSync('git', ['branch', '--list', 'crew-*'], { cwd: repo, encoding: 'utf8' }), '');

  // A follow-up reviews the change as it is then, in a new snapshot.
  fs.writeFileSync(path.join(repo, 'app.js'), 'export const x = 4;\n');
  adapter.reply = async (ctl, message) => {
    calls.push(message);
    seen.again = fs.readFileSync(path.join(ctl.job.cwd, 'app.js'), 'utf8');
    ctl.done('reviewed again');
  };
  await jobs.reply(job.id, { message: 'look again' });
  assert.match(calls[0], /look again\n\nThe snapshot has been refreshed/);
  assert.equal(seen.again, 'export const x = 4;\n');
  await settled(jobs, job);
  await gone(job);
  assert.ok(!fs.existsSync(seen.cwd));
});

test('only a job that can run commands may run the app', async () => {
  const repo = tempRepo();
  const review = { target: { type: 'uncommittedChanges' as const }, mode: 'adversarial' as const };
  const { jobs } = harness((ctl) => ctl.done('ok'));
  await assert.rejects(jobs.create({ kind: 'polish', cwd: repo, targets: ['README.md'], runsApp: true }), /A polish job cannot run the app/);
  const delegate = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x', runsApp: true }));
  assert.equal(delegate.runsApp, true);
  assert.match(delegate.instructions, /# Running the app/);

  const reader = resolveConfig({ roles: { review: { agent: 'antigravity' } } });
  const other = harness((ctl) => ctl.done('ok'), () => reader);
  await assert.rejects(other.jobs.create({ kind: 'review', cwd: repo, review, runsApp: true }), /cannot run commands as a reviewer/);
});

test('a refused action goes back to the reviewer once, then to the user', async () => {
  const repo = tempRepo();
  const refuse = (ctl: JobCtl) => ctl.refused('rm -rf ~/cache', 'outside the workspace');
  const { jobs, adapter, calls } = harness((ctl) => {
    refuse(ctl);
    ctl.done('could not clean the cache');
  });
  const reviewers: boolean[] = [];
  adapter.reply = async (ctl, message) => {
    calls.push(message);
    reviewers.push(Boolean(ctl.job.asksUser));
    if (reviewers.length < 3) refuse(ctl);
    ctl.done('again');
  };
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'clean up' }));
  assert.deepEqual(job.refusals, [{ action: 'rm -rf ~/cache', reason: 'outside the workspace', turn: 1 }]);
  assert.match(describe(job), /REFUSED by Codex's automatic reviewer:\n  rm -rf ~\/cache\n  reason: outside the workspace\n.*without asking them again/);
  await assert.rejects(jobs.reply(job.id, { approved_by_user: ' ' }), /must quote what the user said/);

  await jobs.reply(job.id, { approved_by_user: 'delete the cache too' });
  await settled(jobs, job);
  assert.match(calls[0], /Their words in the lead session: "delete the cache too"\n\nRun the refused action again, exactly as before:\nrm -rf ~\/cache$/);
  assert.match(describe(job), /already sent back once/);

  await jobs.reply(job.id, { approved_by_user: 'delete the cache too', message: 'Then report.' });
  await settled(jobs, job);
  assert.match(calls[1], /Then report\.$/);
  // An ordinary follow-up is the automatic reviewer's again.
  await jobs.reply(job.id, { message: 'thanks' });
  await settled(jobs, job);
  assert.deepEqual(reviewers, [false, true, false]);
  // Nothing was refused in that last turn, so there is nothing to send back.
  await assert.rejects(jobs.reply(job.id, { approved_by_user: 'delete the cache too' }), /Nothing was refused in the last turn/);

  // A different action refused later starts with the automatic reviewer again.
  adapter.reply = async (ctl) => {
    ctl.refused('curl https://example.com', 'network');
    ctl.done('blocked');
  };
  await jobs.reply(job.id, { message: 'fetch the page' });
  await settled(jobs, job);
  assert.match(describe(job), /without asking them again/);
  // A retry turn that fails before the worker acts keeps the refusal, and the next retry is the user's.
  adapter.reply = async (ctl) => {
    reviewers.push(Boolean(ctl.job.asksUser));
    ctl.fail('server exited');
  };
  await jobs.reply(job.id, { approved_by_user: 'fetch it' });
  assert.equal(job.state, 'failed');
  assert.match(describe(job), /REFUSED[^]*curl https:\/\/example\.com[^]*already sent back once/);
  await jobs.reply(job.id, { approved_by_user: 'fetch it' });
  assert.deepEqual(reviewers.slice(3), [false, true]);
});

test('a follow-up sent while a job is being discarded is refused, not started in a removed worktree', async () => {
  const repo = tempRepo();
  const { jobs, calls } = harness((ctl) => ctl.done('built'));
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const discard = jobs.discard(job.id);
  await assert.rejects(jobs.reply(job.id, { message: 'one more thing' }), /is being discarded/);
  await discard;
  assert.equal(job.state, 'done');
  assert.equal(job.worktree, null);
  assert.deepEqual(calls, []);
});

for (const kind of ['delegate', 'polish'] as const) {
  test(`${kind} records each changing turn, and undo and keep recompute the branch result`, async () => {
    const repo = tempRepo();
    const { jobs, adapter, events, home } = harness((ctl) => {
      fs.writeFileSync(path.join(ctl.job.cwd, 'new.js'), 'export const y = 2;\n');
      ctl.done('first');
    });
    const job = await settled(jobs, await jobs.create({ kind, cwd: repo, task: 'x', targets: kind === 'polish' ? ['new.js'] : undefined }));
    const first = structuredClone(job.rounds![0]);
    assert.equal(first.turn, 1);
    assert.equal(first.commit, job.result!.commit);
    assert.deepEqual(first.files, ['new.js']);
    assert.match(first.stat, /1 file changed, 1 insertion/);
    assert.equal(first.state, 'kept');
    assert.ok(first.at >= job.createdAt && first.at <= Date.now());

    adapter.reply = async (ctl) => {
      fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'second turn\n');
      ctl.done('second');
    };
    await jobs.reply(job.id, { message: 'again' });
    await settled(jobs, job);
    assert.deepEqual(job.rounds!.map((round) => round.turn), [1, 2]);
    assert.deepEqual(job.rounds![0], first);
    assert.deepEqual(job.rounds![1].files, ['README.md']);
    assert.match(job.rounds![1].stat, /1 file changed, 1 insertion\(\+\), 1 deletion/);
    assert.deepEqual(job.result!.files, ['README.md', 'new.js']);
    assert.deepEqual(job.result!.outOfScope, kind === 'polish' ? ['README.md'] : []);

    adapter.reply = async (ctl) => ctl.done('no changes');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' });
    await jobs.reply(job.id, { message: 'check once more' });
    await settled(jobs, job);
    assert.equal(job.turns, 3);
    assert.equal(job.rounds!.length, 2);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' }), head);

    const seq = job.seq;
    assert.equal(await jobs.round(job.id, 2, 'undo'), job);
    assert.equal(fs.readFileSync(path.join(job.cwd, 'README.md'), 'utf8'), 'hello\n');
    assert.deepEqual(job.result!.files, ['new.js']);
    assert.match(job.result!.stat, /1 file changed, 1 insertion/);
    assert.deepEqual(job.result!.outOfScope, []);
    assert.equal(job.rounds![1].state, 'undone');
    assert.equal(job.rounds![1].revert, job.result!.commit);
    assert.equal(job.seq, seq + 1);
    assert.equal(events.at(-1)!.kind, 'progress');
    assert.equal(events.at(-1)!.job_id, job.id);
    assert.equal(events.at(-1)!.detail, 'round 2 undone');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'jobs.json'), 'utf8')).jobs[0].rounds, job.rounds);

    await jobs.round(job.id, 2, 'keep');
    assert.equal(fs.readFileSync(path.join(job.cwd, 'README.md'), 'utf8'), 'second turn\n');
    assert.equal(job.rounds![1].state, 'kept');
    assert.ok(!('revert' in job.rounds![1]));
    assert.deepEqual(job.result!.files, ['README.md', 'new.js']);
    assert.match(job.result!.stat, /2 files changed/);
    assert.deepEqual(job.result!.outOfScope, kind === 'polish' ? ['README.md'] : []);
    assert.equal(job.result!.commit, execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' }).trim());
    assert.equal(events.at(-1)!.detail, 'round 2 kept');

    await jobs.round(job.id, 1, 'undo');
    adapter.reply = async (ctl) => {
      assert.equal(fs.existsSync(path.join(ctl.job.cwd, 'new.js')), false);
      fs.writeFileSync(path.join(ctl.job.cwd, 'later.js'), 'later\n');
      ctl.done('continued after undo');
    };
    await jobs.reply(job.id, { message: 'continue' });
    await settled(jobs, job);
    assert.deepEqual(job.rounds!.map((round) => [round.turn, round.state]), [[1, 'undone'], [2, 'kept'], [4, 'kept']]);
    assert.deepEqual(job.rounds![2].files, ['later.js']);
    assert.deepEqual(job.result!.files, ['README.md', 'later.js']);
    await jobs.discard(job.id);
  });
}

test('round refusals leave the job and worktree unchanged', async () => {
  const repo = tempRepo();
  const { jobs, adapter, events } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'first\n');
    ctl.done('changed');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const snapshot = () => ({
    job: structuredClone(job), events: events.length,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' }),
    status: execFileSync('git', ['status', '--porcelain'], { cwd: job.cwd, encoding: 'utf8' }),
    file: fs.readFileSync(path.join(job.cwd, 'README.md'), 'utf8'),
  });
  const refuses = async (id: string, turn: number, action: 'undo' | 'keep', reason: RegExp) => {
    const before = snapshot();
    await assert.rejects(jobs.round(id, turn, action), reason);
    assert.deepEqual(snapshot(), before);
  };
  await refuses('missing', 1, 'undo', /No job with id/);
  await refuses(job.id, 99, 'undo', /no round for turn 99/);
  await refuses(job.id, 1, 'keep', /already kept/);
  await jobs.round(job.id, 1, 'undo');
  await refuses(job.id, 1, 'undo', /already undone/);
  await jobs.round(job.id, 1, 'keep');

  let worker!: JobCtl;
  adapter.reply = async (ctl) => { worker = ctl; };
  await jobs.reply(job.id, { message: 'continue' });
  await refuses(job.id, 1, 'undo', /still running/);
  worker.waiting('question', 'what next?');
  await refuses(job.id, 1, 'undo', /still waiting/);
  worker.resumed();
  worker.done('done');
  await settled(jobs, job);

  fs.writeFileSync(path.join(job.cwd, 'README.md'), 'uncommitted\n');
  await refuses(job.id, 1, 'undo', /uncommitted changes/);
  fs.writeFileSync(path.join(job.cwd, 'README.md'), 'first\n');

  const tree = job.worktree!;
  // A removed directory can leave the saved worktree record behind.
  execFileSync('git', ['worktree', 'remove', '--force', tree.path], { cwd: repo });
  const beforeMissing = structuredClone(job);
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /worktree is gone or discarded/);
  assert.deepEqual(job, beforeMissing);
  await jobs.discard(job.id);
  const beforeDiscarded = structuredClone(job);
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /worktree is gone or discarded/);
  assert.deepEqual(job, beforeDiscarded);
});

for (const action of ['undo', 'keep'] as const) {
  test(`a conflicting round ${action} aborts without changing the worktree or job`, async () => {
    const repo = tempRepo();
    const { jobs, adapter, events } = harness((ctl) => {
      fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'first\n');
      fs.writeFileSync(path.join(ctl.job.cwd, 'new.js'), 'first\n');
      ctl.done('first');
    });
    const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
    if (action === 'keep') await jobs.round(job.id, 1, 'undo');
    adapter.reply = async (ctl) => {
      fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'conflicting later edit\n');
      ctl.done('second');
    };
    await jobs.reply(job.id, { message: 'replace the same line' });
    await settled(jobs, job);
    const before = structuredClone(job);
    const count = events.length;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' });
    await assert.rejects(jobs.round(job.id, 1, action), /conflicted files: README\.md/);
    assert.deepEqual(job, before);
    assert.equal(events.length, count);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: job.cwd, encoding: 'utf8' }), head);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: job.cwd, encoding: 'utf8' }), '');
    assert.equal(fs.readFileSync(path.join(job.cwd, 'README.md'), 'utf8'), 'conflicting later edit\n');
    assert.equal(fs.existsSync(path.join(job.cwd, 'new.js')), action === 'undo');
    if (action === 'undo') assert.equal(fs.readFileSync(path.join(job.cwd, 'new.js'), 'utf8'), 'first\n');
    const revertHead = execFileSync('git', ['rev-parse', '--git-path', 'REVERT_HEAD'], { cwd: job.cwd, encoding: 'utf8' }).trim();
    assert.equal(fs.existsSync(path.resolve(job.cwd, revertHead)), false);
    await jobs.discard(job.id);
  });
}

test('round operations exclude concurrent changes, follow-ups and discard', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'changed\n');
    ctl.done('done');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const pending = jobs.round(job.id, 1, 'undo');
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /already changing a round/);
  await assert.rejects(jobs.reply(job.id, { message: 'again' }), /changing a round/);
  await assert.rejects(jobs.discard(job.id), /changing a round/);
  await pending;
  await jobs.round(job.id, 1, 'keep');
  const discarding = jobs.discard(job.id);
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /being discarded/);
  await discarding;
});

test('in-place and review jobs never record rounds', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'README.md'), 'changed\n');
    ctl.touched(path.join(ctl.job.cwd, 'README.md'));
    ctl.done('done');
  });
  const inPlace = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x', isolation: 'in_place' }));
  assert.equal(inPlace.rounds, undefined);
  assert.match(inPlace.result!.stat, /edited in place/);
  for (const runsApp of [false, true]) {
    const review = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, runsApp, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
    assert.equal(review.rounds, undefined);
    assert.equal(review.result, null);
    await jobs.discard(review.id);
  }
});

for (const agent of ['codex', 'antigravity'] as const) {
  test(`an ask uses the delegate assignment for ${agent}, runs read-only in cwd and returns only its answer`, async () => {
    const repo = tempRepo();
    const cwd = path.join(repo, 'sub');
    fs.mkdirSync(cwd);
    const assigned = resolveConfig({ roles: { delegate: { agent, model: 'question-model', effort: 'high' } } });
    const { jobs, home } = harness((ctl) => {
      assert.equal(ctl.job.cwd, cwd);
      assert.equal(ctl.job.sandbox, 'read-only');
      assert.equal(ctl.job.worktree, null);
      ctl.done('The answer.');
    }, () => assigned);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });
    const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd, task: 'How does it work?', ask: true }));
    assert.equal(job.ask, true);
    assert.equal(job.agent, agent);
    assert.equal(job.model, 'question-model');
    assert.equal(job.effort, 'high');
    assert.equal(job.nativeReview, null);
    assert.equal(job.report, 'The answer.');
    assert.equal(job.result, null);
    assert.equal(job.rounds, undefined);
    assert.match(job.instructions, /^# Role: question responder/);
    assert.match(job.instructions, /Change nothing in the repository or anywhere else\. If you were given a directory of your own, checks may write there and only there/);
    assert.match(job.instructions, /Give the answer as your final message/);
    assert.match(job.instructions, /# This machine is shared/);
    assert.equal(job.prompt, '# Question\nHow does it work?');
    assert.equal(fs.existsSync(path.join(home, 'worktrees')), false);
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }), head);
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }), '');
    await jobs.reply(job.id, { message: 'Explain further.' });
    await settled(jobs, job);
    assert.equal(job.sandbox, 'read-only');
    assert.equal(job.cwd, cwd);
    assert.equal(job.worktree, null);
    assert.equal(job.result, null);
    assert.equal(job.rounds, undefined);
  });
}

test('ask jobs require a question and refuse every conflicting option before starting', async () => {
  const repo = tempRepo();
  const { jobs, home } = harness(() => assert.fail('invalid ask must not start'));
  const spec: JobSpec = { kind: 'delegate', cwd: repo, task: 'Question?', ask: true };
  for (const kind of ['review', 'polish'] as const) {
    await assert.rejects(jobs.create({ ...spec, kind }), /ask job must use kind "delegate"/);
  }
  for (const task of [undefined, '', '  \n']) {
    await assert.rejects(jobs.create({ ...spec, task }), /ask job requires a task/);
  }
  const options: Partial<JobSpec>[] = [{ exclusive: true }, { runsApp: true }, { targets: [] }, { targets: ['README.md'] }, { base: 'HEAD' }, { isolation: 'worktree' }];
  for (const option of options) {
    await assert.rejects(jobs.create({ ...spec, ...option }), /ask job cannot use/);
  }
  assert.equal(jobs.list().length, 0);
  assert.equal(fs.existsSync(path.join(home, 'worktrees')), false);
  assert.equal(execFileSync('git', ['branch', '--list', 'crew-*'], { cwd: repo, encoding: 'utf8' }), '');
});

test('ask jobs also work outside git with explicit in-place isolation', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-question-'));
  const { jobs } = harness((ctl) => ctl.done('answer'));
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd, task: 'Question?', ask: true, isolation: 'in_place' }));
  assert.equal(job.repo, null);
  assert.equal(job.cwd, cwd);
  assert.equal(job.sandbox, 'read-only');
  assert.equal(job.worktree, null);
  assert.equal(job.result, null);
  assert.equal(job.rounds, undefined);
});

test('saved worktree jobs without rounds load and gain rounds on their next changing turn', async () => {
  const repo = tempRepo();
  const first = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'old.js'), 'old\n');
    ctl.done('old bridge');
  });
  const job = await settled(first.jobs, await first.jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  first.jobs.flush();
  const file = path.join(first.home, 'jobs.json');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete saved.jobs[0].rounds;
  fs.writeFileSync(file, JSON.stringify(saved));
  first.adapter.reply = async (ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'new.js'), 'new\n');
    ctl.done('new bridge');
  };
  const restored = new Jobs(first.home, () => config, { codex: first.adapter, antigravity: first.adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  const loaded = restored.get(job.id);
  assert.equal(loaded.rounds, undefined);
  await assert.rejects(restored.round(job.id, 1, 'undo'), /no round for turn 1/);
  await restored.reply(job.id, { message: 'next' });
  await settled(restored, loaded);
  assert.equal(loaded.rounds!.length, 1);
  assert.equal(loaded.rounds![0].turn, 2);
  assert.deepEqual(loaded.rounds![0].files, ['new.js']);
  assert.deepEqual(loaded.result!.files, ['new.js', 'old.js']);
  await restored.round(job.id, 2, 'undo');
  assert.deepEqual(loaded.result!.files, ['old.js']);
  await restored.discard(job.id);
});

test('a round changed just before the bridge stopped is recovered from the branch', async () => {
  const repo = tempRepo();
  const first = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'a.js'), 'a\n');
    ctl.done('done');
  });
  const job = await settled(first.jobs, await first.jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  first.jobs.flush();
  const saved = fs.readFileSync(path.join(first.home, 'jobs.json'), 'utf8');
  await first.jobs.round(job.id, 1, 'undo');
  // The revert is on the branch, but the saved job still says the round is kept.
  fs.writeFileSync(path.join(first.home, 'jobs.json'), saved);

  const restored = new Jobs(first.home, () => config, { codex: first.adapter, antigravity: first.adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  const loaded = restored.get(job.id);
  assert.equal(loaded.rounds![0].state, 'kept');
  await assert.rejects(restored.round(job.id, 1, 'undo'), /already undone/);
  assert.equal(loaded.rounds![0].state, 'undone');
  assert.deepEqual(loaded.result!.files, []);
  await restored.round(job.id, 1, 'keep');
  assert.equal(fs.readFileSync(path.join(loaded.cwd, 'a.js'), 'utf8'), 'a\n');
  assert.deepEqual([loaded.rounds![0].state, loaded.rounds![0].revert], ['kept', undefined]);
  // Undone, kept, and undone again replays to the latest revert.
  await restored.round(job.id, 1, 'undo');
  fs.writeFileSync(path.join(first.home, 'jobs.json'), saved);
  const again = new Jobs(first.home, () => config, { codex: first.adapter, antigravity: first.adapter }, { onEvent: () => {}, onJob: () => {}, onAttention: () => {} });
  await again.round(job.id, 1, 'keep');
  assert.equal(fs.readFileSync(path.join(loaded.cwd, 'a.js'), 'utf8'), 'a\n');
  await again.discard(job.id);
});

test('a round is not changed through a link or on another branch', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'a.js'), 'a\n');
    ctl.done('done');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const tree = job.worktree!.path;
  const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' });

  execFileSync('git', ['switch', '--quiet', '--detach'], { cwd: tree });
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /is not on crew-/);
  execFileSync('git', ['switch', '--quiet', job.worktree!.branch], { cwd: tree });

  // The worktree directory replaced by a link to the main repository, as after a merge.
  const before = head();
  fs.renameSync(tree, `${tree}.moved`);
  fs.symlinkSync(repo, tree);
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /now a link to somewhere else/);
  assert.equal(head(), before);
  assert.equal(job.rounds![0].state, 'kept');
  fs.rmSync(tree);
  fs.renameSync(`${tree}.moved`, tree);
  await jobs.round(job.id, 1, 'undo');
  await jobs.discard(job.id);
});

test('a read-only Codex job gets a scratch directory for the turn, and Antigravity none', async () => {
  const repo = tempRepo();
  let worker!: JobCtl;
  const { jobs, home, adapter } = harness((ctl) => { worker = ctl; });
  const review = await jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } });
  const scratch = path.join(home, 'scratch', review.id);
  assert.equal(review.scratch, scratch);
  assert.ok(fs.statSync(scratch).isDirectory());
  assert.ok(review.instructions.includes(`one directory of your own: \`${scratch}\``));
  fs.writeFileSync(path.join(scratch, 'cache'), 'x');
  worker.done('reviewed');
  await settled(jobs, review);
  // Moved aside at once, so a follow-up that starts immediately cannot inherit it or lose its own to a late removal.
  assert.equal(fs.existsSync(scratch), false);

  // A follow-up turn gets it back, empty.
  adapter.reply = async (ctl) => { worker = ctl; };
  await jobs.reply(review.id, { message: 'look again' });
  assert.deepEqual(fs.readdirSync(scratch), []);
  worker.done('again');
  await settled(jobs, review);

  const ask = await jobs.create({ kind: 'delegate', ask: true, cwd: repo, task: 'why?' });
  assert.equal(ask.scratch, path.join(home, 'scratch', ask.id));
  worker.done('because');
  await settled(jobs, ask);

  // A job that writes, or runs the app, has its own writable tree and needs none.
  const build = await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' });
  assert.equal(build.scratch, undefined);
  assert.ok(!build.instructions.includes('What you can run'));
  worker.done('built');
  await settled(jobs, build);
  await jobs.discard(build.id);

  const other = harness((ctl) => ctl.done('read'), () => resolveConfig({ notify: false, roles: { review: { agent: 'antigravity' } } }));
  const handed = await settled(other.jobs, await other.jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  assert.equal(handed.scratch, undefined);
});

test('a job whose worktree was removed takes no further turn', async () => {
  const repo = tempRepo();
  const { jobs } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'a.js'), 'a\n');
    ctl.session('s-1');
    ctl.done('done');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  await jobs.discard(job.id);
  const before = structuredClone(job);
  await assert.rejects(jobs.reply(job.id, { message: 'one more thing' }), /worktree was removed, so it cannot take another turn/);
  assert.deepEqual(job, before);
});

test('Finder metadata does not count as uncommitted work', async () => {
  const repo = tempRepo();
  fs.writeFileSync(path.join(repo, '.DS_Store'), 'x');
  fs.mkdirSync(path.join(repo, 'sub'));
  fs.writeFileSync(path.join(repo, 'sub', '.DS_Store'), 'x');
  const { jobs } = harness((ctl) => ctl.done('done'));
  const clean = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  assert.ok(!clean.notes.some((note) => note.includes('uncommitted path')));
  fs.writeFileSync(path.join(repo, 'real.js'), 'x');
  const dirty = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  assert.ok(dirty.notes.some((note) => note.startsWith('1 uncommitted path(s)')));
  await jobs.discard(clean.id);
  await jobs.discard(dirty.id);
});

test('a follow-up can first bring the worker up to date with the lead, without claiming what the lead changed', async () => {
  const repo = tempRepo();
  const commit = (file: string, text: string) => {
    fs.writeFileSync(path.join(repo, file), text);
    execFileSync('git', ['add', '-A'], { cwd: repo });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', file], { cwd: repo });
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  };
  const { jobs, adapter } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'worker.js'), 'w\n');
    ctl.session('s-1');
    ctl.done('first');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const head = commit('lead.js', 'l\n');

  let told = '';
  adapter.reply = async (ctl, message) => {
    told = message;
    assert.equal(fs.readFileSync(path.join(ctl.job.cwd, 'lead.js'), 'utf8'), 'l\n');
    fs.writeFileSync(path.join(ctl.job.cwd, 'worker.js'), 'w2\n');
    ctl.done('second');
  };
  await jobs.reply(job.id, { message: 'use the new file', sync: true });
  await settled(jobs, job);
  assert.match(told, new RegExp(`commits up to \`${head.slice(0, 8)}\``));
  assert.equal(job.worktree!.base, head);
  // The lead's file is in the worktree but is not the worker's change.
  assert.deepEqual(job.result!.files, ['worker.js']);
  assert.deepEqual(job.rounds!.map((round) => [round.turn, round.files]), [[1, ['worker.js']], [2, ['worker.js']]]);

  // A merge that conflicts changes nothing and starts no turn.
  commit('worker.js', 'lead version\n');
  const before = structuredClone(job);
  await assert.rejects(jobs.reply(job.id, { message: 'again', sync: true }), /conflicted files: worker\.js/);
  assert.deepEqual(job, before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: job.cwd, encoding: 'utf8' }), '');

  const review = await settled(jobs, await jobs.create({ kind: 'review', cwd: repo, review: { target: { type: 'uncommittedChanges' }, mode: 'adversarial' } }));
  await assert.rejects(jobs.reply(review.id, { message: 'x', sync: true }), /no worktree of its own/);
  // A sync is for the gap between turns: it is refused while the worker is editing, not dropped without a word.
  let live!: JobCtl;
  adapter.reply = async (ctl) => { live = ctl; };
  await jobs.reply(job.id, { message: 'start' });
  await assert.rejects(jobs.reply(job.id, { message: 'and this', sync: true }), /sync brings a finished job up to date/);
  live.done('third');
  await settled(jobs, job);
  await jobs.discard(job.id);
});

test('a sync holds the worktree against round changes and discard, and rounds survive a moved base', async () => {
  const repo = tempRepo();
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim();
  const { jobs, adapter } = harness((ctl) => {
    fs.writeFileSync(path.join(ctl.job.cwd, 'worker.js'), 'w\n');
    ctl.session('s-1');
    ctl.done('first');
  });
  const job = await settled(jobs, await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' }));
  const started = job.worktree!.base;
  await jobs.round(job.id, 1, 'undo');
  // The lead takes the worker's branch as it is, undo included, and commits something of its own.
  git(repo, 'merge', '-q', '--no-edit', job.worktree!.branch);
  fs.writeFileSync(path.join(repo, 'lead.js'), 'l\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'lead');

  let worker!: JobCtl;
  adapter.reply = async (ctl) => { worker = ctl; };
  const syncing = jobs.reply(job.id, { message: 'carry on', sync: true });
  await assert.rejects(jobs.round(job.id, 1, 'keep'), /being brought up to date/);
  await assert.rejects(jobs.discard(job.id), /still running|being brought up to date/);
  await syncing;
  worker.done('second');
  await settled(jobs, job);

  assert.equal(job.roundsBase, started);
  assert.notEqual(job.worktree!.base, started);
  // The undo is behind the new base now, and is still found.
  assert.equal(job.rounds![0].state, 'undone');
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /already undone/);
  await jobs.round(job.id, 1, 'keep');
  assert.equal(fs.readFileSync(path.join(job.cwd, 'worker.js'), 'utf8'), 'w\n');
  await jobs.discard(job.id);
});

test('a job says what its tokens are made of and what the latest turn added', async () => {
  const repo = tempRepo();
  let worker!: JobCtl;
  const { jobs, adapter } = harness((ctl) => { worker = ctl; ctl.session('s-1'); });
  const job = await jobs.create({ kind: 'delegate', cwd: repo, task: 'x' });
  worker.tokens(1000, { input: 900, cachedInput: 600, output: 100 });
  assert.deepEqual(job.tokenUse, { input: 900, cachedInput: 600, output: 100, turn: 1000 });
  const { describe } = await import('../plugin/bridge/render.ts');
  assert.match(describe(job), /tokens: 1,000 \(input 900, of which 600 cached; output 100\)/);
  worker.done('first');
  await settled(jobs, job);

  adapter.reply = async (ctl) => { worker = ctl; };
  await jobs.reply(job.id, { message: 'more' });
  worker.tokens(1400, { input: 1250, cachedInput: 900, output: 150 });
  assert.equal(job.tokenUse!.turn, 400);
  worker.done('second');
  await settled(jobs, job);
  assert.match(describe(job), /output 150; this turn 400\)/);
  // An agent that reports only a total keeps working as before.
  worker.tokens(1500);
  assert.equal(job.tokens, 1500);
  await jobs.discard(job.id);
});
