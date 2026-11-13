import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { effectiveRole, PORT, runsCommands, WORKERS } from './config.ts';
import type { Config, Role, WorkerAgent } from './config.ts';
import { carryUncommitted, changesSince, commitAll, commitChanges, copyIncluded, createWorktree, currentBranch, dirtyCount, mergeInto, isInside, projectRoot, removeWorktree, repoRoot, revertCommit, revertsSince, reviewDiff } from './git.ts';
import type { Worktree } from './git.ts';
import { sharedInstructions } from './instructions.ts';
import { buildPrompt } from './prompts.ts';
import { findSkills } from './skills.ts';

export type { WorkerAgent };
export type Agent = 'claude' | WorkerAgent;
export type JobKind = Role;
export type JobState = 'running' | 'waiting' | 'done' | 'failed' | 'cancelled';
export type EventKind = 'started' | 'progress' | 'waiting' | 'error' | 'limit' | 'stalled' | 'done' | 'cancelled';

export interface CrewEvent {
  seq: number;
  ts: string;
  agent: Agent;
  session_id: string | null;
  job_id?: string;
  kind: EventKind;
  detail: string;
}

export type ReviewTarget =
  | { type: 'uncommittedChanges' }
  | { type: 'baseBranch'; branch: string }
  | { type: 'commit'; sha: string };

export interface JobSpec {
  kind: JobKind;
  cwd: string;
  /** Project directory of the session that started the job. */
  project?: string;
  title?: string;
  /** delegate: what to build. polish: extra guidance. review: what to focus on. */
  task?: string;
  done_when?: string;
  /** polish: files or directories the worker may touch. */
  targets?: string[];
  /** Ref the worktree is created from (delegate, polish). */
  base?: string;
  isolation?: 'worktree' | 'in_place';
  review?: { target: ReviewTarget; mode: 'adversarial' | 'standard' };
  model?: string;
  effort?: string;
  /** Mission the job is part of, if the lead started it while carrying out one. */
  mission?: string;
  /** delegate: the job measures performance and must run alone. It starts only when no other job is running, and none starts until it ends. */
  exclusive?: boolean;
  /**
   * delegate, review: the job has to start the app to check its work. Its sandbox gets network access, and a
   * review runs in a snapshot of the change instead of read-only in the user's tree.
   */
  runsApp?: boolean;
  /**
   * The job answers a question and changes nothing: it takes the delegate role's agent, runs read-only in the
   * caller's directory with no worktree, and its report is the answer.
   */
  ask?: boolean;
  /** Lines the caller wants shown with the result from the start. */
  notes?: string[];
  /** Names of the user's skills (`~/.agents/skills`) the lead picked for this job; the worker is told to read them. */
  skills?: string[];
}

/** One worker turn that changed files, as its own commit on the job branch. */
export interface Round {
  turn: number;
  /** The commit holding this turn's changes. */
  commit: string;
  files: string[];
  stat: string;
  /** "undone" once the turn's commit has been reverted on the job branch. */
  state: 'kept' | 'undone';
  /** The revert commit, when undone. */
  revert?: string;
  at: number;
}

export interface LeadQuestion {
  id: string;
  text: string;
  blocks?: string;
  at: number;
  answer?: string;
  answeredAt?: number;
}

export interface Job {
  id: string;
  kind: JobKind;
  agent: WorkerAgent;
  title: string;
  state: JobState;
  /** What the worker is doing right now; overwritten freely, not logged. */
  phase: string;
  repo: string | null;
  /** Project of the lead session that owns the job; sessions only wait on and list their own project's jobs. */
  project: string;
  /** Main working tree of the job's repository, for grouping on the board; absent on jobs saved before it was recorded. */
  root?: string;
  /** Mission this job is one strand of; absent for a job started on its own. */
  mission?: string;
  /** Runs alone on the machine, for measurement. */
  exclusive?: boolean;
  /** May start the app: network access in the sandbox, and for a review a snapshot worktree. */
  runsApp?: boolean;
  /** Answers a question read-only; see JobSpec.ask. */
  ask?: boolean;
  /**
   * A directory of the job's own that a read-only worker may write to: temporary files, caches, a throwaway
   * clone to try something in. It exists only while a turn runs. Absent where the agent cannot run commands.
   */
  scratch?: string;
  /** The commit the job's branch started from, kept once a sync has moved the worktree's base past it. */
  roundsBase?: string;
  /** Turns that changed files, oldest first; absent on jobs without a worktree and on jobs saved before rounds existed. */
  rounds?: Round[];
  /** Actions the agent's automatic reviewer refused, with the turn they were refused in. */
  refusals?: { action: string; reason: string; turn: number }[];
  /** Set while the latest turn is a retry of refused actions: the actions it was sent back with. */
  retrying?: string[];
  /** Approval requests of the current turn go to the user, not the automatic reviewer. */
  asksUser?: boolean;
  /** Directory the worker runs in: the worktree when isolated, else the caller's cwd. */
  cwd: string;
  worktree: Worktree | null;
  sandbox: 'read-only' | 'workspace-write';
  prompt: string;
  instructions: string;
  /** Files of shared instructions the worker was given; absent on jobs saved before they existed. */
  shared?: string[];
  /** Set when the review should use the agent's native review mode instead of a prompted turn. */
  nativeReview: ReviewTarget | null;
  /** Preserved for refreshed review diffs; absent on older saved jobs. */
  reviewTarget?: ReviewTarget;
  targets: string[];
  model?: string;
  effort?: string;
  /** Codex thread id or ACP session id; lets the user continue the session in the vendor's own app. */
  sessionId: string | null;
  createdAt: number;
  /** Last sign of life from the worker. */
  activeAt: number;
  endedAt: number | null;
  turns: number;
  stalled: boolean;
  waiting: { type: 'approval' | 'question'; reason: string; id: string; since: number } | null;
  /** The worker's final message for the latest turn. */
  report: string;
  questions?: LeadQuestion[];
  /** Seq of the latest lead question, so later progress cannot redeliver it. */
  questionSeq?: number;
  result: { files: string[]; stat: string; commit: string | null; outOfScope: string[] } | null;
  notes: string[];
  error: { message: string; limit: boolean } | null;
  tokens: number | null;
  /**
   * What the total is made of, where the agent reports it, and what the latest turn added. Most of a
   * worker's tokens are input it has already sent once; this is how to tell that from new work.
   */
  tokenUse?: { input: number; cachedInput: number; output: number; turn: number };
  /** Seq of the latest event about this job. */
  seq: number;
  /** Seq up to which the lead has already been told; stops the wake hook from repeating it. */
  delivered: number;
}

