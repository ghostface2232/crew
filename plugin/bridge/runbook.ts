import { checkLine } from './check.ts';
import { WORKERS } from './config.ts';
import type { Job } from './jobs.ts';
import type { Mission } from './missions.ts';

/**
 * A finished mission as Markdown: what was asked, what the lead recorded about decisions and dead ends,
 * and what each job did and was checked against. It is a draft to read and edit before reusing it, for
 * example as a skill; nothing in it is trusted as an instruction on its own.
 */
export function runbook(mission: Mission, jobs: Job[]): string {
  const date = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : '');
  const out = [
    `# ${mission.title}`,
    '',
    `Mission ${mission.id} · ${mission.state}${mission.outcome ? ` — ${mission.outcome}` : ''} · ${date(mission.createdAt)}${mission.endedAt ? ` to ${date(mission.endedAt)}` : ''}`,
    `Project: ${mission.root}`,
  ];
  if (mission.stages?.length) out.push(`Stages: ${mission.stages.join(' → ')}`);
  if (mission.record) out.push('', '## Decisions and dead ends', '', mission.record);
  if (mission.notes?.length) out.push('', '## Notes pinned by the user', '', ...mission.notes.map((note) => `- ${note.text.replace(/\n/g, '\n  ')}`));

  const own = jobs.filter((job) => job.mission === mission.id).sort((a, b) => a.createdAt - b.createdAt);
  if (own.length) out.push('', '## Jobs');
  for (const job of own) {
    out.push('', `### ${job.id} · ${WORKERS[job.agent].name} · ${job.ask ? 'question' : job.kind} — ${job.title}`, '');
    const facts = [`state: ${job.state}`, `turns: ${job.turns}`];
    const model = job.resolvedModel ?? job.model;
    if (model) facts.push(`model: ${model}${job.resolvedEffort ?? job.effort ? ` (${job.resolvedEffort ?? job.effort})` : ''}`);
    out.push(`- ${facts.join(' · ')}`);
    if (job.result?.stat) out.push(`- changes: ${job.result.stat}${job.result.commit ? ` · ${job.result.commit}` : ''}`);
    if (job.result?.outOfScope.length) out.push(`- out of scope: ${job.result.outOfScope.join(', ')}`);
    for (const receipt of job.receipts ?? []) {
      const at = receipt.head ? ` at ${receipt.head.slice(0, 8)}` : '';
      const stale = receipt.stale ? ` (later ${receipt.stale})` : '';
      if (receipt.check) out.push(`- turn ${receipt.turn} check${at}: ${checkLine(receipt.check)}${stale}`);
      if (receipt.reviewed) out.push(`- turn ${receipt.turn} reviewed ${receipt.reviewed.target}${at}${stale}`);
    }
    for (const refusal of job.refusals ?? []) out.push(`- turn ${refusal.turn} refused: \`${refusal.action.split('\n')[0]}\` (${refusal.reason})`);
    for (const approval of job.approvals ?? []) out.push(`- turn ${approval.turn}: the lead relayed the user's approval${approval.matched ? ', matching their words' : ''}`);
    if (job.error) out.push(`- error: ${job.error.message.split('\n')[0]}`);
    if (job.debate && job.exchange?.length) {
      out.push('', '<details><summary>Debate</summary>', '');
      for (const entry of job.exchange) out.push(`**${entry.from === 'lead' ? 'Lead' : WORKERS[job.agent].name}, round ${entry.turn}**`, '', entry.text, '');
      out.push('</details>');
    } else if (job.report.trim()) out.push('', '<details><summary>Report</summary>', '', job.report.trim(), '', '</details>');
  }
  return `${out.join('\n')}\n`;
}
