import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CodexAdapter } from '../plugin/bridge/adapters/codex.ts';
import { resolveConfig } from '../plugin/bridge/config.ts';
import { commitAll, copyIncluded, createWorktree, detachLinks, dirtyCount, removeDirectory, removeEmptyLeftover, removeWorktree } from '../plugin/bridge/git.ts';
import type { Job, JobCtl } from '../plugin/bridge/jobs.ts';
import { buildPrompt } from '../plugin/bridge/prompts.ts';

for (const code of ['ENOTSUP', 'EOPNOTSUPP', 'EXDEV', 'ENOSYS', 'EINVAL']) {
  test(`included directories are shared read-only when cloning returns ${code}`, async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-include-')));
    t.after(async () => { if (process.platform === 'win32') await detachLinks(home); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
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
    const excluded = fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null;
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
    // The exclude file is the user's checkout's too, so it is left alone.
    assert.equal(fs.existsSync(exclude) ? fs.readFileSync(exclude, 'utf8') : null, excluded);
    // Git reads a Windows junction as a directory, which `node_modules/` already ignores; a symlink it does not.
    assert.equal(await dirtyCount(wt.path), process.platform === 'win32' ? 0 : 1);
    assert.equal(await dirtyCount(wt.path, wt.linked), 0);
    assert.equal(await commitAll(wt.path, 'no dependency links', wt.linked), null);
    fs.writeFileSync(path.join(wt.path, 'work.txt'), 'change');
    assert.ok(await commitAll(wt.path, 'work only', wt.linked));
    assert.equal(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: wt.path, encoding: 'utf8' }).trim(), 'work.txt');
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

test('a linked dependency path that Git already ignores is not named in a pathspec, so the commit still works', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-ignored-link-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(path.join(repo, 'deps'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'deps', 'tool'), 'keep');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo });
  git('init', '-q');
  // No trailing slash, so the rule ignores a link as well as a directory on every platform.
  fs.writeFileSync(path.join(repo, '.gitignore'), 'deps\n');
  git('add', '.gitignore');
  git('-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
  const wt = await createWorktree(repo, 'cx-ignore', 'HEAD', home);
  const link = path.join(wt.path, 'deps');
  fs.symlinkSync(path.join(repo, 'deps'), link, 'junction');
  wt.linked = ['deps'];
  assert.equal(await dirtyCount(wt.path, wt.linked), 0);
  fs.writeFileSync(path.join(wt.path, 'work.txt'), 'change');
  assert.ok(await commitAll(wt.path, 'work only', wt.linked));
  assert.equal(execFileSync('git', ['show', '--format=', '--name-only', 'HEAD'], { cwd: wt.path, encoding: 'utf8' }).trim(), 'work.txt');
  await detachLinks(wt.path);
});

test('included directory clone success keeps a private copy, and permission errors do not become links', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-clone-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  execFileSync('git', ['init', '-q'], { cwd: home });
  fs.writeFileSync(path.join(home, '.gitignore'), 'deps/\n');
  fs.writeFileSync(path.join(home, '.worktreeinclude'), 'deps\n');
  fs.mkdirSync(path.join(home, 'deps'));
  fs.writeFileSync(path.join(home, 'deps', 'file'), 'original');
  for (const fail of [false, true]) {
    const wt = path.join(home, fail ? 'denied' : 'cloned');
    fs.mkdirSync(wt);
    const result = await copyIncluded(home, wt, async (source, dest) => {
      if (fail) throw Object.assign(new Error(['Command failed: cp -cR deps', ...Array.from({ length: 5000 }, (_, i) => `cp: deps/f${i}: clonefile failed: Operation not permitted`)].join('\n')), { code: 'EPERM' });
      await fs.promises.cp(source, dest, { recursive: true });
    });
    assert.deepEqual(result.linked, []);
    if (fail) {
      // cp lists every file; the note keeps the gist so results stay readable.
      assert.match(result.failed[0], /deps\/ \(Command failed: cp -cR deps cp: deps\/f0: clonefile failed: Operation not permitted … and 4999 more line\(s\)\)$/);
      assert.ok(result.failed[0].length < 600);
    }
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

test('Windows clears read-only directories and files in both trees before Git removal, after detaching links', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-readonly-')));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }); });
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: repo });
  const wt = await createWorktree(repo, 'cx-123abc', 'HEAD', home);
  const admin = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: wt.path, encoding: 'utf8' }).trim();
  const outside = path.join(home, 'shared');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'tool'), 'keep');
  const link = path.join(wt.path, 'node_modules');
  fs.symlinkSync(outside, link, 'junction');
  const dirs = [wt.path, path.join(wt.path, 'readonly-dir'), admin, path.join(admin, 'logs'), path.join(admin, 'refs'),
    ...Array.from({ length: 20 }, (_, index) => path.join(wt.path, `nested-${index}`, 'child'))];
  const file = path.join(wt.path, 'readonly');
  fs.writeFileSync(file, 'remove');
  fs.chmodSync(file, 0o444);
  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  // POSIX needs a writable parent to unlink; Windows's directory attribute does not impose that rule.
  for (const dir of dirs.slice(1)) fs.chmodSync(dir, 0o555);
  const prepared: string[][] = [];
  const execFile = childProcess.execFile;
  t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
    if (bin === 'attrib') {
      assert.equal(options.windowsHide, true);
      assert.equal(fs.existsSync(link), false);
      prepared.push(args);
      const recursive = args.includes('/S');
      const root = recursive ? path.dirname(args[1]) : args[1];
      // Git prints the admin directory with forward slashes on Windows; the recursive form is built with path.join.
      assert.ok(path.normalize(root) === wt.path || path.normalize(root) === path.normalize(admin));
      assert.deepEqual(args, ['-R', recursive ? path.join(root, '*') : root, ...(recursive ? ['/S'] : []), '/D', '/L']);
      const clear = (file: string) => {
        const entry = fs.lstatSync(file);
        assert.equal(entry.isSymbolicLink(), false);
        fs.chmodSync(file, entry.mode | (entry.isDirectory() ? 0o700 : 0o200));
        if (recursive && entry.isDirectory()) for (const name of fs.readdirSync(file)) clear(path.join(file, name));
      };
      if (recursive) for (const name of fs.readdirSync(root)) clear(path.join(root, name));
      else clear(root);
      return execFile(process.execPath, ['-e', ''], options, callback);
    }
    if (bin === 'git' && args[1] === 'remove') {
      assert.deepEqual(prepared, [
        ['-R', wt.path, '/D', '/L'], ['-R', path.join(wt.path, '*'), '/S', '/D', '/L'],
        ['-R', admin, '/D', '/L'], ['-R', path.join(admin, '*'), '/S', '/D', '/L'],
      ]);
      for (const dir of dirs) assert.ok(fs.statSync(dir).mode & 0o200, dir);
      assert.ok(fs.statSync(file).mode & 0o200);
    }
    return execFile(bin, args, options, callback);
  });
  syncBuiltinESMExports();
  await removeWorktree(repo, wt, 'cx-123abc', home, 'win32');
  assert.equal(fs.readFileSync(path.join(outside, 'tool'), 'utf8'), 'keep');
  assert.ok(!fs.existsSync(wt.path));
  assert.ok(!fs.existsSync(admin));
});