/** What an adapter may do to the job it is running. */
export interface JobCtl {
  readonly job: Job;
  readonly mcp: { command: string; args: string[]; env: Record<string, string> };
  /** Worker is alive; resets the stall timer. */
  activity(): void;
  phase(text: string): void;
  progress(detail: string): void;
  session(id: string): void;
  touched(file: string): void;
  /** Adds a line to the result that the lead should see, such as a refused action. */
  note(text: string): void;
  /** The agent's automatic reviewer refused an action in this turn. */
  refused(action: string, reason: string): void;
  tokens(total: number, parts?: { input: number; cachedInput: number; output: number }): void;
  waiting(type: 'approval' | 'question', reason: string): void;
  resumed(): void;
  done(report: string): void;
  fail(message: string, opts?: { limit?: boolean }): void;
  cancelled(): void;
}

export interface Adapter {
  /** Starts the first turn. Resolves once the worker has accepted it. */
  start(ctl: JobCtl): Promise<void>;
  /** Sends a follow-up message, steering the active turn or starting a new one. */
  reply(ctl: JobCtl, message: string): Promise<void>;
  /** Resolves the pending approval or question. */
  answer(ctl: JobCtl, approve: boolean, message?: string): Promise<void>;
  cancel(ctl: JobCtl): Promise<void>;
  shutdown(): void;
}

export interface JobsHooks {
  onEvent(event: CrewEvent): void;
  onJob(job: Job): void;
  onAttention(job: Job, kind: EventKind, detail: string): void;
  /** Whether a mission is still being kept; its jobs are then kept with it, beyond the history limit. */
  keepsMission?(id: string): boolean;
}

const TERMINAL: JobState[] = ['done', 'failed', 'cancelled'];
const KEEP_JOBS = 200;
const KEEP_EVENTS = 5000;

/**
 * Refused actions the lead still has to deal with: those of the latest turn, or, when a retry turn
 * failed before the worker could try again, the ones that turn was sent back with.
 */
export function openRefusals(job: Pick<Job, 'refusals' | 'turns' | 'retrying' | 'state'>): { action: string; reason?: string }[] {
  const latest = (job.refusals ?? []).filter((refusal) => refusal.turn === job.turns);
  if (latest.length || job.state !== 'failed') return latest;
  return (job.retrying ?? []).map((action) => ({ action }));
}

export function isTerminal(job: Job): boolean {
  return TERMINAL.includes(job.state);
}

export class Jobs {
  readonly jobs = new Map<string, Job>();
  readonly recent: CrewEvent[] = [];
  private seq = 0;
  private workerTokens = new Map<string, string>();
  private waiters = new Map<string, Set<() => void>>();
  private touchedFiles = new Map<string, Set<string>>();
  private discarding = new Set<string>();
  private finalizing = new Set<string>();
  private cancelling = new Set<string>();
  private changingRounds = new Set<string>();
  /** Each job's token total when its current turn began, so the turn's own share can be shown. */
  private turnStartTokens = new Map<string, number>();
  /** Jobs past the alone-check but not yet registered, so two starts cannot both slip through it. */
  private starting: { exclusive: boolean }[] = [];
  private preparingReviews = new Set<string>();
  /** Review snapshots being removed; a follow-up waits for the removal before it makes a new one. */
  private snapshots = new Map<string, Promise<void>>();
  private saveTimer: NodeJS.Timeout | null = null;
  private home: string;
  private readConfig: () => Config;
  /** Settings as of startup, for timers that must not fail on a config edit. */
  private settings: Config;
  private adapters: Record<WorkerAgent, Adapter>;
  private hooks: JobsHooks;

  /** `config` is called again for each new job, so role assignments can change without a restart. */
  constructor(home: string, config: () => Config, adapters: Record<WorkerAgent, Adapter>, hooks: JobsHooks) {
    this.home = home;
    this.readConfig = config;
    this.settings = config();
    this.adapters = adapters;
    this.hooks = hooks;
    this.load();
    setInterval(() => this.checkStalls(), 15_000).unref();
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Number of jobs that would be lost if the daemon stopped now. */
  get activeCount(): number {
    return [...this.jobs.values()].filter((job) => !isTerminal(job)).length;
  }

  get(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`No job with id "${id}". Call status to list jobs.`);
    return job;
  }

  /**
   * Refuses a start that would break a measurement: a job that must run alone while others run, or any
   * job while one runs alone. Refusing, not queueing, keeps the lead in charge of the order: it waits and tries again.
   */
  private checkAlone(exclusive: boolean, self?: string): void {
    const running = this.list().filter((job) => !isTerminal(job) && job.id !== self);
    // What each one is doing, because waiting only helps for a job that can end by itself.
    const say = (job: Job) => `${job.id} (${job.state === 'waiting' ? 'waiting on the user' : job.stalled ? 'no activity, may be stuck' : 'running'})`;
    const way = 'Wait for a running job with wait; one waiting on the user needs their answer; cancel one that is stuck. Then start this again.';
    const alone = running.find((job) => job.exclusive);
    if (alone) throw new Error(`Job ${say(alone)} is measuring and has the machine to itself, in whichever project it runs. ${way}`);
    if (this.starting.some((other) => other.exclusive)) throw new Error('A job that must run alone is starting right now. Try again in a moment; it will then show in status and on the board.');
    if (!exclusive) return;
    if (running.length) throw new Error(`A job that runs alone cannot start while ${running.length} other job(s) are active: ${running.map(say).join(', ')}. ${way}`);
    if (this.starting.length) throw new Error(`A job that runs alone cannot start while ${this.starting.length} other job(s) are starting. Try again in a moment.`);
  }

