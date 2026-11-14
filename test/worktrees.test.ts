import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { commitAll, copyIncluded, createWorktree, detachLinks, dirtyCount, removeWorktree } from '../plugin/bridge/git.ts';
import type { Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { buildPrompt } from '../plugin/bridge/prompts.ts';

for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL']) {
  test(`included directories are shared read-only when cloning returns ${code}`, async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-include-')));
    t.after(async () => { if (process.platform === 'win32') await detachLinks(home); fs.rmSync(home, { recursive: true, force: true }); });
    const repo = path.join(home, 'repo');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
    git('init', '-q');
    git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init', '--allow-empty');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n.env\n');
    fs.writeFileSync(path.join(repo, '.worktreeinclude'), 'node_modules\n.env\n');
    git('add', '.gitignore', '.worktreeinclude');
    git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'includes');
    fs.mkdirSync(path.join(repo, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'node_modules', '.bin', 'tool'), 'keep');
    fs.writeFileSync(path.join(repo, '.env'), 'KEY=1');
    const id = 'cx-abcdef';
    const wt = await createWorktree(repo, id, 'HEAD', home);
    const exclude = path.resolve(wt.path, execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], { cwd: wt.path, encoding: 'utf8' }).trim());
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, '\n/keep-me');
    const included = await copyIncluded(repo, wt.path, async (_source, dest) => {
      // Some files may have cloned before the unsupported file is reached.
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'partial'), 'discard');
      throw Object.assign(new Error('forced no-clone fixture'), { code });
    });
    assert.deepEqual(included, { copied: ['.env'], linked: ['node_modules'], failed: [] });
    wt.linked = included.linked;
    const link = path.join(wt.path, 'node_modules');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.equal(fs.realpathSync(link), path.join(repo, 'node_modules'));
    assert.equal(fs.existsSync(path.join(link, 'partial')), false);
    assert.equal(fs.lstatSync(path.join(wt.path, '.env')).isFile(), true);
    assert.match(fs.readFileSync(exclude, 'utf8'), /\/keep-me\n\/node_modules\n/);
    assert.equal(await dirtyCount(wt.path), 0);
    assert.equal(await commitAll(wt.path, 'no dependency links'), null);
    for (const runsApp of [false, true]) {
      const built = buildPrompt({ kind: 'delegate', cwd: wt.path, task: 'test', runsApp }, wt, null, '', path.join(home, 'scratch'));
      assert.match(built.instructions, /shared read-only.*node_modules/);
      assert.match(built.instructions, /Do not install into them or delete them/);
      const job = { cwd: wt.path, sandbox: 'workspace-write', worktree: wt, scratch: path.join(home, 'scratch'), runsApp, instructions: built.instructions } as Job;
      const adapter = new CodexAdapter(resolveConfig({}));
      const params = await (adapter as any).threadParams({ job, mcp: {} } as JobCtl, {});
      const config = params.config;
      const files = config.permissions[config.default_permissions].filesystem;
      assert.equal(params.sandbox, null);
      assert.equal(files[wt.path], 'write');
      assert.equal(files[link], 'read');
      // This explicit target rule overrides even a writable /tmp parent, after symlink resolution.
      assert.equal(files[fs.realpathSync(link)], 'read');
      assert.equal(files[job.scratch!], 'write');
      assert.deepEqual(config.shell_environment_policy.set, { TMPDIR: job.scratch, TMP: job.scratch, TEMP: job.scratch });
      assert.deepEqual(config.permissions[config.default_permissions].network, { enabled: runsApp });
    }
    // Assert detachment precedes git worktree remove, not merely that Unix unlink happens to be safe.
    const unlink = t.mock.method(fs.promises, 'unlink');
    await removeWorktree(repo, wt, id, home);
    assert.ok(unlink.mock.calls.some((call) => call.arguments[0] === link));
    assert.equal(fs.existsSync(wt.path), false);
    assert.equal(fs.readFileSync(path.join(repo, 'node_modules', '.bin', 'tool'), 'utf8'), 'keep');
  });
}

test('included directory clone success keeps a private copy, and permission errors do not become links', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-clone-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: home });
  fs.writeFileSync(path.join(home, '.gitignore'), 'deps/\n');
  fs.writeFileSync(path.join(home, '.worktreeinclude'), 'deps\n');
  fs.mkdirSync(path.join(home, 'deps'));
  fs.writeFileSync(path.join(home, 'deps', 'file'), 'original');
  for (const fail of [false, true]) {
    const wt = path.join(home, fail ? 'denied' : 'cloned');
    fs.mkdirSync(wt);
    const result = await copyIncluded(home, wt, async (source, dest) => {
      if (fail) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      await fs.promises.cp(source, dest, { recursive: true });
    });
    assert.deepEqual(result.linked, []);
    if (fail) assert.match(result.failed[0], /permission denied/);
    else {
      assert.deepEqual(result.copied, ['deps/']);
      assert.ok(!fs.lstatSync(path.join(wt, 'deps')).isSymbolicLink());
      fs.writeFileSync(path.join(wt, 'deps', 'file'), 'private');
      assert.equal(fs.readFileSync(path.join(home, 'deps', 'file'), 'utf8'), 'original');
    }
  }
});

test('APFS includes use native clones and preserve dependency symlinks', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-apfs-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wt = path.join(dir, 'worker');
  fs.mkdirSync(wt);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'deps/\n');
  fs.writeFileSync(path.join(dir, '.worktreeinclude'), 'deps\n');
  fs.mkdirSync(path.join(dir, 'deps', '.bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'deps', 'tool'), 'original');
  fs.symlinkSync('../tool', path.join(dir, 'deps', '.bin', 'tool'));
  const result = await copyIncluded(dir, wt);
  assert.deepEqual(result, { copied: ['deps/'], linked: [], failed: [] });
  assert.ok(!fs.lstatSync(path.join(wt, 'deps')).isSymbolicLink());
  assert.equal(fs.readlinkSync(path.join(wt, 'deps', '.bin', 'tool')), '../tool');
  fs.writeFileSync(path.join(wt, 'deps', 'tool'), 'private');
  assert.equal(fs.readFileSync(path.join(dir, 'deps', 'tool'), 'utf8'), 'original');
});

test('nested APFS includes create missing destination parents before cloning', { skip: process.platform !== 'darwin' }, async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-nested-clone-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const wt = path.join(dir, 'worker');
  fs.mkdirSync(wt);
  execFileSync('git', ['init', '-q'], { cwd: dir });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'a/deps/\n');
  fs.writeFileSync(path.join(dir, '.worktreeinclude'), 'a/deps/\n');
  fs.mkdirSync(path.join(dir, 'a', 'deps'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a', 'deps', 'file'), 'original');
  assert.equal(fs.existsSync(path.join(wt, 'a')), false);
  assert.deepEqual(await copyIncluded(dir, wt), { copied: ['a/deps/'], linked: [], failed: [] });
  assert.equal(fs.readFileSync(path.join(wt, 'a', 'deps', 'file'), 'utf8'), 'original');
});
