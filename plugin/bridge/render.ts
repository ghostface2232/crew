import { unread } from './delivery.ts';
import { checkLine } from './check.ts';
import { WORKERS } from './config.ts';
import { expectsOutcome, jobRole, openRefusals } from './jobs.ts';
import type { Job } from './jobs.ts';

/** Text renderings of a job, shared by the MCP tools, the wake hook, and the CLI. */

export type JobView = Omit<Job, 'prompt' | 'instructions'> & { outcomeContradiction?: string };

/** Command that reopens the worker's session in its own CLI, for the user to take over by hand. */
export function resumeCommand(job: JobView): string {
  return `${WORKERS[job.agent].resume} ${job.sessionId}`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/** Finished, waiting on the user, or asking a lead question not yet delivered. */
export const needsLead = (job: JobView) => job.state !== 'running' || unread(job).some((news) =>
  (news.kind === 'question' && job.questions?.some((q) => q.id === news.question && q.answer === undefined)) || (news.kind === 'stalled' && job.stalled));

function refusedThisTurn(job: JobView): boolean {
  return job.declinedTurn === job.turns || Boolean(job.refusals?.some((r) => r.turn === job.turns));
}

function noChangesAfterRefusal(job: JobView): boolean {
  return job.state === 'done' && job.result?.files.length === 0 && refusedThisTurn(job);
}

/** Keeps a declared success from obscuring a failed check or a refusal that left no changes. */
export function outcomeContradiction(job: JobView): string | undefined {
  if (job.state !== 'done' || job.outcome !== 'done' || !expectsOutcome(job)) return;
  const observations: string[] = [];
  const receipt = job.receipts?.at(-1);
  const check = receipt?.check;
  if (receipt?.turn === job.turns && check && !check.skipped && check.exit !== 0) {
    observations.push(check.timedOut ? 'the bridge check timed out' : check.exit === null ? 'the bridge check could not run' : 'the bridge check failed');
  }
  if (noChangesAfterRefusal(job)) observations.push('no files changed after an action was refused or declined');
  return observations.join(' and ') || undefined;
}

/** `waitingHint` replaces the default advice on how to settle a waiting job. */
export function describe(job: JobView, waitingHint?: string): string {
  const elapsed = duration((job.endedAt ?? Date.now()) - job.createdAt);
  const kind = job.debate ? `debate, round ${job.turns} of ${job.debate.rounds}` : jobRole(job);
  const lines = [`[${job.id}] ${WORKERS[job.agent].name} · ${kind} · ${job.state.toUpperCase()} (${elapsed}) — ${job.title}`];

  const effort = job.resolvedEffort ?? (job.agent === 'codex' && !job.nativeReview ? job.effort : undefined);
  lines.push(`model: ${job.resolvedModel ?? job.model ?? 'unknown (agent default)'}${effort ? ` · effort: ${effort}` : ''}${job.tier && job.tier !== 'standard' ? ` · tier: ${job.tier}` : ''}${job.preset ? ` · preset: ${job.preset}` : ''}`);

  for (const question of job.questions ?? []) {
    if (question.answer !== undefined) continue;
    lines.push(`ASKS YOU: [${question.id}] ${question.text}`);
    if (question.blocks) lines.push(`Blocks: ${question.blocks}`);
    const shown = (question.attachments ?? []).map((file) => job.evidence?.find((item) => item.file === file)?.path ?? file);
    if (shown.length) lines.push(`Attached: ${shown.join(', ')}`);
    lines.push(`Call answer with job_id "${job.id}", question_id "${question.id}" and your answer, then end your turn; you are woken when it ends or needs you.`);
  }

  if (job.state === 'running') {
    lines.push(`now: ${job.phase}${job.stalled ? ' — no activity for a while, may be stuck' : ''}`);
    lines.push(job.stalled
      ? unread(job).some((news) => news.kind === 'stalled')
        ? `The worker may be stuck, and nothing confirmed it is still working. Check its status again later, reply to steer it, or cancel it.`
        : `No recent activity was observed; this is not proof the worker stopped. Completion and questions are still watched.`
      : 'Still working. You are woken when it ends or needs you; end your turn rather than waiting on it.');
  }
  if (job.state === 'waiting') {
    const waiting = job.waiting!;
    lines.push(`NEEDS A DECISION:\n${waiting.reason}`);
    const ask = `wait with job id "${job.id}" so the user is asked in the app`;
    if (waiting.type === 'approval') {
      lines.push('Approval is the user\'s call. Never approve on your own. If the request is clearly outside the task or role, use reply with decision "decline" and a message saying why and what to do instead.');
      lines.push(waitingHint ?? `Otherwise, call ${ask}, or relay their decision with reply ("approve" or "deny"${waiting.grant ? `, or "allow_for_job" if they allowed ${waiting.grant} for the rest of this job` : ''}).`);
    } else lines.push(waitingHint ?? `Call ${ask}, or use reply with the answer they gave you.`);
    lines.push(`When settling the request, pass request_id: "${waiting.id}".`);
  }
  const receipt = job.receipts?.at(-1);
  if (receipt) {
    const at = receipt.head ? ` at ${receipt.head.slice(0, 8)}` : '';
    const stale = receipt.stale ? ` — no longer current: ${receipt.stale} since` : '';
    if (receipt.reviewed) {
      lines.push(`reviewed (turn ${receipt.turn}): ${receipt.reviewed.target}${at}${receipt.reviewed.diff ? `, diff ${receipt.reviewed.diff}` : ''}${stale}`);
    } else if (receipt.check) {
      lines.push(`check by the bridge (turn ${receipt.turn}${at}): ${checkLine(receipt.check)}${stale}`);
      if (receipt.check.exit !== 0 && receipt.check.output) lines.push(`check output (end):\n${receipt.check.output.split('\n').slice(-15).map((line) => `  ${line}`).join('\n')}`);
    }
  }
  if (job.capabilities) {
    const { filesystem, network, plugins } = job.capabilities;
    lines.push(`runs with: ${filesystem}; network ${network}${plugins.length ? `; plugins ${plugins.join(', ')} (act outside the sandbox)` : ''}`);
  }
  const approval = job.approvals?.at(-1);
  if (approval) {
    const basis = approval.recorded
      ? `the user's own ${approval.recorded} recent message(s) went with it${approval.matched ? ', and your quote matches one' : '; your quote is a translation or paraphrase of them'}`
      : 'no messages of the user were recorded for your session, so only your quote went with it';
    lines.push(`approval relayed for turn ${approval.turn}: ${basis}.`);
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
  if (job.cleanupPending) {
    lines.push(heldFolderOnly(job)
      ? 'Cleanup: Windows still holds the empty worktree folder; it is removed automatically.'
      : `Cleanup incomplete: ${job.cleanupPending.join('; ') || 'Git registration unconfirmed'}; run crew gc.`);
  }
  if (job.state === 'done' && expectsOutcome(job)) {
    const contradiction = outcomeContradiction(job);
    lines.push(!job.outcome ? 'outcome: not declared — read the report before treating this as finished'
      : contradiction ? `outcome: done as declared, but ${contradiction}`
        : `outcome: ${job.outcome}${job.outcome === 'done' ? '' : ' — see Open points in the report'}`);
  }
  if (job.result) {
    lines.push(`changes: ${noChangesAfterRefusal(job) ? 'none — an action was refused or declined; see refusals/notes below' : job.result.stat || 'none'}${job.result.commit ? ` · commit ${job.result.commit}` : ''}`);
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
  // Paths, so a reader without the images (the wake hook, the CLI) can still open them.
  const evidence = (job.evidence ?? []).filter((item) => item.from === 'worker');
  const latest = evidence.filter((item) => item.turn === job.turns);
  if (evidence.length) {
    lines.push(`evidence: ${latest.length ? `${latest.length} file(s) from turn ${job.turns}` : 'none from this turn'}${evidence.length > latest.length ? `, ${evidence.length - latest.length} earlier` : ''}`);
    for (const item of latest) lines.push(`  ${item.path}`);
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

/** Only the emptied worktree folder is left; the bridge's delayed retries remove it without the user. */
function heldFolderOnly(job: JobView): boolean {
  return Boolean(job.worktree) && job.cleanupPending?.length === 1 && job.cleanupPending[0] === `directory ${job.worktree!.path}`;
}

export function summarize(job: JobView): string {
  const tail = job.state === 'running' ? job.phase : job.state === 'waiting' ? `needs a decision: ${job.waiting!.reason}` : (job.error?.message ?? job.result?.stat ?? '');
  const unread = job.endedAt && job.seq > job.delivered ? ' (result not read yet)' : '';
  return `[${job.id}] ${WORKERS[job.agent].name} · ${jobRole(job)} · ${job.state} (${duration((job.endedAt ?? Date.now()) - job.createdAt)}) — ${job.title}${tail ? ` — ${tail}` : ''}${unread}${job.cleanupPending ? heldFolderOnly(job) ? ' — empty worktree folder still held; removed automatically' : ` — cleanup incomplete (${job.cleanupPending.join('; ')}); run crew gc` : ''}`;
}