  async create(spec: JobSpec): Promise<Job> {
    const exclusive = Boolean(spec.exclusive);
    // Checked and reserved before the first await, so concurrent starts see each other.
    this.checkAlone(exclusive);
    const reservation = { exclusive };
    this.starting.push(reservation);
    try {
      return await this.start(spec);
    } finally {
      this.starting.splice(this.starting.indexOf(reservation), 1);
    }
  }

  private async start(spec: JobSpec): Promise<Job> {
    if (spec.ask) {
      if (spec.kind !== 'delegate') throw new Error('An ask job must use kind "delegate".');
      if (!spec.task?.trim()) throw new Error('An ask job requires a task with the question to answer.');
      if (spec.exclusive || spec.runsApp || spec.targets !== undefined || spec.base !== undefined || spec.isolation === 'worktree') {
        throw new Error('An ask job cannot use exclusive, runsApp, targets, base, or isolation "worktree": it runs read-only in cwd.');
      }
    }
    // Only an engineer can measure: a review runs in a read-only sandbox and an editor runs nothing.
    if (spec.exclusive && spec.kind !== 'delegate') {
      throw new Error(`A ${spec.kind} job cannot run alone, because it has nothing to measure with. Measure with delegate and exclusive, or drop exclusive.`);
    }
    const config = this.readConfig();
    const role = effectiveRole(config, spec.kind);
    const { agent } = role;
    if (spec.runsApp && spec.kind === 'polish') throw new Error('A polish job cannot run the app: an editor only changes wording. Drop runs_app.');
    if (spec.runsApp && spec.kind === 'review' && !WORKERS[agent].reviewerRunsGit) {
      throw new Error(`review is assigned to ${WORKERS[agent].name}, which cannot run commands as a reviewer, so it cannot run the app. Drop runs_app, or run the app in your own review.`);
    }
    if (agent === 'antigravity' && !config.antigravity.enabled) {
      throw new Error(`${spec.kind} is assigned to Antigravity, which is disabled in ~/.crew/config.json (antigravity.enabled).`);
    }
    if (!fs.existsSync(spec.cwd)) throw new Error(`cwd does not exist: ${spec.cwd}`);
    if (spec.skills !== undefined && (!Array.isArray(spec.skills) || spec.skills.some((name) => typeof name !== 'string'))) {
      throw new Error('skills must be a list of skill names.');
    }
    const skills = findSkills(spec.skills ?? []);

    const id = `${WORKERS[agent].idPrefix}-${randomBytes(3).toString('hex')}`;
    const repo = await repoRoot(spec.cwd);
    // Read from the main working tree even when the job starts inside a worktree, so an uncommitted edit applies to the next job.
    const root = (await projectRoot(spec.cwd)) ?? spec.project ?? spec.cwd;
    const shared = sharedInstructions(this.home, root);
    const notes: string[] = Array.isArray(spec.notes) ? spec.notes.filter((note) => typeof note === 'string') : [];
    let worktree: Worktree | null = null;
    let cwd = spec.cwd;

    if (!spec.ask && spec.kind !== 'review' && (spec.isolation ?? 'worktree') === 'worktree') {
      if (!repo) {
        throw new Error(`${spec.cwd} is not inside a git repository, so there is no worktree to isolate the worker in. Pass isolation: "in_place" to let it edit that directory directly.`);
      }
      const base = spec.base ?? 'HEAD';
      worktree = await createWorktree(repo, id, base, this.home);
      cwd = worktree.path;
      const included = await copyIncluded(repo, worktree.path);
      if (included.copied.length) notes.push(`Copied from .worktreeinclude: ${included.copied.join(', ')}`);
      if (included.failed.length) notes.push(`Could not copy from .worktreeinclude: ${included.failed.join('; ')}`);
      const dirty = await dirtyCount(repo);
      if (dirty > 0) notes.push(`${dirty} uncommitted path(s) in the main tree are not in this worktree, which starts from ${base} (${worktree.base.slice(0, 8)}). Commit first if the worker needs them.`);
    }

    if (spec.kind === 'review' && spec.runsApp) {
      if (!repo) throw new Error(`${spec.cwd} is not inside a git repository, so there is no snapshot to run the app in. Drop runs_app.`);
      worktree = await this.snapshot(repo, id, spec.review!.target, notes);
      cwd = worktree.path;
    }

    let diffFile: string | null = null;
    if (spec.kind === 'review' && !WORKERS[agent].reviewerRunsGit) {
      if (!repo) throw new Error(`review is assigned to ${WORKERS[agent].name}, which has to be handed the diff, and ${spec.cwd} is not inside a git repository.`);
      diffFile = this.diffFile(id);
      fs.mkdirSync(path.dirname(diffFile), { recursive: true });
      fs.writeFileSync(diffFile, await reviewDiff(repo, spec.review!.target));
      notes.push(`${WORKERS[agent].name} cannot run commands as a reviewer: it was given the diff as a file and could not run tests or checks.`);
    }
    if (spec.review?.mode === 'standard' && agent !== 'codex') notes.push(`The standard review mode is Codex's own; ${WORKERS[agent].name} ran the adversarial review instead.`);
    // A read-only worker that runs commands gets somewhere to write: without it a test that makes a temporary file cannot run.
    const readOnly = Boolean(spec.ask) || (spec.kind === 'review' && !spec.runsApp);
    const scratch = readOnly && WORKERS[agent].readOnlyScratch ? this.scratchDir(id) : undefined;
    if (scratch) fs.mkdirSync(scratch, { recursive: true });

    // Diffs name files relative to the repo root, so scope targets must be too.
    const targetRoot = repo ?? spec.cwd;
    spec.targets = spec.targets?.map((t) => path.relative(targetRoot, path.resolve(spec.cwd, t)));

    const title = (spec.title ?? spec.task ?? spec.targets?.join(', ') ?? spec.kind).split('\n')[0].slice(0, 80);
    const now = Date.now();
    const job: Job = {
      id,
      kind: spec.kind,
      agent,
      title,
      state: 'running',
      phase: 'starting',
      repo,
      project: spec.project ?? repo ?? spec.cwd,
      root,
      mission: spec.mission,
      exclusive: Boolean(spec.exclusive) || undefined,
      runsApp: Boolean(spec.runsApp) || undefined,
      ask: Boolean(spec.ask) || undefined,
      cwd,
      worktree,
      sandbox: spec.ask || (spec.kind === 'review' && !spec.runsApp) ? 'read-only' : 'workspace-write',
      scratch,
      ...buildPrompt(spec, worktree, diffFile, shared.text, scratch, runsCommands(agent, spec), skills),
      shared: shared.sources,
      // Only Codex has a built-in review mode; other agents get the prompted review.
      nativeReview: spec.kind === 'review' && agent === 'codex' && spec.review?.mode === 'standard' ? spec.review.target : null,
      reviewTarget: spec.review?.target,
      targets: spec.targets ?? [],
      model: spec.model ?? role.model,
      effort: spec.effort ?? role.effort,
      sessionId: null,
      createdAt: now,
      activeAt: now,
      endedAt: null,
      turns: 1,
      stalled: false,
      waiting: null,
      report: '',
      result: null,
      notes,
      error: null,
      tokens: null,
      seq: 0,
      delivered: 0,
    };
    this.jobs.set(id, job);
    this.event(job, 'started', `${spec.kind}: ${title}`);
    if (worktree) this.flush();

    const ctl = this.ctl(job);
    // Session setup can take seconds; the caller gets the job id right away and follows via wait.
    this.adapters[agent].start(ctl).catch((err) => ctl.fail(String(err?.message ?? err)));
    return job;
  }

