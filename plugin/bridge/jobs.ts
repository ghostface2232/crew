import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { WORKERS } from './config.ts';
import type { Config, Role, WorkerAgent } from './config.ts';
import { changesSince, commitAll, copyIncluded, createWorktree, dirtyCount, isInside, projectRoot, removeWorktree, repoRoot, reviewDiff } from './git.ts';
import type { Worktree } from './git.ts';
import { sharedInstructions } from './instructions.ts';
import { buildPrompt } from './prompts.ts';

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
  /** Lines the caller wants shown with the result from the start. */
  notes?: string[];
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
  result: { files: string[]; stat: string; commit: string | null; outOfScope: string[] } | null;
  notes: string[];
  error: { message: string; limit: boolean } | null;
  tokens: number | null;
  /** Seq of the latest event about this job. */
  seq: number;
  /** Seq up to which the lead has already been told; stops the wake hook from repeating it. */
  delivered: number;
}

/** What an adapter may do to the job it is running. */
export interface JobCtl {
  readonly job: Job;
  /** Worker is alive; resets the stall timer. */
  activity(): void;
  phase(text: string): void;
  progress(detail: string): void;
  session(id: string): void;
  touched(file: string): void;
  /** Adds a line to the result that the lead should see, such as a refused action. */
  note(text: string): void;
  tokens(total: number): void;
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

export function isTerminal(job: Job): boolean {
  return TERMINAL.includes(job.state);
}

export class Jobs {
  readonly jobs = new Map<string, Job>();
  readonly recent: CrewEvent[] = [];
  private seq = 0;
  private waiters = new Map<string, Set<() => void>>();
  private touchedFiles = new Map<string, Set<string>>();
  private discarding = new Set<string>();
  private finalizing = new Set<string>();
  private cancelling = new Set<string>();
  private preparingReviews = new Set<string>();
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

