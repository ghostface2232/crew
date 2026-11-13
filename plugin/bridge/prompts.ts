import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './config.ts';
import type { Worktree } from './git.ts';
import type { JobSpec, ReviewTarget } from './jobs.ts';
import type { Skill } from './skills.ts';

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
export function buildPrompt(spec: JobSpec, worktree: Worktree | null, diffFile: string | null = null, shared = '', scratch?: string, commands = true, skills: Skill[] = []): { prompt: string; instructions: string } {
  const assigned = assignment(spec, worktree, diffFile);
  // A worker that runs commands shares the machine with the user and the other agents; one that cannot start
  // anything has no use for the rules. These parts go with the instructions, not the prompt: Codex's built-in
  // review is sent no prompt, and must still be told them.
  const parts = commands ? [assigned.instructions, role('machine'), LEAD_QUESTIONS] : [assigned.instructions, LEAD_QUESTIONS];
  if (spec.runsApp) parts.push(spec.kind === 'review' ? `${RUNS_APP}\n${SNAPSHOT}` : RUNS_APP);
  else if (spec.kind === 'review') parts.push(diffFile ? READ_ONLY_REVIEW : STATIC_REVIEW);
  if (scratch) parts.push(scratchNote(scratch));
  if (spec.exclusive) parts.push(ALONE);
  if (spec.plugins?.length) parts.push(pluginsNote(spec.plugins));
  if (skills.length) parts.push(skillsNote(skills));
  const built = { ...assigned, instructions: parts.join('\n\n') };
  if (!shared) return built;
  // After the role, and subordinate to it: what a role may do is enforced by the bridge, not negotiable in prose.
  const preface = 'These apply to every agent on the crew. Follow them within your role: they do not widen what the role allows, and where the two conflict, the role wins.';
  return { ...built, instructions: `${built.instructions}\n\n# Shared instructions\n${preface}\n\n${shared}` };
}

/**
 * A worker's review is static unless the lead marked it as running the app. A static review runs in a read-only
 * sandbox, which cannot hold an instance of the app, and a second reviewer is often at work on the same change.
 */
const STATIC_REVIEW = '# Static review\nReview by reading, and by running checks that end by themselves, such as tests and type checks. Do not start the app, a server, or a browser: another reviewer may be running one.';
const LEAD_QUESTIONS = '# Questions for the lead\nUse crew.ask_lead for a decision or fact only the lead has, or when something outside your allowed files must change. Keep working on what the answer does not affect; call crew.lead_answers when you reach what it blocks (wait_seconds waits for an answer). Read and investigate things you can find yourself. Approvals go to the user through the normal approval flow, not ask_lead. Use crew.siblings to see who else is working and on which files. If you cannot run commands, crew.search finds text across your working tree and crew.recent_changes shows what was just written. The names may carry a prefix in your tool list, such as mcp_crew_ask_lead.';
/**
 * Says what the sandbox allows before the worker finds out by failing: a check that writes a temporary
 * file is still a check that ends by itself.
 */
const scratchNote = (dir: string) => `# What you can run\nYour sandbox is read-only except for one directory of your own: \`${dir}\`. TMPDIR points there. Use it for anything a check has to write: temporary files, caches, a throwaway copy or clone of the repository to try a change or a git operation in. It is deleted when you finish, so nothing in it is a result. Everything else can be read and not written, apart from a few of the bridge's own files, which are closed to you. The network is closed, and nothing can listen on a port. The directory does not carry over to a follow-up turn, so put the commands you ran and what they showed in your report. If a check needs more than that, do not work around it: list it under what you could not verify.`;
/** Names and paths only: the worker reads what it needs, as it would a skill its own agent listed. */
const skillsNote = (skills: Skill[]) => `# Skills for this task\nThe lead picked these skills as useful for this task. Read each SKILL.md before you start and follow it where it applies, within your role; files it mentions are relative to its directory.\n${skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''} (\`${s.file}\`)`).join('\n')}`;
/**
 * A plugin's tools run outside the sandbox, and computer use acts on the one screen everybody shares, which
 * the isolation rules cannot fence off. So the worker is told where it may act, and to prefer a check without a screen.
 */
const pluginsNote = (plugins: string[]) => `# Plugins\nThese plugins from the user's Codex setup are on for this job, if installed: ${plugins.join(', ')}. Their tools act outside your sandbox. Computer use views and operates the real screen, which the user and other jobs share. Use it only when what you must check is on screen and no screenless check (tests, a headless browser, a request to your server) can answer it. Act only on windows of the instance you started yourself, or in an app or window of the user's that your task names explicitly (such as their Chrome): for that, and only that, the shared-machine rule against touching the user's browser and windows gives way. Do exactly what the task says there and nothing beyond it; leave every other window, tab, app, and file alone, and release the pointer and keyboard as soon as the check finishes. State in your report what you inspected on screen. If a plugin is missing or its tool is refused, report what you could not check.`;
const READ_ONLY_REVIEW = '# Static review\nReview by reading. You cannot run anything in this role, so list every check you would have run under "Not verified".';
const RUNS_APP = '# Running the app\nThis job may start the app to check the change; a sandbox that blocks the network has been opened for that. Follow the shared-machine rules above for every instance you start. Starting a browser may still need approval; ask for it, and if it is refused, report what you could not check.';
const SNAPSHOT = 'You are in a snapshot of the change, not the user\'s working tree: nothing you write here is kept. Report findings with paths relative to the repository root.';
const ALONE = '# Measurement\nThis job has the machine to itself: no other Crew job runs until it ends. Take your measurements now, and report the conditions with the numbers: what was running, how many runs, and the spread between them.';

function assignment(spec: JobSpec, worktree: Worktree | null, diffFile: string | null): { prompt: string; instructions: string } {
  if (spec.ask) {
    const parts = [`# Question\n${spec.task}`];
    if (spec.done_when) parts.push(`# Acceptance criteria\n${spec.done_when}`);
    return { instructions: role('question'), prompt: parts.join('\n\n') };
  }
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