  async reply(id: string, input: { message?: string; decision?: 'approve' | 'deny'; request_id?: string; approved_by_user?: string; sync?: boolean | string }): Promise<Job> {
    const job = this.get(id);
    if (this.changingRounds.has(id)) throw new Error(`Job ${id} is changing a round. Wait for it to finish.`);
    if (this.discarding.has(id)) throw new Error(`Job ${id} is being discarded.`);
    if (this.cancelling.has(id)) throw new Error(`Job ${id} is being cancelled.`);
    if (this.preparingReviews.has(id)) throw new Error(`Job ${id} is preparing its review diff. Wait for it to finish.`);
    if (this.finalizing.has(id)) throw new Error(`Job ${id} is collecting its result. Wait for it to finish.`);
    const ctl = this.ctl(job);
    const adapter = this.adapters[job.agent];
    if (input.request_id !== undefined && input.request_id !== job.waiting?.id) {
      throw new Error('That request is no longer pending. Check the current job before answering.');
    }
    if (input.decision !== undefined && input.decision !== 'approve' && input.decision !== 'deny') {
      throw new Error('Pass decision "approve" or "deny".');
    }
    if (job.waiting) {
      if (input.approved_by_user !== undefined) throw new Error(`Job ${id} is waiting on the user (${job.waiting.reason}). approved_by_user is for an action the automatic reviewer refused in a finished turn; call wait so the user is asked.`);
      if (!input.request_id) throw new Error('Pass the request_id shown in the current job status.');
      // A message alone must never count as approval: the lead may only be asking the worker why.
      if (job.waiting.type === 'approval' && !input.decision) throw new Error(`Job ${id} is waiting for approval (${job.waiting.reason}). Pass decision "approve" or "deny".`);
      if (!input.decision && !input.message?.trim()) throw new Error(`Job ${id} asked a question (${job.waiting.reason}). Pass a message with the answer, or a decision.`);
      await adapter.answer(ctl, input.decision !== 'deny', input.message);
      return job;
    }
    if (input.decision !== undefined) throw new Error(`Job ${id} is not waiting for a decision.`);
    const retry = input.approved_by_user === undefined ? null : this.retryRefused(job, input.approved_by_user, input.message);
    if (retry) input = { message: retry.message };
    if (!input.message) throw new Error(`Job ${id} is not waiting for a decision. Pass a message to send a follow-up.`);
    if (!job.sessionId) throw new Error(`Job ${id} never opened a session, so there is nothing to continue. Start a new job instead.`);
    // Its directory is gone: a turn would run nowhere, and its edits would be reported as made in place.
    // A review that runs the app is the exception: its snapshot is made anew for each turn, below.
    if (!(job.kind === 'review' && job.runsApp) && !fs.existsSync(job.cwd)) {
      throw new Error(`Job ${id}'s worktree was removed, so it cannot take another turn. Start a new job; to ask something without changing anything, use a question.`);
    }
    if (!isTerminal(job)) {
      // A merge under a worker that is in the middle of editing would pull the tree out from under it.
      if (input.sync) throw new Error(`Job ${id} is still ${job.state}; sync brings a finished job up to date before its next turn. Wait for the turn to end, or send the message without sync.`);
      // Steering a live turn: a rejected message is the caller's problem, not a reason to fail the job.
      await adapter.reply(ctl, input.message);
      return job;
    }
    // The worker started from an older commit. Merging the lead's branch in first gives it what was committed since,
    // and moves the base, so the job's result stays the worker's own changes.
    let synced: string | null = null;
    if (input.sync) {
      if (!job.worktree || !job.repo || job.kind === 'review') throw new Error(`Job ${id} has no worktree of its own to bring up to date. Drop sync.`);
      this.preparingReviews.add(id);
      try {
        synced = await mergeInto(job.worktree.path, job.repo, typeof input.sync === 'string' ? input.sync : 'HEAD');
        if (synced !== job.worktree.base) {
          // Rounds are replayed from the branch's history, which starts where the job did, not where it was last synced.
          job.roundsBase ??= job.worktree.base;
          job.worktree.base = synced;
          job.notes.push(`Brought up to date with ${synced.slice(0, 8)} before turn ${job.turns + 1}.`);
          job.result = await this.worktreeResult(job, job.result?.commit ?? null);
          this.flush();
        }
      } finally {
        this.preparingReviews.delete(id);
      }
      if (!isTerminal(job)) return job;
    }
    const refreshDiff = job.kind === 'review' && !WORKERS[job.agent].reviewerRunsGit;
    if (refreshDiff && (!job.reviewTarget || !job.repo)) {
      throw new Error(`Job ${id} has no saved review target or repository. Start a new review instead.`);
    }
    // A follow-up turn sets a finished worker running again, so it is a start like any other.
    this.checkAlone(Boolean(job.exclusive), id);
    job.state = 'running';
    job.phase = 'starting';
    job.endedAt = null;
    job.error = null;
    // A retry that follows a retry goes to the user; every other turn is the automatic reviewer's.
    job.asksUser = retry !== null && job.retrying !== undefined;
    job.retrying = retry?.actions;
    job.turns += 1;
    this.turnStartTokens.set(id, job.tokens ?? 0);
    job.activeAt = Date.now();
    const what = !retry ? input.message.split('\n')[0].slice(0, 80) : job.asksUser ? 'refused action retried; the user is asked about each request' : 'refused action retried with the user\'s approval';
    this.event(job, 'started', `follow-up: ${what}`);
    try {
      let message = input.message;
      if (job.scratch) fs.mkdirSync(job.scratch, { recursive: true });
      if (synced) message += `\n\nYour worktree has been brought up to date: it now contains the lead's commits up to \`${synced.slice(0, 8)}\`, merged into your branch. Look at what changed (\`git log -5 --stat\`) before continuing.`;
      if (job.kind === 'review' && job.runsApp) {
        this.preparingReviews.add(id);
        try {
          await this.snapshots.get(id);
          if (job.worktree) throw new Error(`The previous snapshot at ${job.worktree.path} could not be removed. Cancel this job with discard: true and start a new review.`);
          job.worktree = await this.snapshot(job.repo!, id, job.reviewTarget!, job.notes);
          // Recorded before anything else can fail, so the snapshot is never left without an owner.
          this.flush();
          if (isTerminal(job)) {
            this.dropSnapshot(job);
            return job;
          }
          message += '\n\nThe snapshot has been refreshed to the current state of the change.';
        } finally {
          this.preparingReviews.delete(id);
        }
      }
      if (refreshDiff) {
        this.preparingReviews.add(id);
        const diffFile = this.diffFile(id, job.turns);
        try {
          const diff = await reviewDiff(job.repo!, job.reviewTarget!);
          if (isTerminal(job)) return job;
          fs.mkdirSync(path.dirname(diffFile), { recursive: true });
          fs.writeFileSync(diffFile, diff);
          message += `\n\nThe review diff has been refreshed at \`${diffFile}\` for the original review target. Read this file before reviewing; it replaces the previous diff.`;
        } finally {
          this.preparingReviews.delete(id);
        }
      }
      await adapter.reply(ctl, message);
    } catch (err) {
      ctl.fail(String((err as Error)?.message ?? err));
    }
    return job;
  }

