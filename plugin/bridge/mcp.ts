import readline from 'node:readline';
import { api, ensureDaemon } from './client.ts';
import { BASE_URL, DEFAULT_ROLES, loadConfig, VERSION, WORKERS } from './config.ts';
import type { Role } from './config.ts';
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

/**
 * Who holds each role, as configured when this session started. Tool text is fixed for the session,
 * so a later change shows up in `status` and in each job's result, which name the agent that ran.
 */
const roles = (() => {
  try {
    return loadConfig().roles;
  } catch {
    return DEFAULT_ROLES;
  }
})();
const holder = (role: Role) => WORKERS[roles[role].agent].name;

const INSTRUCTIONS = `Crew connects this session to other coding agents that run in the background. You are the lead: you plan, do the main implementation, review, and decide what is merged.

Roles (assigned by the user in ~/.crew/config.json; each tool goes to the agent holding that role, and you do not reassign them):
- \`delegate\` — supporting engineer, currently ${holder('delegate')}. Give it a separable piece of implementation.
- \`review\` — cross-reviewer, currently ${holder('review')}. Ask it for an adversarial review.
- \`polish\` — editor, currently ${holder('polish')}. It improves UI strings, comments, and docs, and must not change logic or structure.

How jobs work:
- delegate and polish run in their own git worktree and branch (crew-<job id>) created from HEAD, so commit anything the worker needs first. Gitignored files it needs (node_modules, .env) are copied in if the repository lists them in .worktreeinclude. The bridge commits the worker's changes on that branch; you inspect the diff and merge or reject it. Nothing reaches your branch unless you merge it.
- By default a call blocks until the worker finishes or needs you. Pass background: true to keep working in parallel; you are notified when the job ends, or call \`wait\`.
- A worker's approval request or question is for the user to answer, not you. While you block on a job, the app asks them directly. If you are told a job is waiting (for example when a background job wakes you), call \`wait\` on it so they are asked. Use \`reply\` with a decision only to pass on one the user gave you in the conversation.
- \`reply\` with a message continues the same worker session, e.g. to request fixes.
- Reject worker changes that go beyond what was asked. For polish, any file listed as out of scope, or any non-text change, is grounds to reject.
- If a worker fails on a usage limit, do that piece yourself and say that the cross-check was skipped.

The user can watch every agent live on the status board at ${BASE_URL}.`;

const common = {
  cwd: { type: 'string', description: 'Project directory. Defaults to this session\'s project.' },
  background: { type: 'boolean', description: 'Return immediately with the job id instead of blocking until the worker finishes. Use for work that runs in parallel with your own.' },
};
const worktreeProps = {
  base: { type: 'string', description: 'Git ref the worker\'s worktree starts from. Defaults to HEAD.' },
  isolation: { type: 'string', enum: ['worktree', 'in_place'], description: 'worktree (default): separate worktree and branch. in_place: edit the project directory directly; only for directories that are not git repositories.' },
};
const modelProps = {
  model: { type: 'string', description: 'Model override for this job. Omit to use the model configured for the role, or the agent\'s own default.' },
  effort: { type: 'string', description: 'Reasoning effort override (e.g. low, medium, high). Ignored by agents without an effort setting.' },
};

