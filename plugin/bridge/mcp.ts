import readline from 'node:readline';
import { api, ensureDaemon } from './client.ts';
import { BASE_URL, DEFAULT_ROLES, loadConfig, VERSION, WORKERS } from './config.ts';
import { listSkills } from './skills.ts';
import { describeUsage } from './usage.ts';
import type { RouteDecision, Usage } from './usage.ts';
import type { Role } from './config.ts';
import type { CrewEvent, JobSpec } from './jobs.ts';
import { normalizeTitle, STAGES } from './missions.ts';
import type { Mission } from './missions.ts';
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
const started = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();
const roles = started?.roles ?? DEFAULT_ROLES;
const holder = (role: Role) => WORKERS[roles[role].agent].name;
/** The model the preset asks the lead to give its subagents; none when no preset is set or it leaves them alone. */
const subagentModel = started?.preset ? started.presets[started.preset].subagentModel : undefined;
const PRESET_LINE = started?.preset
  ? `\n- The user chose the "${started.preset}" preset. Workers get its model and effort automatically. ${subagentModel && subagentModel !== 'inherit' ? `Start your own subagents (including crew:self-reviewer) with model "${subagentModel}" unless the user asks otherwise.` : 'Your own subagents stay on your model.'}`
  : '';

const INSTRUCTIONS = `Crew connects this session to other coding agents that run in the background. You are the lead: you plan, do the main implementation, review, and decide what is merged.

Roles (assigned by the user in ~/.crew/config.json; each tool goes to the agent holding that role, and you do not reassign them):
- \`delegate\` — supporting engineer, currently ${holder('delegate')}. Give it a separable piece of implementation.
- \`review\` — cross-reviewer, currently ${holder('review')}. Ask it for an adversarial review.
- \`polish\` — editor, currently ${holder('polish')}. It improves UI strings, comments, and docs, and must not change logic or structure.

How jobs work:
- delegate and polish run in their own git worktree and branch (crew-<job id>) created from HEAD, so commit anything the worker needs first. Gitignored files it needs (node_modules, .env) are copied in if the repository lists them in .worktreeinclude. The bridge commits the worker's changes on that branch; you inspect the diff and merge or reject it. Nothing reaches your branch unless you merge it.
- By default a call blocks until the worker finishes or needs you. Pass background: true to keep working in parallel; you are notified when the job ends, or call \`wait\`.
- Codex's approval requests go to its own automatic reviewer first; only what reaches you as a waiting job is for the user. If a result lists an action the reviewer REFUSED and the user's request in this conversation clearly covers it, send it back yourself with \`reply\` and approved_by_user, quoting their words; do not ask them again. If it is refused a second time, the same call has the user asked directly. If their request does not cover it, tell them and let them decide.
- A waiting job's approval request or question is for the user to answer, not you. While you block on a job, the app asks them directly. If you are told a job is waiting (for example when a background job wakes you), call \`wait\` on it so they are asked. Use \`reply\` with a decision only to pass on one the user gave you in the conversation.
- A worker may use ask_lead mid-task for a question that is yours to answer, unlike approval requests, which are the user's. Answer it with \`answer\`, then call \`wait\` again while the worker continues.
- \`reply\` with a message continues the same worker session, e.g. to request fixes.
- Reject worker changes that go beyond what was asked. For polish, any file listed as out of scope, or any non-text change, is grounds to reject.
- If a worker fails on a usage limit, do that piece yourself and say that the cross-check was skipped.
- This machine is shared. Workers are told to start their own isolated instance of anything they run (free port, own data directory, headless browser) and to measure nothing unless the job runs alone. A job that has to start the app takes runs_app: its sandbox then has network access, and a review runs in a snapshot of the change. Without it a worker's review is static. Only one reviewer of a change runs the app: if the cross-review does, tell your self-review subagent to stay static, and the other way round. A delegate job that measures performance takes exclusive: it is refused while other jobs are active, so wait for them first.
- When to review while you run the Crew pipeline (/crew:run), without being asked: one review (your crew:self-reviewer subagent or \`review\`, not both) when a substantial piece of implementation reaches a stopping point; both in parallel before you push or open a pull request, on whatever is going out that has not had both; none for small fixes and wording. Reviewers that run in parallel are static unless exactly one of them is told it may run the app. The user's own request for a review, or for none, comes first. Outside the pipeline, review only when the user asks: do not hold back a commit or a push for one.
- When you take a user's command through several steps, call \`mission\` with its title first, with the stage as you move on, and with done at the end. The board then shows the command as one unit with its jobs under it. Skip it for a single delegated job.
- Usage is measured by AgentGauge. In the pipeline, call \`route\` once at each stage boundary before you hand out work (not on every turn) and follow its assignee and reason; when it says degraded, say in your report what was skipped. Outside the pipeline, follow the roles unless a job fails on a limit.${PRESET_LINE}

The user can watch every agent live on the status board at ${BASE_URL}.`;

