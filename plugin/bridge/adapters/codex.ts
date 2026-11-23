import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenFile } from '../auth.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal, noteLeadDecline } from '../jobs.ts';
import type { Adapter, Capabilities, Job, JobCtl, Probe } from '../jobs.ts';
import { PLUGIN_USER_APP } from '../prompts.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer, RpcTimeoutError } from '../rpc.ts';
import { clip } from '../text.ts';

type Answer = { approve: boolean; message?: string; cancelled?: boolean; forJob?: boolean };
/** A plugin tool approval the user may allow for the rest of the job: `key` matches later requests, `label` names what it covers. */
interface Grant { key: string; label: string }
interface Pending {
  id: string | number;
  threadId: string;
  turnId?: string;
  type: 'approval' | 'question';
  reason: string;
  grant?: Grant;
  resolve(answer: Answer | null): void;
}

interface ItemDetails {
  turnId?: string;
  type: string;
  server?: string;
  tool?: string;
  input?: string;
  files?: string;
}

interface Run {
  ctl: JobCtl;
  pluginsEnabled: boolean;
  /** Id of the turn in flight, or null between turns. */
  turnId: string | null;
  awaitingTurn: symbol | null;
  interrupt: ReturnType<typeof Promise.withResolvers<void>> | null;
  message: string;
  pending: Pending[];
  crewCalls: Set<string>;
  items: Map<string, ItemDetails>;
  /** Sub-agent threads with a turn in flight, and that turn's id; they can still edit the worktree. */
  busyChildren: Map<string, string | null>;
  /** The parent's turn/completed, held until busyChildren is empty so the result includes their edits. */
  held: any | null;
  /** Includes turns the status check found over without a completion. Keys are scoped to the reporting thread. */
  ended?: Set<string>;
  /** Keys of plugin tool approvals the user allowed for this job. */
  grants: Set<string>;
  /** The lead has been told that this thread's Crew tools did not start. */
  toolsDown: boolean;
}

export interface CodexLimits {
  plan: string | null;
  windows: { minutes: number | null; usedPercent: number; resetsAt: number | null }[];
  reached: boolean;
}

const CREW_TOOLS = ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes', 'rate'];
const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'];
const IDLE_SHUTDOWN_MS = 10 * 60_000;
/**
 * Codex applies the job's sandbox rules before it answers `thread/start` or `thread/resume`. On Windows that is an
 * ACL pass over every writable and protected path: 6 to 29 s on a quiet machine, and over a minute when the setup
 * runs of other jobs' commands queue ahead of it. The shared timeout failed those jobs while the thread was still starting.
 */
const THREAD_TIMEOUT_MS = 180_000;
const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONFIRM_MS = 3_000;
const STALE_THREAD_MS = 7 * 24 * 60 * 60_000;
const TIDY_EVERY_MS = 24 * 60 * 60_000;
/** A job's worktree, with or without the repository folder inside its slot. */
const WORKER_CWD = /[\\/]worktrees[\\/][^\\/]+-[0-9a-f]{8}[\\/](cx|ag)-[0-9a-f]{6}([\\/][^\\/]+)?$/;
/**
 * The user's own Codex setup brings skills, plugins, and app connectors (design, music, mail) into every thread.
 * Few Crew jobs use them, and they cost each turn thousands of input tokens. A job that names plugins gets
 * those and no others (`lean` below).
 */
const LEAN = {
  skills: { include_instructions: false },
  features: { apps: false, plugins: false, tool_suggest: false },
};

/**
 * Drives Codex through `codex app-server` (JSON-RPC over stdio). One server
 * process hosts every thread; it is started on demand and stopped when idle.
 */
export class CodexAdapter implements Adapter {
  limits: CodexLimits | null = null;
  onLimits: (limits: CodexLimits) => void = () => {};