test('directory-style Windows junctions are detached non-recursively', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-junction-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const dir = path.join(home, 'tree');
  const outside = path.join(home, 'outside');
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'tool'), 'keep');
  const link = path.join(dir, 'deps');
  fs.symlinkSync(outside, link, 'junction');
  const lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async (file: any) => file === link ? fs.statSync(outside) : lstat(file));
  const rmdir = t.mock.method(fs.promises, 'rmdir', async (file: any) => {
    assert.equal(file, link);
    await fs.promises.unlink(file);
  });
  await detachLinks(dir, 'win32');
  assert.equal(rmdir.mock.callCount(), 1);
  assert.equal(fs.existsSync(link), false);
  assert.equal(fs.readFileSync(path.join(outside, 'tool'), 'utf8'), 'keep');
});

for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY']) test(`Windows removal retries ${code} with bounded backoff`, async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-retry-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  // A missing root needs no attrib command.
  const dir = path.join(home, 'missing');
  const waits: number[] = [];
  t.mock.method(globalThis, 'setTimeout', (callback: () => void, delay: number) => { waits.push(delay); queueMicrotask(callback); });
  let calls = 0;
  t.mock.method(fs.promises, 'rm', async () => { if (++calls < 4) throw Object.assign(new Error('locked'), { code }); });
  await removeDirectory(dir, 'win32');
  assert.equal(calls, 4);
  assert.deepEqual(waits, [100, 200, 300]);
});

test('Windows preparation refuses a Git admin path outside common/worktrees before detaching anything', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-admin-guard-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const repo = path.join(home, 'repo');
  fs.mkdirSync(repo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-qm', 'init'], { cwd: repo });
  const wt = await createWorktree(repo, 'cx-abcdef', 'HEAD', home);
  // Git hides `.git` on Windows, and a hidden file cannot be opened for writing.
  fs.rmSync(path.join(wt.path, '.git'));
  fs.writeFileSync(path.join(wt.path, '.git'), `gitdir: ${path.join(repo, '.git')}\n`);
  fs.symlinkSync(repo, path.join(wt.path, 'shared'), 'junction');
  const unlink = t.mock.method(fs.promises, 'unlink');
  await assert.rejects(removeWorktree(repo, wt, 'cx-abcdef', home, 'win32'), /Refusing to prepare Git metadata outside/);
  assert.equal(unlink.mock.callCount(), 0);
  assert.ok(fs.lstatSync(path.join(wt.path, 'shared')).isSymbolicLink());
});

