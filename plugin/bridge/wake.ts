import { api } from './client.ts';
import { describe, needsLead } from './render.ts';
import type { JobView } from './render.ts';

/**
 * PostToolUse hook (asyncRewake) for the Crew job tools. When a tool call
 * leaves a job running in the background, this process outlives the call,
 * waits for the job to end or need a decision, and exits with code 2 so
 * Claude Code wakes the lead session with the result on stderr.
 *
 * It watches every job the tool result mentions rather than trusting the
 * state printed there: a job reported as running may already be waiting.
 */

const JOB_ID = /\[((?:cx|ag)-[0-9a-f]{6})\]/g;

async function watch(id: string): Promise<JobView | null> {
  let job: JobView = await api('GET', `/api/jobs/${id}`);
  let after = job.seq;
  while (!needsLead(job)) {
    const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=50`);
    job = res.job;
    after = job.seq;
  }
  // The lead may be reading this very result through a blocking wait call; let that win.
  await new Promise((r) => setTimeout(r, 1500));
  const { claimed } = await api('POST', `/api/jobs/${id}/delivered`, { seq: job.seq });
  return claimed ? job : null;
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const text = JSON.stringify(JSON.parse(input).tool_response ?? '');
  const ids = [...new Set([...text.matchAll(JOB_ID)].map((m) => m[1]))];
  if (ids.length === 0) process.exit(0);

  // Wake on the first job with news the lead has not seen. A job whose result the tool call
  // already returned is marked delivered, so its watcher resolves to null and is ignored.
  const job = await Promise.any(ids.map((id) => watch(id).then((j) => j ?? Promise.reject(new Error('already delivered')))));
  const body = describe(job);
  process.stderr.write(`Crew background job update:\n\n${body.length > 9000 ? `${body.slice(0, 9000)}\n… (truncated; call status with job_id "${job.id}" for the rest)` : body}\n`);
  process.exit(2);
} catch {
  // Bridge unreachable, or every watched job was already reported: nothing to say.
  process.exit(0);
}