const TOOLS = [
  {
    name: 'delegate',
    title: `Delegate to ${holder('delegate')}`,
    description: `Hand a separable piece of implementation to the supporting engineer (${holder('delegate')}). It works in its own git worktree and reports back; its changes land on a crew-<job id> branch for you to review and merge.`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to build, with the context the engineer needs: relevant files, constraints, interfaces to match. It has not seen this conversation.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        done_when: { type: 'string', description: 'Concrete completion criteria, e.g. tests that must pass.' },
        ...worktreeProps,
        ...modelProps,
        ...common,
      },
      required: ['task'],
    },
  },
  {
    name: 'review',
    title: `Review by ${holder('review')}`,
    description: `Ask the cross-reviewer (${holder('review')}) for a read-only review of changes in this repository. Use after your own self-review, once per step; do not loop reviews.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['uncommitted', 'branch', 'commit'], description: 'uncommitted (default): staged, unstaged and untracked changes. branch: current branch against `base`. commit: a single commit.' },
        base: { type: 'string', description: 'Base branch for target "branch", e.g. main.' },
        commit: { type: 'string', description: 'Commit SHA for target "commit".' },
        focus: { type: 'string', description: 'What to scrutinize: the design decisions, assumptions or risks you are least sure about.' },
        mode: { type: 'string', enum: ['adversarial', 'standard'], description: 'adversarial (default): challenges design and assumptions. standard: Codex\'s built-in code review; other agents run the adversarial review instead.' },
        done_when: { type: 'string', description: 'Acceptance criteria to verify in adversarial mode.' },
        ...modelProps,
        ...common,
      },
    },
  },
  {
    name: 'polish',
    title: `Polish by ${holder('polish')}`,
    description: `Have the editor (${holder('polish')}) improve UI strings, comments, and documentation in the given files, in its own worktree. It may not change logic or structure. Not a merge gate: run it after the code is settled.`,
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
    description: 'Block until one of the given jobs finishes or fails, then return its result. If a job needs an approval or an answer meanwhile, the user is asked in the app and the wait continues. With no ids, waits on every active job of this project.',
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
    description: 'Send a follow-up message that continues the same worker session, e.g. to request fixes after reviewing its diff. Also passes on a decision the user gave you for a waiting job (decision: approve or deny); to have the user asked, call wait instead.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: { type: 'string', description: 'Follow-up instruction, or the answer to the worker\'s question.' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'The user\'s decision for a job waiting on approval.' },
        request_id: { type: 'string', description: 'Required when forwarding an answer. Use the request ID shown in the job status.' },
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
/** The daemon is shared by every session; a session only lists and waits on its own project's jobs. */
const PROJECT = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

/** Set from the client's initialize request: whether it can show the user a form on our behalf. */
let canElicit = false;
/**
 * Waiting requests that go back to the lead instead of being asked again:
 * those the user dismissed, and those the app failed to show (with the error).
 */
const dismissed = new Set<string>();
const failed = new Map<string, string>();

const APPROVAL_FORM = {
  type: 'object',
  // A plain enum is the one choice schema every protocol version with elicitation accepts.
  properties: { decision: { type: 'string', title: 'Decision', enum: ['approve', 'deny'] } },
  required: ['decision'],
};
const ANSWER_FORM = { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } }, required: ['answer'] };

let promptQueue: Promise<unknown> = Promise.resolve();

/** Several jobs can wait at once; ask about them one after another rather than stacking prompts in the app. */
function oneAtATime<T>(ask: () => Promise<T>): Promise<T> {
  const turn = promptQueue.then(ask, ask);
  promptQueue = turn.catch(() => {});
  return turn;
}

/**
 * Puts a worker's approval request or question to the user through MCP
 * elicitation, which the app renders as its own prompt, and forwards the
 * answer to the worker.
 */
async function askUser(job: JobView, signal: AbortSignal): Promise<'settled' | 'dismissed' | 'failed'> {
  const waiting = job.waiting!;
  // While queued behind another prompt, this request may have been answered on the board, or the call cancelled.
  const current: JobView = await api('GET', `/api/jobs/${job.id}`);
  if (signal.aborted || current.waiting?.id !== waiting.id) return 'settled';

  const approval = waiting.type === 'approval';
  const prompt = request('elicitation/create', {
    message: `${WORKERS[job.agent].name} (${job.title}) ${approval ? 'requests approval' : 'asks a question'}\n\n${waiting.reason}`,
    requestedSchema: approval ? APPROVAL_FORM : ANSWER_FORM,
  });

  // The same request can be answered on the status board, or the call can be cancelled; then the prompt is moot.
  let open = true;
  const moot = (async () => {
    let latest = current;
    while (open && !signal.aborted && latest.waiting?.id === waiting.id) {
      latest = (await api('GET', `/api/jobs/${job.id}/wait?after=${latest.seq}&timeout=5`)).job;
    }
  })().then(
    () => null,
    // An unreachable bridge is not the app's failure; the next poll reports it.
    () => null,
  );
  // The tool call returning, for any reason, withdraws the prompt at once.
  const withdrawn = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  let result: any;
  try {
    result = await Promise.race([prompt.response, moot, withdrawn]);
  } catch (err) {
    failed.set(waiting.id, String((err as Error).message ?? err));
    return 'failed';
  } finally {
    open = false;
  }
  if (result === null) {
    prompt.cancel();
    return 'settled';
  }
  const answer = result.action === 'accept' ? result.content : null;
  const body = approval
    ? (answer?.decision === 'approve' || answer?.decision === 'deny') && { decision: answer.decision }
    : typeof answer?.answer === 'string' && answer.answer.trim() && { message: answer.answer };
  if (!body) return 'dismissed';
  // Already answered elsewhere in the meantime is fine: the worker has its decision.
  await api('POST', `/api/jobs/${job.id}/reply`, { ...body, request_id: waiting.id }).catch(() => {});
  return 'settled';
}

/**
 * Follows jobs until one needs the lead (finished, failed, or waiting with no way
 * to ask the user), the time budget runs out, or the call is cancelled.
 */
async function follow(ids: string[], seconds: number, onEvent: (e: CrewEvent) => void, signal: AbortSignal): Promise<JobView[]> {
  const latest = new Map<string, JobView>();
  let stop = false;
  const deadline = Date.now() + seconds * 1000;
  // Ends when the call is cancelled or this follow returns, so no prompt outlives the call.
  const done = new AbortController();
  const quit = () => {
    stop = true;
    done.abort();
  };
  signal.addEventListener('abort', quit, { once: true });

  const watch = async (id: string) => {
    let job: JobView = await api('GET', `/api/jobs/${id}`);
    latest.set(id, job);
    // Start from the present: earlier events were already reported by a previous call.
    let after = needsLead(job) ? job.seq : Math.max(job.seq - 1, 0);
    while (!stop && Date.now() < deadline) {
      const key = job.waiting?.id;
      if (key && canElicit && !dismissed.has(key) && !failed.has(key)) {
        const asked = job;
        if ((await oneAtATime(() => askUser(asked, done.signal))) === 'dismissed') dismissed.add(key);
        job = await api('GET', `/api/jobs/${id}`);
        latest.set(id, job);
        continue;
      }
      if (needsLead(job)) break;
      const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=25`);
      job = res.job;
      latest.set(id, job);
      for (const event of res.events as CrewEvent[]) if (!stop) onEvent(event);
      // Advance even when the event buffer no longer holds these events, so the poll cannot spin.
      after = Math.max(after, job.seq);
    }
  };
  // Resolves as soon as any one job needs the lead; the other watchers wind down on their next poll.
  await Promise.race(ids.map(watch));
  quit();

  const jobs = ids.map((id) => latest.get(id)).filter((j): j is JobView => Boolean(j));
  await Promise.all(jobs.filter(needsLead).map((j) => api('POST', `/api/jobs/${j.id}/delivered`, { seq: j.seq }).catch(() => {})));
  return jobs;
}

