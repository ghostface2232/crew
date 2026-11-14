import { WORKERS } from './config.ts';
import { openRefusals } from './jobs.ts';
import type { Job } from './jobs.ts';

/** Text renderings of a job, shared by the MCP tools, the wake hook, and the CLI. */

export type JobView = Omit<Job, 'prompt' | 'instructions'>;

/** Command that reopens the worker's session in its own CLI, for the user to take over by hand. */
export function resumeCommand(job: JobView): string {
  return `${WORKERS[job.agent].resume} ${job.sessionId}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Finished, waiting on the user, or asking a lead question not yet delivered. */
export const needsLead = (job: JobView) => job.state !== 'running' || ((job.questionSeq ?? 0) > job.delivered && Boolean(job.questions?.some((q) => q.answer === undefined)));

/** `waitingHint` replaces the default advice on how to settle a waiting job. */
export function describe(job: JobView, waitingHint?: string): string {
  const elapsed = duration((job.endedAt ?? Date.now()) - job.createdAt);
  const lines = [`[${job.id}] ${WORKERS[job.agent].name} · ${job.kind} · ${job.state.toUpperCase()} (${elapsed}) — ${job.title}`];

  const effort = job.resolvedEffort ?? (job.agent === 'codex' && !job.nativeReview ? job.effort : undefined);
  lines.push(`model: ${job.resolvedModel ?? job.model ?? 'unknown (agent default)'}${effort ? ` · effort: ${effort}` : ''}`);

  for (const question of job.questions ?? []) {
    if (question.answer !== undefined) continue;
    lines.push(`ASKS YOU: [${question.id}] ${question.text}`);
    if (question.blocks) lines.push(`Blocks: ${question.blocks}`);
    lines.push(`Call answer with job_id "${job.id}", question_id "${question.id}" and your answer, then wait again.`);
  }

  if (job.state === 'running') {
    lines.push(`now: ${job.phase}${job.stalled ? ' — no activity for a while, may be stuck' : ''}`);
    lines.push('Still working. You are woken when it ends or needs you; end your turn rather than waiting on it.');
  }
  if (job.state === 'waiting') {
    lines.push(`NEEDS A DECISION:\n${job.waiting!.reason}`);
    lines.push(waitingHint ?? `This is the user's call, not yours. Call wait with job id "${job.id}" so they are asked in the app; use reply only to pass on a decision they already gave you (decision "approve" or "deny"${job.waiting!.type === 'question' ? ', or a message with the answer' : ''}).`);
    lines.push(`When forwarding the answer, pass request_id: "${job.waiting!.id}".`);
  }
  if (job.error) {
    lines.push(`error: ${job.error.message}`);
    if (job.error.limit) lines.push(`${WORKERS[job.agent].name} is out of usage for now. Do this piece yourself, and tell the user the ${job.kind === 'review' ? 'cross-review was skipped' : 'work was not delegated'}.`);
  }
  if (job.tokens != null) {
    const n = (value: number) => value.toLocaleString('en-US');
    const use = job.tokenUse;
    lines.push(`tokens: ${n(job.tokens)}${use ? ` (input ${n(use.input)}, of which ${n(use.cachedInput)} cached; output ${n(use.output)}${job.turns > 1 ? `; this turn ${n(use.turn)}` : ''})` : ''}`);
  }
  if (job.worktree) lines.push(`worktree: ${job.worktree.path} (branch ${job.worktree.branch}, base ${job.worktree.base.slice(0, 8)})`);
  if (job.cleanupPending) lines.push(`Cleanup incomplete: ${job.cleanupPending.join('; ') || 'Git registration unconfirmed'}; run crew gc.`);
  if (job.result) {
    const blocked = job.state === 'done' && !job.result.files.length && (job.declinedTurn === job.turns || job.refusals?.some((r) => r.turn === job.turns));
    lines.push(`changes: ${blocked ? 'none — an action was refused or declined; see refusals/notes below' : job.result.stat || 'none'}${job.result.commit ? ` · commit ${job.result.commit}` : ''}`);
    for (const file of job.result.files.slice(0, 40)) lines.push(`  ${file}`);
    if (job.result.files.length > 40) lines.push(`  … and ${job.result.files.length - 40} more`);
    if (job.result.outOfScope.length) lines.push(`OUT OF SCOPE — changed but not in the allowed targets: ${job.result.outOfScope.join(', ')}`);
  }
  if (job.runsApp) lines.push(job.kind === 'review' ? 'may run the app, in a snapshot of the change' : 'may run the app');
  if (job.plugins?.length) lines.push(`plugins on: ${job.plugins.join(', ')}`);
  if (job.exclusive) lines.push(job.endedAt ? 'ran alone on the machine' : 'runs alone: no other job starts until this one ends');
  if (job.shared?.length) lines.push(`shared instructions: ${job.shared.join(', ')}`);
  for (const note of job.notes) lines.push(`note: ${note}`);
  const refused = openRefusals(job);
  if (refused.length) {
    lines.push(`REFUSED by ${WORKERS[job.agent].name}'s automatic reviewer:`);
    for (const refusal of refused) {
      const reason = refusal.reason?.trim();
      const generic = reason && /^(?:blocked by policy|denied|refused|not allowed|policy violation)[.!]?$/i.test(reason);
      lines.push(`  ${refusal.action}\n  reason: ${generic ? `${reason} (generic; no specific reason supplied)` : reason || 'no reason given; a retry may have failed before the action ran again'}`);
    }
    if (job.endedAt) {
      lines.push(job.retrying
        ? 'This was already sent back once. If the user\'s request still covers it, call reply with approved_by_user again: the user is then asked about each request directly.'
        : 'If the user\'s request in this conversation covers the refused action, call reply with approved_by_user quoting their words, without asking them again; the reviewer then judges it once more. If it does not, tell the user what was refused and let them decide.');
    }
    lines.push('Do it another way within the job permissions, or report the exact action and message as not verified.');
  }
  if (job.sessionId) lines.push(`session: ${resumeCommand(job)}`);
  // While a follow-up turn runs, the report is the previous turn's, which the lead has already read.
  if (job.report && job.state !== 'running') lines.push('', '--- report ---', job.report);
  else if (job.report) lines.push(`(The report of turn ${job.turns - 1} is not repeated here.)`);

  if (job.state === 'done' && job.worktree && job.result?.files.length) {
    const { branch, base } = job.worktree;
    const commits = job.rounds ? job.rounds.filter((round) => round.state === 'kept').map((round) => round.commit) : job.result.commit ? [job.result.commit] : [];
    lines.push(
      '',
      '--- next ---',
      `Inspect: git diff ${base.slice(0, 8)}..${branch}`,
      `Accept:  git merge --squash ${branch}${commits.length ? `   (or cherry-pick ${commits.join(' ')})` : ''}`,
      `Fix:     reply with a message describing what to change`,
      `Then:    cancel with discard: true to remove the worktree and branch`,
    );
  }
  return lines.join('\n');
}

export function summarize(job: JobView): string {
  const tail = job.state === 'running' ? job.phase : job.state === 'waiting' ? `needs a decision: ${job.waiting!.reason}` : (job.error?.message ?? job.result?.stat ?? '');
  const unread = job.endedAt && job.seq > job.delivered ? ' (result not read yet)' : '';
  return `[${job.id}] ${WORKERS[job.agent].name} · ${job.kind} · ${job.state} (${duration((job.endedAt ?? Date.now()) - job.createdAt)}) — ${job.title}${tail ? ` — ${tail}` : ''}${unread}${job.cleanupPending ? ` — cleanup incomplete (${job.cleanupPending.join('; ')}); run crew gc` : ''}`;
}
