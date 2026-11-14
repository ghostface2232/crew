import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { collectGarbage } from '../plugin/bridge/gc.ts';
import { createWorktree, removeWorktree, worktreePath } from '../plugin/bridge/git.ts';
import { Jobs } from '../plugin/bridge/jobs.ts';
import type { Adapter, Job } from '../plugin/bridge/jobs.ts';
import { describe, summarize } from '../plugin/bridge/render.ts';

function fixture(t: TestContext, platform: NodeJS.Platform = process.platform) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-gc-')));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 't@example.com');
  git('commit', '--allow-empty', '-qm', 'init');
  const adapter: Adapter = { start: async () => {}, reply: async () => {}, answer: async () => {}, cancel: async () => {}, shutdown() {} };
  const jobs = new Jobs(home, () => resolveConfig({ notify: false }), { codex: adapter, antigravity: adapter }, {
    onEvent() {}, onJob() {}, onAttention() {},
  }, platform);
  const job = { id: 'cx-000000', kind: 'delegate', agent: 'codex', state: 'done', title: 'test', phase: 'done',
    repo, project: repo, cwd: repo, worktree: null, notes: [], createdAt: 0, endedAt: 1, seq: 0, delivered: 0,
    nativeReview: null, tokens: null, error: null, result: null, sessionId: null, turns: 1, report: '',
    sandbox: 'workspace-write', prompt: '', instructions: '', targets: [], activeAt: 0, stalled: false, waiting: null } as Job;
  jobs.jobs.set(job.id, job);
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); jobs.flush(); fs.rmSync(home, { recursive: true, force: true }); });
  return { home, repo, git, jobs, job, adapter };
}

// Git lists worktrees with forward slashes on Windows; paths in the tests are native.
const listed = (git: (...args: string[]) => string) => git('worktree', 'list', '--porcelain').replaceAll('/', path.sep);

for (const platform of ['darwin', 'win32'] as const) test(`gc dry run lists without changes; apply keeps branches until --branches (${platform})`, async (t) => {
  const { home, repo, git, jobs } = fixture(t, platform);
  let prunes = 0;
  if (platform === 'win32') {
    const exec = childProcess.execFile;
    t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
      if (bin === 'attrib') return exec(process.execPath, ['-e', ''], options, callback);
      if (bin === 'git' && args[1] === 'prune' && ++prunes === 1) return exec('git', ['--version'], options, callback);
      return exec(bin, args, options, callback);
    });
    syncBuiltinESMExports();
  }
  const orphan = worktreePath(repo, 'cx-abcdef', home);
  fs.mkdirSync(orphan, { recursive: true });
  fs.writeFileSync(path.join(orphan, 'file'), 'orphan');
  const namedFile = worktreePath(repo, 'ag-ffffff', home);
  fs.writeFileSync(namedFile, 'not a directory');
  const outside = path.join(home, 'shared');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'tool'), 'keep');
  const link = path.join(orphan, 'node_modules');
  fs.symlinkSync(outside, link, 'junction');
  const missing = await createWorktree(repo, 'ag-112233', 'HEAD', home);
  const admin = git('-C', missing.path, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(missing.path, { recursive: true, force: true });
  git('branch', 'crew-cx-aabbcc');
  const commit = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'unmerged');
  git('branch', 'crew-ag-aabbcc', commit);
  const before = git('worktree', 'list', '--porcelain');
  const branches = git('branch', '--format=%(refname:short)');
  const dry = await jobs.gc();
  assert.match(dry, /dry run/);
  assert.ok(dry.includes(`Directory: ${orphan}`));
  assert.ok(dry.includes(`Git admin directory: ${path.normalize(admin)}`));
  assert.ok(dry.includes('crew-cx-aabbcc (merged into HEAD)'));
  assert.ok(dry.includes('crew-ag-aabbcc (not merged into HEAD)'));
  assert.equal(git('worktree', 'list', '--porcelain'), before);
  assert.equal(git('branch', '--format=%(refname:short)'), branches);
  assert.equal(fs.readFileSync(path.join(orphan, 'file'), 'utf8'), 'orphan');
  assert.ok(fs.existsSync(admin));
  const unlinks = t.mock.method(fs.promises, 'unlink');
  const applied = await jobs.gc({ apply: true });
  assert.ok(applied.includes('Removed.'));
  assert.ok(!fs.existsSync(orphan));
  assert.ok(!fs.existsSync(admin));
  if (platform === 'win32') assert.equal(prunes, 2);
  assert.ok(unlinks.mock.calls.some((call) => call.arguments[0] === link));
  assert.equal(fs.readFileSync(path.join(outside, 'tool'), 'utf8'), 'keep');
  assert.equal(fs.readFileSync(namedFile, 'utf8'), 'not a directory');
  assert.equal(git('branch', '--format=%(refname:short)'), branches);
  const cleaned = await jobs.gc({ apply: true, branches: true });
  assert.equal(git('branch', '--list', '--format=%(refname:short)', 'crew-*'), 'crew-ag-aabbcc');
  assert.ok(cleaned.includes('Kept; not merged into HEAD. To delete manually: git branch -D crew-ag-aabbcc'));
});