  private peer: RpcPeer | null = null;
  private starting: Promise<RpcPeer> | null = null;
  private runs = new Map<string, Run>();
  /** Sub-agent thread id -> run of the thread that spawned it. */
  private children = new Map<string, Run>();
  /** Threads the current server process has in memory. */
  private loaded = new Set<string>();
  private lastUsed = Date.now();
  private lastTidy = 0;
  /** Threads a reply is resuming, which `tidy` must leave alone until they are loaded. Counted: see `hold`. */
  private resuming = new Map<string, number>();
  /** Jobs whose thread Codex is still starting or resuming, which can take minutes; `probe` vouches for them. Counted. */
  private opening = new Map<string, number>();
  /** Threads whose Crew tools Codex could not start, and why. Codex may say so before the thread has a run to tell. */
  private toolFailures = new Map<string, string>();
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    setInterval(() => {
      const busy = [...this.runs.values()].some((run) => !isTerminal(run.ctl.job));
      if (this.peer && !busy && Date.now() - this.lastUsed > IDLE_SHUTDOWN_MS) this.peer.close();
    }, 60_000).unref();
  }

  async start(ctl: JobCtl): Promise<void> {
    const opened = await this.open(ctl).finally(hold(this.opening, ctl.job.id));
    if (!opened || isTerminal(ctl.job)) return;
    const { peer, params, res } = opened;
    const threadId: string = res.thread.id;
    const run = this.openRun(ctl, threadId, params.config.features.plugins);
    this.loaded.add(threadId);
    ctl.session(threadId);
    // Native reviews do not use turn/start's effort override.
    const effort = ctl.job.nativeReview ? res.reasoningEffort : ctl.job.effort ?? this.config.codex.effort ?? res.reasoningEffort;
    ctl.model(res.model ?? res.thread.model ?? ctl.job.model ?? this.config.codex.model, effort ?? undefined);
    // Makes the thread recognizable in the Codex app and `codex resume`.
    peer.request('thread/name/set', { threadId, name: `Crew · ${ctl.job.title}` }, RPC_TIMEOUT_MS).catch(() => {});

    if (ctl.job.nativeReview) {
      const target = ctl.job.nativeReview;
      await this.sendTurn(peer, run, 'review/start', { threadId, target: target.type === 'commit' ? { ...target, title: null } : target });
    } else {
      await this.startTurn(peer, run, ctl.job.prompt);
    }
  }

  /** Launches the server if needed and starts the job's thread. */
  private async open(ctl: JobCtl) {
    const peer = await this.ensure();
    if (isTerminal(ctl.job)) return null;
    const params = await this.threadParams(ctl, peer);
    ctl.capabilities(capabilitiesOf(ctl.job, params));
    return { peer, params, res: await peer.request('thread/start', params, THREAD_TIMEOUT_MS) };
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    // Starting the server, reading the settings or a resume can outlast a cancel and the next reply; only the turn
    // that asked may go on to send its message.
    const turn = ctl.job.turns;
    const peer = await this.ensure();
    if (ctl.job.turns !== turn) return;
    const threadId = ctl.job.sessionId!;
    let pluginsEnabled = this.runs.get(threadId)?.pluginsEnabled ?? false;
    if (!this.loaded.has(threadId)) {
      const params = await this.threadParams(ctl, peer);
      if (ctl.job.turns !== turn) return;
      ctl.capabilities(capabilitiesOf(ctl.job, params));
      const resume = () => peer.request('thread/resume', { threadId, ...params, excludeTurns: true }, THREAD_TIMEOUT_MS);
      const loaded = hold(this.resuming, threadId);
      const opened = hold(this.opening, ctl.job.id);
      // `tidy` archives a worker's thread after a week; a reply to that job brings it back.
      const res = await resume().catch(async (err) => {
        if (!/^session \S+ is archived\b/.test(String(err?.message))) throw err;
        await peer.request('thread/unarchive', { threadId }, RPC_TIMEOUT_MS).catch((failed) => {
          throw new Error(`${err.message} Unarchiving it failed: ${failed?.message ?? failed}`, { cause: failed });
        });
        return resume();
      }).finally(() => {
        loaded();
        opened();
      });
      this.loaded.add(threadId);
      if (ctl.job.turns !== turn) return;
      pluginsEnabled = params.config.features.plugins;
      ctl.model(res.model ?? res.thread?.model ?? ctl.job.model ?? this.config.codex.model, ctl.job.effort ?? this.config.codex.effort ?? res.reasoningEffort ?? undefined);
    }
    if (isTerminal(ctl.job)) return;
    const run = this.runs.get(threadId) ?? this.openRun(ctl, threadId);
    run.pluginsEnabled = pluginsEnabled;
    if (run.awaitingTurn || run.interrupt) throw new Error('Codex has not confirmed the turn status. Check the job before sending another message.');
    // The turn is over, so there is nothing to steer, and a new turn would be ended by the old sub-agents' completion.
    if (run.held) throw new Error(`Codex finished its turn and is waiting for ${run.busyChildren.size} sub-agent(s). Send the message once the job ends, or cancel it.`);
    if (run.turnId) {
      await peer.request('turn/steer', { threadId, input: [textInput(message)], expectedTurnId: run.turnId }, RPC_TIMEOUT_MS);
    } else {
      await this.startTurn(peer, run, message);
    }
  }

  async answer(ctl: JobCtl, approve: boolean, message?: string, opts?: { forJob?: boolean; by?: 'lead' }): Promise<void> {
    const threadId = ctl.job.sessionId ?? '';
    const run = this.runs.get(threadId);
    const request = run?.pending[0];
    if (!run || !request) throw new Error('The request this job was waiting on is no longer pending.');
    if (opts?.forJob && !request.grant) throw new Error('This request cannot be allowed for the whole job. Approve or deny it.');
    if (request.type === 'approval' && !approve) {
      if (opts?.by === 'lead') {
        const note = noteLeadDecline(ctl, request.reason, message!.trim());
        const requestedTurn = request.turnId ?? run.busyChildren.get(request.threadId);
        // The parent can act on the reason when the sub-agent's turn is unknown.
        const turnId = requestedTurn ?? run.turnId;
        const peer = this.peer;
        const undelivered = (detail: string) => ctl.note(`The lead's reason did not reach the worker (${detail}). Send it with reply as a message once the turn ends.`);
        if (peer && turnId) {
          // Approval responses carry no text. Write the steer first, release the refusal without waiting, and
          // retry after the refusal if Codex rejected the steer while the approval was open.
          const steer = () => peer.request('turn/steer', { threadId: requestedTurn ? request.threadId : threadId, input: [textInput(note)], expectedTurnId: turnId }, RPC_TIMEOUT_MS);
          void steer().catch(steer).catch((err) => undelivered(err.message));
        } else undelivered(peer ? 'no confirmed turn to steer' : 'the Codex connection is closed');
      } else ctl.note(`The user declined an action: ${request.reason}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    }
    this.settleRequest(run, 0, { approve, message, forJob: opts?.forJob });
  }

  async cancel(ctl: JobCtl): Promise<void> {
    const threadId = ctl.job.sessionId;
    const run = threadId ? this.runs.get(threadId) : undefined;
    if (!run) return;
    if (run.held) return this.stopChildren(run);
    if (run.awaitingTurn) throw new Error('Codex has not confirmed the start of the turn. The job is still active.');
    if (!run.turnId || !this.peer) return;
    if (run.interrupt) throw new Error('Cancellation is already in progress.');
    const interrupt = Promise.withResolvers<void>();
    run.interrupt = interrupt;
    for (const request of run.pending.splice(0)) request.resolve({ approve: false, cancelled: true });
    run.ctl.resumed();
    try {
      const ended = interrupt.promise.then(() => true);
      // Codex does not promise to pass the interrupt on; a sub-agent left running would keep editing the worktree.
      this.interruptChildren(run);
      const ack = this.peer.request('turn/interrupt', { threadId, turnId: run.turnId }, RPC_TIMEOUT_MS);
      const stopped = await Promise.race([ended, ack.then(() => ended), delay(5_000, false, { ref: false })]);
      if (!stopped) throw new Error('Codex did not confirm cancellation. The job is still active.');
    } finally {
      run.interrupt = null;
    }
  }

  /** Interrupts every sub-agent turn still in flight, without waiting for Codex to confirm. */
  private interruptChildren(run: Run): void {
    const peer = this.peer;
    if (!peer) return;
    for (const [threadId, turnId] of run.busyChildren) {
      if (turnId) peer.request('turn/interrupt', { threadId, turnId }, RPC_TIMEOUT_MS).catch(() => {});
    }
  }

  /** Cancels a job whose own turn is over but whose sub-agents still work: interrupts each, so none edits after the job ends. */
  private async stopChildren(run: Run): Promise<void> {
    const peer = this.peer;
    const children = [...run.busyChildren];
    run.held = null;
    for (const threadId of run.busyChildren.keys()) this.childSettled(run, threadId);
    for (const request of run.pending.splice(0)) request.resolve({ approve: false, cancelled: true });
    if (!peer) return;
    const acks = children.filter(([, turnId]) => turnId).map(([threadId, turnId]) => peer.request('turn/interrupt', { threadId, turnId }, RPC_TIMEOUT_MS));
    const settled = await Promise.race([Promise.allSettled(acks).then(() => true), delay(5_000, false, { ref: false })]);
    if (!settled || children.some(([, turnId]) => !turnId)) run.ctl.note('Cancelled while sub-agents were still working; not every one confirmed it stopped. Check the worktree before reusing it.');
  }

  /**
   * Reads the thread's runtime status for a silent job. Sub-agents come first: one whose turn ended unheard would
   * hold the parent's completion forever. A thread found not active is read again after a pause, so a completion
   * still on its way is not mistaken for a lost one.
   */
  async probe(ctl: JobCtl): Promise<Probe> {
    const threadId = ctl.job.sessionId;
    const run = threadId ? this.runs.get(threadId) : undefined;
    const peer = this.peer;
    // Starting and resuming a thread have their own, longer timeout.
    if (this.opening.has(ctl.job.id)) return { verdict: 'working', detail: 'Codex has yet to open the thread' };
    if (!threadId || !run) return { verdict: 'ended', detail: 'Codex holds no session for this job, so its end will never arrive. Reply to resume it, or cancel it.' };
    if (!peer?.alive) return { verdict: 'ended', detail: 'codex app-server is no longer running. Reply to resume the job, or cancel it.' };
    // Starting and interrupting a turn have their own timeouts.
    if (run.awaitingTurn || run.interrupt) return { verdict: 'working', detail: 'Codex has yet to confirm the turn' };
    const read = async (id: string) => (await peer.request('thread/read', { threadId: id, includeTurns: false }, PROBE_TIMEOUT_MS))?.thread?.status;
    const settled = async (id: string) => {
      const first = await read(id);
      if (first?.type === 'active') return first;
      await delay(PROBE_CONFIRM_MS, undefined, { ref: false });
      return read(id);
    };
    // Any activity since the check began, including a sub-agent's new turn, makes its answers stale.
    const since = ctl.job.activeAt;
    const stale = () => ctl.job.activeAt !== since || ctl.job.state !== 'running';
    for (const [child, childTurn] of [...run.busyChildren]) {
      if ((await settled(child))?.type === 'active') continue;
      if (stale() || !run.busyChildren.has(child) || run.busyChildren.get(child) !== childTurn) continue;
      for (const key of run.items.keys()) if (key.startsWith(`${child}\0`)) run.items.delete(key);
      ctl.note(`A sub-agent's turn ended without the bridge hearing of it; it no longer holds the job.`);
      this.childSettled(run, child);
    }
    if (stale()) return { verdict: 'working', detail: 'settled during the status check' };
    if (run.busyChildren.size) return { verdict: 'working', detail: `Codex reports ${run.busyChildren.size} sub-agent(s) still working` };
    const turnId = run.turnId;
    const status = await settled(threadId);
    if (run.turnId !== turnId || stale()) return { verdict: 'working', detail: 'settled during the status check' };
    if (status?.type === 'active') {
      return status.activeFlags?.length
        ? { verdict: 'unknown', detail: `Codex is ${status.activeFlags.join(', ')}, but the bridge never received that request` }
        : { verdict: 'working', detail: 'Codex reports the turn still in progress' };
    }
    if (!status?.type) return { verdict: 'unknown', detail: 'Codex did not report the thread status' };
    if (turnId) (run.ended ??= new Set()).add(`${threadId}\0${turnId}`);
    run.turnId = null;
    return { verdict: 'ended', detail: `Codex's thread is ${status.type}, but the bridge never received the end of its turn. The work may be finished: reply to have it report, or check the worktree.` };
  }

  async release(ctl: JobCtl): Promise<void> {
    const threadId = ctl.job.sessionId;
    const peer = this.peer;
    if (!threadId || !peer || !this.loaded.has(threadId)) return;
    const run = this.runs.get(threadId);
    const threads = [...this.children].filter(([, owner]) => owner === run).map(([id]) => id);
    for (const id of [...threads, threadId]) {
      // Unsubscribe schedules an idle unload; it does not guarantee immediate handle release.
      await peer.request('thread/unsubscribe', { threadId: id }, 5_000);
      this.loaded.delete(id);
      this.children.delete(id);
    }
    this.runs.delete(threadId);
  }

  shutdown(): void {
    this.peer?.close();
  }

  /**
   * `LEAN`, with the job's requested plugins enabled. Because Codex can only switch plugins on as a whole,
   * every other installed plugin is disabled by id.
   */
  private async lean(ctl: JobCtl, peer: RpcPeer) {
    const wanted = ctl.job.plugins ?? [];
    if (!wanted.length) return LEAN;
    // Re-queried on each start or resume in case installed plugins or user settings changed.
    // If Codex cannot list its plugins, the job still runs without them.
    const installed: { id: string; enabled: boolean }[] = await peer.request('plugin/installed', { cwds: [ctl.job.cwd] }, RPC_TIMEOUT_MS)
      .then((res) => ((res.marketplaces ?? []) as any[]).flatMap((marketplace) => ((marketplace.plugins ?? []) as any[])
        .filter((plugin) => plugin.installed).map((plugin) => ({ id: plugin.id, enabled: plugin.enabled === true }))))
      .catch(() => []);
    const named = (id: string, name: string) => id === name || id.startsWith(`${name}@`);
    // Configured defaults need not be installed; only the lead's explicit requests warrant a note.
    const explicit = ctl.job.requestedPlugins ?? wanted.filter((name) => !this.config.codex.plugins.includes(name) && (!ctl.job.runsApp || !this.config.codex.appPlugins.includes(name)));
    const missing = explicit.filter((name) => !installed.some((plugin) => named(plugin.id, name)));
    if (missing.length) ctl.note(`Codex has no plugin named ${missing.join(', ')}; the job runs without it.`);
    const disabled = explicit.filter((name) => installed.some((plugin) => named(plugin.id, name)) && !installed.some((plugin) => plugin.enabled && named(plugin.id, name)));
    if (disabled.length) ctl.note(`Codex has plugin ${disabled.join(', ')}, but the user has it off; the job runs without it.`);
    if (!installed.some((plugin) => plugin.enabled && wanted.some((name) => named(plugin.id, name)))) return LEAN;
    return {
      // Codex 0.167's include_instructions hides the entire skill catalog, including plugin skills.
      // Keep it on here so enabled plugins remain usable; it cannot suppress only user skills.
      features: { ...LEAN.features, plugins: true },
      // Inventory can omit a marketplace or precede a remote install; do not inherit enablement for unseen plugins.
      plugins: { _default: { enabled: false }, ...Object.fromEntries(installed.map((plugin) => [plugin.id, { enabled: plugin.enabled && wanted.some((name) => named(plugin.id, name)) }])) },
    };
  }

  private async threadParams(ctl: JobCtl, peer: RpcPeer) {
    const { job } = ctl;
    const lean = await this.lean(ctl, peer);
    // Read-only with one writable directory is not a sandbox mode; it is a permissions profile, which replaces the mode.
    // Each profile also denies the daemon's token file. A job with the network open could otherwise read it and
    // call the daemon as the user. Plugin tools also act outside the sandbox, so plugin jobs need the deny too.
    const secret = { [tokenFile(HOME)]: 'deny' };
    // Evidence outlives the turn, so it is a directory of its own, writable in every profile.
    const evidence = job.evidenceDir ? { [job.evidenceDir]: 'write' } : {};
    const scratch = job.sandbox === 'read-only' && job.scratch
      ? {
          default_permissions: 'crew_read_only',
          permissions: { crew_read_only: { filesystem: { ':root': 'read', [job.scratch]: 'write', ...evidence, ...secret } } },
        }
      : null;
    // Shared targets need explicit read rules even when they live under a writable temp root.
    const shared = Object.fromEntries((job.worktree?.linked ?? []).flatMap((dir) => {
      const link = path.join(job.cwd, dir);
      try {
        return [[realpathSync(link), 'read'], [link, 'read']];
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        return [[link, 'read']];
      }
    }));
    const profile = job.runsApp ? 'crew_app' : 'crew_workspace';
    // Commands get the scratch directory as their temp directory, so the system's is left out. Codex would resolve
    // it to the server's own TEMP, the user's whole temp folder, and on Windows grant write on it by an inherited ACL
    // over every file there: minutes on a full folder, during which thread/start does not answer.
    const app = (job.runsApp || lean.features.plugins || Object.keys(shared).length > 0) && job.sandbox === 'workspace-write'
      ? {
          default_permissions: profile,
          permissions: { [profile]: { filesystem: { ':root': 'read', [job.cwd]: 'write', [path.join(job.cwd, '.git')]: 'read', ':slash_tmp': 'write', ...(job.scratch ? { [job.scratch]: 'write' } : {}), ...evidence, ...shared, ...secret }, network: { enabled: Boolean(job.runsApp) } } },
        }
      : null;
    return {
      cwd: job.cwd,
      sandbox: scratch || app ? null : job.sandbox,
      // A read-only job (a static review, a question) must never block on a prompt, and has nothing to approve.
      approvalPolicy: job.sandbox === 'read-only' ? 'never' : this.config.codex.approvalPolicy,
      approvalsReviewer: this.reviewer(job),
      config: { ...(app ?? scratch),
      ...(job.scratch ? {
        shell_environment_policy: { set: { TMPDIR: job.scratch, TMP: job.scratch, TEMP: job.scratch } },
        ...(!app && !scratch ? { sandbox_workspace_write: { writable_roots: [job.scratch, ...Object.keys(evidence)], exclude_tmpdir_env_var: true } } : {}),
      } : {}), // Its three tools only talk to the bridge. Without this a job with approval policy "never" (a review, a question)
      // is refused the call outright, and any other job would stop to ask.
      mcp_servers: { crew: { ...ctl.mcp, default_tools_approval_mode: 'approve' } },
      ...lean },
      developerInstructions: lean.features.plugins && !job.nativeReview ? `${job.instructions}\n\n${PLUGIN_USER_APP}` : job.instructions,
      model: job.model ?? (job.agentDefault ? null : this.config.codex.model) ?? null,
    };
  }

  private reviewer(job: Job) {
    return job.asksUser ? 'user' : this.config.codex.approvalsReviewer;
  }

  private openRun(ctl: JobCtl, threadId: string, pluginsEnabled = false): Run {
    const run: Run = { ctl, pluginsEnabled, turnId: null, awaitingTurn: null, interrupt: null, message: '', pending: [], crewCalls: new Set(), items: new Map(), busyChildren: new Map(), held: null, grants: new Set(), toolsDown: false };
    this.runs.set(threadId, run);
    this.noteToolFailure(threadId);
    return run;
  }

  /**
   * A worker whose Crew server failed to start works on without `ask_lead` and the rest, and says nothing: it
   * cannot tell a tool that is missing from one it was never given. Only Codex's startup status shows it.
   */
  private noteToolFailure(threadId: string): void {
    const run = this.runs.get(threadId);
    const error = this.toolFailures.get(threadId);
    if (!run || error === undefined || run.toolsDown) return;
    run.toolsDown = true;
    const note = `Crew's worker tools did not start for this job (${error}). The worker cannot ask you questions (ask_lead), see other jobs, or start the bridge's browser, so do not wait for its questions, and read its report for what it could not check. If the next job says the same, restart Crew.`;
    run.ctl.note(note);
    run.ctl.progress(note);
  }

  private startTurn(peer: RpcPeer, run: Run, text: string): Promise<void> {
    const { job } = run.ctl;
    return this.sendTurn(peer, run, 'turn/start', {
      threadId: job.sessionId,
      input: [textInput(text)],
      effort: job.effort ?? this.config.codex.effort ?? null,
      // Sent with every turn: an override stays on the thread until the next one replaces it.
      approvalsReviewer: this.reviewer(job),
    });
  }

  private async sendTurn(peer: RpcPeer, run: Run, method: string, params: unknown): Promise<void> {
    run.held = null;
    run.message = '';
    run.items.clear();
    const start = Symbol(method);
    run.awaitingTurn = start;
    try {
      const res = await peer.request(method, params, RPC_TIMEOUT_MS);
      if (run.awaitingTurn === start) {
        run.turnId = res.turn.id;
        run.awaitingTurn = null;
      }
    } catch (err) {
      if (run.awaitingTurn !== start) return;
      run.awaitingTurn = null;
      if (err instanceof RpcTimeoutError) {
        // A retry could start a second turn after one whose acknowledgement was lost.
        run.ctl.fail(`${err.message}. The turn may have started anyway; check the worker session (resume command) before retrying.`);
        return;
      }
      throw err;
    }
  }

  private ensure(): Promise<RpcPeer> {
    this.lastUsed = Date.now();
    if (this.starting) return this.starting;
    if (this.peer?.alive) return Promise.resolve(this.peer);
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<RpcPeer> {
    const env = agentEnv();
    const { bin, args, shell } = agentCommand(this.config.codex.bin, ['app-server'], env);
    const child = spawn(bin, args, { env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const peer = new RpcPeer(child, {
      // A start acknowledgement and the next event can share a read. Dispatch both in wire order with the RPC continuations.
      onNotification: (method, params) => queueMicrotask(() => this.onNotification(method, params)),
      onRequest: (method, params, id) => Promise.resolve().then(() => this.onRequest(method, params, id)),
      onExit: (reason) => {
        if (this.peer === peer) this.peer = null;
        this.loaded.clear();
        this.children.clear();
        this.toolFailures.clear();
        for (const run of this.runs.values()) {
          run.turnId = null;
          run.interrupt?.resolve();
          for (const request of run.pending.splice(0)) request.resolve(null);
          run.ctl.fail(`codex app-server ${reason}`);
        }
        this.runs.clear();
      },
    }, shell);
    this.peer = peer;
    await peer.initialize({ clientInfo: { name: 'crew', title: 'Crew', version: VERSION }, capabilities: null });
    peer.notify('initialized');
    peer.request('account/rateLimits/read', undefined, RPC_TIMEOUT_MS).then((res) => this.setLimits(res.rateLimits), () => {});
    void this.tidy(peer);
    return peer;
  }

  /**
   * Archives the threads of workers that have been quiet for a week. Codex's apps list threads by working
   * directory, so every worktree shows as a project of its own and the list fills with finished jobs.
   * An archived thread stays readable in Codex, and `reply` unarchives it. Best effort, at most once a day.
   */
  private async tidy(peer: RpcPeer, now = Date.now()): Promise<void> {
    const last = this.lastTidy;
    if (now - last < TIDY_EVERY_MS) return;
    this.lastTidy = now;
    const cutoff = (now - STALE_THREAD_MS) / 1000;
    try {
      const stale: string[] = [];
      let cursor: string | null = null;
      // Oldest first, so the listing can stop at the first thread that is still recent.
      list: do {
        const page: any = await peer.request('thread/list', { archived: false, cursor, limit: 100, sortKey: 'updated_at', sortDirection: 'asc', useStateDbOnly: true }, RPC_TIMEOUT_MS);
        for (const thread of (page?.data ?? []) as any[]) {
          if (typeof thread?.updatedAt !== 'number' || thread.updatedAt > cutoff) break list;
          if (thread.originator === 'crew' && typeof thread.cwd === 'string' && WORKER_CWD.test(thread.cwd)) stale.push(thread.id);
        }
        cursor = typeof page?.nextCursor === 'string' ? page.nextCursor : null;
      } while (cursor);
      for (const threadId of stale) {
        if (this.peer !== peer) break;
        // Codex refuses a thread another client has open; it is tried again on a later day.
        if (!this.runs.has(threadId) && !this.loaded.has(threadId) && !this.resuming.has(threadId)) await peer.request('thread/archive', { threadId }, RPC_TIMEOUT_MS).catch(() => {});
      }
    } catch {
      // A listing that failed is tried again at the next start instead of a day later.
      this.lastTidy = last;
    }
  }

  private setLimits(snapshot: any): void {
    if (!snapshot) return;
    const windows = [snapshot.primary, snapshot.secondary]
      .filter(Boolean)
      .map((w: any) => ({ minutes: w.windowDurationMins, usedPercent: w.usedPercent, resetsAt: w.resetsAt }));
    // Rolling updates are sparse: keep the previous value for anything they omit.
    this.limits = {
      plan: snapshot.planType ?? this.limits?.plan ?? null,
      windows: windows.length ? windows : (this.limits?.windows ?? []),
      reached: Boolean(snapshot.rateLimitReachedType),
    };
    this.onLimits(this.limits);
  }

  private onNotification(method: string, p: any): void {
    if (method === 'account/rateLimits/updated') return this.setLimits(p.rateLimits);
    if (method === 'thread/started' && p.thread?.parentThreadId) {
      const parent = this.runs.get(p.thread.parentThreadId) ?? this.children.get(p.thread.parentThreadId);
      if (parent) this.children.set(p.thread.id, parent);
      return;
    }
    const threadId: string | undefined = p?.threadId;
    if (!threadId) return;
    if (method === 'mcpServer/startupStatus/updated') {
      if (p.name !== 'crew') return;
      if (p.status === 'failed') {
        this.toolFailures.set(threadId, detail((typeof p.error === 'string' && p.error.trim()) || 'no reason given', 300));
        this.noteToolFailure(threadId);
      } else if (p.status === 'ready') this.toolFailures.delete(threadId);
      return;
    }
    if (method === 'thread/closed') this.toolFailures.delete(threadId);
    const run = this.runs.get(threadId);
    const owner = run ?? this.children.get(threadId);
    const id = p.turn?.id ?? p.turnId;
    if (id && owner) {
      const confirmed = run ? run.turnId : owner.busyChildren.get(threadId);
      const key = `${threadId}\0${id}`;
      if (id !== confirmed && owner.ended?.has(key)) {
        // Cumulative thread usage can arrive after its turn completes.
        if (method !== 'thread/tokenUsage/updated') return;
      } else if (confirmed && id !== confirmed) {
        if (run || method !== 'turn/started') return;
        // A child can start its next turn before Crew hears the previous completion.
        (owner.ended ??= new Set()).add(`${threadId}\0${confirmed}`);
      }
      if (method === 'turn/completed') (owner.ended ??= new Set()).add(key);
    }
    if (method === 'thread/closed' || (!run && method === 'turn/started')) {
      for (const [key, item] of owner?.items ?? []) {
        if (key.startsWith(`${threadId}\0`) && (method === 'thread/closed' || item.turnId !== id)) owner?.items.delete(key);
      }
    }
    if (method === 'item/started' && owner && ['mcpToolCall', 'fileChange'].includes(p.item?.type)) {
      const item = p.item;
      owner.items.set(`${threadId}\0${item.id}`, {
        type: item.type, turnId: p.turnId, server: item.server, tool: item.tool,
        input: item.type === 'mcpToolCall' ? inputText(item.arguments) : undefined,
        files: item.type === 'fileChange' ? fileList(item.changes) : undefined,
      });
    }
    if (method === 'thread/closed') {
      const owner = this.children.get(threadId);
      if (owner) {
        this.childSettled(owner, threadId);
        for (let index = owner.pending.length - 1; index >= 0; index--) {
          if (owner.pending[index].threadId === threadId) this.settleRequest(owner, index, null);
        }
        this.children.delete(threadId);
        return;
      }
    }
    if (method === 'serverRequest/resolved') {
      const owner = this.runs.get(threadId) ?? this.children.get(threadId);
      const index = owner?.pending.findIndex((request) => request.threadId === threadId && request.id === p.requestId) ?? -1;
      if (owner && index >= 0) this.settleRequest(owner, index, null);
      return;
    }
    if (method === 'item/autoApprovalReview/completed') {
      // An aborted review ended with its turn; only a verdict against the action is a refusal.
      const status = p.review?.status;
      if (status === 'denied' || status === 'timedOut') {
        const reason = detail(p.review.rationale?.trim() || (status === 'timedOut' ? 'the review timed out; no reason given' : 'no reason given'), 2000);
        owner?.ctl.refused(reviewedAction(p.action, this.itemDetails(owner, p)), reason);
      }
      return;
    }
    if (!run) {
      // Sub-agent work only proves the job is alive; its turns must not end the parent job.
      if (method === 'turn/started') owner?.busyChildren.set(threadId, p.turn?.id ?? null);
      if (method === 'turn/completed') {
        for (const key of owner?.items.keys() ?? []) if (key.startsWith(`${threadId}\0`)) owner?.items.delete(key);
        if (owner) this.childSettled(owner, threadId);
      }
      this.children.get(threadId)?.ctl.activity();
      return;
    }
    const { ctl } = run;
    this.lastUsed = Date.now();

    switch (method) {
      case 'turn/started':
        run.turnId = p.turn.id;
        run.awaitingTurn = null;
        ctl.phase('working');
        break;
      case 'item/started':
        if (p.item.type === 'mcpToolCall' && p.item.server === 'crew' && CREW_TOOLS.includes(p.item.tool)) run.crewCalls.add(p.item.id);
        this.onItemStarted(ctl, p.item);
        break;
      case 'item/completed':
        run.crewCalls.delete(p.item.id);
        this.onItemCompleted(run, p.item);
        break;
      case 'turn/plan/updated': {
        const step = p.plan?.find((s: any) => s.status === 'inProgress');
        if (step) ctl.phase(step.step);
        break;
      }
      case 'thread/tokenUsage/updated':
        if (p.tokenUsage.total.totalTokens < (ctl.job.tokens ?? 0)) break;
        ctl.tokens(p.tokenUsage.total.totalTokens, {
          input: p.tokenUsage.total.inputTokens ?? 0,
          cachedInput: p.tokenUsage.total.cachedInputTokens ?? 0,
          output: p.tokenUsage.total.outputTokens ?? 0,
        });
        // The latest request holds the whole context, so its size is how full the window is.
        if (p.tokenUsage.modelContextWindow) ctl.context(p.tokenUsage.last?.totalTokens ?? 0, p.tokenUsage.modelContextWindow);
        break;
      case 'turn/diff/updated':
        if (p.turnId) ctl.diff(p.diff);
        break;
      case 'model/rerouted':
        // The rest of the turn runs on the other model, so scores and ratings must name that one.
        if (p.toModel) {
          ctl.model(p.toModel, ctl.job.resolvedEffort);
          ctl.note(`Codex moved this job from ${p.fromModel ?? 'its model'} to ${p.toModel}${p.reason ? ` (${p.reason})` : ''}.`);
        }
        break;
      case 'error':
        if (p.willRetry) ctl.progress(`retrying: ${p.error.message}`);
        break;
      case 'turn/completed': {
        run.awaitingTurn = null;
        run.turnId = null;
        if (run.busyChildren.size && p.turn?.status === 'completed' && !run.interrupt) {
          // Collecting the result now would miss what a sub-agent still writes.
          run.held = p;
          ctl.phase(`waiting for ${run.busyChildren.size} sub-agent(s) to finish`);
          break;
        }
        this.endTurn(run, p);
        break;
      }
      default:
        // Streaming deltas and other chatter: proof of life, nothing to log.
        ctl.activity();
    }
  }

  /** A sub-agent's turn ended; a parent completion held for it goes ahead once none is left. */
  private childSettled(run: Run, threadId: string): void {
    const turnId = run.busyChildren.get(threadId);
    if (turnId) (run.ended ??= new Set()).add(`${threadId}\0${turnId}`);
    run.busyChildren.delete(threadId);
    if (run.held && run.busyChildren.size === 0) {
      const held = run.held;
      run.held = null;
      this.endTurn(run, held);
    }
  }

  private endTurn(run: Run, p: any): void {
    const { ctl } = run;
    run.held = null;
    run.crewCalls.clear();
    run.items.clear();
    for (const request of run.pending.splice(0)) request.resolve(null);
    // A failed or interrupted parent ends the job at once, so its sub-agents must not go on editing.
    if (p.turn?.status !== 'completed' || run.interrupt) {
      this.interruptChildren(run);
      for (const threadId of run.busyChildren.keys()) this.childSettled(run, threadId);
    }
    const report = run.message;
    run.message = '';
    const turn = p.turn;
    if (run.interrupt || turn.status === 'interrupted') ctl.cancelled();
    else if (turn.status === 'completed') ctl.done(report);
    else {
      const info = turn.error?.codexErrorInfo;
      const message = turn.error?.message ?? 'turn failed';
      // Not a fault in the work: the reviewer's refusals ended it, and they are listed with the job.
      if (info === 'tooManyDenials') {
        const listed = ctl.job.refusals?.some((refusal) => refusal.turn === ctl.job.turns);
        ctl.fail(`Codex stopped the turn after too many of its actions were refused (${message}).${listed ? ' The refused actions are listed with the job.' : ''}`);
      }
      else ctl.fail(message, { limit: typeof info === 'string' && LIMIT_ERRORS.includes(info) });
    }
    run.interrupt?.resolve();
  }

  private onItemStarted(ctl: JobCtl, item: any): void {
    switch (item.type) {
      case 'commandExecution':
        return ctl.progress(`$ ${shortCommand(item.command)}`);
      case 'fileChange':
        return ctl.progress(`editing ${item.changes.map((c: any) => basename(c.path)).join(', ') || 'files'}`);
      case 'mcpToolCall':
        return ctl.progress(`tool ${item.server}.${item.tool}`);
      case 'webSearch':
        return ctl.progress('searching the web');
      case 'collabAgentToolCall':
        return ctl.progress(`sub-agent: ${item.tool}`);
      case 'contextCompaction':
        return ctl.progress('compacting context');
      case 'enteredReviewMode':
        return ctl.progress('reviewing');
      case 'reasoning':
        return ctl.phase('thinking');
      case 'agentMessage':
        return ctl.phase('writing');
      default:
        ctl.activity();
    }
  }

  private onItemCompleted(run: Run, item: any): void {
    const { ctl } = run;
    switch (item.type) {
      case 'agentMessage':
        if (!item.text) break;
        if (item.phase === 'commentary') ctl.progress(firstLine(item.text));
        else run.message = item.text;
        break;
      case 'exitedReviewMode':
        run.message = item.review;
        break;
      case 'fileChange':
        if (item.status === 'completed') for (const change of item.changes) ctl.touched(change.path);
        break;
      case 'commandExecution':
        if (item.exitCode) ctl.progress(`exit ${item.exitCode}: ${shortCommand(item.command)}`);
        break;
    }
    ctl.activity();
  }

  private settleRequest(run: Run, index: number, answer: Answer | null): void {
    const [request] = run.pending.splice(index, 1);
    request.resolve(answer);
    let head = index === 0;
    if (answer?.forJob && request.grant) {
      run.grants.add(request.grant.key);
      run.ctl.progress(`allowed for this job: ${request.grant.label}`);
      // Requests already queued for the same target are covered by the same grant.
      for (let i = run.pending.length - 1; i >= 0; i--) {
        const queued = run.pending[i];
        if (queued.grant?.key !== request.grant.key) continue;
        run.pending.splice(i, 1);
        queued.resolve({ approve: true });
        if (i === 0) head = true;
      }
    }
    if (!head) return;
    const next = run.pending[0];
    if (next) run.ctl.waiting(next.type, next.reason, next.grant?.label);
    else run.ctl.resumed();
  }

  private itemDetails(run: Run | undefined, params: any): ItemDetails | undefined {
    const item = run?.items.get(`${params.threadId}\0${params.targetItemId ?? params.itemId}`);
    return item && (!item.turnId || !params.turnId || item.turnId === params.turnId) ? item : undefined;
  }

  private async onRequest(method: string, p: any, id: string | number): Promise<unknown> {
    const threadId = p?.threadId;
    const run = this.runs.get(threadId) ?? this.children.get(threadId);
    const item = this.itemDetails(run, p);
    const ask = (type: 'approval' | 'question', reason: string, grant?: Grant) => {
      reason = detail(reason, 8000);
      if (!run || isTerminal(run.ctl.job)) return Promise.resolve<Answer>({ approve: false });
      if (run.interrupt) return Promise.resolve<Answer>({ approve: false, cancelled: true });
      // Nothing in a read-only job is the user's to allow: a question or a static review that asks to write is declined.
      if (type === 'approval' && run.ctl.job.sandbox === 'read-only') {
        run.ctl.note(`Declined in a read-only job: ${reason}\nDo it another way using the scratch directory, or report what could not be verified.`, { declined: true });
        return Promise.resolve<Answer>({ approve: false });
      }
      if (this.children.has(threadId)) reason = `Sub-agent request\n${reason}`;
      return new Promise<Answer | null>((resolve) => {
        run.pending.push({ id, threadId, turnId: p.turnId ?? item?.turnId, type, reason, grant, resolve });
        if (run.pending.length === 1) run.ctl.waiting(type, reason, grant?.label);
      });
    };
    const why = p?.reason ? `\nReason: ${detail(p.reason, 2000)}` : '';

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const deny = p.availableDecisions && !p.availableDecisions.includes('decline') ? 'cancel' : 'decline';
        const command = p.command ? `Run:\n${reviewedAction({ type: 'command', command: p.command, cwd: p.cwd })}` : '';
        const network = p.networkApprovalContext ? `Network access: ${detail(p.networkApprovalContext.host ?? '(target missing)')} (${detail(p.networkApprovalContext.protocol ?? 'protocol missing')})` : '';
        const permissions = p.additionalPermissions ? `Additional permissions:\n${permissionText(p.additionalPermissions)}` : '';
        const description = detail([command, network, permissions].filter(Boolean).join('\n') + why, 8000);
        if (p.availableDecisions && !p.availableDecisions.includes('accept')) {
          run?.ctl.note(`The bridge declined a command approval that offered no acceptance: ${command || network ? description : `exact action unavailable (input missing)${description ? `\n${description}` : ''}`}. Do it another way or report what could not be verified.`, { declined: true });
          return { decision: deny };
        }
        if (!command && !network) {
          run?.ctl.note(`The bridge declined a command approval that omitted the command (exact action unavailable; input missing).${description ? `\n${description}` : ''} Send a request naming the command, or do it another way.`, { declined: true });
          return { decision: deny };
        }
        const answer = await ask('approval', description);
        if (!answer) return;
        const cancel = !p.availableDecisions || p.availableDecisions.includes('cancel') ? 'cancel' : deny;
        return { decision: answer.cancelled ? cancel : answer.approve ? 'accept' : deny };
      }
      case 'item/fileChange/requestApproval': {
        const answer = await ask('approval', `write files: ${item?.files ?? fileList(p.files)}${p.grantRoot ? `\nGrant root: ${detail(p.grantRoot)}` : ''}${why}`);
        return answer ? { decision: answer.cancelled ? 'cancel' : answer.approve ? 'accept' : 'decline' } : undefined;
      }
      case 'item/permissions/requestApproval': {
        const answer = await ask('approval', `Grant permissions:\n${permissionText(p.permissions)}${why}`);
        if (!answer) return;
        const granted: Record<string, unknown> = {};
        if (answer.approve && p.permissions?.network) granted.network = p.permissions.network;
        if (answer.approve && p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
        return { permissions: granted, scope: 'turn' };
      }
      case 'item/tool/requestUserInput': {
        const questions: any[] = p.questions ?? [];
        if (run && !isTerminal(run.ctl.job) && !run.interrupt && run.crewCalls.has(p.itemId) && questions.length &&
          questions.every((q) => q.id === `mcp_tool_call_approval_${p.itemId}`)) {
          return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: ['Allow'] }])) };
        }
        const answer = await ask('question', questions.map((q) => q.question).join(' / ') || 'the worker asked a question');
        if (!answer) return;
        if (answer.cancelled) return { answers: {} };
        const text = answer.message ?? (answer.approve ? 'Yes.' : 'No.');
        return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [text] }])) };
      }
      case 'mcpServer/elicitation/request':
        if (run && !isTerminal(run.ctl.job) && !run.interrupt && p.serverName === 'crew' &&
          ['form', 'openai/form', 'openaiForm'].includes(p.mode) && p._meta?.codex_approval_kind === 'mcp_tool_call' && CREW_TOOLS.includes(p._meta?.tool_name)) {
          return { action: 'accept', content: {}, _meta: null };
        }
        // Plugin tools ask for approval before running; forward those to the user like commands,
        // and decline requests from other servers when no plugins are enabled.
        if (run?.pluginsEnabled && p._meta?.codex_approval_kind === 'mcp_tool_call') {
          const grant = toolGrant(p);
          if (grant && run.grants.has(grant.key) && !isTerminal(run.ctl.job) && !run.interrupt && run.ctl.job.sandbox !== 'read-only') {
            run.ctl.progress(`${this.children.has(threadId) ? 'sub-agent ' : ''}allowed for this job: ${detail(p._meta?.tool_name ?? 'tool', 200)} · ${grant.label}`);
            return { action: 'accept', content: {}, _meta: null };
          }
          const answer = await ask('approval', toolRequest(p, item), grant);
          if (!answer) return;
          return { action: answer.cancelled ? 'cancel' : answer.approve ? 'accept' : 'decline', content: answer.approve ? {} : null, _meta: null };
        }
        run?.ctl.note(`The bridge declined an unsupported MCP request: ${toolRequest(p, item)}. Use a supported tool or do it another way.`, { declined: true });
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `${method} is not supported by Crew`);
    }
  }
}

