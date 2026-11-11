import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './config.ts';
import type { Worktree } from './git.ts';
import type { JobSpec, ReviewTarget } from './jobs.ts';

const ROLE_FILES = { delegate: 'engineer', review: 'reviewer', polish: 'polisher' };

function role(name: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'roles', `${name}.md`), 'utf8').trim();
}

/** With `commands`, says how to see the change; a reviewer that is handed the diff has no use for them. */
function describeTarget(target: ReviewTarget, commands: boolean): string {
  if (!commands) {
    return target.type === 'uncommittedChanges' ? 'the uncommitted changes in this repository'
      : target.type === 'baseBranch' ? `the changes on the current branch relative to \`${target.branch}\``
        : `commit \`${target.sha}\``;
  }
  switch (target.type) {
    case 'uncommittedChanges':
      return 'the uncommitted changes in this repository (`git status`, `git diff HEAD`, plus untracked files)';
    case 'baseBranch':
      return `the changes on the current branch relative to \`${target.branch}\` (\`git diff ${target.branch}...HEAD\`)`;
    case 'commit':
      return `commit \`${target.sha}\` (\`git show ${target.sha}\`)`;
  }
}

/** Role text goes in `instructions`; the concrete assignment goes in `prompt`. Each adapter delivers both its own way. */
export function buildPrompt(spec: JobSpec, worktree: Worktree | null, diffFile: string | null = null, shared = ''): { prompt: string; instructions: string } {
  const built = assignment(spec, worktree, diffFile);
  if (!shared) return built;
  // After the role, and subordinate to it: what a role may do is enforced by the bridge, not negotiable in prose.
  const preface = 'These apply to every agent on the crew. Follow them within your role: they do not widen what the role allows, and where the two conflict, the role wins.';
  return { ...built, instructions: `${built.instructions}\n\n# Shared instructions\n${preface}\n\n${shared}` };
}

function assignment(spec: JobSpec, worktree: Worktree | null, diffFile: string | null): { prompt: string; instructions: string } {
  const where = worktree
    ? `You are working in an isolated git worktree (branch \`${worktree.branch}\`). Edit files only inside it. Do not commit, push, or switch branches: the bridge commits your changes when you finish.`
    : spec.kind === 'review'
      ? ''
      : 'You are editing the working directory in place. Do not commit, push, or switch branches.';

  if (spec.kind === 'delegate') {
    const parts = [`# Task\n${spec.task}`];
    if (spec.done_when) parts.push(`# Done when\n${spec.done_when}`);
    parts.push(`# Workspace\n${where}`);
    return { instructions: role(ROLE_FILES.delegate), prompt: parts.join('\n\n') };
  }

  if (spec.kind === 'review') {
    const target = `# Review target\nReview ${describeTarget(spec.review!.target, !diffFile)}.`;
    const parts = [diffFile ? `${target}\nYou cannot run commands in this role, so the diff is saved at \`${diffFile}\`. Read it first, then the code around each change in the repository. Report the checks you could not run under "Not verified".` : target];
    if (spec.done_when) parts.push(`# Acceptance criteria\n${spec.done_when}`);
    if (spec.task) parts.push(`# Focus\n${spec.task}`);
    return { instructions: role(ROLE_FILES.review), prompt: parts.join('\n\n') };
  }

  const parts = [`# Files you may edit\n${spec.targets!.map((t) => `- ${t}`).join('\n')}`];
  if (spec.task) parts.push(`# Guidance from the lead\n${spec.task}`);
  parts.push(`# Workspace\n${where}`);
  return { instructions: role(ROLE_FILES.polish), prompt: parts.join('\n\n') };
}
