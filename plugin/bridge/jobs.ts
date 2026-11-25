import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { addNews, Delivery, deliveryPosition, leadSession, unread } from './delivery.ts';
import type { DeliveryState, News } from './delivery.ts';
import type { Pulls } from './pulls.ts';
import { runCheck } from './check.ts';
import type { CheckResult } from './check.ts';
import type { Usage } from './usage.ts';
import { assignHint, canonicalPath, defaultHolder, disabledAgents, effectiveRole, isRole, LEAD, LEDGER_ASIDE, MAX_DEBATE_ROUNDS, daemonPort, nodeEnv, projectSettings, roleInfo, ROLES, runsCommands, WORKERS, workerInfo } from './config.ts';
import type { Config, JobKind, PresetName, Role, WorkerAgent } from './config.ts';
import { attached, untrackedPaths, carryUncommitted, changesSince, commitAll, commitChanges, copyIncluded, createWorktree, currentBranch, dirtyCount, git, mergeInto, isInside, NO_HOOKS, NO_SUBMODULES, projectRoot, realpath, removeDirectory, removeEmptyLeftover, removeEmptySlot, removeWorktree, repoRoot, revertCommit, revertsSince, reviewDiff, withBaseWorktree, WorktreeCleanupError, worktreeIncludeHint } from './git.ts';
import { collectGarbage } from './gc.ts';
import { BrowserServers, jobWritable } from './browser.ts';
import { tokenFile } from './auth.ts';
import { attachEvidence, attachmentsNote, checkAttachments, collectEvidence, detachEvidence, questionAttachments } from './evidence.ts';
import type { Evidence } from './evidence.ts';
import type { Worktree } from './git.ts';
import { sharedInstructions, type SharedScope } from './instructions.ts';
import { clip } from './text.ts';
import { buildPrompt } from './prompts.ts';
import { findSkills } from './skills.ts';
import { defaultTier, familyTier, modelId, tierEffort, tierModel, tierOf, TIERS } from './tiers.ts';
import type { Tier } from './tiers.ts';
import { DIFFICULTIES } from './notes.ts';
import type { Difficulty } from './notes.ts';

export type { WorkerAgent };
export type Agent = 'claude' | WorkerAgent;
export type { JobKind, Role };
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
  | { type: 'commit'; sha: string }
  /**
   * Files or directories as they stand: an audit of the code, with no change and so no diff. The paths are relative
   * to the directory the reviewer starts in, which for one that runs the app is its snapshot's root.
   */
  | { type: 'files'; paths: string[] };
/** How many paths one audit may name; past this the lead means a directory. */
const AUDIT_PATHS = 50;

export interface JobSpec {
  /** Starting Claude session; absent for board and other unowned jobs. */
  lead?: string;
  /** How the job runs. Taken from the role when only the role is given. */
  kind: JobKind;
  /** Whose work it is, and so which agent takes it; see resolveRole. */
  role?: Role;
  /** One of the role's holders, picked by the lead for this job; its default holder when absent. */
  agent?: Agent;
  /** The preset the job runs under: its mission's, else the global one. Set by the daemon, never by a caller. */
  preset?: PresetName | null;
  cwd: string;
  /** Project directory of the session that started the job. */
  project?: string;
  title?: string;
  /** delegate: what to build. polish: what to change. review: what to focus on. */
  task?: string;
  done_when?: string;
  /** delegate: a shell command the bridge runs in the worktree after each turn, recording its exit status. */
  check?: string;
  /** polish: files or directories the worker may touch. */
  targets?: string[];
  /** Ref the worktree is created from (delegate, polish). */
  base?: string;
  isolation?: 'worktree' | 'in_place';
  review?: { target: ReviewTarget; mode: 'adversarial' | 'standard' };
  model?: string;
  effort?: string;
  /** How demanding the job is; the bridge turns it into the model (see tiers.ts). An explicit model wins. */
  tier?: Tier;
  /** delegate: how hard the work is, for its build line in the model notes. Set here so its review cannot change it. */
  difficulty?: Difficulty;
  /** Mission the job is part of, if the lead started it while carrying out one. */
  mission?: string;
  /** Plan occurrence captured by the daemon when this job was requested. */
  missionStep?: number;
  /** The mission's task this job is done for, as the lead named it. */
  taskId?: string;
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
  /** A read-only debate with the lead over a hard or important decision, in at most `rounds` exchanges. Implies ask. */
  debate?: { rounds: number };
  /** Names of the user's skills (`~/.agents/skills`) the lead picked for this job; the worker is told to read them. */
  skills?: string[];
  /** Additional Codex plugin names beyond the configured defaults. */
  plugins?: string[];
  /** Images or recordings the lead attaches to the task; copied into the job's evidence directory. */
  attachments?: string[];
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
  /** The state the worker was last told of; absent means kept, as the worker made it. */
  toldWorker?: 'undone';
  at: number;
}

export interface Capabilities {
  /** Where the worker may read and write, in a few words. */
  filesystem: string;
  network: 'on' | 'off' | 'agent-managed';
  /** Plugins on for the job. Their tools act outside the sandbox. */
  plugins: string[];
  /** The agent's server runs inside a sandbox of Crew's own, with its own session store: the job continues there. */
  confined?: boolean;
}

export interface ExchangeEntry {
  turn: number;
  from: 'lead' | 'worker';
  text: string;
  at: number;
}

export interface RelayedApproval {
  turn: number;
  /** The lead's quote of the user. */
  quote: string;
  /** The quote appears, ignoring case, spacing and punctuation, in one of the user's recorded prompts. */
  matched: boolean;
  /** How many of the user's own prompts were recorded and attached; 0 when the lead session sent none. */
  recorded: number;
  at: number;
}

/** What a turn left behind and what was checked against it, so a result can be judged without the transcript. */
export interface TurnReceipt {
  turn: number;
  /** The job branch's commit after the turn (delegate), or the reviewed commit (review). */
  head: string | null;
  /** The lead's check, as the bridge ran it after the turn. */
  check?: CheckResult;
  base?: { exit: number | null; timedOut: boolean; ms: number; unavailable?: string };
  /** review: what was under review at the start of the turn. */
  reviewed?: { target: string; diff?: string };
  /** Why this receipt no longer describes the branch, once a round change or sync moved it. */
  stale?: string;
  at: number;
}

export interface LeadQuestion {
  id: string;
  text: string;
  blocks?: string;
  at: number;
  answer?: string;
  answeredAt?: number;
  /** Evidence files the worker showed with the question. */
  attachments?: string[];
}

export interface Job {
  lead?: string;
  newsSeq?: number;
  ackedSeq?: number;
  news?: News[];
  id: string;
  kind: JobKind;
  /** Absent on jobs saved before roles were recorded; jobRole() derives it for them. */
  role?: Role;
  /** The preset the job's model and effort were picked under, kept for its follow-up turns. */
  preset?: PresetName | null;
  agent: Agent;
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
  missionStep?: number;
  /** The mission's task it is done for. The task shows this job's state; nothing of the job is copied into it. */
  taskId?: string;
  /** Runs alone on the machine, for measurement. */
  exclusive?: boolean;
  /** May start the app: network access in the sandbox, and for a review a snapshot worktree. */
  runsApp?: boolean;
  /** Answers a question read-only; see JobSpec.ask. */
  ask?: boolean;
  /** A debate: how many rounds it may run. The current round is the job's turn. */
  debate?: { rounds: number };
  /** Asked to rate the work it sees (a reviewer the change, an engineer the review it gets back); set when peer ratings were on as it started. */
  rates?: true;
  /** The messages of the job in order: the lead's task and follow-ups, and the worker's report for each turn. */
  exchange?: ExchangeEntry[];
  /** The user's Codex plugins that are on for this job, by name; absent when it runs with none. */
  plugins?: string[];
  /** Caller-picked names, kept apart from configured defaults so unavailable explicit requests can be noted. */
  requestedPlugins?: string[];
  /** Per-turn Codex directory for temporary files, caches, and throwaway clones. */
  scratch?: string;
  /** Kept with the job: screenshots and recordings from the worker, and the lead's attachments. */
  evidenceDir?: string;
  evidence?: Evidence[];
  /** The commit the job's branch started from, kept once a sync has moved the worktree's base past it. */
  roundsBase?: string;
  /** Turns that changed files, oldest first; absent on jobs without a worktree and on jobs saved before rounds existed. */
  rounds?: Round[];
  /** Actions the agent's automatic reviewer refused, with the turn they were refused in. */
  refusals?: { action: string; reason: string; turn: number }[];
  /**
   * Approvals the lead relayed for refused actions, with the user's own recent words as Crew recorded them
   * from the lead session. Nothing is refused for a mismatch: the record is there so the worker's automatic
   * reviewer and the user can see what the approval rests on.
   */
  approvals?: RelayedApproval[];
  /** delegate: the lead's check, run by the bridge after every turn. */
  check?: string;
  /** One per finished turn, oldest first; absent on jobs saved before receipts existed. */
  receipts?: TurnReceipt[];
  /** The follow-up Crew sent to repair a check that passed on the base. */
  autoFixTurn?: number;
  /** Follow-ups Crew sent when usage limits lifted. */
  autoResumes?: number;
  /** What the worker's runtime was set up to allow, as the adapter configured it; absent until the session starts. */
  capabilities?: Capabilities;
  /** Set while the latest turn is a retry of refused actions: the actions it was sent back with. */
  retrying?: string[];
  /** Approval requests of the current turn go to the user, not the automatic reviewer. */
  asksUser?: boolean;
  /** Directory the worker runs in: the worktree when isolated, else the caller's cwd. */
  cwd: string;
  worktree: Worktree | null;
  /** A failed discard keeps its record until gc can finish the removal. */
  cleanupPending?: string[];
  sandbox: 'read-only' | 'workspace-write';
  prompt: string;
  instructions: string;
  /** Files of shared instructions the worker was given; absent on jobs saved before they existed. */
  shared?: string[];
  /** Each of `shared`'s scope, by position; absent on jobs saved before it was recorded. */
  sharedScopes?: SharedScope[];
  /** Set when the review should use the agent's native review mode instead of a prompted turn. */
  nativeReview: ReviewTarget | null;
  /** Preserved for refreshed review diffs; absent on older saved jobs. */
  reviewTarget?: ReviewTarget;
  targets: string[];
  model?: string;
  effort?: string;
  /** The tier the model was picked by; absent when a model was named or configured, and on older jobs. */
  tier?: Tier;
  /** How hard the lead said the work was when it handed it out; see JobSpec.difficulty. */
  difficulty?: Difficulty;
  /** A preset's cap left no model to name, so the adapter must not fall back to the agent's configured one. */
  agentDefault?: boolean;
  /** Session-reported model, or the configured fallback; absent on older saved jobs. */
  resolvedModel?: string;
  resolvedEffort?: string;
  /** Latest turn in which a bridge note recorded an action that was not allowed. */
  declinedTurn?: number;
  /** Codex thread id or ACP session id; lets the user continue the session in the vendor's own app. */
  sessionId: string | null;
  createdAt: number;
  turnStartedAt?: number;
  /** Time spent on user requests already answered in this turn. */
  turnWaitMs?: number;
  /** Last sign of life from the worker. */
  activeAt: number;
  endedAt: number | null;
  turns: number;
  stalled: boolean;
  /** grant: what "Allow for this job" would cover; set only for a plugin tool approval that names its target. */
  waiting: { type: 'approval' | 'question'; reason: string; id: string; since: number; grant?: string } | null;
  /** The worker's final message for the latest turn. */
  report: string;
  outcome?: 'done' | 'partial' | 'blocked';
  /** Structured findings from the latest completed review report. */
  review?: {
    verdict: 'approve' | 'approve with fixes' | 'request changes' | undefined;
    findings: { blocker: number; major: number; minor: number };
    evidence: { reproduced: number; read: number; suspected: number };
  };
  /** The worker was told to declare an outcome. Absent on a job from before outcomes existed. */
  outcomeAsked?: boolean;
  questions?: LeadQuestion[];
  /** Legacy event sequence of the latest lead question. Delivery uses news snapshots. */
  questionSeq?: number;
  result: { files: string[]; stat: string; commit: string | null; outOfScope: string[] } | null;
  notes: string[];
  error: { message: string; limit: boolean; budget?: true } | null;
  tokens: number | null;
  /**
   * What the total is made of, where the agent reports it, and what the latest turn added. Most of a
   * worker's tokens are input it has already sent once; this is how to tell that from new work.
   */
  tokenUse?: { input: number; cachedInput: number; output: number; turn: number };
  /** How full the worker's context window is, as the agent last reported it. */
  context?: { used: number; size: number };
  /** Set while a running turn has a diff so far (Codex); the text is held in memory, see Jobs.liveDiff. */
  liveDiff?: { turn: number; at: number; chars: number };
  /** Seq of the latest event about this job. */
  seq: number;
  /** Compatibility projection of acknowledged news onto event seq; never an ACK input. */
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
  model(name: string | undefined, effort?: string): void;
  capabilities(value: Capabilities): void;
  touched(file: string): void;
  /** Adds a line to the result that the lead should see, such as a refused action. */
  note(text: string, opts?: { declined?: boolean }): void;
  /** The agent's automatic reviewer refused an action in this turn. */
  refused(action: string, reason: string): void;
  tokens(total: number, parts?: { input: number; cachedInput: number; output: number }): void;
  context(used: number, size: number): void;
  /** The changes the running turn has made so far, as one unified diff. */
  diff(text: string): void;
  waiting(type: 'approval' | 'question', reason: string, grant?: string): void;
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
  /** Resolves the pending approval or question. forJob also allows later requests with the same grant in this job. */
  answer(ctl: JobCtl, approve: boolean, message?: string, opts?: { forJob?: boolean; by?: 'lead' }): Promise<void>;
  cancel(ctl: JobCtl): Promise<void>;
  /** Releases a finished session before removing its workspace. */
  release?(ctl: JobCtl): Promise<void>;
  /** Asks the agent about a job that has been silent past the stall limit. Without it, a stall is reported unconfirmed. */
  probe?(ctl: JobCtl): Promise<Probe>;
  shutdown(): void;
}