test('gc preserves unowned registered worktrees and cleans missing metadata through a symlinked home', async (t) => {
  const { home, repo, git, job } = fixture(t);
  const alias = path.join(home, 'alias');
  fs.symlinkSync(home, alias, 'junction');
  const wt = await createWorktree(repo, 'cx-abcdef', 'HEAD', alias);
  fs.writeFileSync(path.join(wt.path, 'uncommitted'), 'keep my work');
  const missing = await createWorktree(repo, 'ag-112233', 'HEAD', alias);
  const admin = git('-C', missing.path, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(missing.path, { recursive: true, force: true });
  const result = await collectGarbage(alias, [job], () => false, { apply: true });
  assert.ok(fs.existsSync(wt.path), result);
  assert.equal(fs.readFileSync(path.join(wt.path, 'uncommitted'), 'utf8'), 'keep my work');
  assert.ok(listed(git).includes(fs.realpathSync(wt.path)));
  assert.ok(!fs.existsSync(admin), result);
  assert.doesNotMatch(result, /Cleanup failed/);
});

test('gc protects an unlisted directory whose .git file points to existing admin metadata', async (t) => {
  const { home, repo, git, jobs } = fixture(t);
  const wt = await createWorktree(repo, 'cx-abcdef', 'HEAD', home);
  const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
  const orphan = worktreePath(repo, 'ag-112233', home);
  fs.mkdirSync(orphan);
  fs.writeFileSync(path.join(orphan, '.git'), `gitdir: ${path.relative(orphan, admin)}\n`);
  fs.writeFileSync(path.join(orphan, 'uncommitted'), 'keep my work');
  const result = await jobs.gc({ apply: true });
  assert.ok(fs.existsSync(orphan), result);
  assert.equal(fs.readFileSync(path.join(orphan, 'uncommitted'), 'utf8'), 'keep my work');
  assert.ok(fs.existsSync(admin));
});

for (const mode of ['fallback', 'failed fallback', 'branch failure', 'recorded admin'] as const) {
  test(`Windows discard preserves unrelated missing worktree metadata during ${mode}`, async (t) => {
    const { home, repo, git } = fixture(t, 'win32');
    const wt = await createWorktree(repo, 'cx-abcdef', 'HEAD', home);
    const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
    const outside = path.join(home, 'detached-drive');
    git('worktree', 'add', '--detach', outside, 'HEAD');
    const otherAdmin = git('-C', outside, 'rev-parse', '--absolute-git-dir');
    const metadata = fs.readFileSync(path.join(otherAdmin, 'gitdir'), 'utf8');
    fs.rmSync(outside, { recursive: true, force: true });
    if (mode === 'recorded admin') {
      wt.admin = admin;
      fs.rmSync(wt.path, { recursive: true, force: true });
      fs.unlinkSync(path.join(admin, 'gitdir'));
    }
    if (mode === 'branch failure') fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', `${wt.branch}.lock`), '');
    const exec = childProcess.execFile;
    t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
      if (bin === 'attrib') return exec(process.execPath, ['-e', ''], options, callback);
      if (bin === 'git' && args[1] === 'remove' && mode.includes('fallback')) {
        return exec(process.execPath, ['-e', 'process.stderr.write("removal failed"); process.exit(1)'], options, callback);
      }
      return exec(bin, args, options, callback);
    });
    if (mode === 'failed fallback') t.mock.method(fs.promises, 'rm', async () => { throw new Error('still busy'); });
    syncBuiltinESMExports();
    const removing = removeWorktree(repo, wt, 'cx-abcdef', home, 'win32');
    if (mode === 'failed fallback' || mode === 'branch failure') await assert.rejects(removing);
    else await removing;
    assert.ok(fs.existsSync(otherAdmin), 'unrelated missing worktree metadata must survive');
    assert.equal(fs.readFileSync(path.join(otherAdmin, 'gitdir'), 'utf8'), metadata);
    assert.ok(listed(git).includes(outside));
    if (mode === 'fallback' || mode === 'recorded admin') {
      assert.ok(!fs.existsSync(admin));
      assert.ok(!listed(git).includes(wt.path));
    }
  });
}