for (const failed of [false, true]) for (const stream of ['stdout', 'stderr']) {
  test(`Windows cleanup tolerates unmatched wildcards in ${stream} (nonzero exit: ${failed})`, async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-attrib-empty-')));
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
    const calls: string[][] = [];
    t.mock.method(childProcess, 'execFile', (bin: string, args: string[], options: any, callback: any) => {
      assert.equal(bin, 'attrib');
      assert.equal(options.windowsHide, true);
      calls.push(args);
      const recursive = args.includes('/S');
      const output = recursive ? `File not found - ${path.join(dir, '*')}\r\n` : '';
      queueMicrotask(() => callback(recursive && failed ? Object.assign(new Error('attrib failed'), { code: 1 }) : null,
        stream === 'stdout' ? output : '', stream === 'stderr' ? output : ''));
      return {} as any;
    });
    syncBuiltinESMExports();
    // English "File not found" output for an unmatched wildcard is still tolerated.
    fs.writeFileSync(path.join(dir, 'child'), '');
    await removeDirectory(dir, 'win32');
    assert.deepEqual(calls, [['-R', dir, '/D', '/L'], ['-R', path.join(dir, '*'), '/S', '/D', '/L']]);
    assert.equal(fs.existsSync(dir), false);
  });
}

test('Windows cleanup of an empty directory runs no recursive attrib, whose message is localized', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-attrib-empty-')));
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
  const calls: string[][] = [];
  t.mock.method(childProcess, 'execFile', (_bin: string, args: string[], _options: any, callback: any) => {
    calls.push(args);
    queueMicrotask(() => callback(args.includes('/S') ? Object.assign(new Error('파일을 찾을 수 없습니다'), { code: 1 }) : null, '', ''));
    return {} as any;
  });
  syncBuiltinESMExports();
  await removeDirectory(dir, 'win32');
  assert.deepEqual(calls, [['-R', dir, '/D', '/L']]);
  assert.equal(fs.existsSync(dir), false);
});

const attribErrors = [
  { name: 'access denied', output: 'Access denied - child', failed: true, root: false },
  { name: 'mixed missing and denied paths', output: 'File not found - child\r\nAccess denied - other', failed: true, root: false },
  { name: 'error output with a zero exit status', output: 'Access denied - child', failed: false, root: false },
  { name: 'a missing attrib executable', output: '', failed: true, root: false },
  { name: 'a missing root rather than an unmatched wildcard', output: 'File not found - root', failed: true, root: true },
  { name: 'a hidden .git file', output: 'Not resetting hidden file - .git', failed: false, root: false },
  { name: 'localized hidden file output', output: '숨김 파일을 다시 설정하지 않습니다 - .git', failed: true, root: false },
];
for (const { name, output, failed, root } of attribErrors) {
  test(`Windows removal proceeds despite attrib reporting ${name}`, async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-attrib-error-')));
    fs.writeFileSync(path.join(dir, 'child'), '');
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); fs.rmSync(dir, { recursive: true, force: true }); });
    const failure = Object.assign(new Error(output || 'spawn attrib ENOENT'), { code: output ? 1 : 'ENOENT' });
    t.mock.method(childProcess, 'execFile', (bin: string, args: string[], _options: any, callback: any) => {
      assert.equal(bin, 'attrib');
      const errorHere = root || args.includes('/S');
      queueMicrotask(() => callback(errorHere && failed ? failure : null, errorHere ? output : '', ''));
      return {} as any;
    });
    syncBuiltinESMExports();
    await removeDirectory(dir, 'win32');
    assert.equal(fs.existsSync(dir), false);
  });
}

test('removeEmptyLeftover removes only an empty directory inside the worktree directory', async (t) => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-leftover-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));
  const worktrees = path.join(home, 'worktrees');
  const empty = path.join(worktrees, 'repo-1', 'cx-aaaaaa');
  const full = path.join(worktrees, 'repo-1', 'cx-bbbbbb');
  fs.mkdirSync(empty, { recursive: true });
  fs.mkdirSync(full, { recursive: true });
  fs.writeFileSync(path.join(full, 'file'), 'keep');
  assert.equal(await removeEmptyLeftover(empty, home), true);
  assert.equal(fs.existsSync(empty), false);
  assert.equal(await removeEmptyLeftover(empty, home), true);
  assert.equal(await removeEmptyLeftover(full, home), false);
  assert.ok(fs.existsSync(path.join(full, 'file')));
  const outside = path.join(home, 'elsewhere');
  fs.mkdirSync(outside);
  await assert.rejects(removeEmptyLeftover(outside, home), /outside the Crew worktree directory/);
  await assert.rejects(removeEmptyLeftover(worktrees, home), /outside the Crew worktree directory/);
  assert.ok(fs.existsSync(outside));
});

test('removeEmptyLeftover refuses a worktrees directory that links elsewhere', async (t) => {
  const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-leftover-link-')));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const home = path.join(temp, 'home');
  const outside = path.join(temp, 'outside', 'repo', 'cx-aaaaaa');
  fs.mkdirSync(home);
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(path.join(temp, 'outside'), path.join(home, 'worktrees'), 'junction');
  await assert.rejects(removeEmptyLeftover(path.join(home, 'worktrees', 'repo', 'cx-aaaaaa'), home), /outside the Crew worktree directory/);
  assert.ok(fs.existsSync(outside));
});