  /** The follow-up that sends a refused action back, stating that the user approved it. */
  private retryRefused(job: Job, words: string, extra?: string): { message: string; actions: string[] } {
    if (typeof words !== 'string' || !words.trim()) throw new Error('approved_by_user must quote what the user said that approves the refused action.');
    if (!isTerminal(job)) throw new Error(`Job ${job.id} is still ${job.state}. Wait for the turn to end before sending a refused action back.`);
    const actions = openRefusals(job).map((refusal) => refusal.action);
    if (!actions.length) throw new Error(`Nothing was refused in the last turn of job ${job.id}, so there is nothing to approve. Send a plain message instead.`);
    const parts = [
      `The user approved what the automatic reviewer refused. Their words in the lead session: "${words.trim()}"`,
      `Run the refused action again, exactly as before:\n${actions.join('\n')}`,
    ];
    if (extra?.trim()) parts.push(extra.trim());
    return { message: parts.join('\n\n'), actions };
  }

  /** A worktree holding the change under review, for a reviewer that runs the app. Removed when the turn ends. */
  private async snapshot(repo: string, id: string, target: ReviewTarget, notes: string[]): Promise<Worktree> {
    const worktree = await createWorktree(repo, id, target.type === 'commit' ? target.sha : 'HEAD', this.home);
    try {
      if (target.type === 'uncommittedChanges') await carryUncommitted(repo, worktree.path);
      const partial = 'The snapshot does not contain submodules: their directories are empty in it.';
      if (fs.existsSync(path.join(repo, '.gitmodules')) && !notes.includes(partial)) notes.push(partial);
      const included = await copyIncluded(repo, worktree.path);
      const failed = `Could not copy from .worktreeinclude: ${included.failed.join('; ')}`;
      if (included.failed.length && !notes.includes(failed)) notes.push(failed);
    } catch (err) {
      await removeWorktree(repo, worktree, id, this.home).catch(() => {});
      throw err;
    }
    return worktree;
  }

  private dropSnapshot(job: Job): void {
    const { worktree, repo } = job;
    if (!worktree || !repo || this.snapshots.has(job.id)) return;
    const removal = removeWorktree(repo, worktree, job.id, this.home).then(
      () => {
        job.worktree = null;
      },
      (err) => {
        job.notes.push(`Could not remove the review snapshot at ${worktree.path}: ${err.message}`);
      },
    ).finally(() => {
      this.snapshots.delete(job.id);
      this.changed(job);
    });
    this.snapshots.set(job.id, removal);
  }

  async cancel(id: string): Promise<Job> {
    const job = this.get(id);
    if (this.cancelling.has(id)) throw new Error(`Job ${id} is already being cancelled.`);
    if (isTerminal(job)) return job;
    if (this.finalizing.has(id)) throw new Error(`Job ${id} is collecting its result. Wait for it to finish.`);
    const ctl = this.ctl(job);
    this.cancelling.add(id);
    try {
      await this.adapters[job.agent].cancel(ctl);
      ctl.cancelled();
    } finally {
      this.cancelling.delete(id);
    }
    return job;
  }