/**
 * Marks `key` as held until the returned function runs. A cancelled turn's resume can still be pending when the next
 * turn starts its own for the same job, so each request releases only its own hold and the mark stays while any is left.
 */
function hold(held: Map<string, number>, key: string): () => void {
  held.set(key, (held.get(key) ?? 0) + 1);
  return () => {
    const left = (held.get(key) ?? 1) - 1;
    if (left > 0) held.set(key, left);
    else held.delete(key);
  };
}

/** Bound free-form provider text before putting it in a report or approval prompt. */
function detail(text: string, limit = 4000): string {
  return text.length > limit ? `${clip(text, limit)}… (truncated)` : text;
}

/** Render only tool input; environment fields are never part of an approval display. */
function inputText(input: unknown): string {
  if (input === undefined) return 'input missing';
  let text = '';
  let truncated = false;
  const append = (part: string) => {
    const room = 4000 - text.length;
    text += clip(part, Math.max(0, room));
    if (part.length > room) truncated = true;
  };
  const visit = (value: unknown, label: string, depth: number) => {
    if (truncated) return;
    if (depth > 6) { append(`${label}… (truncated)\n`); return; }
    if (value !== null && typeof value === 'object') {
      const entries = Object.entries(value).filter(([key]) => !/^(?:env(?:s|variables|vars)?|environment(?:variables|vars)?)$/i.test(key.replace(/[_-]/g, '')));
      if (label) append(`${label}\n`);
      if (!entries.length) append('(no arguments)\n');
      for (const [key, child] of entries) {
        if (truncated) break;
        visit(child, `${'  '.repeat(depth)}${key}: `, depth + 1);
      }
    } else append(`${label}${value === '' ? '""' : String(value)}\n`);
  };
  visit(input, '', 0);
  return truncated ? `${text}… (truncated)` : text.slice(0, -1);
}

