import readline from 'node:readline';
import { api, ensureDaemon } from './client.ts';
import { BASE_URL, VERSION } from './config.ts';
import type { CrewEvent, JobSpec } from './jobs.ts';
import { describe, needsLead, summarize } from './render.ts';
import type { JobView } from './render.ts';

/**
 * Stdio MCP server the lead Claude session talks to. It holds no state: every
 * tool call is forwarded to the Crew daemon, which owns the workers.
 *
 * The protocol subset needed here (lifecycle, tools, progress, cancellation) is
 * small, so it is implemented directly; that keeps the plugin free of
 * dependencies and a build step.
 */

const INSTRUCTIONS = `Crew connects this session to two other coding agents that run in the background. You are the lead: you plan, do the main implementation, review, and decide what is merged.

Roles (fixed):
- Codex — supporting engineer and cross-reviewer. \`delegate\` gives it a separable piece of implementation; \`review\` asks it for an adversarial review.
- Antigravity — editor. \`polish\` has it improve UI strings, comments, and docs. It must not change logic or structure.

How jobs work:
- delegate and polish run in their own git worktree and branch (crew/<job id>) created from HEAD, so commit anything the worker needs first. The bridge commits the worker's changes on that branch; you inspect the diff and merge or reject it. Nothing reaches your branch unless you merge it.
- By default a call blocks until the worker finishes or needs you. Pass background: true to keep working in parallel; you are notified when the job ends, or call \`wait\`.
- A job in the "waiting" state needs a decision: use \`reply\`. Approve a sandbox escape only if the command is clearly needed for the task and safe.
- \`reply\` with a message continues the same worker session, e.g. to request fixes.
- Reject worker changes that go beyond what was asked. For polish, any file listed as out of scope, or any non-text change, is grounds to reject.
- If a worker fails on a usage limit, do that piece yourself and say that the cross-check was skipped.

The user can watch all three agents live on the status board at ${BASE_URL}.`;

const common = {
  cwd: { type: 'string', description: 'Project directory. Defaults to this session\'s project.' },
  background: { type: 'boolean', description: 'Return immediately with the job id instead of blocking until the worker finishes. Use for work that runs in parallel with your own.' },
};
const worktreeProps = {
  base: { type: 'string', description: 'Git ref the worker\'s worktree starts from. Defaults to HEAD.' },
  isolation: { type: 'string', enum: ['worktree', 'in_place'], description: 'worktree (default): separate worktree and branch. in_place: edit the project directory directly; only for directories that are not git repositories.' },
};
const codexProps = {
  model: { type: 'string', description: 'Codex model override. Omit to use the user\'s Codex default.' },
  effort: { type: 'string', description: 'Codex reasoning effort override (e.g. low, medium, high).' },
};

const TOOLS = [
  {
    name: 'delegate',
    title: 'Delegate to Codex',
    description: 'Hand a separable piece of implementation to Codex, the supporting engineer. It works in its own git worktree and reports back; its changes land on a crew/<job id> branch for you to review and merge.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to build, with the context Codex needs: relevant files, constraints, interfaces to match. It has not seen this conversation.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        done_when: { type: 'string', description: 'Concrete completion criteria, e.g. tests that must pass.' },
        ...worktreeProps,
        ...codexProps,
        ...common,
      },
      required: ['task'],
    },
  },
  {
    name: 'review',
    title: 'Review by Codex',
    description: 'Ask Codex for a read-only review of changes in this repository. Use after your own self-review, once per step; do not loop reviews.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['uncommitted', 'branch', 'commit'], description: 'uncommitted (default): staged, unstaged and untracked changes. branch: current branch against `base`. commit: a single commit.' },
        base: { type: 'string', description: 'Base branch for target "branch", e.g. main.' },
        commit: { type: 'string', description: 'Commit SHA for target "commit".' },
        focus: { type: 'string', description: 'What to scrutinize: the design decisions, assumptions or risks you are least sure about.' },
        mode: { type: 'string', enum: ['adversarial', 'standard'], description: 'adversarial (default): challenges design and assumptions. standard: Codex\'s built-in code review.' },
        ...codexProps,
        ...common,
      },
    },
  },
  {
    name: 'polish',
    title: 'Polish by Antigravity',
    description: 'Have Antigravity improve UI strings, comments, and documentation in the given files, in its own worktree. It may not change logic or structure. Not a merge gate: run it after the code is settled.',
    inputSchema: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files or directories it may edit, relative to the project. Changes elsewhere are reported as out of scope.' },
        guidance: { type: 'string', description: 'Tone, terminology, audience, or what to leave alone.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        ...worktreeProps,
        ...common,
      },
      required: ['targets'],
    },
  },
  {
    name: 'status',
    title: 'Crew status',
    description: 'Show one job in full, or list recent jobs with what each worker is doing now.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } },
  },
  {
    name: 'wait',
    title: 'Wait for workers',
    description: 'Block until one of the given jobs finishes, fails, or needs a decision, then return its result. With no ids, waits on every active job.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number', description: 'Give up waiting after this long (default 1800). The jobs keep running.' },
      },
    },
  },
  {
    name: 'reply',
    title: 'Reply to a worker',
    description: 'Answer a waiting job (decision: approve or deny), or send a follow-up message that continues the same worker session, e.g. to request fixes after reviewing its diff.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: { type: 'string', description: 'Follow-up instruction, or the answer to the worker\'s question.' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'For a job waiting on approval.' },
        background: common.background,
      },
      required: ['job_id'],
    },
  },
  {
    name: 'cancel',
    title: 'Cancel a job',
    description: 'Stop a running job. With discard: true, also remove a finished job\'s worktree and branch (after merging or rejecting its changes).',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, discard: { type: 'boolean' } },
      required: ['job_id'],
    },
  },
];