/** Keeps the lead's reason visible because approval responses cannot carry it. */
export function noteLeadDecline(ctl: JobCtl, request: string, reason: string): string {
  const note = `The lead declined an action: ${request}\nReason: ${reason}\nDo it another way within the task, or report what could not be done.`;
  ctl.note(note, { declined: true });
  ctl.progress(note);
  return note;
}

/** working: the agent confirms the turn is in progress. ended: it is certainly over, but no end was received. unknown: neither. */
export interface Probe { verdict: 'working' | 'ended' | 'unknown'; detail: string }

export interface JobsHooks {
  onEvent(event: CrewEvent): void;
  onJob(job: Job): void;
  onAttention(job: Job, kind: EventKind, detail: string): void;
  /** Whether a mission is still being kept; its jobs are then kept with it, beyond the history limit. */
  keepsMission?(id: string): boolean;
  /** The watched pull requests. They are saved in the jobs' snapshot, so their news commits with the receipts that cover it. */
  pulls?: Pulls;
  /** The user's recent prompts in a lead session, oldest first, as its hooks reported them. */
  userPrompts?(session: string): { text: string; at: number }[];
}

const TERMINAL: JobState[] = ['done', 'failed', 'cancelled'];
const MAX_EXCHANGE_TEXT = 20_000;
const MAX_AUTO_RESUMES = 3;
/** A running turn's diff is for watching it, not for review: past this it is cut, and the worktree has the rest. */
const LIVE_DIFF_CHARS = 200_000;
const KEEP_EXCHANGE = 40;

/** Adds a message to the job's conversation, bounded so a long debate cannot grow the record without limit. */
function exchanged(job: Job, from: ExchangeEntry['from'], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  const entry = { turn: job.turns, from, text: trimmed.length > MAX_EXCHANGE_TEXT ? `${clip(trimmed, MAX_EXCHANGE_TEXT)}\n… (cut)` : trimmed, at: Date.now() };
  job.exchange = [...(job.exchange ?? []), entry].slice(-KEEP_EXCHANGE);
}
const KEEP_JOBS = 200;
/** Unacknowledged news keeps a finished job past the history limit, but not forever: a lead that never echoed it is gone. */
const UNREAD_KEEP_MS = 7 * 24 * 60 * 60_000;
/** A job that ended this recently stays, whatever its age, so whoever waited on it can read it. */
const RECENT_MS = 60 * 60_000;
const KEEP_EVENTS = 5000;
const TURN_BUDGET = {
  routine: { tokens: 60_000_000, minutes: 120 },
  standard: { tokens: 80_000_000, minutes: 180 },
  hard: { tokens: 120_000_000, minutes: 240 },
} satisfies Record<Difficulty, { tokens: number; minutes: number }>;

/**
 * Refused actions the lead still has to deal with: those of the latest turn, or, when a retry turn
 * failed before the worker could try again, the ones that turn was sent back with.
 */
export function openRefusals(job: Pick<Job, 'refusals' | 'turns' | 'retrying' | 'state'>): { action: string; reason?: string }[] {
  const latest = (job.refusals ?? []).filter((refusal) => refusal.turn === job.turns);
  if (latest.length || job.state !== 'failed') return latest;
  return (job.retrying ?? []).map((action) => ({ action }));
}

/** Whether Crew may still take up a job a usage limit stopped by itself; past the cap, continuing it is the lead's. */
export function autoResumesLeft(job: Pick<Job, 'autoResumes'>): boolean {
  return (job.autoResumes ?? 0) < MAX_AUTO_RESUMES;
}

/** Only follow-ups requested by the lead count toward the build's adoption rating. */
export function followUps(job: Pick<Job, 'turns' | 'approvals' | 'autoFixTurn' | 'autoResumes'>): number {
  return Math.max(0, (job.turns ?? 1) - 1 - (job.approvals?.length ?? 0) - Number(Boolean(job.autoFixTurn)) - (job.autoResumes ?? 0));
}

/** A saved job's role, derived for jobs saved before roles were recorded. */
export function jobRole(job: Pick<Job, 'role' | 'kind' | 'debate' | 'runsApp'>): Role {
  return job.role ?? (job.debate ? 'debate' : job.kind === 'review' && job.runsApp ? 'verify' : job.kind);
}

/** Only roles tasked with completing work are asked to declare whether they finished it. */
export function expectsOutcome(job: Pick<Job, 'kind' | 'role' | 'ask' | 'debate'>): boolean {
  return !job.ask && !job.debate && job.role !== 'debate' && (job.kind === 'delegate' || job.kind === 'polish');
}

/** Keeps fenced examples out of report parsing. */
function* unfencedLines(lines: string[]): IterableIterator<[number, string]> {
  let fence: string | undefined;
  for (const [i, line] of lines.entries()) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker?.[1].startsWith(fence) && !marker[2].trim()) fence = undefined;
      continue;
    }
    if (marker && (marker[1][0] === '~' || !marker[2].includes('`'))) {
      fence = marker[1];
      continue;
    }
    yield [i, line];
  }
}

/** Reads the worker's own declaration so examples in its report cannot count as outcomes. */
export function parseOutcome(report: string): Job['outcome'] {
  const lines = report.split(/\r?\n/);
  for (const [i, line] of unfencedLines(lines)) {
    const heading = /^ {0,3}##[ \t]+Outcome(?::[ \t]*(.*?))?(?:[ \t]+#+)?[ \t]*$/i.exec(line);
    if (!heading) continue;
    const declared = heading[1] ?? lines.slice(i + 1).find((text) => text.trim()) ?? '';
    return /^(?:-[ \t]+)?(\*\*|\*|_|`)?(done|partial|blocked)\1(?=$|[^\w`*_-])/i.exec(declared.trimStart())?.[2].toLowerCase() as Job['outcome'];
  }
}