function fileList(files: any): string {
  if (!Array.isArray(files) || !files.length) return 'exact action unavailable (files missing)';
  return detail(files.slice(0, 100).map((file) => typeof file === 'string' ? file : file.path ?? '(path missing)').join(', ') + (files.length > 100 ? '… (truncated)' : ''));
}

function permissionText(permissions: any): string {
  const lines: string[] = [];
  if (permissions?.network?.enabled !== undefined) lines.push(`Network: ${permissions.network.enabled ? 'enabled' : 'disabled'}`);
  const files = permissions?.fileSystem;
  for (const access of ['read', 'write']) {
    if (files?.[access]?.length) lines.push(`${access} paths: ${fileList(files[access])}`);
  }
  for (const entry of (files?.entries ?? []).slice(0, 100)) {
    const target = entry.path;
    lines.push(`${detail(entry.access ?? '(access missing)')}: ${detail(target?.path ?? target?.pattern ?? target?.value?.kind ?? '(path missing)')}${target?.value?.subpath ? `/${detail(target.value.subpath)}` : ''}`);
  }
  if (files?.entries?.length > 100) lines.push('… (truncated)');
  if (files?.globScanMaxDepth !== undefined) lines.push(`Glob scan depth: ${files.globScanMaxDepth}`);
  return detail(lines.join('\n') || 'exact permissions unavailable');
}