  /** Removes the worktree and branch of a finished job. */
  async discard(id: string): Promise<Job> {
    const job = this.get(id);
    if (this.changingRounds.has(id)) throw new Error(`Job ${id} is changing a round. Wait for it to finish.`);
    if (this.cancelling.has(id)) throw new Error(`Job ${id} is being cancelled.`);
    if (!isTerminal(job)) throw new Error(`Job ${id} is still ${job.state}; cancel it first.`);
    if (this.preparingReviews.has(id)) throw new Error(`Job ${id} is being brought up to date. Wait for it to finish.`);
    if (this.discarding.has(id)) throw new Error(`Job ${id} is already being discarded.`);
    // Reserved before the first await, so a follow-up cannot set the worker running in a worktree that is about to go.
    this.discarding.add(id);
    try {
      // A review snapshot may be on its way out already; removing it twice would fail on the branch.
      await this.snapshots.get(id);
      if (job.worktree && job.repo) {
        await removeWorktree(job.repo, job.worktree, job.id, this.home);
        job.worktree = null;
        job.notes.push('Worktree and branch removed.');
        this.changed(job);
        this.flush();
      }
    } finally {
      this.discarding.delete(id);
    }
    return job;
  }

  async round(id: string, turn: number, action: 'undo' | 'keep'): Promise<Job> {
    const job = this.get(id);
    if (!isTerminal(job)) throw new Error(`Job ${id} is still ${job.state}; wait for the turn to end before changing a round.`);
    if (this.discarding.has(id)) throw new Error(`Job ${id} is being discarded.`);
    if (this.changingRounds.has(id)) throw new Error(`Job ${id} is already changing a round.`);
    // A sync is merging into the same worktree.
    if (this.preparingReviews.has(id)) throw new Error(`Job ${id} is being brought up to date. Wait for it to finish.`);
    const round = job.rounds?.find((round) => round.turn === turn);
    if (!round) throw new Error(`Job ${id} has no round for turn ${turn}.`);
    if (!job.worktree || !fs.existsSync(path.join(job.worktree.path, '.git'))) throw new Error(`Job ${id}'s worktree is gone or discarded.`);
    // The path is where git will commit. It must still be the job's own worktree on the job's own branch:
    // a link put in its place, or a branch switched by hand, would send the revert somewhere else.
    if (fs.lstatSync(job.worktree.path).isSymbolicLink()) throw new Error(`Job ${id}'s worktree path is now a link to somewhere else, so no round was changed.`);
    this.changingRounds.add(id);
    try {
      if ((await currentBranch(job.worktree.path)) !== job.worktree.branch) throw new Error(`Job ${id}'s worktree is not on ${job.worktree.branch}, so no round was changed.`);
      // A revert made just before the daemon stopped is in git but not in the saved job; git is the truth.
      await this.reconcileRounds(job);
      const state = action === 'undo' ? 'undone' : 'kept';
      if (round.state === state) throw new Error(`Round ${turn} is already ${state}.`);
      const commit = action === 'undo' ? round.commit : round.revert;
      if (!commit) throw new Error(`Round ${turn} has no revert commit to keep.`);
      const reverted = await revertCommit(job.worktree.path, commit);
      const result = await this.worktreeResult(job, reverted);
      round.state = state;
      if (action === 'undo') round.revert = reverted;
      else delete round.revert;
      job.result = result;
      this.event(job, 'progress', `round ${turn} ${state}`);
      this.flush();
    } finally {
      this.changingRounds.delete(id);
    }
    return job;
  }

  /** Sets each round's state from the reverts on the job branch, replayed in the order they were made. */
  private async reconcileRounds(job: Job): Promise<void> {
    const rounds = job.rounds ?? [];
    const same = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
    const before = JSON.stringify(rounds);
    for (const round of rounds) {
      round.state = 'kept';
      delete round.revert;
    }
    for (const { commit, reverts } of await revertsSince(job.worktree!.path, job.roundsBase ?? job.worktree!.base)) {
      for (const round of rounds) {
        if (round.state === 'kept' && same(reverts, round.commit)) {
          round.state = 'undone';
          round.revert = commit.slice(0, round.commit.length);
        } else if (round.state === 'undone' && same(reverts, round.revert!)) {
          round.state = 'kept';
          delete round.revert;
        }
      }
    }
    if (JSON.stringify(rounds) === before) return;
    job.result = await this.worktreeResult(job, job.result?.commit ?? null);
    this.flush();
  }

