import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ReviewTarget } from './jobs.ts';

export function git(cwd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

/** The change under review as text, for a reviewer that cannot run git itself. */
export async function reviewDiff(root: string, target: ReviewTarget): Promise<string> {
  if (target.type === 'baseBranch') return git(root, ['diff', `${target.branch}...HEAD`]);
  if (target.type === 'commit') return git(root, ['show', target.sha]);
  const diff = await git(root, ['diff', 'HEAD']);
  const untracked = await git(root, ['ls-files', '--others', '--exclude-standard']);
  return untracked ? `${diff}\n\nUntracked files, not in the diff above; read each one in full:\n${untracked}` : diff;
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/**
 * The main working tree of the repository `cwd` is in, even when `cwd` is inside a linked worktree,
 * or null outside a repository. Project-wide files are looked up here so every worktree shares them.
 * Unlike `repoRoot`, a git failure throws: "could not tell" must not read as "no project".
 */
export async function projectRoot(cwd: string): Promise<string | null> {
  let list: string;
  try {
    list = await git(cwd, ['worktree', 'list', '--porcelain']);
  } catch (err) {
    if (/not a git repository/i.test((err as Error).message)) return null;
    throw err;
  }
  // The main working tree is always listed first.
  return /^worktree (.+)$/m.exec(list)?.[1] ?? null;
}

export interface Worktree {
  path: string;
  branch: string;
  /** Commit the worktree was created from. */
  base: string;
}

/** Number of uncommitted paths in the main tree; a worktree created from a ref will not contain them. */
export async function dirtyCount(root: string): Promise<number> {
  // Every untracked file by name, so a folder holding nothing but Finder's metadata is not counted either.
  const out = await git(root, ['status', '--porcelain', '--untracked-files=all']);
  // Finder's .DS_Store files are never something a worker needs, and they are in most trees that do not ignore them.
  return out.split('\n').filter((line) => line && !/(^|\/)\.DS_Store"?$/.test(line.slice(3))).length;
}

/**
 * Worktrees live outside the repository. Inside it, anything that walks the
 * tree (test discovery, tsc, linters, file watchers) would also pick up the
 * worktree copies.
 */
export async function createWorktree(root: string, id: string, baseRef: string, home: string): Promise<Worktree> {
  const base = await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  const wtPath = worktreePath(root, id, home);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  // Flat rather than `crew/<id>`: a repository with a branch named `crew` cannot also have `crew/...`.
  const branch = `crew-${id}`;
  await git(root, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { path: wtPath, branch, base };
}

/**
 * Copies the main tree's uncommitted changes into a worktree created from HEAD, so a reviewer can run the
 * change under review without touching the user's files. Ignored files are left to `copyIncluded`.
 */
export async function carryUncommitted(root: string, wt: string): Promise<void> {
  // Through a file: `git()` trims its output, and a patch can end in a blank context line.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crew-snapshot-'));
  try {
    const patch = path.join(dir, 'changes.patch');
    // The user's diff settings (no prefix, an external tool, textconv) would produce a patch `git apply` cannot read.
    await git(root, ['diff', 'HEAD', '--binary', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', `--output=${patch}`]);
    if ((await fs.stat(patch)).size) await git(wt, ['apply', '--whitespace=nowarn', patch]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
  const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const file of untracked) {
    await fs.mkdir(path.dirname(path.join(wt, file)), { recursive: true });
    await fs.cp(path.join(root, file), path.join(wt, file), { recursive: true, verbatimSymlinks: true });
  }
}

function worktreePath(root: string, id: string, home: string): string {
  // The hash keeps two repositories with the same folder name apart.
  const repoKey = `${path.basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  return path.join(home, 'worktrees', repoKey, id);
}

/**
 * Copies the gitignored files named in the repository's `.worktreeinclude`
 * (the convention Claude Code uses for its own worktrees) into a new worktree,
 * so a worker can run tests without reinstalling dependencies. Copies rather
 * than links: tools write caches into `node_modules`, and a link would send
 * those writes to the main tree.
 */
export async function copyIncluded(root: string, wt: string): Promise<{ copied: string[]; failed: string[] }> {
  const result = { copied: [] as string[], failed: [] as string[] };
  if (!(await fs.stat(path.join(root, '.worktreeinclude')).catch(() => null))) return result;
  // Let git apply the patterns, so the syntax is exactly .gitignore's.
  const matched = await git(root, ['ls-files', '--others', '--ignored', '--exclude-from=.worktreeinclude', '--directory']);
  if (!matched) return result;
  // Only ignored paths are copied: an untracked, unignored file would end up in the worker's commit.
  const ignored = await git(root, ['check-ignore', '--stdin'], matched).catch(() => '');
  for (const entry of ignored.split('\n').filter(Boolean)) {
    const rel = entry.replace(/\/$/, '');
    try {
      await fs.cp(path.join(root, rel), path.join(wt, rel), {
        recursive: true,
        errorOnExist: false,
        force: false,
        verbatimSymlinks: true,
        // Copy-on-write clone where the filesystem supports it (APFS), so large trees are cheap.
        mode: constants.COPYFILE_FICLONE,
      });
      result.copied.push(entry);
    } catch (err) {
      result.failed.push(`${entry} (${(err as Error).message})`);
    }
  }
  return result;
}

/** True when `file` is `root` or inside it, after resolving symlinks. */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(realpath(root), realpath(path.resolve(root, file)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** Resolves symlinks for the part of the path that exists; the rest may be a file not created yet. */
function realpath(target: string): string {
  let existing = target;
  const rest: string[] = [];
  while (!existsSync(existing) && path.dirname(existing) !== existing) {
    rest.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  return path.join(realpathSync(existing), ...rest);
}

/**
 * Commits whatever the worker left in its worktree. Workers cannot commit
 * themselves: the worktree's git metadata lives outside their sandbox.
 *
 * This is a transport commit the lead squashes or picks, so the user's
 * settings for their own commits must not make it fail: hooks are skipped,
 * signing (which can block on a passphrase prompt nobody sees) is off, and a
 * missing identity falls back to Crew's.
 */
export async function commitAll(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A']);
  const staged = await git(wt, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  await git(wt, [...await commitSettings(wt), 'commit', '--no-verify', '-m', message]);
  return git(wt, ['rev-parse', '--short', 'HEAD']);
}

async function commitSettings(wt: string): Promise<string[]> {
  const settings = ['-c', 'commit.gpgsign=false'];
  const name = await git(wt, ['config', 'user.name']).catch(() => '');
  const email = await git(wt, ['config', 'user.email']).catch(() => '');
  if (!name) settings.push('-c', 'user.name=Crew');
  if (!email) settings.push('-c', 'user.email=crew@localhost');
  return settings;
}

export async function commitChanges(wt: string, commit: string): Promise<{ files: string[]; stat: string }> {
  const names = await git(wt, ['show', '--format=', '--name-only', '-z', commit]);
  const stat = await git(wt, ['show', '--format=', '--shortstat', commit]);
  return { files: names.split('\0').filter(Boolean), stat };
}

/**
 * Merges `ref` of the repository into the branch checked out in `wt` and returns the merged commit.
 * A merge that does not apply cleanly is aborted, so the worktree is left as it was.
 */
export async function mergeInto(wt: string, repo: string, ref: string): Promise<string> {
  const commit = await git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]);
  if (await dirtyCount(wt)) throw new Error('The worktree has uncommitted changes, so nothing was merged into it.');
  try {
    await git(wt, [...await commitSettings(wt), '-c', `core.hooksPath=${os.devNull}`, 'merge', '--no-edit', commit]);
  } catch (err) {
    const conflicts = (await git(wt, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    await git(wt, ['merge', '--abort']).catch(() => {});
    throw new Error(`Could not merge ${commit.slice(0, 8)} into the worker's branch${conflicts.length ? `; conflicted files: ${conflicts.join(', ')}` : ''}: ${(err as Error).message}`);
  }
  return commit;
}

/** Branch checked out in a working tree, or null when HEAD is detached. */
export async function currentBranch(wt: string): Promise<string | null> {
  return git(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null);
}

/** The reverts made since `base`, oldest first, each with the commit it reverts. */
export async function revertsSince(wt: string, base: string): Promise<{ commit: string; reverts: string }[]> {
  const log = await git(wt, ['log', '--reverse', '--format=%H%x00%B%x01', `${base}..HEAD`]);
  return log.split('\x01').flatMap((entry) => {
    const [commit, body = ''] = entry.trim().split('\0');
    const reverted = /^This reverts commit ([0-9a-f]{7,40})\.?$/m.exec(body);
    return commit && reverted ? [{ commit, reverts: reverted[1] }] : [];
  });
}

/** Reverts are transport commits too; a conflict must leave the finished worker's tree untouched. */
export async function revertCommit(wt: string, commit: string): Promise<string> {
  if (await dirtyCount(wt)) throw new Error('The worktree has uncommitted changes; commit or remove them before changing a round.');
  try {
    await git(wt, [...await commitSettings(wt), '-c', `core.hooksPath=${os.devNull}`, 'revert', '--no-edit', commit]);
  } catch (err) {
    const conflicts = (await git(wt, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
    // A preflight failure may not have opened a revert, so abort has nothing to do in that case.
    await git(wt, ['revert', '--abort']).catch(async (abort) => {
      if (await dirtyCount(wt)) throw new Error(`${(err as Error).message}; could not abort the revert: ${abort.message}`);
    });
    throw new Error(`Could not revert ${commit}${conflicts.length ? `; conflicted files: ${conflicts.join(', ')}` : ''}: ${(err as Error).message}`);
  }
  return git(wt, ['rev-parse', '--short', 'HEAD']);
}

export async function changesSince(wt: string, base: string): Promise<{ files: string[]; stat: string }> {
  const names = await git(wt, ['diff', '--name-only', base, 'HEAD']);
  const stat = await git(wt, ['diff', '--shortstat', base, 'HEAD']);
  return { files: names ? names.split('\n') : [], stat };
}

export async function removeWorktree(root: string, wt: Worktree, id: string, home: string): Promise<void> {
  const worktrees = path.join(home, 'worktrees');
  if (!/^(cx|ag)-[0-9a-f]{6}$/.test(id) || wt.branch !== `crew-${id}`
      || path.resolve(wt.path) !== path.resolve(worktreePath(root, id, home))
      || !isInside(worktrees, wt.path) || !isInside(home, worktrees)) {
    throw new Error('Refusing to remove a worktree outside the Crew worktree directory.');
  }
  const entries = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0\0');
  const registered = entries.map((entry) => entry.split('\0')).find(
    ([dir]) => dir.startsWith('worktree ') && realpath(dir.slice(9)) === realpath(wt.path),
  );
  const dir = lstatSync(wt.path, { throwIfNoEntry: false });
  if (registered) {
    if (dir && (!dir.isDirectory() || !lstatSync(path.join(wt.path, '.git'), { throwIfNoEntry: false })?.isFile())) {
      throw new Error(`Refusing to remove ${wt.path}: it is no longer a linked worktree.`);
    }
    if (!registered.includes(`branch refs/heads/${wt.branch}`)) {
      throw new Error(`Refusing to remove ${wt.path}: Git lists it under a different branch.`);
    }
    await git(root, ['worktree', 'remove', '--force', wt.path]);
  } else if (dir) {
    throw new Error(`Refusing to remove ${wt.path}: Git no longer lists it as a worktree.`);
  }
  if (await git(root, ['branch', '--list', '--format=%(refname:short)', wt.branch])) {
    await git(root, ['branch', '-D', wt.branch]);
  }
}