for (const state of ['owned', 'active', 'discarding', 'changingRounds'] as const) {
  test(`gc leaves an ${state} job's directory, admin metadata and branch alone`, async (t) => {
    const { home, repo, git, jobs, job } = fixture(t);
    const wt = await createWorktree(repo, job.id, 'HEAD', home);
    job.worktree = wt;
    const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
    fs.rmSync(wt.path, { recursive: true, force: true });
    // Also protect an unregistered directory still owned by the job.
    fs.mkdirSync(wt.path);
    fs.writeFileSync(path.join(wt.path, 'keep'), 'owned');
    if (state === 'active') job.state = 'running';
    if (state === 'discarding' || state === 'changingRounds') (jobs as any)[state].add(job.id);
    const before = git('worktree', 'list', '--porcelain');
    await jobs.gc({ apply: true, branches: true });
    assert.equal(fs.readFileSync(path.join(wt.path, 'keep'), 'utf8'), 'owned');
    assert.ok(fs.existsSync(admin));
    assert.equal(git('worktree', 'list', '--porcelain'), before);
    assert.ok(git('branch', '--list', wt.branch));
  });
}

test('gc refuses an orphan path redirected outside Crew worktrees', async (t) => {
  const { home, repo, jobs } = fixture(t);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'safe');
  const orphan = worktreePath(repo, 'cx-abcdef', home);
  fs.mkdirSync(path.dirname(orphan), { recursive: true });
  fs.symlinkSync(outside, orphan, 'junction');
  assert.match(await jobs.gc({ apply: true }), /Refusing to clean a path outside/);
  assert.ok(fs.lstatSync(orphan).isSymbolicLink());
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'safe');
});

test('gc does not let global prune remove unrelated missing worktrees or owned metadata', async (t) => {
  const { home, repo, git, jobs } = fixture(t);
  const missing = await createWorktree(repo, 'cx-abcdef', 'HEAD', home);
  const admin = git('-C', missing.path, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(missing.path, { recursive: true, force: true });
  const outside = path.join(home, 'outside');
  git('worktree', 'add', '--detach', outside, 'HEAD');
  const otherAdmin = git('-C', outside, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(outside, { recursive: true, force: true });
  assert.match(await jobs.gc({ apply: true }), /Prune skipped/);
  assert.ok(fs.existsSync(admin));
  assert.ok(fs.existsSync(otherAdmin));
});

test('Windows partial discard releases the session, preserves its record and original error, and reports all leftovers', async (t) => {
  const { home, repo, jobs, job, adapter, git } = fixture(t, 'win32');
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
  let released = false;
  adapter.release = async () => { assert.ok(fs.existsSync(wt.path)); released = true; };
  const exec = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
    if (bin === 'attrib') return exec(process.execPath, ['-e', ''], options, callback);
    if (bin === 'git' && args[1] === 'remove') {
      assert.ok(released);
      return exec(process.execPath, ['-e', 'process.stderr.write("original permission failure"); process.exit(1)'], options, callback);
    }
    return exec(bin, args, options, callback);
  });
  t.mock.method(fs.promises, 'rm', async () => { throw Object.assign(new Error('still busy'), { code: 'EBUSY' }); });
  syncBuiltinESMExports();
  await assert.rejects(jobs.discard(job.id), (error: any) => {
    assert.match(error.message, /original permission failure.*still busy/s);
    assert.match(error.cause.message, /original permission failure/);
    return true;
  });
  assert.equal(job.worktree, wt);
  assert.deepEqual(job.cleanupPending, [`directory ${wt.path}`, `Git admin directory ${admin}`, `branch ${wt.branch}`]);
  assert.ok(job.notes.some((note) => note.includes('Run crew gc') && note.includes('original permission failure')));
  assert.ok(describe(job).includes('Cleanup incomplete:'));
  assert.ok(summarize(job).includes('cleanup incomplete'));
  // Only the emptied folder left: the delayed retries remove it, so the user is not told to run gc.
  const held = { ...job, cleanupPending: [`directory ${wt.path}`] };
  assert.match(describe(held), /removed automatically/);
  assert.equal(describe(held).includes('run crew gc'), false);
  assert.match(summarize(held), /removed automatically/);
  const saved = JSON.parse(fs.readFileSync(path.join(home, 'jobs.json'), 'utf8')).jobs[0];
  assert.deepEqual(saved.cleanupPending, job.cleanupPending);
});