  ask(id: string, text: string, blocks?: string): LeadQuestion {
    const job = this.get(id);
    if (isTerminal(job)) throw new Error(`Job ${id} is ${job.state}; questions require a running or waiting job.`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Question text must be a non-empty string.');
    if (text.length > 4000) throw new Error('Question text must be at most 4000 characters.');
    if (blocks !== undefined && typeof blocks !== 'string') throw new Error('blocks must be a string.');
    if ((job.questions?.length ?? 0) >= 20) throw new Error(`Job ${id} already has 20 lead questions.`);
    const question: LeadQuestion = { id: randomUUID(), text, ...(blocks === undefined ? {} : { blocks }), at: Date.now() };
    (job.questions ??= []).push(question);
    job.activeAt = Date.now();
    job.questionSeq = this.seq + 1;
    this.event(job, 'progress', `asks the lead: ${text.trim().split('\n')[0]}`);
    return question;
  }

  answer(id: string, questionId: string, text: string): Job {
    const job = this.get(id);
    const question = job.questions?.find((q) => q.id === questionId);
    if (!question) throw new Error(`No lead question with id "${questionId}" on job ${id}.`);
    if (question.answer !== undefined) throw new Error(`Lead question ${questionId} is already answered.`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Answer must be a non-empty string.');
    question.answer = text;
    question.answeredAt = Date.now();
    this.event(job, 'progress', `lead answered ${questionId}`);
    return job;
  }

  workerAuthorized(id: string, token: unknown): boolean {
    return typeof token === 'string' && token.length > 0 && this.workerTokens.get(id) === token;
  }

  siblings(id: string) {
    const job = this.get(id);
    return this.list().filter((other) => other.id !== id && !isTerminal(other) &&
      (job.mission ? other.mission === job.mission : other.project === job.project))
      // What a neighbor needs to stay out of the way: who has which files, and whether it is held up. Not its log.
      .map(({ id, kind, agent, title, targets, ask, questions, worktree }) => ({
        id, kind: ask ? 'question' : kind, agent, title, files: targets, asking: Boolean(questions?.some((q) => q.answer === undefined)), base: worktree?.base ?? null,
      }));
  }

  async leadAnswers(id: string, seconds: number): Promise<LeadQuestion[]> {
    const job = this.get(id);
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error('wait must be a non-negative number of seconds.');
    const open = (job.questions ?? []).filter((q) => q.answer === undefined);
    const deadline = Date.now() + Math.min(seconds, 600) * 1000;
    while (open.length && open.every((q) => q.answer === undefined) && Date.now() < deadline) {
      await this.wait(id, job.seq, deadline - Date.now());
    }
    return job.questions ?? [];
  }

  /** Resolves when the job has an event newer than `after`, or after `timeoutMs`. */
  wait(id: string, after: number, timeoutMs: number): Promise<void> {
    const job = this.get(id);
    if (job.seq > after) return Promise.resolve();
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set();
      this.waiters.set(id, set);
      const finish = () => {
        clearTimeout(timer);
        set.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      set.add(finish);
    });
  }

  /** Records that the lead has seen the job up to `seq`. Returns false if it already had. */
  markDelivered(id: string, seq: number): boolean {
    const job = this.jobs.get(id);
    if (!job || seq <= job.delivered) return false;
    job.delivered = seq;
    this.changed(job);
    return true;
  }

  private ctl(job: Job): JobCtl {
    const live = () => !isTerminal(job);
    let token = this.workerTokens.get(job.id);
    if (!token) this.workerTokens.set(job.id, token = randomBytes(32).toString('hex'));
    return {
      job,
      mcp: {
        command: process.execPath,
        args: [path.join(import.meta.dirname, `worker-mcp${path.extname(import.meta.filename)}`)],
        env: { CREW_JOB_ID: job.id, CREW_JOB_TOKEN: token, CREW_PORT: String(PORT), CREW_JOB_CWD: job.cwd },
      },
      activity: () => {
        if (!live()) return;
        job.activeAt = Date.now();
        if (job.stalled) {
          job.stalled = false;
          this.event(job, 'progress', 'active again');
        }
      },
      phase: (text) => {
        if (!live()) return;
        job.activeAt = Date.now();
        job.stalled = false;
        if (job.phase !== text) {
          job.phase = text;
          this.changed(job);
        }
      },
      progress: (detail) => {
        if (!live()) return;
        job.activeAt = Date.now();
        job.stalled = false;
        job.phase = detail;
        this.event(job, 'progress', detail);
      },
      session: (id) => {
        job.sessionId = id;
        this.changed(job);
      },
      touched: (file) => {
        const set = this.touchedFiles.get(job.id) ?? new Set();
        this.touchedFiles.set(job.id, set);
        set.add(file);
      },
      note: (text) => {
        if (job.notes.includes(text)) return;
        job.notes.push(text);
        this.changed(job);
      },
      refused: (action, reason) => {
        if (!live()) return;
        (job.refusals ??= []).push({ action, reason, turn: job.turns });
        this.event(job, 'progress', `refused by the automatic reviewer: ${action.split('\n')[0].slice(0, 120)}`);
      },
      tokens: (total, parts) => {
        job.tokens = total;
        if (parts) job.tokenUse = { ...parts, turn: total - (this.turnStartTokens.get(job.id) ?? 0) };
      },
      waiting: (type, reason) => {
        if (!live()) return;
        job.state = 'waiting';
        job.stalled = false;
        job.waiting = { type, reason, id: randomUUID(), since: Date.now() };
        job.phase = type === 'approval' ? 'needs approval' : 'has a question';
        this.event(job, 'waiting', reason);
        this.hooks.onAttention(job, 'waiting', reason);
      },
      resumed: () => {
        if (job.state !== 'waiting') return;
        job.state = 'running';
        job.waiting = null;
        job.phase = 'working';
        job.activeAt = Date.now();
        this.event(job, 'progress', 'resumed');
      },
      done: (report) => {
        if (!live() || this.finalizing.has(job.id)) return;
        this.finalizing.add(job.id);
        this.finalize(job, report).catch((err) => {
          this.finalizing.delete(job.id);
          if (live()) this.fail(job, `could not collect the result: ${err.message}`, false);
        });
      },
      fail: (message, opts) => {
        if (live() && !this.finalizing.has(job.id)) this.fail(job, message, opts?.limit ?? false);
      },
      cancelled: () => {
        if (!live() || this.finalizing.has(job.id)) return;
        job.state = 'cancelled';
        job.waiting = null;
        job.stalled = false;
        job.endedAt = Date.now();
        job.phase = 'cancelled';
        this.event(job, 'cancelled', 'cancelled');
      },
    };
  }

  private async finalize(job: Job, report: string): Promise<void> {
    let result: Job['result'];
    // A review's worktree is a snapshot to run the app in; nothing in it is kept.
    if (job.worktree && job.kind !== 'review') {
      const commit = await commitAll(job.worktree.path, `crew(${job.agent}): ${job.title}`);
      if (commit) (job.rounds ??= []).push({ turn: job.turns, commit, ...await commitChanges(job.worktree.path, commit), state: 'kept', at: Date.now() });
      result = await this.worktreeResult(job, commit);
    } else if (job.kind === 'review' || job.ask) {
      result = null;
    } else {
      const root = job.repo ?? job.cwd;
      const files = [...(this.touchedFiles.get(job.id) ?? [])].map((f) => path.relative(root, f));
      result = { files, stat: `${files.length} file(s) edited in place`, commit: null, outOfScope: outOfScope(files, job.targets) };
    }
    this.finalizing.delete(job.id);
    if (isTerminal(job)) return;
    job.report = report;
    job.result = result;
    job.state = 'done';
    job.waiting = null;
    job.stalled = false;
    job.endedAt = Date.now();
    job.phase = 'done';
    this.event(job, 'done', result?.stat || headline(report) || 'finished');
    if (this.settings.notifyOnDone) this.hooks.onAttention(job, 'done', job.title);
  }

  private async worktreeResult(job: Job, commit: string | null): Promise<NonNullable<Job['result']>> {
    const { files, stat } = await changesSince(job.worktree!.path, job.worktree!.base);
    // The diff only covers the worktree; edits the worker reported elsewhere are violations too.
    const escaped = [...(this.touchedFiles.get(job.id) ?? [])].filter((f) => !isInside(job.cwd, f));
    return { files, stat, commit, outOfScope: [...outOfScope(files, job.targets), ...escaped] };
  }

  private fail(job: Job, message: string, limit: boolean): void {
    job.state = 'failed';
    job.waiting = null;
    job.stalled = false;
    job.endedAt = Date.now();
    job.error = { message, limit };
    job.phase = limit ? 'usage limit reached' : 'failed';
    const kind: EventKind = limit ? 'limit' : 'error';
    this.event(job, kind, message);
    this.hooks.onAttention(job, kind, message);
  }

  private checkStalls(): void {
    const limit = this.settings.stallSeconds * 1000;
    for (const job of this.jobs.values()) {
      if (job.state !== 'running' || job.stalled || Date.now() - job.activeAt < limit) continue;
      job.stalled = true;
      const detail = `no activity for ${Math.round(limit / 60_000)} min (last: ${job.phase})`;
      this.event(job, 'stalled', detail);
      this.hooks.onAttention(job, 'stalled', detail);
    }
  }

  /** Appends to the event log. Also used for Claude session events, which have no job. */
  record(agent: Agent, sessionId: string | null, kind: EventKind, detail: string, jobId?: string): CrewEvent {
    const event: CrewEvent = { seq: ++this.seq, ts: new Date().toISOString(), agent, session_id: sessionId, job_id: jobId, kind, detail };
    this.recent.push(event);
    if (this.recent.length > KEEP_EVENTS) this.recent.splice(0, this.recent.length - KEEP_EVENTS);
    fs.appendFile(path.join(this.home, 'events.jsonl'), JSON.stringify(event) + '\n', () => {});
    this.hooks.onEvent(event);
    return event;
  }

  private scratchDir(id: string): string {
    return path.join(this.home, 'scratch', id);
  }

  /**
   * Moved aside in one step and deleted afterwards: a follow-up turn that starts at once makes a fresh
   * directory, and the slow removal of a large one can never reach it.
   */
  private dropScratch(id: string): void {
    const dir = this.scratchDir(id);
    const gone = `${dir}.gone-${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(dir, gone);
    } catch {
      return;
    }
    fs.rm(gone, { recursive: true, force: true }, () => {});
  }

  private diffFile(id: string, turn = 1): string {
    return path.join(this.home, 'reviews', `${id}${turn === 1 ? '' : `-${turn}`}.diff`);
  }

  eventsFor(id: string, after: number): CrewEvent[] {
    return this.recent.filter((e) => e.job_id === id && e.seq > after);
  }

  private event(job: Job, kind: EventKind, detail: string): void {
    job.seq = this.record(job.agent, job.sessionId, kind, detail, job.id).seq;
    // Each turn has its own file, so delayed cleanup cannot delete a follow-up's fresh diff.
    if (isTerminal(job) && job.kind === 'review') {
      fs.rm(this.diffFile(job.id, job.turns), { force: true }, () => {});
      this.dropSnapshot(job);
    }
    // Scratch is for the turn: nothing in it is a result. The path is derived, never read from the job, before it is removed.
    if (isTerminal(job) && job.scratch) this.dropScratch(job.id);
    this.changed(job);
    for (const wake of [...(this.waiters.get(job.id) ?? [])]) wake();
  }

  private changed(job: Job): void {
    this.hooks.onJob(job);
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  private save(): void {
    let history = 0;
    const keep = this.list().filter((job) =>
      job.worktree || !isTerminal(job) || job.seq > job.delivered || (job.mission !== undefined && this.hooks.keepsMission?.(job.mission)) || history++ < KEEP_JOBS,
    );
    const file = path.join(this.home, 'jobs.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ seq: this.seq, jobs: keep }));
    fs.renameSync(`${file}.tmp`, file);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private load(): void {
    let saved: { seq: number; jobs: Job[] };
    try {
      saved = JSON.parse(fs.readFileSync(path.join(this.home, 'jobs.json'), 'utf8'));
    } catch {
      return;
    }
    this.seq = saved.seq;
    for (const job of saved.jobs) {
      // Jobs saved before ownership was recorded; their repository is the closest stand-in.
      job.project ??= job.repo ?? job.cwd;
      if (!isTerminal(job)) {
        // The worker process died with the previous bridge; its session can still be continued with reply.
        job.state = 'failed';
        job.waiting = null;
        job.endedAt = Date.now();
        job.phase = 'failed';
        const next = job.sessionId ? 'Use reply to continue the same session.' : 'Start a new job.';
        job.error = { message: `The bridge restarted while this job was running. ${next}`, limit: false };
      }
      this.jobs.set(job.id, job);
      if (job.kind === 'review') this.dropSnapshot(job);
    }
    // No turn survives a restart, so neither does any scratch.
    fs.rmSync(path.join(this.home, 'scratch'), { recursive: true, force: true });
  }
}

/** First line of a report that says something, skipping markdown headings. */
function headline(report: string): string {
  const line = report.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '';
  return line.trim().slice(0, 140);
}

/** Files changed outside the paths the worker was told it may touch. */
export function outOfScope(files: string[], targets: string[]): string[] {
  if (targets.length === 0) return [];
  const allowed = targets.map((t) => t.replace(/^\.\//, '').replace(/\/+$/, ''));
  return files.filter((file) => !allowed.some((t) => file === t || file.startsWith(`${t}/`) || path.matchesGlob(file, t)));
}