interface CallContext {
  progress(message: string): void;
  signal: AbortSignal;
}

async function runJob(spec: JobSpec, background: boolean, ctx: CallContext): Promise<string> {
  const job: JobView = await api('POST', '/api/jobs', { ...spec, project: PROJECT });
  return background ? describe(job) : followOne(job.id, ctx);
}

async function followOne(id: string, ctx: CallContext): Promise<string> {
  const [job] = await follow([id], DEFAULT_WAIT_SECONDS, (e) => ctx.progress(e.detail), ctx.signal);
  return render(job);
}

/** `describe`, plus what the lead should do about a waiting job that could not be settled in the app. */
function render(job: JobView): string {
  if (job.state !== 'waiting') return describe(job);
  const key = job.waiting!.id;
  const error = failed.get(key);
  let hint: string | undefined;
  if (error !== undefined) hint = `The app could not show the prompt to the user (${error}). Ask them in the conversation, then pass their decision on with reply.`;
  else if (dismissed.has(key)) hint = 'The user was asked in the app and dismissed the prompt without deciding. Do not decide for them: ask what they want, then pass it on with reply.';
  else if (!canElicit) hint = 'This client cannot show the prompt itself. Ask the user in the conversation, then pass their decision on with reply.';
  return describe(job, hint);
}