function toolInput(action: any, item?: ItemDetails): string {
  if (action.arguments !== undefined) return inputText(action.arguments);
  return item?.type === 'mcpToolCall' && item.server === action.server && item.tool === (action.toolName ?? action.tool)
    ? item.input ?? 'input missing' : 'input missing (started item unavailable)';
}

function toolRequest(params: any, item?: ItemDetails): string {
  const action = { server: params.serverName, toolName: params._meta?.tool_name, arguments: params.arguments };
  return detail(`Use the tool ${detail(action.server ?? '(server missing)')}.${detail(action.toolName ?? '(unnamed)')}\nArguments:\n${toolInput(action, item)}${params.message ? `\nMessage: ${detail(params.message, 2000)}` : ''}${params.reason ? `\nReason: ${detail(params.reason, 2000)}` : ''}`, 8000);
}

/**
 * What a plugin tool approval is about, when the request names it in a stable form. Computer use asks
 * `Allow Computer Use to use "<App>"?` on every call; the server and that message (not the tool) are the key,
 * so another app, or another server, still asks. Requests without such a target cannot be allowed for a job.
 */
function toolGrant(params: any): Grant | undefined {
  const server = params?.serverName;
  const message = params?.message;
  if (typeof server !== 'string' || !server || typeof message !== 'string') return;
  const target = /^Allow (.{1,100}?) to use "([^"\n]{1,200})"\?$/.exec(message);
  if (!target) return;
  return { key: `${server}\0${message}`, label: `${target[1]} using "${target[2]}"` };
}