const common = {
  cwd: { type: 'string', description: 'Project directory. Defaults to this session\'s project.' },
  background: { type: 'boolean', description: 'Return immediately with the job id instead of blocking until the worker finishes. Use for work that runs in parallel with your own.' },
};
const worktreeProps = {
  base: { type: 'string', description: 'Git ref the worker\'s worktree starts from. Defaults to HEAD.' },
  isolation: { type: 'string', enum: ['worktree', 'in_place'], description: 'worktree (default): separate worktree and branch. in_place: edit the project directory directly; only for directories that are not git repositories.' },
};
const aloneProp = {
  exclusive: { type: 'boolean', description: 'The job measures performance (benchmark, profile, load test) and must have the machine to itself. It is refused while any other job runs, and no other job can start until it ends: wait for running jobs first, and start nothing alongside it.' },
};
const runsAppProp = (what: string) => ({
  runs_app: { type: 'boolean', description: `The job has to start the app (a server, a headless browser) to ${what}. Its sandbox gets network access for that; without this a worker cannot bind a port. Pass it only when running the app is needed.` },
});
const installedSkills = listSkills();
const skillsProp = installedSkills.length ? {
  skills: { type: 'array', items: { type: 'string', enum: installedSkills }, description: 'Skills from ~/.agents/skills that would help with this particular job, such as a design or writing skill for UI work. The worker is not shown the user\'s skills otherwise; it is told to read the ones you pick. Pick only those that fit the task.' },
} : {};
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
        ...runsAppProp('do or verify the work'),
        ...aloneProp,
        ...skillsProp,
        ...common,
      },
      required: ['task'],
    },
  },
  {
    name: 'review',
    title: `Review by ${holder('review')}`,
    description: `Ask the cross-reviewer (${holder('review')}) for a review of changes in this repository; it changes nothing in your tree. By default it is static and read-only: the worker reads the change and runs checks that end by themselves. In the pipeline, before a push or pull request, start it together with your own self-review; at other stopping points one of the two is enough. Do not loop reviews.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['uncommitted', 'branch', 'commit'], description: 'uncommitted (default): staged, unstaged and untracked changes. branch: current branch against `base`. commit: a single commit.' },
        base: { type: 'string', description: 'For target "branch": the branch or commit to compare against, e.g. main, or the commit before your first one when you work on main itself.' },
        commit: { type: 'string', description: 'Commit SHA for target "commit".' },
        focus: { type: 'string', description: 'What to scrutinize: the design decisions, assumptions or risks you are least sure about.' },
        mode: { type: 'string', enum: ['adversarial', 'standard'], description: 'adversarial (default): challenges design and assumptions. standard: Codex\'s built-in code review; other agents run the adversarial review instead.' },
        done_when: { type: 'string', description: 'Acceptance criteria to verify in adversarial mode.' },
        ...runsAppProp('judge the change. The review then runs in a snapshot worktree holding the change, and your own self-review must stay static'),
        ...modelProps,
        ...skillsProp,
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
        ...skillsProp,
        ...common,
      },
      required: ['targets'],
    },
  },
  {
    name: 'mission',
    title: 'Report the mission',
    description: 'Tell the board which user command you are carrying out and how far along it is, so the user sees the command as one unit with its jobs under it. Pass title to start one (jobs you start afterwards belong to it), stage as you move through the steps, and done when it is finished. One short call per step; it starts no work itself.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The user\'s command in a few words. Pass it once, to start the mission; later calls need only stage. A different title starts a new mission and closes this session\'s open one as abandoned.' },
        stage: { type: 'string', enum: [...STAGES], description: 'The step you are on now.' },
        done: { type: 'boolean', description: 'The command is finished.' },
        abandoned: { type: 'boolean', description: 'The command was dropped before it finished.' },
        outcome: { type: 'string', description: 'With done or abandoned: one line on how it ended.' },
      },
    },
  },
  {
    name: 'route',
    title: 'Route by usage',
    description: 'Ask who should take a kind of work now, given each agent\'s remaining usage as AgentGauge measured it. Returns the assignee (the role\'s holder, or you), the reason, and whether the result is degraded or should wait. Call it at stage boundaries in the pipeline, not on every turn. With no kind, shows every agent\'s usage.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['lead', 'delegate', 'review', 'polish'], description: 'What you are about to hand out. lead asks whether you yourself should carry on.' } },
    },
  },
  {
    name: 'status',
    title: 'Crew status',
    description: 'Show one job in full, or list recent jobs with what each worker is doing now, with each agent\'s usage.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { job_id: { type: 'string' } } },
  },
  {
    name: 'wait',
    title: 'Wait for workers',
    description: 'Block until one of the given jobs finishes, fails, or asks you a new lead question, then return its result. If a job needs an approval or a user answer meanwhile, the user is asked in the app and the wait continues. With no ids, waits on every active job of this project.',
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
    name: 'answer',
    title: 'Answer a worker question',
    description: 'Answer a lead question without ending or restarting the worker turn, then call wait again.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, question_id: { type: 'string' }, answer: { type: 'string' } },
      required: ['job_id', 'question_id', 'answer'],
    },
  },
  {
    name: 'reply',
    title: 'Reply to a worker',
    description: 'Send a follow-up message that continues the same worker session, e.g. to request fixes after reviewing its diff. Also passes on a decision the user gave you for a waiting job (decision: approve or deny); to have the user asked, call wait instead. With approved_by_user it sends back an action the worker\'s automatic reviewer refused.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: { type: 'string', description: 'Follow-up instruction, or the answer to the worker\'s question.' },
        decision: { type: 'string', enum: ['approve', 'deny'], description: 'The user\'s decision for a job waiting on approval.' },
        request_id: { type: 'string', description: 'Required when forwarding an answer. Use the request ID shown in the job status.' },
        sync: { type: 'boolean', description: 'For a finished delegate or polish job: first merge your current HEAD into the worker\'s branch, so the next turn sees what you committed since it started (a fix it was waiting for, an interface you changed). Commit first. Refused, with nothing changed, if the merge conflicts.' },
        approved_by_user: { type: 'string', description: 'For a finished job whose result lists a REFUSED action: the user\'s own words from this conversation that cover it. The worker runs the action again and the automatic reviewer judges it with that approval. Use it without asking the user when their request clearly covers the action. A second use on the same job sends each request to the user to answer.' },
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
 * Follows jobs until one needs the lead (finished, failed, asking the lead, or
 * waiting with no way to ask the user), the time budget runs out, or the call is cancelled.
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
      const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=${Math.min(25, Math.max(0, (deadline - Date.now()) / 1000))}`);
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