  async create(spec: JobSpec): Promise<Job> {
    const config = this.readConfig();
    const role = config.roles[spec.kind];
    const { agent } = role;
    if (agent === 'antigravity' && !config.antigravity.enabled) {
      throw new Error(`${spec.kind} is assigned to Antigravity, which is disabled in ~/.crew/config.json (antigravity.enabled).`);
    }
    if (!fs.existsSync(spec.cwd)) throw new Error(`cwd does not exist: ${spec.cwd}`);

    const id = `${WORKERS[agent].idPrefix}-${randomBytes(3).toString('hex')}`;
    const repo = await repoRoot(spec.cwd);
    // Read from the main working tree even when the job starts inside a worktree, so an uncommitted edit applies to the next job.
    const root = (await projectRoot(spec.cwd)) ?? spec.project ?? spec.cwd;
    const shared = sharedInstructions(this.home, root);
    const notes: string[] = Array.isArray(spec.notes) ? spec.notes.filter((note) => typeof note === 'string') : [];
    let worktree: Worktree | null = null;
    let cwd = spec.cwd;

    if (spec.kind !== 'review' && (spec.isolation ?? 'worktree') === 'worktree') {
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

    let diffFile: string | null = null;
    if (spec.kind === 'review' && !WORKERS[agent].reviewerRunsGit) {
      if (!repo) throw new Error(`review is assigned to ${WORKERS[agent].name}, which has to be handed the diff, and ${spec.cwd} is not inside a git repository.`);
      diffFile = this.diffFile(id);
      fs.mkdirSync(path.dirname(diffFile), { recursive: true });
      fs.writeFileSync(diffFile, await reviewDiff(repo, spec.review!.target));
      notes.push(`${WORKERS[agent].name} cannot run commands as a reviewer: it was given the diff as a file and could not run tests or checks.`);
    }
    if (spec.review?.mode === 'standard' && agent !== 'codex') notes.push(`The standard review mode is Codex's own; ${WORKERS[agent].name} ran the adversarial review instead.`);

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
      cwd,
      worktree,
      sandbox: spec.kind === 'review' ? 'read-only' : 'workspace-write',
      ...buildPrompt(spec, worktree, diffFile, shared.text),
      shared: shared.sources,
      // Only Codex has a built-in review mode; other agents get the prompted review.
      nativeReview: agent === 'codex' && spec.review?.mode === 'standard' ? spec.review.target : null,
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

  async reply(id: string, input: { message?: string; decision?: 'approve' | 'deny'; request_id?: string }): Promise<Job> {
    const job = this.get(id);
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
      if (!input.request_id) throw new Error('Pass the request_id shown in the current job status.');
      // A message alone must never count as approval: the lead may only be asking the worker why.
      if (job.waiting.type === 'approval' && !input.decision) throw new Error(`Job ${id} is waiting for approval (${job.waiting.reason}). Pass decision "approve" or "deny".`);
      if (!input.decision && !input.message?.trim()) throw new Error(`Job ${id} asked a question (${job.waiting.reason}). Pass a message with the answer, or a decision.`);
      await adapter.answer(ctl, input.decision !== 'deny', input.message);
      return job;
    }
    if (input.decision !== undefined) throw new Error(`Job ${id} is not waiting for a decision.`);
    if (!input.message) throw new Error(`Job ${id} is not waiting for a decision. Pass a message to send a follow-up.`);
    if (!job.sessionId) throw new Error(`Job ${id} never opened a session, so there is nothing to continue. Start a new job instead.`);
    if (!isTerminal(job)) {
      // Steering a live turn: a rejected message is the caller's problem, not a reason to fail the job.
      await adapter.reply(ctl, input.message);
      return job;
    }
    const refreshDiff = job.kind === 'review' && !WORKERS[job.agent].reviewerRunsGit;
    if (refreshDiff && (!job.reviewTarget || !job.repo)) {
      throw new Error(`Job ${id} has no saved review target or repository. Start a new review instead.`);
    }
    job.state = 'running';
    job.phase = 'starting';
    job.endedAt = null;
    job.error = null;
    job.turns += 1;
    job.activeAt = Date.now();
    this.event(job, 'started', `follow-up: ${input.message.split('\n')[0].slice(0, 80)}`);
    try {
      let message = input.message;
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
    if (this.cancelling.has(id)) throw new Error(`Job ${id} is being cancelled.`);
    if (!isTerminal(job)) throw new Error(`Job ${id} is still ${job.state}; cancel it first.`);
    if (this.discarding.has(id)) throw new Error(`Job ${id} is already being discarded.`);
    if (job.worktree && job.repo) {
      this.discarding.add(id);
      try {
        await removeWorktree(job.repo, job.worktree, job.id, this.home);
        job.worktree = null;
        job.notes.push('Worktree and branch removed.');
        this.changed(job);
        this.flush();
      } finally {
        this.discarding.delete(id);
      }
    }
    return job;
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
    return {
      job,
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
      tokens: (total) => {
        job.tokens = total;
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
    if (job.worktree) {
      const commit = await commitAll(job.worktree.path, `crew(${job.agent}): ${job.title}`);
      const { files, stat } = await changesSince(job.worktree.path, job.worktree.base);
      // The diff only covers the worktree; edits the worker reported elsewhere are violations too.
      const escaped = [...(this.touchedFiles.get(job.id) ?? [])].filter((f) => !isInside(job.cwd, f));
      result = { files, stat, commit, outOfScope: [...outOfScope(files, job.targets), ...escaped] };
    } else if (job.kind === 'review') {
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

  private diffFile(id: string, turn = 1): string {
    return path.join(this.home, 'reviews', `${id}${turn === 1 ? '' : `-${turn}`}.diff`);
  }

  eventsFor(id: string, after: number): CrewEvent[] {
    return this.recent.filter((e) => e.job_id === id && e.seq > after);
  }

  private event(job: Job, kind: EventKind, detail: string): void {
    job.seq = this.record(job.agent, job.sessionId, kind, detail, job.id).seq;
    // Each turn has its own file, so delayed cleanup cannot delete a follow-up's fresh diff.
    if (isTerminal(job) && job.kind === 'review') fs.rm(this.diffFile(job.id, job.turns), { force: true }, () => {});
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
    }
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