/** Keep action fields useful to a decision, without protocol ids or environment metadata. */
function reviewedAction(action: any, item?: ItemDetails): string {
  const cwd = action?.cwd ? `\nWorking directory: ${detail(action.cwd)}` : '';
  switch (action?.type) {
    case 'command':
      return detail(`${detail(action.command ?? 'exact action unavailable (command missing)')}${cwd}`, 8000);
    case 'execve': {
      const argv = Array.isArray(action.argv) ? action.argv.slice(0, 100).map((arg: string, i: number) => `  [${i}] ${detail(JSON.stringify(arg))}`).join('\n') + (action.argv.length > 100 ? '\n… (truncated)' : '') : 'input missing (argv unavailable)';
      return detail(`execve\nProgram: ${detail(action.program ?? 'exact action unavailable')}\nArguments:\n${detail(argv)}${cwd || '\nWorking directory: missing'}`, 8000);
    }
    case 'applyPatch':
      return detail(`write files: ${fileList(action.files)}${cwd}`, 8000);
    case 'networkAccess':
      return `network access to ${detail(action.target ?? '(target missing)')}`;
    case 'mcpToolCall':
      return detail(`tool ${detail(action.server ?? '(server missing)')}.${detail(action.toolName ?? action.tool ?? '(unnamed)')}\nArguments:\n${toolInput(action, item)}`, 8000);
    case 'writeStdin':
      return detail(`Write to process ${detail(action.processId ?? '(process missing)')}:\n${detail(action.stdin ?? 'input missing')}${cwd}`, 8000);
    case 'requestPermissions':
      return detail(`Grant permissions:\n${permissionText(action.permissions)}${action.reason ? `\nReason: ${detail(action.reason, 2000)}` : ''}`, 8000);
    default:
      return `exact action unavailable${action?.type ? ` (unsupported action ${detail(action.type)})` : ' (Codex omitted it)'}`;
  }
}