/** Reads review declarations and findings outside examples, with a fallback for native Codex priorities. */
export function parseReview(report: string): NonNullable<Job['review']> {
  const findings = { blocker: 0, major: 0, minor: 0 };
  const evidence = { reproduced: 0, read: 0, suspected: 0 };
  const priorities = { P0: 'blocker', P1: 'major', P2: 'minor', P3: 'minor' } as const;
  const native = { ...findings };
  let inFindings = false;
  let sawVerdict = false;
  let declared: string | undefined;

  for (const [, line] of unfencedLines(report.split(/\r?\n/))) {
    if (sawVerdict && declared === undefined && line.trim()) declared = line;
    const heading = /^ {0,3}(#{1,2})(?:[ \t]+(.*?))?[ \t]*$/.exec(line);
    if (heading) {
      const title = heading[2]?.replace(/[ \t]+#+[ \t]*$/, '') ?? '';
      inFindings = heading[1] === '##' && /^Findings$/i.test(title);
      const verdict = heading[1] === '##' && /^Verdict(?::[ \t]*(.*))?$/i.exec(title);
      if (verdict && !sawVerdict) {
        sawVerdict = true;
        declared = verdict[1] || undefined;
      }
      continue;
    }
    if (inFindings) {
      const finding = /^[ \t]*[-*+][ \t]+\[(blocker|major|minor)\](?:[ \t]+\[(reproduced|read|suspected)\])?/i.exec(line);
      if (finding) {
        findings[finding[1].toLowerCase() as keyof typeof findings]++;
        if (finding[2]) evidence[finding[2].toLowerCase() as keyof typeof evidence]++;
      }
    }
    const priority = /^[ \t]*[-*+][ \t]+\[(P[0-3])\][ \t]+\S/.exec(line);
    if (priority) native[priorities[priority[1] as keyof typeof priorities]]++;
  }

  const verdict = /^(?:-[ \t]+)?(\*\*|\*|_|`)?(approve with fixes|request changes|approve)\1(?=$|[ \t]*[—–:.,!-])/i
    .exec(declared?.trim() ?? '')?.[2].toLowerCase() as NonNullable<Job['review']>['verdict'];
  if (!sawVerdict) {
    for (const severity of Object.keys(findings) as (keyof typeof findings)[]) findings[severity] += native[severity];
  }
  return { verdict, findings, evidence };
}

/**
 * Settles a new job's role and fills what the role implies, refusing a combination that contradicts it. Every
 * entry point goes through here, so a role decides the agent whoever starts the job.
 */
export function resolveRole(spec: JobSpec): Role {
  if (spec.role !== undefined && !isRole(spec.role)) throw new Error(`role must be one of: ${ROLES.join(', ')}.`);
  const role = jobRole(spec);
  if (!isRole(role)) throw new Error(`kind must be one of: delegate, review, polish; or pass a role (${ROLES.join(', ')}).`);
  const info = roleInfo(role);
  spec.kind ??= info.kind;
  if (spec.kind !== info.kind) throw new Error(`The ${role} role runs as a ${info.kind} job, not ${spec.kind}.`);
  if (role === 'debate' && !spec.debate) throw new Error('A debate job needs debate rounds; start it with the debate tool.');
  if (spec.debate !== undefined && role !== 'debate') throw new Error(`A debate is the debate role, not ${role}.`);
  if (role === 'verify') {
    spec.runsApp ??= true;
    if (!spec.runsApp) throw new Error('The verify role runs the app; use the review role for a static review.');
  }
  if (role === 'review' && spec.runsApp) throw new Error('A review that runs the app is the verify role. Drop runs_app, or use role verify.');
  if ((role === 'refactor' || role === 'release' || role === 'fix') && spec.ask) throw new Error(`A ${role} job changes files, so it cannot be a question.`);
  spec.role = role;
  return role;
}

/**
 * Model for a new job, in this order: what the lead named for the job, the tier the lead named, what the user
 * configured (role, preset, or the agent's own setting in config.json), and last the default tier. Effort differs:
 * a role's or preset's effort holds over a named tier's.
 */
function pickModel(agent: Agent, spec: JobSpec, role: { model?: string; effort?: string; ownModel?: boolean }, config: Config, preset: PresetName | null): { model?: string; effort?: string; tier?: Tier; agentDefault?: boolean } {
  const configured = { model: role.model ?? config[agent].model, effort: role.effort ?? (agent === 'antigravity' ? undefined : config[agent].effort) };
  const cap = preset ? config.presets[preset].maxTier : undefined;
  // A family name passed as the model is that family's tier, so it resolves, caps and sets effort like one.
  const family = spec.model ? familyTier(agent, spec.model) : undefined;
  const exact = spec.model && !family ? modelId(agent, spec.model) : undefined;
  const wanted = family ?? spec.tier ?? (configured.model ? undefined : defaultTier(spec));
  const tier = wanted && cap && TIERS.indexOf(wanted) > TIERS.indexOf(cap) ? cap : wanted;
  let model = exact ?? (tier ? tierModel(agent, tier) : undefined) ?? configured.model;
  // The cap holds for a model named outright too; effort stays the lead's to choose. A model set on the role is the
  // user's own choice for that work and overrides the preset, cap included, unless the lead named a tier or a model.
  const roleModel = role.ownModel && !exact && !tier;
  const named = model && !roleModel ? tierOf(agent, model) : undefined;
  const capped = Boolean(cap && named && TIERS.indexOf(named) > TIERS.indexOf(cap));
  if (capped) model = tierModel(agent, cap!);
  // With no model of the capped tier to name, the configured fallback could be the very model the cap refused.
  const agentDefault = capped && !model ? true : undefined;
  // A role's or preset's effort is the user's choice and holds over the tier's; the agent-wide setting does not.
  const effort = spec.effort ?? role.effort ?? (spec.tier || family || !configured.effort ? (agent === 'codex' ? tierEffort(tier ?? defaultTier(spec)) : undefined) : configured.effort);
  const shown = capped ? cap : !exact ? tier : undefined;
  return { ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(shown ? { tier: shown } : {}), ...(agentDefault ? { agentDefault } : {}) };
}

/** A few paths by name, and how many more there are. */
const pathList = (paths: string[], shown = 3) => `${paths.slice(0, shown).join(', ')}${paths.length > shown ? ` and ${paths.length - shown} more` : ''}`;

/** Marks the receipts that still describe the branch as no longer doing so. */
function staleReceipts(job: Job, why: string): void {
  for (const receipt of job.receipts ?? []) receipt.stale ??= why;
}

/** Text compared without case, spacing or punctuation, in any script. */
function looseText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export function isTerminal(job: Job): boolean {
  return TERMINAL.includes(job.state);
}

/** jobs.json was read but does not hold a ledger. Nothing was changed; the caller decides what becomes of the file. */
export class UnreadableLedger extends Error {}

export class Jobs {
  readonly jobs = new Map<string, Job>();
  readonly recent: CrewEvent[] = [];
  readonly delivery = new Delivery(() => this.list(), () => { this.flush(); }, () => this.hooks.pulls?.list() ?? []);
  private seq = 0;
  private workerTokens = new Map<string, string>();
  private waiters = new Map<string, Set<() => void>>();
  private touchedFiles = new Map<string, Set<string>>();
  private discarding = new Set<string>();
  private browsers = new BrowserServers();
  private finalizing = new Set<string>();
  private cancelling = new Set<string>();
  private budgetStops = new Map<string, { message: string; ended: boolean }>();
  private changingRounds = new Set<string>();
  /** Each job's token total when its current turn began, so the turn's own share can be shown. */
  private turnStartTokens = new Map<string, number>();
  private liveDiffs = new Map<string, { turn: number; diff: string; at: number }>();
  /** Jobs past the alone-check but not yet registered, so two starts cannot both slip through it. */
  private starting: { exclusive: boolean }[] = [];
  private preparingReviews = new Set<string>();
  /** Review snapshots being removed; a follow-up waits for the removal before it makes a new one. */
  private snapshots = new Map<string, Promise<void>>();
  /** Checks being run while a turn's result is collected; cancelling the job stops its check. */
  private checks = new Map<string, AbortController>();
  private baseChecks = new Map<string, { result: Promise<NonNullable<TurnReceipt['base']>>; stop: AbortController; users: number }>();
  private latestUsage?: Usage;
  private collecting = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private home: string;
  private readConfig: () => Config;
  /** Settings as of startup, for timers that must not fail on a config edit. */
  private settings: Config;
  /** Claude's only where the daemon runs Claude workers; a test may leave it out. */
  private adapters: Record<WorkerAgent, Adapter> & { claude?: Adapter };
  private hooks: JobsHooks;
  private platform: NodeJS.Platform;

  /** `config` is called again for each new job, so role assignments can change without a restart. */
  constructor(home: string, config: () => Config, adapters: Record<WorkerAgent, Adapter> & { claude?: Adapter }, hooks: JobsHooks, platform: NodeJS.Platform = process.platform) {
    this.home = home;
    this.readConfig = config;
    this.settings = config();
    this.adapters = adapters;
    this.hooks = hooks;
    this.platform = platform;
    this.load();
    for (const job of this.jobs.values()) void this.clearLeftover(job);
    setInterval(() => this.checkStalls(), 15_000).unref();
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  /**
   * Number of jobs that would be disrupted if the daemon stopped now, including jobs still starting
   * and finished jobs syncing, changing rounds, discarding, or refreshing a review.
   */
  get activeCount(): number {
    return [...this.jobs.values()].filter((job) => !isTerminal(job) || this.preparingReviews.has(job.id) || this.changingRounds.has(job.id) || this.discarding.has(job.id)).length + this.starting.length;
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
    if (spec.lead !== undefined) leadSession(spec.lead);
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
    if (this.collecting) throw new Error('Crew gc is running. Try again when it finishes.');
    const roleName = resolveRole(spec);
    if (spec.debate !== undefined) {
      const rounds = spec.debate?.rounds;
      if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_DEBATE_ROUNDS) throw new Error(`A debate takes 1 to ${MAX_DEBATE_ROUNDS} rounds.`);
      if (spec.kind !== 'delegate') throw new Error('A debate must use kind "delegate".');
      spec.ask = true;
    }
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
    const preset = spec.preset === undefined ? config.preset : spec.preset;
    // A reviewer sees the change and an engineer the review of its own. A debate, a question and an edit see nobody's
    // work; a fix starts from a review of someone else's, and release preparation is not sent findings.
    // An audit of files as they stand reads no one job's work, so its reviewer has nothing to rate.
    const rates = config.peerRatings && !spec.debate && !spec.ask && spec.kind !== 'polish' && roleName !== 'fix' && roleName !== 'release'
      && spec.review?.target.type !== 'files';
    const holders = config.roles[roleName].agents;
    // Claude runs as a worker only for a Codex lead; under a Claude lead, or with none, a role Claude holds is a lead session's own work.
    const codexLead = spec.lead !== undefined && this.delivery.hostOf(spec.lead) === 'codex';
    // Named no holder, the job goes to the role's first worker, Claude included for a Codex lead.
    const picked = spec.agent ?? defaultHolder(roleName, config.roles[roleName], disabledAgents(config), codexLead ? 'codex' : LEAD);
    if (!holders.includes(picked)) throw new Error(`${spec.agent} does not hold ${roleName}; its holders are: ${holders.join(', ')}. Pick one of them. ${assignHint(roleName)}`);
    const claudeWorker = picked === LEAD && codexLead;
    // The MCP server keeps a role the lead's own agent holds with the lead; a lead calling the API directly gets the same answer.
    if (picked === 'codex' && codexLead) throw new Error(`${roleName} is held by Codex, the lead's own agent, which starts no Codex worker: the lead does the work itself, in a subagent, or in a session it starts.`);
    if (picked === LEAD && !claudeWorker) throw new Error(`${roleName} is held by Claude, which runs no worker here: start it from a lead session. Claude Code does the work itself or in a subagent, and a Codex lead starts a Claude worker.`);
    const role: { agent: Agent; model?: string; effort?: string; ownModel?: boolean } = claudeWorker ? { agent: LEAD } : effectiveRole(config, roleName, preset, picked as WorkerAgent);
    const { agent } = role;
    if (spec.runsApp && spec.kind === 'polish') throw new Error('A polish job cannot run the app: an editor only changes wording. Drop runs_app.');
    if (spec.runsApp && spec.kind === 'review' && !workerInfo(agent).reviewerRunsGit) {
      throw new Error(`${roleName} is assigned to ${workerInfo(agent).name}, which cannot run commands as a reviewer, so it cannot run the app. Assign verify to an agent that can in the settings, or run the app in your own review.`);
    }
    if (agent === 'antigravity' && !config.antigravity.enabled) {
      throw new Error(`${roleName} is assigned to Antigravity, which is disabled in ~/.crew/config.json (antigravity.enabled).`);
    }
    if (!fs.existsSync(spec.cwd)) throw new Error(`cwd does not exist: ${spec.cwd}`);
    if (spec.skills !== undefined && (!Array.isArray(spec.skills) || spec.skills.some((name) => typeof name !== 'string'))) {
      throw new Error('skills must be a list of skill names.');
    }
    const skills = findSkills(spec.skills ?? []);
    if (spec.plugins !== undefined && (!Array.isArray(spec.plugins) || spec.plugins.some((name) => typeof name !== 'string' || !name))) {
      throw new Error('plugins must be a list of plugin names.');
    }
    if (spec.plugins?.length && (spec.ask || (spec.kind === 'review' && !spec.runsApp))) {
      throw new Error(spec.ask ? 'An ask job is read-only and cannot use plugins. Drop plugins.' : 'A read-only review cannot use plugins. Add runs_app, or drop plugins.');
    }
    if (spec.plugins?.length && spec.kind === 'polish') throw new Error('A polish job cannot use plugins: an editor only changes wording. Drop plugins.');
    if (spec.tier !== undefined && !TIERS.includes(spec.tier)) throw new Error(`tier must be one of: ${TIERS.join(', ')}.`);
    if (spec.difficulty !== undefined && (!DIFFICULTIES.includes(spec.difficulty) || spec.kind !== 'delegate' || spec.ask)) {
      throw new Error(`difficulty is for work handed out with delegate, and one of: ${DIFFICULTIES.join(', ')}.`);
    }
    if (spec.check !== undefined && (typeof spec.check !== 'string' || !spec.check.trim())) throw new Error('check must be a shell command.');
    if (spec.check && (spec.kind !== 'delegate' || spec.ask || spec.isolation === 'in_place')) {
      throw new Error('check runs in the job\'s own worktree after each turn, so only a delegate job with a worktree takes it. Run the check yourself, or drop check.');
    }
    const audit = spec.review?.target.type === 'files' ? spec.review.target : undefined;
    if (audit) {
      const { paths } = audit;
      if (!Array.isArray(paths) || !paths.length || paths.length > AUDIT_PATHS || paths.some((file) => typeof file !== 'string' || !file.trim())) {
        throw new Error(`A review of files needs paths: 1 to ${AUDIT_PATHS} files or directories, relative to the project.`);
      }
      const outside = paths.find((file) => path.isAbsolute(file) || !isInside(spec.cwd, path.join(spec.cwd, file)));
      if (outside) throw new Error(`${outside} is not inside ${spec.cwd}. Give paths relative to the project.`);
      const missing = paths.find((file) => !fs.existsSync(path.join(spec.cwd, file)));
      if (missing) throw new Error(`${missing} does not exist in ${spec.cwd}.`);
      // As checked: the reviewer is given these names, and `a/../b` would be resolved by its system, link by link.
      audit.paths = paths.map((file) => slashed(path.normalize(file)));
      if (spec.review!.mode === 'standard' && agent === 'codex') {
        throw new Error('Codex\'s standard review reads a change, and files as they stand are not one. Use the adversarial mode.');
      }
    }
    const attachments = checkAttachments(spec.attachments);
    if (attachments.length && spec.review?.mode === 'standard' && agent === 'codex') {
      throw new Error('Codex\'s standard review is sent no prompt, so it would never see the attachments. Use the adversarial mode, or drop attachments.');
    }

    // The failure path below removes the record under this id as its own, so it must be no other job's.
    let id: string;
    do {
      id = `${workerInfo(agent).idPrefix}-${randomBytes(3).toString('hex')}`;
    } while (this.jobs.has(id));
    const repo = await repoRoot(spec.cwd);
    // Read from the main working tree even when the job starts inside a worktree, so an uncommitted edit applies to the next job.
    const root = (await projectRoot(spec.cwd)) ?? spec.project ?? spec.cwd;
    const shared = sharedInstructions(this.home, root);
    const notes: string[] = Array.isArray(spec.notes) ? spec.notes.filter((note) => typeof note === 'string') : [];
    // Plugins are Codex's. The set the job runs with is settled here, so the prompt, the result and the adapter agree.
    const requestedPlugins = spec.plugins ?? [];
    const plugins = agent === 'codex' && !spec.ask && (spec.kind === 'delegate' || (spec.kind === 'review' && spec.runsApp))
      ? [...new Set([...config.codex.plugins, ...(spec.runsApp ? config.codex.appPlugins : []), ...(spec.plugins ?? [])])] : [];
    if (spec.plugins?.length && agent !== 'codex') notes.push(`${workerInfo(agent).name} has no plugins to turn on, so the job runs without: ${spec.plugins.join(', ')}.`);
    spec.plugins = plugins;
    let worktree: Worktree | null = null;
    let cwd = spec.cwd;

    let registered = false;
    try {
      if (!spec.ask && spec.kind !== 'review' && (spec.isolation ?? 'worktree') === 'worktree') {
        if (!repo) {
          throw new Error(`${spec.cwd} is not inside a git repository, so there is no worktree to isolate the worker in. Pass isolation: "in_place" to let it edit that directory directly.`);
        }
        const base = spec.base ?? 'HEAD';
        worktree = await createWorktree(repo, id, base, this.home);
        cwd = worktree.path;
        const included = await copyIncluded(repo, worktree.path);
        worktree.linked = included.linked;
        // Asked of Git rather than of the copy: a copy into a directory the base already has adds files of its own.
        const copied = included.copied.length ? await untrackedPaths(worktree.path) : [];
        if (copied.length) worktree.copied = copied;
        if (included.linked.length) notes.push(`Shared read-only from .worktreeinclude: ${included.linked.join(', ')}`);
        if (included.copied.length) notes.push(`Copied from .worktreeinclude: ${included.copied.join(', ')}`);
        if (included.failed.length) notes.push(`Could not copy from .worktreeinclude: ${included.failed.join('; ')}`);
        const dirty = await dirtyCount(repo);
        if (dirty > 0) notes.push(`${dirty} uncommitted path(s) in the main tree are not in this worktree, which starts from ${base} (${worktree.base.slice(0, 8)}). Commit first if the worker needs them.`);
      }

      if (spec.kind === 'review' && spec.runsApp) {
        if (!repo) throw new Error(`${spec.cwd} is not inside a git repository, so there is no snapshot to run the app in. Drop runs_app.`);
        worktree = await this.snapshot(repo, id, spec.review!.target, notes);
        cwd = worktree.path;
        if (audit) {
          // The reviewer starts at the snapshot's root, not in the subdirectory the paths were given from.
          audit.paths = audit.paths.map((file) => slashed(path.relative(realpath(repo), realpath(path.join(spec.cwd, file)))));
          const absent = audit.paths.find((file) => !fs.existsSync(path.join(worktree!.path, file)));
          if (absent) throw new Error(`${absent} is not in the snapshot a review that runs the app reads: Git ignores it and .worktreeinclude does not list it. Drop runs_app, or list it there.`);
        }
      }

      let diffFile: string | null = null;
      const reviewed = spec.kind === 'review' && !workerInfo(agent).reviewerRunsGit ? spec.review!.target : undefined;
      if (reviewed?.type === 'files') {
        notes.push(`${workerInfo(agent).name} cannot run commands as a reviewer: it read the files and could not run tests or checks.`);
      } else if (reviewed) {
        if (!repo) throw new Error(`review is assigned to ${workerInfo(agent).name}, which has to be handed the diff, and ${spec.cwd} is not inside a git repository.`);
        diffFile = this.diffFile(id);
        fs.mkdirSync(path.dirname(diffFile), { recursive: true });
        fs.writeFileSync(diffFile, await reviewDiff(repo, reviewed));
        notes.push(`${workerInfo(agent).name} cannot run commands as a reviewer: it was given the diff as a file and could not run tests or checks.`);
      }
      if (spec.review?.mode === 'standard' && agent !== 'codex') notes.push(`The standard review mode is Codex's own; ${workerInfo(agent).name} ran the adversarial review instead.`);
      const scratch = agent === 'codex' ? this.scratchDir(id) : undefined;
      if (scratch) fs.mkdirSync(scratch, { recursive: true });
      const evidenceDir = this.evidenceDir(id);
      // `work` holds what the worker keeps across turns that is not evidence: scratch is emptied after every turn.
      fs.mkdirSync(scratch ? path.join(evidenceDir, 'work') : evidenceDir, { recursive: true });
      const attached = attachEvidence(evidenceDir, attachments, 1);
      if (attached.length) spec.task = `${spec.task ?? ''}${attachmentsNote(attached)}`;

      // Diffs name files relative to the repo root with forward slashes, so scope targets must be too.
      const targetRoot = repo ?? spec.cwd;
      spec.targets = spec.targets?.map((t) => slashed(path.relative(targetRoot, path.resolve(spec.cwd, t))));

      const title = clip((spec.title ?? spec.task ?? spec.targets?.join(', ') ?? spec.kind).split('\n')[0], 80);
      const now = Date.now();
      const job: Job = {
        id,
        lead: spec.lead,
        newsSeq: 0,
        ackedSeq: 0,
        news: [],
        kind: spec.kind,
        role: roleName,
        preset,
        agent,
        title,
        state: 'running',
        phase: 'starting',
        repo,
        project: canonicalPath(spec.project ?? repo ?? spec.cwd),
        root: canonicalPath(root),
        mission: spec.mission,
        missionStep: spec.missionStep,
        taskId: spec.mission ? spec.taskId : undefined,
        exclusive: Boolean(spec.exclusive) || undefined,
        difficulty: spec.difficulty,
        runsApp: Boolean(spec.runsApp) || undefined,
        ask: Boolean(spec.ask) || undefined,
        debate: spec.debate ? { rounds: spec.debate.rounds } : undefined,
        rates: rates || undefined,
        plugins: plugins.length ? plugins : undefined,
        requestedPlugins,
        cwd,
        worktree,
        sandbox: spec.ask || (spec.kind === 'review' && !spec.runsApp) ? 'read-only' : 'workspace-write',
        scratch,
        evidenceDir,
        evidence: attached.length ? attached : undefined,
        ...buildPrompt(spec, worktree, diffFile, shared.text, scratch, runsCommands(agent, spec), skills, evidenceDir, rates),
        shared: shared.sources,
        sharedScopes: shared.scopes,
        // Only Codex has a built-in review mode; other agents get the prompted review.
        nativeReview: spec.kind === 'review' && agent === 'codex' && spec.review?.mode === 'standard' ? spec.review.target : null,
        reviewTarget: spec.review?.target,
        targets: spec.targets ?? [],
        check: spec.check?.trim() || undefined,
        ...pickModel(agent, spec, { ...role, ownModel: agent !== LEAD && Boolean(config.roles[roleName][agent]?.model) }, config, preset),
        sessionId: null,
        createdAt: now,
        turnStartedAt: now,
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
      exchanged(job, 'lead', spec.task ?? '');
      if (job.instructions.includes('## Outcome')) job.outcomeAsked = true;
      if (worktree && repo) {
        const hint = await worktreeIncludeHint(repo, job.project, this.home).catch(() => null);
        if (hint) notes.push(hint);
      }
      this.jobs.set(id, job);
      if (job.kind === 'review' && repo) await this.recordReviewed(job, repo);
      if (isTerminal(job) || this.cancelling.has(id)) {
        registered = true;
        return job;
      }
      this.event(job, 'started', `${spec.kind}: ${title}`);
      this.flush();
      registered = true;

      const ctl = this.ctl(job);
      // Session setup can take seconds; the caller gets the job id right away and follows via wait.
      this.adapter(agent).start(ctl).catch((err) => {
        // As in reply: a start that fails after a cancel and a follow-up must not end that follow-up.
        if (job.turns === 1) ctl.fail(String(err?.message ?? err));
      });
      return job;
    } catch (err) {
      if (!registered) {
        this.jobs.delete(id);
        if (worktree) {
          try {
            await removeWorktree(repo!, worktree, id, this.home, this.platform);
          } catch (cleanup) {
            throw new Error(`${(err as Error).message}; worktree cleanup failed: ${(cleanup as Error).message}`, { cause: err });
          }
        }
      }
      throw err;
    }
  }

  async resumeLimited(usage: Usage, activeMission: (id: string) => boolean): Promise<void> {
    this.latestUsage = usage;
    for (const job of this.jobs.values()) {
      if (job.state !== 'failed' || !job.error?.limit || !job.worktree || !job.sessionId || !job.mission) continue;
      const turn = job.turns;
      const eligible = () => {
        const reading = this.latestUsage?.providers.find((provider) => provider.agent === job.agent);
        return job.turns === turn && job.state === 'failed' && Boolean(job.error?.limit && reading?.capturedAt
          && reading.capturedAt > (job.endedAt ?? 0) && (reading.status === 'ok' || reading.status === 'tight')
          && job.mission && activeMission(job.mission) && projectSettings(this.readConfig(), job.root ?? job.project).autoResume);
      };
      if (!eligible() || !fs.existsSync(job.worktree.path)) continue;
      if (!autoResumesLeft(job)) {
        const note = `Stopped after ${MAX_AUTO_RESUMES} automatic resumes. Use reply to continue this job.`;
        if (!job.notes.includes(note)) {
          job.notes.push(note);
          this.changed(job);
        }
        continue;
      }
      try {
        await this.reply(job.id, { message: 'Your usage limit has reset; continue where you stopped.' }, { kind: 'resume', eligible });
      } catch {
        // A manual reply, workspace operation or exclusive job can win. A later reading can try again.
      }
    }
  }

  async reply(id: string, input: { message?: string; decision?: 'approve' | 'deny' | 'allow_for_job' | 'decline'; request_id?: string; approved_by_user?: string; lead_session?: string; sync?: boolean | string; attachments?: string[] }, automatic?: { kind: 'fix' } | { kind: 'resume'; eligible: () => boolean }): Promise<Job> {
    if (this.collecting) throw new Error('Crew gc is running. Try again when it finishes.');
    const job = this.get(id);
    if (job.cleanupPending) throw new Error(`Job ${id} has incomplete cleanup. Run crew gc to resolve it before continuing.`);
    if (this.changingRounds.has(id)) throw new Error(`Job ${id} is changing a round. Wait for it to finish.`);
    if (this.discarding.has(id)) throw new Error(`Job ${id} is being discarded.`);
    if (this.cancelling.has(id)) throw new Error(`Job ${id} is being cancelled.`);
    if (this.preparingReviews.has(id)) throw new Error(`Job ${id} is preparing its review diff. Wait for it to finish.`);
    if (this.finalizing.has(id) && automatic?.kind !== 'fix') throw new Error(`Job ${id} is collecting its result. Wait for it to finish.`);
    const ctl = this.ctl(job);
    const adapter = this.adapter(job.agent);
    const attachments = checkAttachments(input.attachments);
    if (input.request_id !== undefined && input.request_id !== job.waiting?.id) {
      throw new Error('That request is no longer pending. Check the current job before answering.');
    }
    if (input.decision !== undefined && !['approve', 'deny', 'allow_for_job', 'decline'].includes(input.decision)) {
      throw new Error('Pass decision "approve", "deny", "allow_for_job", or "decline".');
    }
    if (job.waiting) {
      if (input.approved_by_user !== undefined) throw new Error(`Job ${id} is waiting on the user (${job.waiting.reason}). approved_by_user is for an action the automatic reviewer refused in a finished turn; call wait so the user is asked.`);
      if (!input.request_id) throw new Error('Pass the request_id shown in the current job status.');
      const decline = input.decision === 'decline';
      if (decline) {
        if (job.waiting.type !== 'approval') throw new Error('Only an approval can be declined by the lead. Pass a message to answer the question.');
        if (typeof input.message !== 'string' || !input.message.trim()) throw new Error('Pass a message with the reason for declining and what to do instead.');
      }
      // A message alone must never count as approval: the lead may only be asking the worker why.
      if (job.waiting.type === 'approval' && !input.decision) throw new Error(`Job ${id} is waiting for approval (${job.waiting.reason}). Pass decision "approve" or "deny" for the user, or use "decline" with a message if the request is outside the task or role.`);
      if (!input.decision && !input.message?.trim()) throw new Error(`Job ${id} asked a question (${job.waiting.reason}). Pass a message with the answer, or a decision.`);
      if (input.decision === 'allow_for_job' && !job.waiting.grant) throw new Error(`Job ${id}'s request cannot be allowed for the whole job. Pass decision "approve" or "deny" for the user, or use "decline" with a message if the request is outside the task or role.`);
      const opts = input.decision === 'allow_for_job' ? { forJob: true } : decline ? { by: 'lead' as const } : undefined;
      await this.sendWith(job, attachments, (note) => adapter.answer(ctl, !decline && input.decision !== 'deny', note ? `${input.message ?? ''}${note}` : input.message, opts));
      return job;
    }
    if (input.decision !== undefined) throw new Error(`Job ${id} is not waiting for a decision.`);
    const retry = input.approved_by_user === undefined ? null : this.retryRefused(job, input.approved_by_user, input.message, input.lead_session);
    if (retry) input = { message: retry.message };
    if (!input.message) throw new Error(`Job ${id} is not waiting for a decision. Pass a message to send a follow-up.`);
    if (job.debate && isTerminal(job) && job.turns >= job.debate.rounds) {
      throw new Error(`This debate has had its ${job.debate.rounds} round(s). Decide from it, or start a new debate if it must go on.`);
    }
    if (!job.sessionId) throw new Error(`Job ${id} never opened a session, so there is nothing to continue. Start a new job instead.`);
    // Its directory is gone: a turn would run nowhere, and its edits would be reported as made in place.
    // A review that runs the app is the exception: its snapshot is made anew for each turn, below.
    if (!(job.kind === 'review' && job.runsApp) && !fs.existsSync(job.cwd)) {
      throw new Error(`Job ${id}'s worktree was removed, so it cannot take another turn. Start a new job; to ask something without changing anything, use a question.`);
    }
    if (!isTerminal(job) && automatic?.kind !== 'fix') {
      // A merge under a worker that is in the middle of editing would pull the tree out from under it.
      if (input.sync) throw new Error(`Job ${id} is still ${job.state}; sync brings a finished job up to date before its next turn. Wait for the turn to end, or send the message without sync.`);
      // Steering a live turn: a rejected message is the caller's problem, not a reason to fail the job.
      const message = input.message;
      await this.sendWith(job, attachments, (note) => adapter.reply(ctl, message + note));
      return job;
    }
    // A review's snapshot is made anew below; any other worktree must still be the job's own branch, or a sync
    // would merge into, and the turn be committed on, whatever was checked out there since.
    if (job.worktree && job.kind !== 'review') {
      this.preparingReviews.add(id);
      try {
        if (fs.lstatSync(job.worktree.path).isSymbolicLink()) throw new Error(`Job ${id}'s worktree path is now a link to somewhere else.`);
        if ((await currentBranch(job.worktree.path)) !== job.worktree.branch) throw new Error(`Job ${id}'s worktree is not on ${job.worktree.branch}.`);
        if (job.rounds?.length) await this.reconcileRounds(job);
      } finally {
        this.preparingReviews.delete(id);
      }
    }
    // The worker started from an older commit. Merging the lead's branch in first gives it what was committed since,
    // and moves the base, so the job's result stays the worker's own changes.
    let synced: string | null = null;
    let syncWarning = '';
    let syncNote = '';
    if (input.sync) {
      if (!job.worktree || !job.repo || job.kind === 'review') throw new Error(`Job ${id} has no worktree of its own to bring up to date. Drop sync.`);
      this.preparingReviews.add(id);
      try {
        const merged = await mergeInto(job.worktree.path, job.repo, typeof input.sync === 'string' ? input.sync : 'HEAD', attached(job.worktree));
        if (merged.conflicts.length) {
          const commit = merged.commit.slice(0, 8);
          const files = merged.conflicts.join(', ');
          syncWarning = `\n\nYour worktree could NOT be brought up to date with the lead's commit \`${commit}\`; conflicted files: ${files}. The merge was aborted and your worktree is unchanged. Inspect the lead's version of these files (\`git diff HEAD...${commit} -- <file>\` or \`git show ${commit}:<file>\`) and account for those changes so your change will merge.`;
          syncNote = `Could not be brought up to date with ${commit} before turn ${job.turns + 1}; conflicted files: ${files}. The message was sent without it.`;
        } else {
          synced = merged.commit;
        }
        // Git treats a previously synced ancestor as up to date. Moving the base back would count lead edits as worker changes.
        if (synced && synced !== job.worktree.base && await git(job.repo, ['merge-base', job.worktree.base, synced]) !== synced) {
          // Rounds are replayed from the branch's history, which starts where the job did, not where it was last synced.
          job.roundsBase ??= job.worktree.base;
          job.worktree.base = synced;
          job.notes.push(`Brought up to date with ${synced.slice(0, 8)} before turn ${job.turns + 1}.`);
          staleReceipts(job, `brought up to date with ${synced.slice(0, 8)}`);
          job.result = await this.worktreeResult(job, job.result?.commit ?? null);
          this.flush();
        }
      } finally {
        this.preparingReviews.delete(id);
      }
      if (!isTerminal(job)) return job;
    }
    // An audit of files has no diff to hand over again.
    const refreshDiff = job.kind === 'review' && !workerInfo(job.agent).reviewerRunsGit && job.reviewTarget?.type !== 'files';
    const diffTarget = job.reviewTarget?.type === 'files' ? undefined : job.reviewTarget;
    if (refreshDiff && (!diffTarget || !job.repo)) {
      throw new Error(`Job ${id} has no saved review target or repository. Start a new review instead.`);
    }
    // A follow-up turn sets a finished worker running again, so it is a start like any other.
    this.checkAlone(Boolean(job.exclusive), id);
    // A mission can close while git verifies the worktree for the follow-up.
    if (automatic?.kind === 'resume') {
      if (!automatic.eligible()) return job;
      job.autoResumes = (job.autoResumes ?? 0) + 1;
    }
    if (automatic?.kind === 'fix') {
      this.finishTurnResources(job);
      this.finalizing.delete(id);
      job.autoFixTurn = job.turns + 1;
    }
    if (syncNote) job.notes.push(syncNote);
    job.state = 'running';
    job.phase = 'starting';
    job.endedAt = null;
    job.error = null;
    delete job.outcome;
    // A retry that follows a retry goes to the user; every other turn is the automatic reviewer's.
    job.asksUser = retry !== null && job.retrying !== undefined;
    job.retrying = retry?.actions;
    job.turns += 1;
    const turn = job.turns;
    if (retry) (job.approvals ??= []).push({ ...retry.approval, turn: job.turns });
    exchanged(job, 'lead', input.message);
    const round = !job.debate ? '' : `\n\n${job.turns === job.debate.rounds
      ? `This is the final round (${job.turns} of ${job.debate.rounds}). Answer, then close with your Conclusion.`
      : `Round ${job.turns} of ${job.debate.rounds}.`}`;
    this.turnStartTokens.set(id, job.tokens ?? 0);
    if (job.tokenUse) job.tokenUse.turn = 0;
    delete job.turnWaitMs;
    job.turnStartedAt = job.activeAt = Date.now();
    const what = !retry ? clip(input.message.split('\n')[0], 80) : job.asksUser ? 'refused action retried; the user is asked about each request' : 'refused action retried with the user\'s approval';
    this.event(job, 'started', `follow-up: ${what}`);
    try {
      // A restart after dispatch must remember that Crew already sent this turn.
      if (automatic) this.flush();
      if (job.kind === 'review' && job.repo && !job.runsApp) {
        // Held like the diff refresh below, so an overlapping follow-up is refused rather than steering this turn.
        this.preparingReviews.add(id);
        try {
          await this.recordReviewed(job, job.repo);
        } finally {
          this.preparingReviews.delete(id);
        }
        if (isTerminal(job)) return job;
      }
      let message = this.attach(job, input.message, attachments, job.turns) + round + syncWarning;
      if (job.agent === 'codex') {
        job.scratch = this.scratchDir(id);
        fs.mkdirSync(job.scratch, { recursive: true });
      }
      if (synced) message += `\n\nYour worktree has been brought up to date: it now contains the lead's commits up to \`${synced.slice(0, 8)}\`, merged into your branch. Look at what changed (\`git log -5 --stat\`) before continuing.`;
      // The worker's conversation still holds the edits of an undone round; told nothing, it builds on them.
      const untold = (job.rounds ?? []).filter((round) => round.state !== (round.toldWorker ?? 'kept'));
      message += roundsNotice(untold);
      if (job.kind === 'review' && job.runsApp) {
        this.preparingReviews.add(id);
        try {
          await this.snapshots.get(id);
          if (job.worktree) {
            this.dropSnapshot(job);
            await this.snapshots.get(id);
          }
          if (job.worktree) throw new Error(`The previous snapshot at ${job.worktree.path} could not be removed. Cancel this job with discard: true and start a new review.`);
          job.worktree = await this.snapshot(job.repo!, id, job.reviewTarget!, job.notes);
          // A job from before worktrees moved into their slot recorded the slot as its directory.
          job.cwd = job.worktree.path;
          // Recorded before anything else can fail, so the snapshot is never left without an owner.
          this.flush();
          await this.recordReviewed(job, job.repo!);
          if (isTerminal(job)) {
            this.dropSnapshot(job);
            return job;
          }
          message += '\n\nThe snapshot has been refreshed to the current state of the change.';
          if (job.worktree.linked?.length) message += ` Shared read-only directories: ${job.worktree.linked.join(', ')}. Do not install into or delete them; put tool caches in the temp directory.`;
        } finally {
          this.preparingReviews.delete(id);
        }
      }
      if (refreshDiff) {
        this.preparingReviews.add(id);
        const diffFile = this.diffFile(id, job.turns);
        try {
          const diff = await reviewDiff(job.repo!, diffTarget!);
          if (isTerminal(job)) return job;
          fs.mkdirSync(path.dirname(diffFile), { recursive: true });
          fs.writeFileSync(diffFile, diff);
          message += `\n\nThe review diff has been refreshed at \`${diffFile}\` for the original review target. Read this file before reviewing; it replaces the previous diff.`;
        } finally {
          this.preparingReviews.delete(id);
        }
      }
      await adapter.reply(ctl, message);
      if (job.turns !== turn) return job;
      for (const round of untold) {
        if (round.state === 'undone') round.toldWorker = 'undone';
        else delete round.toldWorker;
      }
    } catch (err) {
      // The send can outlast a cancel and the follow-up after it; its failure then belongs to a turn that is over.
      if (job.turns === turn) ctl.fail(String((err as Error)?.message ?? err));
    }
    return job;
  }

  /**
   * The follow-up that sends a refused action back with the user's approval. The lead's quote may be a
   * translation or a paraphrase, so it is never checked against what the user typed; instead the user's own
   * recent prompts go with it, verbatim, for the worker's automatic reviewer to judge.
   */
  private retryRefused(job: Job, words: string, extra?: string, session?: string): { message: string; actions: string[]; approval: Omit<RelayedApproval, 'turn'> } {
    if (typeof words !== 'string' || !words.trim()) throw new Error('approved_by_user must quote what the user said that approves the refused action.');
    if (!isTerminal(job)) throw new Error(`Job ${job.id} is still ${job.state}. Wait for the turn to end before sending a refused action back.`);
    const actions = openRefusals(job).map((refusal) => refusal.action);
    if (!actions.length) throw new Error(`Nothing was refused in the last turn of job ${job.id}, so there is nothing to approve. Send a plain message instead.`);
    const quote = words.trim();
    const prompts = typeof session === 'string' && session ? this.hooks.userPrompts?.(session) ?? [] : [];
    const loose = looseText(quote);
    const matched = Boolean(loose) && prompts.some((prompt) => looseText(prompt.text).includes(loose));
    const parts = [
      `The user approved what the automatic reviewer refused. As the lead relays it: "${quote}"`,
    ];
    if (prompts.length) {
      parts.push(`The user's own most recent messages in the lead session, recorded by Crew verbatim (oldest first; the lead's words above may translate or paraphrase them):\n${prompts.map((prompt) => `- ${prompt.text.replace(/\n/g, '\n  ')}`).join('\n')}`);
    }
    parts.push(`Run the refused action again, exactly as before:\n${actions.join('\n')}`);
    if (extra?.trim()) parts.push(extra.trim());
    return { message: parts.join('\n\n'), actions, approval: { quote, matched, recorded: prompts.length, at: Date.now() } };
  }

  /** Records what this review turn is reading, so a later change to the tree shows the review no longer covers it. */
  private async recordReviewed(job: Job, repo: string): Promise<void> {
    const target = job.reviewTarget;
    if (!target) return;
    // A reviewer that runs the app reads its snapshot, which may already be behind the lead's tree.
    const where = job.worktree?.path ?? repo;
    try {
      const head = (await git(where, ['rev-parse', target.type === 'commit' ? target.sha : 'HEAD'])).trim();
      const reviewed: TurnReceipt['reviewed'] = target.type === 'uncommittedChanges'
        ? { target: 'uncommitted changes', diff: createHash('sha256').update(await reviewDiff(where, target)).digest('hex').slice(0, 12) }
        : target.type === 'files' ? { target: `${pathList(target.paths)} as ${target.paths.length > 1 ? 'they stand' : 'it stands'}` }
          : { target: target.type === 'commit' ? `commit ${target.sha}` : `changes against ${target.branch}` };
      (job.receipts ??= []).push({ turn: job.turns, head, reviewed, at: Date.now() });
    } catch (err) {
      job.notes.push(`Could not record what turn ${job.turns} reviewed: ${(err as Error).message.split('\n')[0]}`);
    }
  }

  /** A worktree holding the change under review, for a reviewer that runs the app. Removed when the turn ends. */
  private async snapshot(repo: string, id: string, target: ReviewTarget, notes: string[]): Promise<Worktree> {
    const worktree = await createWorktree(repo, id, target.type === 'commit' ? target.sha : 'HEAD', this.home);
    try {
      // Files as they stand are the working tree's, uncommitted edits included.
      if (target.type === 'uncommittedChanges' || target.type === 'files') await carryUncommitted(repo, worktree.path);
      const partial = 'The snapshot does not contain submodules: their directories are empty in it.';
      if (fs.existsSync(path.join(repo, '.gitmodules')) && !notes.includes(partial)) notes.push(partial);
      const included = await copyIncluded(repo, worktree.path);
      worktree.linked = included.linked;
      const linked = `Shared read-only from .worktreeinclude: ${included.linked.join(', ')}`;
      if (included.linked.length && !notes.includes(linked)) notes.push(linked);
      const failed = `Could not copy from .worktreeinclude: ${included.failed.join('; ')}`;
      if (included.failed.length && !notes.includes(failed)) notes.push(failed);
    } catch (err) {
      try {
        await removeWorktree(repo, worktree, id, this.home, this.platform);
      } catch (cleanup) {
        throw new Error(`${(err as Error).message}; worktree cleanup failed: ${(cleanup as Error).message}`, { cause: err });
      }
      throw err;
    }
    return worktree;
  }

  private dropSnapshot(job: Job): void {
    const { worktree, repo } = job;
    if (!worktree || !repo || this.snapshots.has(job.id)) return;
    const removal = this.removeJobWorktree(job).then(
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
    const check = this.checks.get(id);
    if (check) {
      // The turn is over; stopping its check lets the result be collected now, with the check marked as stopped.
      check.abort();
      return job;
    }
    if (this.finalizing.has(id)) throw new Error(`Job ${id} is collecting its result. Wait for it to finish.`);
    const ctl = this.ctl(job);
    this.cancelling.add(id);
    try {
      await this.adapter(job.agent).cancel(ctl);
      ctl.cancelled();
    } finally {
      this.finishCancellation(job);
    }
    return job;
  }

  private async removeJobWorktree(job: Job): Promise<void> {
    try {
      await this.adapter(job.agent).release?.(this.ctl(job));
    } catch (err) {
      job.notes.push(`Could not release the worker session: ${(err as Error).message}`);
    }
    try {
      await removeWorktree(job.repo!, job.worktree!, job.id, this.home, this.platform);
      delete job.cleanupPending;
    } catch (err) {
      if (err instanceof WorktreeCleanupError) {
        job.cleanupPending = err.leftovers;
        if (!this.onlyDirectoryLeft(job)) {
          job.notes.push(`Cleanup left: ${err.leftovers.join('; ') || 'Git registration could not be confirmed'}. Run crew gc to remove leftovers later. ${err.message}`);
        }
        this.changed(job);
        this.flush();
        // Delays are consecutive: tries at about 30 s and 2.5 min after the failed removal.
        this.retryLeftover(job, [30_000, 120_000]);
      }
      throw err;
    }
  }

  /** Windows can hold the worktree directory for a while after its files and Git metadata are gone. */
  private onlyDirectoryLeft(job: Job): boolean {
    return this.platform === 'win32' && Boolean(job.repo && job.worktree) && job.cleanupPending?.length === 1
      && job.cleanupPending[0] === `directory ${job.worktree!.path}`;
  }

  /** One attempt at that directory. True once it is gone and the job no longer has leftovers. */
  private async clearLeftover(job: Job): Promise<boolean> {
    if (!this.onlyDirectoryLeft(job) || this.collecting || this.discarding.has(job.id) || this.changingRounds.has(job.id)
        || this.snapshots.has(job.id)) return false;
    const worktree = job.worktree!;
    // Shares discard's reservation, so a discard, reply, round change or gc cannot start on this job meanwhile.
    this.discarding.add(job.id);
    try {
      const listed = (await git(job.repo!, ['worktree', 'list', '--porcelain', '-z'])).split('\0');
      // A directory Git still lists is for crew gc, which prunes the registration too.
      if (listed.some((line) => line.startsWith('worktree ') && realpath(line.slice(9)) === realpath(worktree.path))) return false;
      if (!await removeEmptyLeftover(worktree.path, this.home)) return false;
      await removeEmptySlot(job.repo!, worktree.path, job.id, this.home);
    } catch {
      return false;
    } finally {
      this.discarding.delete(job.id);
    }
    if (job.worktree === worktree) {
      delete job.cleanupPending;
      job.worktree = null;
      job.notes.push('Worktree leftovers removed after a delay.');
      this.changed(job);
      this.flush();
    }
    return true;
  }

  private retryLeftover(job: Job, delays: number[]): void {
    const [wait, ...rest] = delays;
    if (wait === undefined || !this.onlyDirectoryLeft(job)) return;
    setTimeout(() => {
      void this.clearLeftover(job).then((done) => { if (!done) this.retryLeftover(job, rest); });
    }, wait).unref();
  }

  async gc(options: { apply?: boolean; branches?: boolean } = {}): Promise<string> {
    if (this.collecting || this.starting.length) throw new Error('Jobs or gc are starting. Try again when they finish.');
    this.collecting = true;
    try {
      const pending = this.list().filter((job) => job.cleanupPending);
      const result = await collectGarbage(this.home, this.list(), (job) => !isTerminal(job) || this.discarding.has(job.id)
        || this.changingRounds.has(job.id) || this.preparingReviews.has(job.id) || this.snapshots.has(job.id)
        || this.finalizing.has(job.id) || this.cancelling.has(job.id), options, this.platform);
      if (options.apply) {
        for (const job of pending) this.changed(job);
        this.flush();
      }
      return result;
    } finally {
      this.collecting = false;
    }
  }

  /** Removes the worktree and branch of a finished job. */
  async discard(id: string): Promise<Job> {
    if (this.collecting) throw new Error('Crew gc is running. Try again when it finishes.');
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
        try {
          await this.removeJobWorktree(job);
        } catch (err) {
          // Windows can hold the emptied folder for a while; the delayed retries finish it, so this is not a failure.
          if (!this.onlyDirectoryLeft(job)) throw err;
          job.notes.push('Worktree files, Git metadata and branch removed. Windows still holds the empty folder; it is removed automatically within about three minutes (retries at 30 seconds and 2.5 minutes), or at the next daemon start.');
          this.changed(job);
          this.flush();
          return job;
        }
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
    if (this.collecting) throw new Error('Crew gc is running. Try again when it finishes.');
    const job = this.get(id);
    if (job.cleanupPending) throw new Error(`Job ${id} has incomplete cleanup. Run crew gc to resolve it before changing a round.`);
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
      const reverted = await revertCommit(job.worktree.path, commit, attached(job.worktree));
      const result = await this.worktreeResult(job, reverted);
      round.state = state;
      staleReceipts(job, `round ${turn} ${state}`);
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
    const before = JSON.stringify(rounds.map(({ state, revert }) => [state, revert]));
    const history = await revertsSince(job.worktree!.path, job.roundsBase ?? job.worktree!.base);
    for (const round of rounds) {
      round.state = 'kept';
      delete round.revert;
    }
    for (const { commit, reverts } of history) {
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
    if (JSON.stringify(rounds.map(({ state, revert }) => [state, revert])) === before) return;
    staleReceipts(job, 'round state recovered from git');
    job.result = await this.worktreeResult(job, job.result?.commit ?? null);
    this.flush();
  }

  ask(id: string, text: string, blocks?: string, attachments?: string[]): LeadQuestion {
    const job = this.get(id);
    if (isTerminal(job)) throw new Error(`Job ${id} is ${job.state}; questions require a running or waiting job.`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Question text must be a non-empty string.');
    if (text.length > 4000) throw new Error('Question text must be at most 4000 characters.');
    if (blocks !== undefined && typeof blocks !== 'string') throw new Error('blocks must be a string.');
    if ((job.questions?.length ?? 0) >= 20) throw new Error(`Job ${id} already has 20 lead questions.`);
    const files = job.evidenceDir ? questionAttachments(job.evidenceDir, attachments) : [];
    if (attachments?.length && !job.evidenceDir) throw new Error(`Job ${id} has no evidence directory to attach from.`);
    if (files.length) job.evidence = collectEvidence(job.evidenceDir!, job.evidence ?? [], job.turns);
    const question: LeadQuestion = { id: randomUUID(), text, ...(blocks === undefined ? {} : { blocks }), ...(files.length ? { attachments: files } : {}), at: Date.now() };
    (job.questions ??= []).push(question);
    job.activeAt = Date.now();
    job.questionSeq = this.seq + 1;
    this.event(job, 'progress', `asks the lead: ${text.trim().split('\n')[0]}`, { kind: 'question', reason: text, question: question.id });
    return question;
  }

  answer(id: string, questionId: string, text: string, attachments?: string[]): Job {
    const job = this.get(id);
    const question = job.questions?.find((q) => q.id === questionId);
    if (!question) throw new Error(`No lead question with id "${questionId}" on job ${id}.`);
    if (question.answer !== undefined) throw new Error(`Lead question ${questionId} is already answered.`);
    if (typeof text !== 'string' || !text.trim()) throw new Error('Answer must be a non-empty string.');
    const files = checkAttachments(attachments);
    question.answer = this.attach(job, text, files, job.turns);
    question.answeredAt = Date.now();
    this.event(job, 'progress', `lead answered ${questionId}`);
    return job;
  }

  /** A Playwright server outside the worker's sandbox, which no browser can start inside on macOS. */
  async browser(id: string): Promise<{ endpoint: string }> {
    const job = this.get(id);
    if (isTerminal(job)) throw new Error(`Job ${id} is ${job.state}; a browser is for a running turn.`);
    if (!job.runsApp) throw new Error('This job may not run the app, so it gets no browser. Report what you could not check; the lead can start the job with runs_app.');
    const endpoint = await this.browsers.start(id, {
      cwd: job.cwd,
      writable: jobWritable([job.cwd, job.scratch, job.evidenceDir]),
      unreadable: [tokenFile(this.home)],
      tmp: job.scratch ?? this.scratchDir(id),
    });
    // Ended meanwhile: the turn's end has already stopped the servers it knew of.
    if (isTerminal(job)) {
      this.browsers.stop(id);
      throw new Error(`Job ${id} ended while its browser started.`);
    }
    return { endpoint };
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

  private adapter(agent: Agent): Adapter {
    const adapter = this.adapters[agent];
    if (!adapter) throw new Error(`${workerInfo(agent).name} runs no workers here.`);
    return adapter;
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
        // The agent starts this server, and agents are launched without the variable that makes the app's executable act as Node.
        env: { ...nodeEnv(), CREW_JOB_ID: job.id, CREW_JOB_TOKEN: token, CREW_PORT: String(daemonPort()), CREW_JOB_CWD: job.cwd, ...(job.rates ? { CREW_JOB_RATES: job.kind } : {}) },
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
        // A waiting job's phase names what it waits on; a sub-agent's progress meanwhile goes to the activity log only.
        if (job.state !== 'waiting') job.phase = detail;
        this.event(job, 'progress', detail);
      },
      session: (id) => {
        job.sessionId = id;
        this.changed(job);
      },
      model: (name, effort) => {
        job.resolvedModel = name;
        job.resolvedEffort = effort;
        this.changed(job);
      },
      capabilities: (value) => {
        job.capabilities = value;
        this.changed(job);
      },
      touched: (file) => {
        const set = this.touchedFiles.get(job.id) ?? new Set();
        this.touchedFiles.set(job.id, set);
        set.add(file);
      },
      note: (text, opts) => {
        // Notes survive follow-ups; record the turn even when the same refusal was already noted.
        if (opts?.declined) {
          job.declinedTurn = job.turns;
          this.changed(job);
        }
        if (job.notes.includes(text)) return;
        job.notes.push(text);
        this.changed(job);
      },
      refused: (action, reason) => {
        if (!live()) return;
        (job.refusals ??= []).push({ action, reason, turn: job.turns });
        this.event(job, 'progress', `refused by the automatic reviewer: ${clip(action.split('\n')[0], 120)}`);
      },
      tokens: (total, parts) => {
        job.tokens = total;
        if (parts) {
          job.tokenUse = { ...parts, turn: total - (this.turnStartTokens.get(job.id) ?? 0) };
          this.checkBudget(job);
        }
      },
      context: (used, size) => {
        // Like tokens, it reaches the board with the job's next change.
        if (used >= 0 && size > 0) job.context = { used, size };
      },
      diff: (text) => {
        if (!live() || this.finalizing.has(job.id) || typeof text !== 'string') return;
        // Never between the halves of a surrogate pair, which a strict JSON decoder (the macOS app's) refuses.
        const cut = /[\uD800-\uDBFF]/.test(text[LIVE_DIFF_CHARS - 1] ?? '') ? LIVE_DIFF_CHARS - 1 : LIVE_DIFF_CHARS;
        const diff = text.length > LIVE_DIFF_CHARS
          ? `${text.slice(0, cut)}\n… ${(text.length - cut).toLocaleString('en-US')} more characters; the worktree has the whole change.`
          : text;
        // Clients refetch when this changes, so two updates in one millisecond still differ.
        const at = Math.max(Date.now(), (job.liveDiff?.at ?? 0) + 1);
        this.liveDiffs.set(job.id, { turn: job.turns, diff, at });
        job.liveDiff = { turn: job.turns, at, chars: text.length };
        this.changed(job);
      },
      waiting: (type, reason, grant) => {
        if (!live()) return;
        const now = Date.now();
        // Answering a request can expose another queued request without returning to running.
        this.recordWait(job, now);
        job.state = 'waiting';
        job.stalled = false;
        job.waiting = { type, reason, id: randomUUID(), since: now, ...(grant ? { grant } : {}) };
        job.phase = type === 'approval' ? 'needs approval' : 'has a question';
        this.event(job, 'waiting', reason);
        this.hooks.onAttention(job, 'waiting', reason);
      },
      resumed: () => {
        if (job.state !== 'waiting') return;
        const now = Date.now();
        this.recordWait(job, now);
        job.state = 'running';
        job.waiting = null;
        job.phase = 'working';
        job.activeAt = now;
        this.event(job, 'progress', 'resumed');
      },
      done: (report) => {
        if (!live() || this.finalizing.has(job.id)) return;
        // An acknowledged interrupt ended the turn. Otherwise a completed report wins a racing budget stop.
        if (this.budgetStops.get(job.id)?.ended) return;
        this.budgetStops.delete(job.id);
        // The turn is over; collecting its result can take a while, and the result replaces what it showed.
        this.dropLiveDiff(job);
        this.finalizing.add(job.id);
        this.finalize(job, report).catch((err) => {
          this.finalizing.delete(job.id);
          if (!live()) return;
          // The worker finished and said what it did; only the bridge's own bookkeeping failed, so its words are kept.
          exchanged(job, 'worker', report);
          job.report = report;
          // The result on record, if any, is an earlier turn's: its commit and files are not what this report describes.
          this.fail(job, `could not collect the result: ${err.message}${job.result ? ' The changes listed are those of the last turn whose result was collected, not of this one.' : ''}`, false);
        });
      },
      fail: (message, opts) => {
        if (live() && !this.finalizing.has(job.id) && !this.budgetEnded(job)) this.fail(job, message, opts?.limit ?? false);
      },
      cancelled: () => {
        if (!live() || this.finalizing.has(job.id)) return;
        if (this.budgetEnded(job)) return;
        job.state = 'cancelled';
        job.waiting = null;
        job.stalled = false;
        job.endedAt = Date.now();
        job.phase = 'cancelled';
        this.event(job, 'cancelled', 'cancelled');
      },
    };
  }

  private async runJobCheck(command: string, cwd: string, network: boolean, codex: string, signal: AbortSignal): Promise<CheckResult> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-check-'));
    try {
      return await runCheck(command, cwd, tmp, [tokenFile(this.home)], { network, signal, codex });
    } finally {
      // A temporary folder left behind costs nothing; it must not cost the turn its collected result.
      await removeDirectory(tmp).catch(() => {});
    }
  }

  private async compareBase(repo: string, sha: string, command: string, network: boolean, codex: string, signal: AbortSignal): Promise<NonNullable<TurnReceipt['base']>> {
    // Never reuse a reading taken with different sandbox permissions.
    const key = JSON.stringify([canonicalPath(repo), sha, command, network, codex]);
    let cached = this.baseChecks.get(key);
    if (!cached) {
      const stop = new AbortController();
      const result = withBaseWorktree(repo, sha, async (cwd) => {
        const check = await this.runJobCheck(command, cwd, network, codex, stop.signal);
        const unavailable = check.skipped || (check.exit === null && !check.timedOut ? check.output || 'no exit status' : undefined);
        return { exit: check.exit, timedOut: check.timedOut, ms: check.ms, ...(unavailable ? { unavailable: clip(unavailable.split(/\r?\n/).at(-1)!, 240) } : {}) };
      }).catch((err: Error) => ({ exit: null, timedOut: false, ms: 0, unavailable: clip(err.message.split(/\r?\n/)[0], 240) })).finally(() => {
        // Includes can change between comparisons. Keep only the run that other waiters can still join.
        if (this.baseChecks.get(key)?.stop === stop) this.baseChecks.delete(key);
      });
      this.baseChecks.set(key, cached = { result, users: 0, stop });
    }
    const entry = cached;
    entry.users++;
    let leave!: (base: NonNullable<TurnReceipt['base']>) => void;
    const cancelled = new Promise<NonNullable<TurnReceipt['base']>>((resolve) => { leave = resolve; });
    const abort = () => {
      if (--entry.users === 0) {
        // The last waiter also waits for cleanup. An overlapping job can start a fresh comparison.
        if (this.baseChecks.get(key) === entry) this.baseChecks.delete(key);
        entry.stop.abort();
      } else leave({ exit: null, timedOut: false, ms: 0, unavailable: 'cancelled' });
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      const result = await Promise.race([entry.result, cancelled]);
      return signal.aborted ? { exit: null, timedOut: false, ms: result.ms, unavailable: 'cancelled' } : result;
    } finally {
      signal.removeEventListener('abort', abort);
      if (!signal.aborted) entry.users--;
    }
  }

  private async finalize(job: Job, report: string): Promise<void> {
    let result: Job['result'];
    let fix: string | undefined;
    // A review's worktree is a snapshot to run the app in; nothing in it is kept.
    if (job.worktree && job.kind !== 'review') {
      const commit = await commitAll(job.worktree.path, `crew(${job.agent}): ${job.title}`, attached(job.worktree));
      if (commit) (job.rounds ??= []).push({ turn: job.turns, commit, ...await commitChanges(job.worktree.path, commit), state: 'kept', at: Date.now() });
      result = await this.worktreeResult(job, commit);
      const head = (await git(job.worktree.path, ['rev-parse', 'HEAD'])).trim();
      let check: CheckResult | undefined;
      let base: TurnReceipt['base'];
      if (job.check && !isTerminal(job)) {
        job.phase = 'running the check';
        this.changed(job);
        // A long check is the bridge at work, not a stalled worker.
        const alive = setInterval(() => { job.activeAt = Date.now(); }, 30_000);
        const stop = new AbortController();
        this.checks.set(job.id, stop);
        try {
          const network = Boolean(job.runsApp);
          const codex = this.readConfig().codex.bin;
          check = await this.runJobCheck(job.check, job.worktree.path, network, codex, stop.signal);
          if (!check.skipped && check.exit !== null && check.exit !== 0 && !stop.signal.aborted) {
            job.phase = 'checking the base commit';
            this.changed(job);
            base = await this.compareBase(job.repo!, job.worktree.base, job.check, network, codex, stop.signal);
            if (base.exit === 0 && !stop.signal.aborted && !job.autoFixTurn && job.sessionId
                && job.declinedTurn !== job.turns && !job.refusals?.some((refusal) => refusal.turn === job.turns)) {
              fix = `The bridge check failed on your change and passed on its base. Fix the cause without weakening the check.\nCommand: ${job.check}\nOutput (end):\n${check.output.split('\n').slice(-15).join('\n')}`;
            }
          }
        } finally {
          this.checks.delete(job.id);
          clearInterval(alive);
          job.activeAt = Date.now();
        }
      }
      // A check that rewrote tracked files passed on a tree the commit does not hold.
      const rewritten = check ? await git(job.worktree.path, [...NO_HOOKS, 'diff', NO_SUBMODULES, '--name-only', '-z', 'HEAD']) : '';
      const added = check ? await git(job.worktree.path, ['ls-files', '--others', '--exclude-standard', '-z']) : '';
      // What Crew attached may be untracked there without being the check's doing; once tracked, a change to it counts.
      const kept = attached(job.worktree);
      const changed = [
        ...rewritten.split('\0'),
        ...added.split('\0').filter((file) => !kept.some((rel) => file === rel || file.startsWith(`${rel}/`))),
      ].filter(Boolean);
      const stale = changed.length ? `the check itself changed ${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ` and ${changed.length - 3} more` : ''}` : undefined;
      if (stale) fix = undefined;
      (job.receipts ??= []).push({ turn: job.turns, head, ...(check ? { check } : {}), ...(base ? { base } : {}), ...(stale ? { stale } : {}), at: Date.now() });
    } else if (job.kind === 'review' || job.ask) {
      result = null;
    } else {
      const root = job.repo ?? job.cwd;
      const files = [...(this.touchedFiles.get(job.id) ?? [])].map((f) => slashed(path.relative(root, f)));
      result = { files, stat: `${files.length} file(s) edited in place`, commit: null, outOfScope: outOfScope(files, job.targets) };
    }
    exchanged(job, 'worker', report);
    job.report = report;
    if (expectsOutcome(job)) job.outcome = parseOutcome(report);
    if (job.kind === 'review') job.review = parseReview(report);
    job.result = result;
    if (fix) {
      try {
        await this.reply(job.id, { message: fix }, { kind: 'fix' });
        return;
      } catch (err) {
        job.notes.push(`Could not start an automatic fix turn: ${(err as Error).message}`);
      }
    }
    this.finalizing.delete(job.id);
    if (isTerminal(job)) return;
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

  private fail(job: Job, message: string, limit: boolean, budget = false): void {
    job.state = 'failed';
    job.waiting = null;
    job.stalled = false;
    job.endedAt = Date.now();
    job.error = { message, limit, ...(budget ? { budget: true as const } : {}) };
    job.phase = limit ? 'usage limit reached' : 'failed';
    const kind: EventKind = limit ? 'limit' : 'error';
    this.event(job, kind, message);
    this.hooks.onAttention(job, kind, message);
  }

  /** Adapters can report the turn's end inside cancel, before it has released its session. */
  private budgetEnded(job: Job): boolean {
    const stop = this.budgetStops.get(job.id);
    if (!stop) return false;
    stop.ended = true;
    if (!this.cancelling.has(job.id)) {
      this.budgetStops.delete(job.id);
      this.fail(job, stop.message, false, true);
    }
    return true;
  }

  private recordWait(job: Job, now: number): void {
    if (job.waiting) job.turnWaitMs = (job.turnWaitMs ?? 0) + Math.max(0, now - job.waiting.since);
  }

  private finishCancellation(job: Job): void {
    this.cancelling.delete(job.id);
    if (this.budgetStops.get(job.id)?.ended) this.budgetEnded(job);
  }

  private checkBudget(job: Job): void {
    if (job.state !== 'running' || this.finalizing.has(job.id) || this.cancelling.has(job.id)) return;
    const budget = TURN_BUDGET[job.difficulty ?? 'standard'];
    const elapsed = Date.now() - (job.turnStartedAt ?? job.createdAt) - (job.turnWaitMs ?? 0);
    const tokens = job.tokenUse?.turn ?? 0;
    let stop = this.budgetStops.get(job.id);
    if (!stop) {
      const message = tokens >= budget.tokens ? `Turn token cap of ${budget.tokens} reached (${tokens} tokens observed).`
        : elapsed >= budget.minutes * 60_000 ? `Turn wall-clock cap of ${budget.minutes} minutes reached (${Math.floor(elapsed / 1000)} seconds observed).` : null;
      if (!message) return;
      this.budgetStops.set(job.id, stop = { message, ended: false });
    }
    this.cancelling.add(job.id);
    void this.adapter(job.agent).cancel(this.ctl(job)).then(() => { stop.ended = true; }, () => {
      // An unconfirmed interrupt leaves the worker live. The next budget sweep retries.
    }).finally(() => this.finishCancellation(job));
  }

  private checkStalls(): void {
    const limit = this.settings.stallSeconds * 1000;
    for (const job of this.jobs.values()) {
      this.checkBudget(job);
      if (this.budgetStops.has(job.id)) continue;
      if (job.state !== 'running' || job.stalled || Date.now() - job.activeAt < limit) continue;
      job.stalled = true;
      const detail = `no activity for ${Math.round(limit / 60_000)} min (last: ${job.phase})`;
      const adapter = this.adapter(job.agent);
      if (!adapter.probe) {
        this.event(job, 'stalled', detail, { kind: 'stalled', reason: detail });
        continue;
      }
      // The board shows the stall at once; the lead is woken only if the agent cannot vouch for the turn.
      this.event(job, 'stalled', detail);
      const since = job.activeAt;
      adapter.probe(this.ctl(job)).then(
        (found) => this.probed(job, since, detail, found),
        (err) => this.probed(job, since, detail, { verdict: 'unknown', detail: `the status check failed: ${err?.message ?? err}` }));
    }
  }

  private probed(job: Job, since: number, detail: string, found: Probe): void {
    // Activity, a decision request or a new turn since the check settled this stall; a later stall has its own check.
    if (job.state !== 'running' || !job.stalled || job.activeAt !== since) return;
    if (found.verdict === 'working') {
      job.activeAt = Date.now();
      job.stalled = false;
      this.event(job, 'progress', found.detail);
    } else if (found.verdict === 'ended') this.ctl(job).fail(found.detail);
    else this.event(job, 'stalled', `${detail}; ${found.detail}`, { kind: 'stalled', reason: `${detail}; ${found.detail}` });
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

  private evidenceDir(id: string): string {
    return path.join(this.home, 'evidence', id);
  }

  /** Copies checked attachments next to the worker's evidence and adds their paths to the message. */
  private attach(job: Job, message: string, sources: string[], turn: number): string {
    return message + attachmentsNote(this.addAttachments(job, sources, turn));
  }

  private addAttachments(job: Job, sources: string[], turn: number) {
    if (!sources.length) return [];
    job.evidenceDir ??= this.evidenceDir(job.id);
    const added = attachEvidence(job.evidenceDir, sources, turn);
    job.evidence = [...(job.evidence ?? []), ...added];
    return added;
  }

  /** For a message into a live turn, which the worker can refuse: the attachments go only if the message does. */
  private async sendWith(job: Job, sources: string[], send: (note: string) => Promise<void>): Promise<void> {
    const added = this.addAttachments(job, sources, job.turns);
    try {
      await send(attachmentsNote(added));
    } catch (err) {
      detachEvidence(added);
      job.evidence = job.evidence?.filter((item) => !added.includes(item));
      throw err;
    }
  }

  /**
   * Moved aside in one step and deleted afterwards: a follow-up turn that starts at once makes a fresh
   * directory, and the slow removal of a large one can never reach it.
   */
  private dropScratch(id: string): void {
    this.removeScratch(this.scratchDir(id));
  }

  private removeScratch(dir: string): void {
    const gone = `${dir}.gone-${randomBytes(4).toString('hex')}`;
    try {
      fs.renameSync(dir, gone);
    } catch {
      return;
    }
    void removeDirectory(gone, this.platform).catch(() => {});
  }

  private diffFile(id: string, turn = 1): string {
    return path.join(this.home, 'reviews', `${id}${turn === 1 ? '' : `-${turn}`}.diff`);
  }

  private dropLiveDiff(job: Job): void {
    this.liveDiffs.delete(job.id);
    if (!job.liveDiff) return;
    delete job.liveDiff;
    this.changed(job);
  }

  /** The diff of a job's running turn so far, while it runs. */
  liveDiff(id: string): { turn: number; diff: string; at: number } | null {
    const job = this.get(id);
    const live = this.liveDiffs.get(id);
    return live && !isTerminal(job) && live.turn === job.turns ? live : null;
  }

  eventsFor(id: string, after: number): CrewEvent[] {
    return this.recent.filter((e) => e.job_id === id && e.seq > after);
  }

  private event(job: Job, kind: EventKind, detail: string, news?: { kind: News['kind']; reason: string; question?: string }): void {
    if (job.autoFixTurn === job.turns && ['done', 'error', 'limit'].includes(kind)) detail = `Automatic fix turn ${job.turns}: ${detail}`;
    job.seq = this.record(job.agent, job.sessionId, kind, detail, job.id).seq;
    if (isTerminal(job)) this.finishTurnResources(job);
    if (news) addNews(job, news.kind, news.reason, { question: news.question });
    else if (kind === 'done') addNews(job, 'done', detail);
    else if (kind === 'error' || kind === 'limit') addNews(job, 'failed', detail);
    else if (kind === 'waiting') addNews(job, 'waiting', detail, { request: job.waiting?.id });
    deliveryPosition(job);
    try {
      if (news || ['done', 'error', 'limit', 'waiting'].includes(kind)) this.flush();
    } catch (err) {
      // The news is in memory and the next save retries it; failing here would also keep watchers and waits asleep.
      console.error(`Could not save ${job.id}: ${(err as Error).message}`);
    }
    this.changed(job);
    this.delivery.changed();
    for (const wake of [...(this.waiters.get(job.id) ?? [])]) wake();
  }

  private finishTurnResources(job: Job): void {
    this.dropLiveDiff(job);
    // Each turn has its own file, so delayed cleanup cannot delete a follow-up's fresh diff.
    if (job.kind === 'review') {
      fs.rm(this.diffFile(job.id, job.turns), { force: true }, () => {});
      this.dropSnapshot(job);
    }
    if (job.evidenceDir) job.evidence = collectEvidence(job.evidenceDir, job.evidence ?? [], job.turns);
    // Like scratch, a browser is the turn's.
    this.browsers.stop(job.id);
    // Scratch is for the turn: nothing in it is a result. The path is derived, never read from the job, before it is removed.
    if (job.scratch) this.dropScratch(job.id);
  }

  private changed(job: Job): void {
    deliveryPosition(job);
    this.hooks.onJob(job);
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500);
  }

  /** Jobs a receipt the lead has not echoed yet still names, which an ack must find. */
  private named(): Set<string> {
    return new Set(Object.values(this.delivery.state.receipts).filter((receipt) => !receipt.acknowledged).flatMap((receipt) => receipt.items.map((item) => item.jobId)));
  }

  private save(): void {
    let history = 0;
    const named = this.named();
    const keep = this.list().filter((job) =>
      job.worktree || job.cleanupPending || !isTerminal(job) || this.finalizing.has(job.id) || this.cancelling.has(job.id)
      || this.discarding.has(job.id) || this.changingRounds.has(job.id) || this.preparingReviews.has(job.id)
      || this.snapshots.has(job.id) || this.checks.has(job.id) || Boolean(this.waiters.get(job.id)?.size) || named.has(job.id)
      // Just ended, its caller has yet to read the result.
      || Date.now() - (job.endedAt ?? 0) < RECENT_MS || (unread(job).length > 0 && Date.now() - (job.endedAt ?? 0) < UNREAD_KEEP_MS) || (job.mission !== undefined && this.hooks.keepsMission?.(job.mission)) || history++ < KEEP_JOBS,
    );
    const file = path.join(this.home, 'jobs.json');
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ seq: this.seq, jobs: keep, delivery: this.delivery.state, pulls: this.hooks.pulls?.saved(named) }));
    fs.renameSync(`${file}.tmp`, file);
    const kept = new Set(keep.map((job) => job.id));
    for (const id of this.jobs.keys()) {
      if (kept.has(id)) continue;
      this.jobs.delete(id);
      this.workerTokens.delete(id);
      this.touchedFiles.delete(id);
      this.turnStartTokens.delete(id);
      this.waiters.delete(id);
    }
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private load(): void {
    const file = path.join(this.home, 'jobs.json');
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      // The file may be whole and only out of reach for now (permissions, a scanner holding it): not a ledger to set aside.
      throw new Error(`Could not read ${file}, so it was left untouched: ${(err as Error).message}`);
    }
    let saved: { seq: number; jobs: Job[]; delivery?: DeliveryState; pulls?: unknown } | null;
    try {
      saved = JSON.parse(text);
    } catch (err) {
      // Starting empty here would have the next save write that emptiness over every job on record.
      throw new UnreadableLedger(`Could not load ${file}, so it was left untouched: ${(err as Error).message}`);
    }
    if (!saved || !Number.isSafeInteger(saved.seq) || !Array.isArray(saved.jobs) || !saved.jobs.every((job) => job && typeof job === 'object' && typeof job.id === 'string')
      // Two records under one id would be saved back as one.
      || new Set(saved.jobs.map((job) => job.id)).size !== saved.jobs.length) {
      throw new UnreadableLedger(`${file} does not hold a job ledger, so it was left untouched.`);
    }
    // Restoring in memory is the test of the records: one this cannot take in sets the whole file aside. So nothing
    // in it reads the disk or touches what outlives this instance, and a throw leaves nothing behind.
    const interrupted: Job[] = [];
    try {
      this.restore(saved, interrupted);
    } catch (err) {
      throw new UnreadableLedger(`${file} holds a record that could not be restored, so it was left untouched: ${(err as Error).message}`);
    }
    this.hooks.pulls?.restore(saved.pulls);
    // The interrupted turns never reached their end, where evidence is otherwise collected.
    for (const job of interrupted) if (job.evidenceDir) job.evidence = collectEvidence(job.evidenceDir, job.evidence ?? [], job.turns);
    for (const job of this.jobs.values()) if (job.kind === 'review') this.dropSnapshot(job);
    try {
      this.flush();
    } catch (err) {
      // The daemon must still start; the state is in memory and the next change saves it again.
      console.error(`crew: could not save jobs at startup: ${(err as Error).message}`);
    }
    // No turn survives a restart, so neither does any scratch.
    this.removeScratch(path.join(this.home, 'scratch'));
    // Evidence lives as long as its job's record. A ledger that was set aside still names its jobs' evidence, so
    // nothing is removed until the user has dealt with that file.
    if (fs.readdirSync(this.home).some((name) => name.startsWith(LEDGER_ASIDE))) return;
    const evidence = path.join(this.home, 'evidence');
    for (const id of fs.existsSync(evidence) ? fs.readdirSync(evidence) : []) {
      if (!this.jobs.has(id)) this.removeScratch(path.join(evidence, id));
    }
  }

  /** The in-memory half of load(): the saved jobs and receipts as this run holds them. */
  private restore(saved: { seq: number; jobs: Job[]; delivery?: DeliveryState }, interrupted: Job[]): void {
    this.seq = saved.seq;
    this.delivery.restore(saved.delivery);
    for (const job of saved.jobs) {
      // The diff text lived in the previous bridge.
      delete job.liveDiff;
      const legacy = job.news === undefined;
      job.news ??= [];
      job.newsSeq ??= 0;
      job.ackedSeq ??= 0;
      // Record unread legacy results without guessing which session owns them. With no owner they are not offered
      // to any lead, and adopting the job later does not hand them over; they stay on the board and in status.
      if (legacy && job.seq > job.delivered) {
        if (job.state === 'done') addNews(job, 'done', job.report || job.title);
        else if (job.state === 'failed') addNews(job, 'failed', job.error?.message ?? 'failed');
        else if (job.waiting) addNews(job, 'waiting', job.waiting.reason, { request: job.waiting.id });
        for (const question of job.questions ?? []) if (question.answer === undefined) addNews(job, 'question', question.text, { question: question.id });
      }
      // Read from the disk after this; a list of another kind would fail there, where it no longer sets the file aside.
      if (job.evidence !== undefined && !Array.isArray(job.evidence)) throw new Error(`job ${job.id} holds evidence that is not a list`);
      // Jobs saved before ownership was recorded; their repository is the closest stand-in.
      job.project = canonicalPath(job.project ?? job.repo ?? job.cwd);
      // Saved before keys were canonical; a Windows job may hold git's `C:/x` spelling.
      if (job.root) job.root = canonicalPath(job.root);
      // Its build line would be refused with it, so a value of no known difficulty counts as none.
      if (job.difficulty !== undefined && !DIFFICULTIES.includes(job.difficulty)) delete job.difficulty;
      if (!isTerminal(job)) {
        // The worker process died with the previous bridge; its session can still be continued with reply.
        job.state = 'failed';
        job.waiting = null;
        job.endedAt = Date.now();
        job.phase = 'failed';
        const next = job.sessionId ? 'Use reply to continue the same session.' : 'Start a new job.';
        job.error = { message: `The bridge restarted while this job was running. ${next}`, limit: false };
        job.seq = ++this.seq;
        addNews(job, 'failed', job.error.message);
        interrupted.push(job);
      }
      deliveryPosition(job);
      this.jobs.set(job.id, job);
    }
    // Every save reads the receipts this way; one that cannot be read would fail each of them.
    this.named();
  }
}

/** First line of a report that says something, skipping markdown headings. */
function headline(report: string): string {
  // The word under "## Outcome" says nothing about the work, so the headline is the line after it.
  const line = report.split('\n').find((l) => l.trim() && !l.startsWith('#') && !/^\s*(-\s+)?[*_`]*(done|partial|blocked)[*_`]*\.?\s*$/i.test(l)) ?? '';
  return clip(line.trim(), 140);
}

/** Tells the worker which of its rounds were undone or restored since it last heard. */
function roundsNotice(rounds: Round[]): string {
  const list = (state: Round['state']) => rounds.filter((round) => round.state === state)
    .map((round) => `turn ${round.turn} (${round.files.join(', ')})`).join('; ');
  const undone = list('undone');
  const restored = list('kept');
  let notice = '';
  if (undone) notice += `\n\nThe changes you made in ${undone} were undone: they are reverted on your branch and no longer in your worktree. Do not redo them unless this message asks you to.`;
  if (restored) notice += `\n\nThe changes you made in ${restored}, undone earlier, were restored and are in your worktree again.`;
  return notice;
}

/** A relative path as git names it: separated by forward slashes on every platform. */
const slashed = (file: string) => file.split(path.sep).join('/');

/** Files changed outside the paths the worker was told it may touch. */
export function outOfScope(files: string[], targets: string[]): string[] {
  if (targets.length === 0) return [];
  // Jobs saved before targets were slashed on Windows still hold backslashes.
  const allowed = targets.map((t) => slashed(t).replace(/^\.\//, '').replace(/\/+$/, ''));
  return files.filter((file) => !allowed.some((t) => file === t || file.startsWith(`${t}/`) || path.matchesGlob(file, t)));
}
