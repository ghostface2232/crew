import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

export function git(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`));
      else resolve(stdout.trim());
    });
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

export async function createWorktree(root: string, id: string, baseRef: string): Promise<Worktree> {
  const base = await git(root, ['rev-parse', '--verify', `${baseRef}^{commit}`]);
  await excludeCrewDir(root);
  const wtPath = path.join(root, '.crew', 'worktrees', id);
  const branch = `crew/${id}`;
  await git(root, ['worktree', 'add', '-b', branch, wtPath, base]);
  return { path: wtPath, branch, base };
}

/** Keeps `.crew/` out of `git status` without touching the tracked .gitignore. */
async function excludeCrewDir(root: string): Promise<void> {
  const common = path.resolve(root, await git(root, ['rev-parse', '--git-common-dir']));
  const file = path.join(common, 'info', 'exclude');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  if (current.split('\n').some((line) => line.trim() === '.crew/')) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${current && !current.endsWith('\n') ? '\n' : ''}.crew/\n`);
}

/**
 * Commits whatever the worker left in its worktree. Workers cannot commit
 * themselves: the worktree's git metadata lives outside their sandbox.
 */
export async function commitAll(wt: string, message: string): Promise<string | null> {
  await git(wt, ['add', '-A']);
  const staged = await git(wt, ['diff', '--cached', '--name-only']);
  if (!staged) return null;
  // The user's commit hooks are meant for their own commits, not this transport commit.
  await git(wt, ['commit', '--no-verify', '-m', message]);
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