test('Windows snapshot and scratch deletion detach links before any recursive removal', async (t) => {
  const { home, repo, jobs, job, adapter } = fixture(t, 'win32');
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  job.kind = 'review';
  const outside = path.join(home, 'shared');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'tool'), 'keep');
  const snapshotLink = path.join(wt.path, 'deps');
  fs.symlinkSync(outside, snapshotLink, 'junction');
  let released = false;
  adapter.release = async () => { released = true; };
  const exec = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
    if (bin === 'attrib') return exec(process.execPath, ['-e', ''], options, callback);
    if (bin === 'git' && args[1] === 'remove') {
      assert.ok(released);
      assert.ok(!fs.existsSync(snapshotLink));
    }
    return exec(bin, args, options, callback);
  });
  syncBuiltinESMExports();
  const unlinks = t.mock.method(fs.promises, 'unlink');
  (jobs as any).dropSnapshot(job);
  await (jobs as any).snapshots.get(job.id);
  assert.equal(job.worktree, null);
  assert.ok(unlinks.mock.calls.some((call) => call.arguments[0] === snapshotLink));
  const scratch = path.join(home, 'scratch', job.id);
  fs.mkdirSync(scratch, { recursive: true });
  fs.symlinkSync(outside, path.join(scratch, 'deps'), 'junction');
  (jobs as any).removeScratch(scratch);
  for (let tries = 0; fs.readdirSync(path.dirname(scratch)).length; tries++) {
    assert.ok(tries < 300);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(unlinks.mock.calls.some((call) => String(call.arguments[0]).includes('.gone-')));
  assert.equal(fs.readFileSync(path.join(outside, 'tool'), 'utf8'), 'keep');
});

test('gc protects an owned worktree even after Git has unregistered it', async (t) => {
  const { home, repo, git, jobs, job } = fixture(t);
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  git('worktree', 'remove', '--force', wt.path);
  fs.mkdirSync(wt.path);
  fs.writeFileSync(path.join(wt.path, 'keep'), 'owned');
  const result = await jobs.gc({ apply: true, branches: true });
  assert.ok(!result.includes(`Directory: ${wt.path}`));
  assert.equal(fs.readFileSync(path.join(wt.path, 'keep'), 'utf8'), 'owned');
  assert.ok(git('branch', '--list', wt.branch));
});

test('gc finishes a failed discard, keeping its branch visible until --branches is supplied', async (t) => {
  const { home, repo, git, jobs, job } = fixture(t);
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
  fs.rmSync(wt.path, { recursive: true, force: true });
  job.cleanupPending = [`directory ${wt.path}`, `Git admin directory ${admin}`, `branch ${wt.branch}`];
  await jobs.gc({ apply: true });
  assert.equal(job.worktree, null);
  assert.deepEqual(job.cleanupPending, [`branch ${wt.branch}`]);
  assert.ok(git('branch', '--list', wt.branch));
  assert.ok(summarize(job).includes(wt.branch));
  await jobs.gc({ apply: true, branches: true });
  assert.equal(job.cleanupPending, undefined);
  assert.equal(git('branch', '--list', wt.branch), '');
  assert.ok(job.notes.includes('Worktree leftovers removed by crew gc.'));
});