/** The mission this session opened and is carrying out. Only this session's own mission is ever advanced or closed from here. */
/** The Claude session this server belongs to; it outlives a restart of the server. Unset in clients that do not pass it on. */
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || undefined;
let missionId: string | null = null;
/** Set when this session's mission was closed from outside (dismissed on the board, or left too long), until the lead has been told. */
let closedElsewhere: Mission | null = null;

/** This session's mission if it is still open. A mission closed from outside is forgotten and remembered as such. */
async function ownMission(): Promise<Mission | null> {
  const id = missionId;
  if (!id) return null;
  const all: Mission[] = (await api('GET', '/api/state')).missions ?? [];
  const mine = all.find((m) => m.id === id);
  if (mine?.state === 'active') return mine;
  // Unless a newer mission was opened while the answer was on its way.
  if (missionId === id) {
    missionId = null;
    closedElsewhere = mine ?? null;
  }
  return null;
}

const describeMission = (m: Mission) => `Mission ${m.id} · ${m.state === 'active' ? `${m.stage} (step ${STAGES.indexOf(m.stage) + 1} of ${STAGES.length})` : m.state} — ${m.title}`;

async function reportMission(args: any): Promise<string> {
  if (args.done && args.abandoned) throw new Error('Pass done or abandoned, not both.');
  const ending = Boolean(args.done || args.abandoned);
  const current = await ownMission();

  if (args.title && !ending) {
    const title = normalizeTitle(args.title);
    if (!title) throw new Error('A mission needs a title: the command it carries out.');
    // The same title again is the same command: report the step, do not open a second card for it.
    if (current && current.title === title) {
      return describeMission(args.stage ? await api('POST', `/api/missions/${current.id}`, { stage: args.stage }) : current);
    }
    // After this server restarts it no longer knows its mission. An open one this session opened under the same title is
    // that mission. The title alone proves nothing: another session in the project may be carrying out a command of the same name.
    const all: Mission[] = current || !SESSION ? [] : ((await api('GET', '/api/state')).missions ?? []);
    const lost = all.find((m) => m.owner === SESSION && m.project === PROJECT && m.state === 'active' && m.title === title);
    if (lost) {
      missionId = lost.id;
      return describeMission(args.stage ? await api('POST', `/api/missions/${lost.id}`, { stage: args.stage }) : lost);
    }
    // Opened before the previous one is closed, so a refused title leaves the previous mission as it was.
    const opened: Mission = await api('POST', '/api/missions', { title: args.title, project: PROJECT, stage: args.stage, owner: SESSION });
    missionId = opened.id;
    closedElsewhere = null;
    if (current) await api('POST', `/api/missions/${current.id}`, { abandoned: true, outcome: 'Superseded by a new mission.' }).catch(() => {});
    return `${describeMission(opened)}\nJobs you start now are shown under it. Report each step with stage (no title needed), and finish with done.`;
  }

  if (!current) {
    if (closedElsewhere) {
      const gone = closedElsewhere;
      closedElsewhere = null;
      // Reopening it would bring back a card the user closed. The work goes on; only the reporting stops.
      return `Mission ${gone.id} was closed outside this session (${gone.outcome || gone.state}). Carry on with the work and do not open a new mission for it.`;
    }
    throw new Error('This session has no open mission. Start one by passing title; if the work is already under way without one, carry on without reporting.');
  }
  if (ending) {
    const ended: Mission = await api('POST', `/api/missions/${current.id}`, { done: Boolean(args.done), abandoned: Boolean(args.abandoned), outcome: args.outcome });
    missionId = null;
    return describeMission(ended);
  }
  if (!args.stage) return describeMission(current);
  return describeMission(await api('POST', `/api/missions/${current.id}`, { stage: args.stage }));
}

