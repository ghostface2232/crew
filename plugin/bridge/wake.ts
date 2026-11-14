import { api } from './client.ts';
import { describe, needsLead } from './render.ts';
import type { JobView } from './render.ts';

/**
 * PostToolUse hook (asyncRewake) for the Crew job tools. When a tool call
 * leaves a job running in the background, this process outlives the call,
 * waits for the job to end, need a decision, or ask a new lead question, and
 * exits with code 2 so Claude Code wakes the lead with the result on stderr.
 *
 * It watches every job the tool result mentions rather than trusting the
 * state printed there: a job reported as running may already be waiting.
 */

const JOB_ID = /\[((?:cx|ag)-[0-9a-f]{6})\]/g;

async function batch(job: JobView): Promise<JobView[]> {
  if (!job.mission) return [job];
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    const { jobs } = await api<{ jobs: JobView[] }>('GET', '/api/state');
    const own = jobs.find((peer) => peer.id === job.id);
    if (!own || own.seq <= own.delivered || !needsLead(own)) return [];
    const peers = jobs.filter((peer) => peer.mission === job.mission && peer.project === job.project
      && Math.abs(peer.createdAt - job.createdAt) <= 20_000 && peer.seq > peer.delivered);
    const decision = peers.some((peer) => peer.state === 'waiting'
      || ((peer.questionSeq ?? 0) > peer.delivered && peer.questions?.some((q) => q.answer === undefined)));
    if (decision || peers.every(needsLead) || Date.now() >= deadline) {
      // Every watcher claims the same first result, so only its winner delivers the batch.
      return peers.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function watch(id: string): Promise<JobView[] | null> {
  let job: JobView = await api('GET', `/api/jobs/${id}`);
  let after = job.seq;
  while (!needsLead(job)) {
    const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=50`);
    job = res.job;
    after = job.seq;
  }
  const peers = await batch(job);
  if (peers.length === 0) return null;
  // The lead may be reading this very result through a blocking wait call; let that win.
  await new Promise((r) => setTimeout(r, 1500));
  job = await api('GET', `/api/jobs/${id}`);
  if (!needsLead(job) || (job.mission && job.seq <= job.delivered)) return null;
  const claimed: JobView[] = [];
  for (const peer of peers) {
    const current: JobView = peer.id === id ? job : await api('GET', `/api/jobs/${peer.id}`);
    if (!needsLead(current)) continue;
    const result = await api('POST', `/api/jobs/${current.id}/delivered`, { seq: current.seq });
    if (result.claimed) claimed.push(current);
    else if (claimed.length === 0) return null;
  }
  return claimed.length ? claimed : null;
}

let input = '';
for await (const chunk of process.stdin) input += chunk;

try {
  const text = JSON.stringify(JSON.parse(input).tool_response ?? '');
  const ids = [...new Set([...text.matchAll(JOB_ID)].map((m) => m[1]))];
  if (ids.length === 0) process.exit(0);

  // Wake on the first job with news the lead has not seen. A job whose result the tool call
  // already returned is marked delivered, so its watcher resolves to null and is ignored.
  const jobs = await Promise.any(ids.map((id) => watch(id).then((j) => j ?? Promise.reject(new Error('already delivered')))));
  const body = jobs.map((job) => {
    const text = describe(job);
    return text.length > 9000 ? `${text.slice(0, 9000)}\n… (truncated; call status with job_id "${job.id}" for the rest)` : text;
  }).join('\n\n');
  process.stderr.write(`Crew background job update:\n\n${body}\n`);
  process.exit(2);
} catch {
  // Bridge unreachable, or every watched job was already reported: nothing to say.
  process.exit(0);
}