async function callTool(name: string, args: any, ctx: CallContext): Promise<string> {
  const cwd: string = args.cwd ?? PROJECT;
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
      return runJob({ kind: 'review', cwd, title, task: args.focus, done_when: args.done_when, review: { target, mode: args.mode ?? 'adversarial' }, model: args.model, effort: args.effort }, Boolean(args.background), ctx);
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
      const jobs: JobView[] = state.jobs.filter((j: JobView) => j.project === PROJECT);
      const active = jobs.filter((j) => !j.endedAt);
      const recent = jobs.filter((j) => j.endedAt).slice(0, 8);
      const lines = [active.length ? 'Active:' : 'No active jobs.', ...active.map(summarize)];
      const elsewhere = state.jobs.filter((j: JobView) => j.project !== PROJECT && !j.endedAt).length;
      if (elsewhere) lines.push(`(${elsewhere} active job(s) belong to other projects; they are on the board.)`);
      if (recent.length) lines.push('', 'Recent:', ...recent.map(summarize));
      // A daemon that predates the role table reports none.
      if (state.roles) lines.push('', `Roles: ${(Object.keys(state.roles) as Role[]).map((role) => `${role} → ${WORKERS[state.roles[role].agent as keyof typeof WORKERS].name}`).join(', ')}`);
      const windows = state.limits.codex?.windows ?? [];
      if (windows.length) lines.push('', `Codex usage: ${windows.map((w: any) => `${Math.round(w.usedPercent)}% of the ${w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}-day` : `${Math.round(w.minutes / 60)}-hour`} window`).join(', ')}`);
      lines.push('', `Board: ${BASE_URL}`);
      return lines.join('\n');
    }
    case 'wait': {
      let ids: string[] = args.job_ids ?? [];
      // Besides active jobs, pick up background jobs that ended without the lead having seen the result.
      if (!ids.length) ids = ((await api('GET', '/api/state')).jobs as JobView[]).filter((j) => j.project === PROJECT && (!j.endedAt || j.seq > j.delivered)).map((j) => j.id);
      if (!ids.length) return 'No active jobs, and no finished job is waiting to be read.';
      const jobs = await follow(ids, args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, (e) => ctx.progress(`${e.job_id}: ${e.detail}`), ctx.signal);
      const ready = jobs.filter(needsLead);
      const running = jobs.filter((j) => !needsLead(j));
      const parts = ready.map(render);
      if (running.length) parts.push(`${ready.length ? 'Still running' : 'Timed out waiting; still running'}:\n${running.map(summarize).join('\n')}`);
      return parts.join('\n\n────────\n\n');
    }
    case 'reply': {
      await api('POST', `/api/jobs/${args.job_id}/reply`, { message: args.message, decision: args.decision, request_id: args.request_id });
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

let nextRequest = 1;
const awaiting = new Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }>();

/** Sends a request to the client. `cancel` withdraws it if it is still open. */
function request(method: string, params: unknown): { response: Promise<any>; cancel(): void } {
  const id = `crew-${nextRequest++}`;
  const response = new Promise<any>((resolve, reject) => awaiting.set(id, { resolve, reject }));
  send({ jsonrpc: '2.0', id, method, params });
  return {
    response,
    cancel: () => {
      if (awaiting.delete(id)) send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'no longer needed' } });
    },
  };
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      canElicit = Boolean(params?.capabilities?.elicitation);
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
  if (typeof msg.method === 'string') return void handle(msg);
  // Otherwise it is the client's response to one of our requests.
  const waiter = awaiting.get(msg.id);
  if (!waiter) return;
  awaiting.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message ?? 'request failed'));
  else waiter.resolve(msg.result);
});

// Start the daemon with the session so the board and hooks work before the first tool call.
ensureDaemon().catch(() => {});
