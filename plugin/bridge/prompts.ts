import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './config.ts';
import type { Worktree } from './git.ts';
import type { JobSpec, ReviewTarget } from './jobs.ts';

function role(name: string): string {
  return fs.readFileSync(path.join(PLUGIN_ROOT, 'roles', `${name}.md`), 'utf8').trim();
}

function describeTarget(target: ReviewTarget): string {
  switch (target.type) {
    case 'uncommittedChanges':
      return 'the uncommitted changes in this repository (`git status`, `git diff HEAD`, plus untracked files)';
    case 'baseBranch':
      return `the changes on the current branch relative to \`${target.branch}\` (\`git diff ${target.branch}...HEAD\`)`;
    case 'commit':
      return `commit \`${target.sha}\` (\`git show ${target.sha}\`)`;
  }
}

/** Role text goes in `instructions`; the concrete assignment goes in `prompt`. */
export function buildPrompt(spec: JobSpec, worktree: Worktree | null): { prompt: string; instructions: string } {
  const where = worktree
    ? `You are working in an isolated git worktree (branch \`${worktree.branch}\`). Edit files only inside it. Do not commit, push, or switch branches: the bridge commits your changes when you finish.`
    : spec.kind === 'review'
      ? ''
      : 'You are editing the working directory in place. Do not commit, push, or switch branches.';

  if (spec.kind === 'delegate') {
    const parts = [`# Task\n${spec.task}`];
    if (spec.done_when) parts.push(`# Done when\n${spec.done_when}`);
    parts.push(`# Workspace\n${where}`);
    return { instructions: role('codex-engineer'), prompt: parts.join('\n\n') };
  }

  if (spec.kind === 'review') {
    const parts = [`# Review target\nReview ${describeTarget(spec.review!.target)}.`];
    if (spec.done_when) parts.push(`# Acceptance criteria\n${spec.done_when}`);
    if (spec.task) parts.push(`# Focus\n${spec.task}`);
    return { instructions: role('codex-reviewer'), prompt: parts.join('\n\n') };
  }

  const parts = [`# Files you may edit\n${spec.targets!.map((t) => `- ${t}`).join('\n')}`];
  if (spec.task) parts.push(`# Guidance from the lead\n${spec.task}`);
  parts.push(`# Workspace\n${where}`);
  // ACP has no separate instruction channel, so the role travels with the prompt.
  return { instructions: '', prompt: `${role('antigravity-polisher')}\n\n${parts.join('\n\n')}` };
}