test('Windows branch-only discard failure is recorded and gc can finish it', async (t) => {
  const { home, repo, git, jobs, job } = fixture(t, 'win32');
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  const lock = path.join(repo, '.git', 'refs', 'heads', `${wt.branch}.lock`);
  fs.writeFileSync(lock, '');
  const exec = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => bin === 'attrib'
    ? exec(process.execPath, ['-e', ''], options, callback) : exec(bin, args, options, callback));
  syncBuiltinESMExports();
  await assert.rejects(jobs.discard(job.id), /cannot lock ref/);
  assert.equal(job.worktree, wt);
  assert.deepEqual(job.cleanupPending, [`branch ${wt.branch}`]);
  fs.unlinkSync(lock);
  await jobs.gc({ apply: true, branches: true });
  assert.equal(job.worktree, null);
  assert.equal(job.cleanupPending, undefined);
});

test('gc reserves workspace operations until collection finishes', async (t) => {
  const { jobs, job, repo } = fixture(t);
  const collecting = jobs.gc();
  await assert.rejects(jobs.discard(job.id), /gc is running/);
  await assert.rejects(jobs.reply(job.id, { message: 'again' }), /gc is running/);
  await assert.rejects(jobs.round(job.id, 1, 'undo'), /gc is running/);
  await assert.rejects(jobs.create({ kind: 'delegate', cwd: repo, task: 'build' }), /gc is running/);
  await assert.rejects(jobs.gc(), /Jobs or gc are starting/);
  await collecting;
});

test('gc can prune recorded Windows admin leftovers after Git has already deleted gitdir', async (t) => {
  const { home, repo, jobs, job, git } = fixture(t, 'win32');
  const wt = await createWorktree(repo, job.id, 'HEAD', home);
  job.worktree = wt;
  const admin = git('-C', wt.path, 'rev-parse', '--absolute-git-dir');
  const exec = childProcess.execFile;
  let keepAdmin = true;
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
    if (bin === 'attrib') return exec(process.execPath, ['-e', ''], options, callback);
    if (bin === 'git' && args[1] === 'remove') {
      fs.rmSync(wt.path, { recursive: true, force: true });
      fs.unlinkSync(path.join(admin, 'gitdir'));
      return exec(process.execPath, ['-e', 'process.stderr.write("original admin permission failure"); process.exit(1)'], options, callback);
    }
    return exec(bin, args, options, callback);
  });
  const rm = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (dir: any, options: any) => {
    if (path.normalize(String(dir)) !== path.normalize(admin) || !keepAdmin) await rm(dir, options);
  });
  syncBuiltinESMExports();
  await assert.rejects(jobs.discard(job.id), /original admin permission failure.*Git metadata remains/s);
  assert.equal(wt.admin, admin);
  assert.deepEqual(job.cleanupPending, [`Git admin directory ${admin}`]);
  assert.equal(git('branch', '--list', wt.branch), '');
  keepAdmin = false;
  assert.match(await jobs.gc({ apply: true }), /recorded failed discard; gitdir is missing/);
  assert.ok(!fs.existsSync(admin));
  assert.equal(job.worktree, null);
  assert.equal(job.cleanupPending, undefined);
});

test('a restarted bridge removes the empty directory a locked Windows discard left behind, and only that', async (t) => {
  const { home, repo, jobs, job, adapter } = fixture(t, 'win32');
  const hooks = { onEvent() {}, onJob() {}, onAttention() {} };
  const cleanup = t.mock.method(Jobs.prototype as unknown as { clearLeftover(job: Job): Promise<boolean> }, 'clearLeftover');
  const restart = async () => {
    const before = cleanup.mock.calls.length;
    const restarted = new Jobs(home, () => resolveConfig({ notify: false }), { codex: adapter, antigravity: adapter }, hooks, 'win32');
    // Startup cleanup must finish before files change or the fixture is removed.
    await Promise.all(cleanup.mock.calls.slice(before).map((call) => call.result));
    return restarted;
  };
  const wt = { path: worktreePath(repo, job.id, home), branch: `crew-${job.id}`, base: 'x' };
  fs.mkdirSync(wt.path, { recursive: true });
  job.worktree = wt;
  job.cleanupPending = [`directory ${wt.path}`];
  jobs.flush();

  // A directory that still holds files is for crew gc.
  fs.writeFileSync(path.join(wt.path, 'file'), 'keep');
  await restart();
  assert.ok(fs.existsSync(path.join(wt.path, 'file')));

  fs.rmSync(path.join(wt.path, 'file'));
  const second = await restart();
  const restored = second.get(job.id);
  assert.equal(restored.worktree, null);
  assert.equal(restored.cleanupPending, undefined);
  assert.equal(fs.existsSync(wt.path), false);
});
