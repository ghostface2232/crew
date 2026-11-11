import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export function git(cwd: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

export async function repoRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

export interface Worktree {
  path: string;
  branch: string;
  /** Commit the worktree was created from. */
  base: string;
}

/** Number of uncommitted paths in the main tree; a worktree created from a ref will not contain them. */
export async function dirtyCount(root: string): Promise<number> {
  const out = await git(root, ['status', '--porcelain']);
  return out ? out.split('\n').length : 0;
}

/**
 * Worktrees live outside the repository. Inside it, anything that walks the
 * tree (test discovery, tsc, linters, file watchers) would also pick up the
 * worktree copies.
 */
export async function createWorktree(root: string, id: string, baseRef: string, home: string): Promise<Worktree> {
  const base = await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  // The hash keeps two repositories with the same folder name apart.
  const repoKey = `${path.basename(root)}-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
  const wtPath = path.join(home, 'worktrees', repoKey, id);
  await fs.mkdir(path.dirname(wtPath), { recursive: true });
  // Flat rather than `crew/<id>`: a repository with a branch named `crew` cannot also have `crew/...`.
  const branch = `crew-${id}`;
  await git(root, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { path: wtPath, branch, base };
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
  const settings = ['-c', 'commit.gpgsign=false'];
  const name = await git(wt, ['config', 'user.name']).catch(() => '');
  const email = await git(wt, ['config', 'user.email']).catch(() => '');
  if (!name) settings.push('-c', 'user.name=Crew');
  if (!email) settings.push('-c', 'user.email=crew@localhost');
  await git(wt, [...settings, 'commit', '--no-verify', '-m', message]);
  return git(wt, ['rev-parse', '--short', 'HEAD']);
}

export async function changesSince(wt: string, base: string): Promise<{ files: string[]; stat: string }> {
  const names = await git(wt, ['diff', '--name-only', base, 'HEAD']);
  const stat = await git(wt, ['diff', '--shortstat', base, 'HEAD']);
  return { files: names ? names.split('\n') : [], stat };
}

export async function removeWorktree(root: string, wt: Worktree): Promise<void> {
  await git(root, ['worktree', 'remove', '--force', wt.path]);
  await git(root, ['branch', '-D', wt.branch]);
}