function textInput(text: string) {
  return { type: 'text', text, text_elements: [] };
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0];
  return line.length > 140 ? `${clip(line, 139)}…` : line;
}

function basename(file: string): string {
  return file.split('/').pop() ?? file;
}

/** Codex reports commands wrapped as `/bin/zsh -lc '<command>'`; show only the command. */
function shortCommand(command: string): string {
  const inner = command.replace(/^\S*sh\s+-l?c\s+/, '').replace(/^(['"])([\s\S]*)\1$/, '$2');
  return firstLine(inner);
}

/** What the thread parameters let the worker do, read back from them so the record matches what Codex was sent. */
export function capabilitiesOf(job: Job, params: { sandbox: string | null; config: Record<string, any> }): Capabilities {
  const profile = params.config.default_permissions as string | undefined;
  const network = profile ? Boolean(params.config.permissions?.[profile]?.network?.enabled) : false;
  return {
    filesystem: profile === 'crew_read_only' ? 'read anywhere; write only its scratch and evidence directories'
      : profile ? 'read anywhere; write the workspace, temp, scratch and evidence directories'
      : params.sandbox === 'read-only' ? 'read-only' : 'write the workspace, scratch and evidence directories',
    network: network ? 'on' : 'off',
    plugins: params.config.features?.plugins ? job.plugins ?? [] : [],
  };
}