async function describeDelivered(job: JobView): Promise<string> {
  if (needsLead(job)) await api('POST', `/api/jobs/${job.id}/delivered`, { seq: job.seq });
  return describe(job);
}

async function runJob(spec: JobSpec, background: boolean, ctx: CallContext): Promise<string> {
  // The id is sent as it is known: the daemon checks it and lets the job stand on its own if the mission has ended.
  const job: JobView = await api('POST', '/api/jobs', { ...spec, project: PROJECT, mission: missionId ?? undefined });
  return background ? describeDelivered(job) : followOne(job.id, ctx);
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
      return runJob({ kind: 'delegate', cwd, title: args.title, task: args.task, done_when: args.done_when, base: args.base, isolation: args.isolation, model: args.model, effort: args.effort, exclusive: Boolean(args.exclusive), runsApp: Boolean(args.runs_app), skills: args.skills }, Boolean(args.background), ctx);
    case 'review': {
      const kind = args.target ?? 'uncommitted';
      if (kind === 'branch' && !args.base) throw new Error('target "branch" needs base (the branch to compare against, e.g. main).');
      if (kind === 'commit' && !args.commit) throw new Error('target "commit" needs commit (the SHA to review).');
      const target = kind === 'branch' ? { type: 'baseBranch' as const, branch: args.base } : kind === 'commit' ? { type: 'commit' as const, sha: args.commit } : { type: 'uncommittedChanges' as const };
      // The focus can be long; the board title only needs to say what is under review.
      const title = `Review of ${kind === 'branch' ? `the branch against ${args.base}` : kind === 'commit' ? `commit ${args.commit.slice(0, 8)}` : 'uncommitted changes'}`;
      return runJob({ kind: 'review', cwd, title, task: args.focus, done_when: args.done_when, review: { target, mode: args.mode ?? 'adversarial' }, model: args.model, effort: args.effort, runsApp: Boolean(args.runs_app), skills: args.skills }, Boolean(args.background), ctx);
    }
    case 'polish':
      if (args.exclusive) throw new Error('polish cannot run alone: an editor measures nothing. Drop exclusive.');
      return runJob({ kind: 'polish', cwd, title: args.title ?? `Polish ${args.targets.join(', ')}`, task: args.guidance, targets: args.targets, base: args.base, isolation: args.isolation, skills: args.skills }, Boolean(args.background), ctx);
    case 'mission':
      return reportMission(args);
    case 'route': {
      if (!args.kind) {
        const measured = describeUsage(await api('GET', '/api/usage'));
        return measured.length ? measured.join('\n') : 'AgentGauge has no usage data on this machine, so the roles are followed as assigned.';
      }
      const decision: RouteDecision = await api('GET', `/api/route?kind=${encodeURIComponent(args.kind)}`);
      const who = decision.assignee === 'claude' ? 'you (the lead)' : WORKERS[decision.assignee].name;
      const lines = [`${args.kind} → ${who}`, decision.reason];
      if (decision.degraded) lines.push('Degraded: the usual cross-check is missing. Say so in your report.');
      if (decision.deferUntil) lines.push(`Can wait until ${new Date(decision.deferUntil).toISOString()}.`);
      if (decision.fallback.length) lines.push(`If that fails: ${decision.fallback.map((a) => (a === 'claude' ? 'you' : WORKERS[a].name)).join(', then ')}.`);
      return lines.join('\n');
    }
    case 'status': {
      if (args.job_id) {
        const job: JobView = await api('GET', `/api/jobs/${args.job_id}`);
        return describeDelivered(job);
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
      // A daemon that predates AgentGauge support reports no usage; Codex's own figures are then all there is.
      const measured = state.usage ? describeUsage(state.usage as Usage) : [];
      if (measured.length) lines.push('', 'Usage (AgentGauge):', ...measured);
      const windows = measured.length ? [] : (state.limits.codex?.windows ?? []);
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
    case 'answer':
      return describeDelivered(await api('POST', `/api/jobs/${args.job_id}/questions/${args.question_id}`, { answer: args.answer }));
    case 'reply': {
      await api('POST', `/api/jobs/${args.job_id}/reply`, { message: args.message, decision: args.decision, request_id: args.request_id, approved_by_user: args.approved_by_user, sync: args.sync ? true : undefined });
      return args.background ? describeDelivered(await api('GET', `/api/jobs/${args.job_id}`)) : followOne(args.job_id, ctx);
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
