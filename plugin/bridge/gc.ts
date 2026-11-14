import fs from 'node:fs/promises';
import path from 'node:path';
import { commonGitDir, git, isInside, prepareRemoval, realpath, removeDirectory, requireAdminDir, worktreePath } from './git.ts';
import type { Job } from './jobs.ts';

const workerId = /^(cx|ag)-[0-9a-f]{6}$/;
const workerBranch = /^crew-((cx|ag)-[0-9a-f]{6})$/;

async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(() => true, (err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return false;
  });
}

async function names(dir: string): Promise<string[]> {
  return fs.readdir(dir).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') throw err;
    return [];
  });
}

function requireCrewPath(home: string, file: string): void {
  const trees = path.join(home, 'worktrees');
  const rel = path.relative(realpath(trees), realpath(file));
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)
      || !isInside(home, trees) || !isInside(trees, file)) {
    throw new Error(`Refusing to clean a path outside the Crew worktree directory: ${file}`);
  }
}

/** Jobs holds a reservation while this runs; a busy repository is left entirely alone. */
export async function collectGarbage(home: string, jobs: Job[], busy: (job: Job) => boolean,
  options: { apply?: boolean; branches?: boolean }, platform: NodeJS.Platform = process.platform): Promise<string> {
  const lines = [options.apply ? 'Crew gc: applying cleanup.' : 'Crew gc: dry run; nothing will be changed. Use --apply to clean up.'];
  const key = (file: string) => platform === 'win32' ? realpath(file).toLowerCase() : realpath(file);
  const roots = [...new Set(jobs.map((job) => job.repo).filter((root): root is string => Boolean(root)))];
  for (const root of roots) {
    lines.push(`Repository: ${root}`);
    const mine = jobs.filter((job) => job.repo === root);
    if (mine.some(busy)) {
      lines.push('  Skipped: a job is active or changing its workspace.');
      continue;
    }
    try {
      const common = await commonGitDir(root);
      const listed = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
      const registered = new Set(listed.filter((line) => line.startsWith('worktree ')).map((line) => key(line.slice(9))));
      const owned = (file: string) => jobs.some((job) => job.worktree && key(job.worktree.path) === key(file) && (!job.cleanupPending || busy(job)));
      const dir = worktreePath(root, '', home);
      requireCrewPath(home, dir);
      for (const id of await names(dir)) {
        if (!workerId.test(id)) continue;
        const orphan = path.join(dir, id);
        requireCrewPath(home, orphan);
        const entry = await fs.lstat(orphan);
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        if (registered.has(key(orphan)) || owned(orphan)) continue;
        const dotGit = path.join(orphan, '.git');
        if ((await fs.lstat(dotGit).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
          return null;
        }))?.isFile()) {
          const admin = /^gitdir: (.+)$/m.exec(await fs.readFile(dotGit, 'utf8'))?.[1].trim();
          if (admin && (await fs.stat(path.resolve(orphan, admin)).catch((err: NodeJS.ErrnoException) => {
            if (err.code !== 'ENOENT') throw err;
            return null;
          }))?.isDirectory()) continue;
        }
        lines.push(`  Directory: ${orphan}`);
        if (options.apply) {
          await removeDirectory(orphan, platform);
          lines.push('    Removed.');
        }
      }

      const parent = path.join(common, 'worktrees');
      if (!isInside(common, parent)) throw new Error(`Refusing to follow Git metadata outside ${common}: ${parent}`);
      const admins: string[] = [];
      let pruneSafe = true;
      for (const name of await names(parent)) {
        const admin = path.join(parent, name);
        requireAdminDir(common, admin);
        const pointer = path.join(admin, 'gitdir');
        const entry = await fs.lstat(pointer).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
          return null;
        });
        // A global prune also visits unrelated entries; do not let it delete unknown or owned metadata.
        if (!entry?.isFile()) {
          const owner = mine.find((job) => job.cleanupPending && job.worktree?.admin && key(job.worktree.admin) === key(admin));
          if (!entry && owner?.worktree && !busy(owner) && !await exists(owner.worktree.path)) {
            requireCrewPath(home, owner.worktree.path);
            admins.push(admin);
            lines.push(`  Git admin directory: ${admin} (recorded failed discard; gitdir is missing)`);
          } else pruneSafe = false;
          continue;
        }
        const value = (await fs.readFile(pointer, 'utf8')).trim();
        const target = path.resolve(admin, value);
        if (!value || path.basename(target) !== '.git') { pruneSafe = false; continue; }
        if (await exists(target)) continue;
        const wt = path.dirname(target);
        if (await exists(wt) || owned(wt) || !isInside(path.join(home, 'worktrees'), wt)) {
          pruneSafe = false;
          continue;
        }
        requireCrewPath(home, wt);
        admins.push(admin);
        lines.push(`  Git admin directory: ${admin} (missing worktree ${wt})`);
      }
      if (options.apply && admins.length) {
        if (!pruneSafe) lines.push('    Prune skipped: it could also remove unrelated or owned Git metadata.');
        else {
          for (const admin of admins) await prepareRemoval(admin, platform);
          for (let attempt = 0; ; attempt++) {
            try {
              await git(root, ['worktree', 'prune', '--expire', 'now']);
              if (!(await Promise.all(admins.map(exists))).some(Boolean) || platform !== 'win32' || attempt === 5) break;
            } catch (err) {
              if (platform !== 'win32' || attempt === 5) throw err;
            }
            await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
          }
          for (const admin of admins) lines.push(`    ${await exists(admin) ? 'Still present' : 'Pruned'}: ${admin}`);
        }
      }

      // A failed discard can be forgotten only after both its directory and registration are gone.
      const remaining = (await git(root, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
      if (options.apply) for (const job of mine) {
        if (!job.cleanupPending || !job.worktree || busy(job)) continue;
        const adminLeft = (await Promise.all(job.cleanupPending.filter((item) => item.startsWith('Git admin directory '))
          .map((item) => exists(item.slice('Git admin directory '.length))))).some(Boolean);
        if (!await exists(job.worktree.path) && !remaining.some((line) => line.startsWith('worktree ') && key(line.slice(9)) === key(job.worktree!.path))
            && !adminLeft) {
          job.worktree = null;
        }
      }
      const checkedOut = new Set(remaining.filter((line) => line.startsWith('branch refs/heads/')).map((line) => line.slice(18)));
      const branches = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split('\n');
      for (const branch of branches) {
        const id = workerBranch.exec(branch)?.[1];
        if (!id || checkedOut.has(branch)) continue;
        const owner = jobs.find((job) => job.id === id);
        if (owner && (owner.worktree || busy(owner))) continue;
        const merged = await git(root, ['merge-base', '--is-ancestor', branch, 'HEAD']).then(() => true, () => false);
        lines.push(`  Branch: ${branch} (${merged ? 'merged into HEAD' : 'not merged into HEAD'})`);
        if (!merged) lines.push(`    Kept; not merged into HEAD. To delete manually: git branch -D ${branch}`);
        else if (options.apply && options.branches) {
          await git(root, ['branch', '-d', branch]);
          lines.push('    Deleted.');
        } else if (options.apply) lines.push('    Kept; add --branches to delete merged branches.');
      }
      if (options.apply) for (const job of mine) {
        if (!job.cleanupPending || busy(job)) continue;
        const leftovers: string[] = [];
        for (const item of job.cleanupPending) {
          if (item.startsWith('branch ')) {
            if (await git(root, ['branch', '--list', '--format=%(refname:short)', item.slice(7)])) leftovers.push(item);
          } else {
            const prefix = item.startsWith('Git admin directory ') ? 'Git admin directory ' : 'directory ';
            if (await exists(item.slice(prefix.length))) leftovers.push(item);
          }
        }
        if (leftovers.length) job.cleanupPending = leftovers;
        else if (!job.worktree) {
          delete job.cleanupPending;
          job.notes.push('Worktree leftovers removed by crew gc.');
        }
      }
    } catch (err) {
      lines.push(`  Cleanup failed: ${(err as Error).message}`);
    }
  }
  if (!roots.length) lines.push('No known repositories.');
  return lines.join('\n');
}
