import type { Job } from './jobs.ts';

/** Text renderings of a job, shared by the MCP tools, the wake hook, and the CLI. */

export type JobView = Omit<Job, 'prompt' | 'instructions'>;
export const AGENT_NAMES = { codex: 'Codex', antigravity: 'Antigravity' };

/** Command that reopens the worker's session in its own CLI, for the user to take over by hand. */
export function resumeCommand(job: JobView): string {
  return job.agent === 'codex' ? `codex resume ${job.sessionId}` : `agy --conversation ${job.sessionId}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** True once the job is no longer just running: it ended, or it is waiting on the lead. */
export const needsLead = (job: JobView) => job.state !== 'running';

/** `waitingHint` replaces the default advice on how to settle a waiting job. */
export function describe(job: JobView, waitingHint?: string): string {
  const elapsed = duration((job.endedAt ?? Date.now()) - job.createdAt);
  const lines = [`[${job.id}] ${AGENT_NAMES[job.agent]} · ${job.kind} · ${job.state.toUpperCase()} (${elapsed}) — ${job.title}`];

  if (job.state === 'running') {
    lines.push(`now: ${job.phase}${job.stalled ? ' — no activity for a while, may be stuck' : ''}`);
    lines.push('Still working. You are notified when it ends; call wait to block on it instead.');
  }
  if (job.state === 'waiting') {
    lines.push(`NEEDS A DECISION: ${job.waiting!.reason}`);
    lines.push(waitingHint ?? `This is the user's call, not yours. Call wait with job id "${job.id}" so they are asked in the app; use reply only to pass on a decision they already gave you (decision "approve" or "deny"${job.waiting!.type === 'question' ? ', or a message with the answer' : ''}).`);
  }
  if (job.error) {
    lines.push(`error: ${job.error.message}`);
    if (job.error.limit) lines.push(`${AGENT_NAMES[job.agent]} is out of usage for now. Do this piece yourself, and tell the user the ${job.kind === 'review' ? 'cross-review was skipped' : 'work was not delegated'}.`);
  }
  if (job.worktree) lines.push(`worktree: ${job.worktree.path} (branch ${job.worktree.branch}, base ${job.worktree.base.slice(0, 8)})`);
  if (job.result) {
    lines.push(`changes: ${job.result.stat || 'none'}${job.result.commit ? ` · commit ${job.result.commit}` : ''}`);
    for (const file of job.result.files.slice(0, 40)) lines.push(`  ${file}`);
    if (job.result.files.length > 40) lines.push(`  … and ${job.result.files.length - 40} more`);
    if (job.result.outOfScope.length) lines.push(`OUT OF SCOPE — changed but not in the allowed targets: ${job.result.outOfScope.join(', ')}`);
  }
  for (const note of job.notes) lines.push(`note: ${note}`);
  if (job.sessionId) lines.push(`session: ${resumeCommand(job)}`);
  if (job.report) lines.push('', '--- report ---', job.report);

  if (job.state === 'done' && job.worktree && job.result?.files.length) {
    const { branch, base } = job.worktree;
    lines.push(
      '',
      '--- next ---',
      `Inspect: git diff ${base.slice(0, 8)}..${branch}`,
      `Accept:  git merge --squash ${branch}   (or cherry-pick ${job.result.commit})`,
      `Fix:     reply with a message describing what to change`,
      `Then:    cancel with discard: true to remove the worktree and branch`,
    );
  }
  return lines.join('\n');
}

export function summarize(job: JobView): string {
  const tail = job.state === 'running' ? job.phase : job.state === 'waiting' ? `needs a decision: ${job.waiting!.reason}` : (job.error?.message ?? job.result?.stat ?? '');
  const unread = job.endedAt && job.seq > job.delivered ? ' (result not read yet)' : '';
  return `[${job.id}] ${AGENT_NAMES[job.agent]} · ${job.kind} · ${job.state} (${duration((job.endedAt ?? Date.now()) - job.createdAt)}) — ${job.title}${tail ? ` — ${tail}` : ''}${unread}`;
}