const DEFAULT_WAIT_SECONDS = 1800;

/**
 * Follows jobs until one stops running (finished, failed, or waiting on the lead),
 * the time budget runs out, or the call is cancelled.
 */
async function follow(ids: string[], seconds: number, onEvent: (e: CrewEvent) => void, signal: AbortSignal): Promise<JobView[]> {
  const latest = new Map<string, JobView>();
  let stop = false;
  const deadline = Date.now() + seconds * 1000;
  signal.addEventListener('abort', () => (stop = true));

  const watch = async (id: string) => {
    const first: JobView = await api('GET', `/api/jobs/${id}`);
    latest.set(id, first);
    // Start from the present: earlier events were already reported by a previous call.
    let after = needsLead(first) ? first.seq : Math.max(first.seq - 1, 0);
    while (!stop && !needsLead(latest.get(id)!) && Date.now() < deadline) {
      const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=25`);
      latest.set(id, res.job);
      for (const event of res.events as CrewEvent[]) if (!stop) onEvent(event);
      // Advance even when the event buffer no longer holds these events, so the poll cannot spin.
      after = Math.max(after, res.job.seq);
    }
  };
  // Resolves as soon as any one job needs the lead; the other watchers wind down on their next poll.
  await Promise.race(ids.map(watch));
  stop = true;

  const jobs = ids.map((id) => latest.get(id)).filter((j): j is JobView => Boolean(j));
  await Promise.all(jobs.filter(needsLead).map((j) => api('POST', `/api/jobs/${j.id}/delivered`, { seq: j.seq }).catch(() => {})));
  return jobs;
}

interface CallContext {
  progress(message: string): void;
  signal: AbortSignal;
}

async function runJob(spec: JobSpec, background: boolean, ctx: CallContext): Promise<string> {
  const job: JobView = await api('POST', '/api/jobs', spec);
  return background ? describe(job) : followOne(job.id, ctx);
}

async function followOne(id: string, ctx: CallContext): Promise<string> {
  const [job] = await follow([id], DEFAULT_WAIT_SECONDS, (e) => ctx.progress(e.detail), ctx.signal);
  return describe(job);
}

async function callTool(name: string, args: any, ctx: CallContext): Promise<string> {
  const cwd: string = args.cwd ?? process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
  switch (name) {
    case 'delegate':
      return runJob({ kind: 'delegate', cwd, title: args.title, task: args.task, done_when: args.done_when, base: args.base, isolation: args.isolation, model: args.model, effort: args.effort }, Boolean(args.background), ctx);
    case 'review': {
      const kind = args.target ?? 'uncommitted';
      if (kind === 'branch' && !args.base) throw new Error('target "branch" needs base (the branch to compare against, e.g. main).');
      if (kind === 'commit' && !args.commit) throw new Error('target "commit" needs commit (the SHA to review).');
      const target = kind === 'branch' ? { type: 'baseBranch' as const, branch: args.base } : kind === 'commit' ? { type: 'commit' as const, sha: args.commit } : { type: 'uncommittedChanges' as const };
      // The focus can be long; the board title only needs to say what is under review.
      const title = `Review of ${kind === 'branch' ? `the branch against ${args.base}` : kind === 'commit' ? `commit ${args.commit.slice(0, 8)}` : 'uncommitted changes'}`;
      return runJob({ kind: 'review', cwd, title, task: args.focus, review: { target, mode: args.mode ?? 'adversarial' }, model: args.model, effort: args.effort }, Boolean(args.background), ctx);
    }
    case 'polish':
      return runJob({ kind: 'polish', cwd, title: args.title ?? `Polish ${args.targets.join(', ')}`, task: args.guidance, targets: args.targets, base: args.base, isolation: args.isolation }, Boolean(args.background), ctx);
    case 'status': {
      if (args.job_id) {
        const job: JobView = await api('GET', `/api/jobs/${args.job_id}`);
        if (needsLead(job)) await api('POST', `/api/jobs/${job.id}/delivered`, { seq: job.seq });
        return describe(job);
      }
      const state = await api('GET', '/api/state');
      const jobs: JobView[] = state.jobs;
      const active = jobs.filter((j) => !j.endedAt);
      const recent = jobs.filter((j) => j.endedAt).slice(0, 8);
      const lines = [active.length ? 'Active:' : 'No active jobs.', ...active.map(summarize)];
      if (recent.length) lines.push('', 'Recent:', ...recent.map(summarize));
      const windows = state.limits.codex?.windows ?? [];
      if (windows.length) lines.push('', `Codex usage: ${windows.map((w: any) => `${Math.round(w.usedPercent)}% of the ${w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}-day` : `${Math.round(w.minutes / 60)}-hour`} window`).join(', ')}`);
      lines.push('', `Board: ${BASE_URL}`);
      return lines.join('\n');
    }
    case 'wait': {
      let ids: string[] = args.job_ids ?? [];
      // Besides active jobs, pick up background jobs that ended without the lead having seen the result.
      if (!ids.length) ids = ((await api('GET', '/api/state')).jobs as JobView[]).filter((j) => !j.endedAt || j.seq > j.delivered).map((j) => j.id);
      if (!ids.length) return 'No active jobs, and no finished job is waiting to be read.';
      const jobs = await follow(ids, args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, (e) => ctx.progress(`${e.job_id}: ${e.detail}`), ctx.signal);
      const ready = jobs.filter(needsLead);
      const running = jobs.filter((j) => !needsLead(j));
      const parts = ready.map(describe);
      if (running.length) parts.push(`${ready.length ? 'Still running' : 'Timed out waiting; still running'}:\n${running.map(summarize).join('\n')}`);
      return parts.join('\n\n────────\n\n');
    }
    case 'reply': {
      await api('POST', `/api/jobs/${args.job_id}/reply`, { message: args.message, decision: args.decision });
      return args.background ? describe(await api('GET', `/api/jobs/${args.job_id}`)) : followOne(args.job_id, ctx);
    }
    case 'cancel': {
      let job: JobView = await api('POST', `/api/jobs/${args.job_id}/cancel`, {});
      if (args.discard) job = await api('POST', `/api/jobs/${args.job_id}/discard`, {});
      return describe(job);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- MCP stdio transport -------------------------------------------------

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const inFlight = new Map<string | number, AbortController>();

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'crew', title: 'Crew', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'notifications/cancelled':
      inFlight.get(params?.requestId)?.abort();
      return;
    case 'tools/call': {
      const controller = new AbortController();
      inFlight.set(id, controller);
      const token = params?._meta?.progressToken;
      let step = 0;
      const ctx: CallContext = {
        signal: controller.signal,
        progress: (message) => {
          if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } });
        },
      };
      try {
        await ensureDaemon();
        const text = await callTool(params.name, params.arguments ?? {}, ctx);
        reply({ content: [{ type: 'text', text }] });
      } catch (err) {
        reply({ content: [{ type: 'text', text: String((err as Error).message ?? err) }], isError: true });
      } finally {
        inFlight.delete(id);
      }
      return;
    }
    default:
      // Requests need an answer; unknown notifications are ignored.
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (typeof msg.method === 'string') void handle(msg);
});

// Start the daemon with the session so the board and hooks work before the first tool call.
ensureDaemon().catch(() => {});
