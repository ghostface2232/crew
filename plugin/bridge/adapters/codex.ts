import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenFile } from '../auth.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, Capabilities, Job, JobCtl } from '../jobs.ts';
import { PLUGIN_USER_APP } from '../prompts.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer, RpcTimeoutError } from '../rpc.ts';

type Answer = { approve: boolean; message?: string; cancelled?: boolean };
interface Pending {
  id: string | number;
  threadId: string;
  type: 'approval' | 'question';
  reason: string;
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
  awaitingTurn: boolean;
  interrupt: ReturnType<typeof Promise.withResolvers<void>> | null;
  message: string;
  pending: Pending[];
  crewCalls: Set<string>;
  items: Map<string, ItemDetails>;
}

export interface CodexLimits {
  plan: string | null;
  windows: { minutes: number | null; usedPercent: number; resetsAt: number | null }[];
  reached: boolean;
}

const CREW_TOOLS = ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes'];
const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'];
const IDLE_SHUTDOWN_MS = 10 * 60_000;
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
  private config: Config;

  constructor(config: Config) {
    this.config = config;
    setInterval(() => {
      const busy = [...this.runs.values()].some((run) => !isTerminal(run.ctl.job));
      if (this.peer && !busy && Date.now() - this.lastUsed > IDLE_SHUTDOWN_MS) this.peer.close();
    }, 60_000).unref();
  }

  async start(ctl: JobCtl): Promise<void> {
    const peer = await this.ensure();
    if (isTerminal(ctl.job)) return;
    const params = await this.threadParams(ctl, peer);
    ctl.capabilities(capabilitiesOf(ctl.job, params));
    const res = await peer.request('thread/start', params, RPC_TIMEOUT_MS);
    if (isTerminal(ctl.job)) return;
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

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const peer = await this.ensure();
    const threadId = ctl.job.sessionId!;
    let pluginsEnabled = this.runs.get(threadId)?.pluginsEnabled ?? false;
    if (!this.loaded.has(threadId)) {
      const params = await this.threadParams(ctl, peer);
      ctl.capabilities(capabilitiesOf(ctl.job, params));
      const res = await peer.request('thread/resume', { threadId, ...params, excludeTurns: true }, RPC_TIMEOUT_MS);
      pluginsEnabled = params.config.features.plugins;
      ctl.model(res.model ?? res.thread?.model ?? ctl.job.model ?? this.config.codex.model, ctl.job.effort ?? this.config.codex.effort ?? res.reasoningEffort ?? undefined);
      this.loaded.add(threadId);
    }
    if (isTerminal(ctl.job)) return;
    const run = this.runs.get(threadId) ?? this.openRun(ctl, threadId);
    run.pluginsEnabled = pluginsEnabled;
    if (run.awaitingTurn || run.interrupt) throw new Error('Codex has not confirmed the turn status. Check the job before sending another message.');
    if (run.turnId) {
      await peer.request('turn/steer', { threadId, input: [textInput(message)], expectedTurnId: run.turnId }, RPC_TIMEOUT_MS);
    } else {
      await this.startTurn(peer, run, message);
    }
  }

  async answer(ctl: JobCtl, approve: boolean, message?: string): Promise<void> {
    const run = this.runs.get(ctl.job.sessionId ?? '');
    if (!run?.pending.length) throw new Error('The request this job was waiting on is no longer pending.');
    this.settleRequest(run, 0, { approve, message });
  }

  async cancel(ctl: JobCtl): Promise<void> {
    const threadId = ctl.job.sessionId;
    const run = threadId ? this.runs.get(threadId) : undefined;
    if (!run) return;
    if (run.awaitingTurn) throw new Error('Codex has not confirmed the start of the turn. The job is still active.');
    if (!run.turnId || !this.peer) return;
    if (run.interrupt) throw new Error('Cancellation is already in progress.');
    const interrupt = Promise.withResolvers<void>();
    run.interrupt = interrupt;
    for (const request of run.pending.splice(0)) request.resolve({ approve: false, cancelled: true });
    run.ctl.resumed();
    try {
      const ended = interrupt.promise.then(() => true);
      const ack = this.peer.request('turn/interrupt', { threadId, turnId: run.turnId }, RPC_TIMEOUT_MS);
      const stopped = await Promise.race([ended, ack.then(() => ended), delay(5_000, false, { ref: false })]);
      if (!stopped) throw new Error('Codex did not confirm cancellation. The job is still active.');
    } finally {
      run.interrupt = null;
    }
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
    const app = (job.runsApp || lean.features.plugins || Object.keys(shared).length > 0) && job.sandbox === 'workspace-write'
      ? {
          default_permissions: profile,
          permissions: { [profile]: { filesystem: { ':root': 'read', [job.cwd]: 'write', ':tmpdir': 'write', ':slash_tmp': 'write', ...(job.scratch ? { [job.scratch]: 'write' } : {}), ...evidence, ...shared, ...secret }, network: { enabled: Boolean(job.runsApp) } } },
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
        ...(!app && !scratch ? { sandbox_workspace_write: { writable_roots: [job.scratch, ...Object.keys(evidence)] } } : {}),
      } : {}), // Its three tools only talk to the bridge. Without this a job with approval policy "never" (a review, a question)
      // is refused the call outright, and any other job would stop to ask.
      mcp_servers: { crew: { ...ctl.mcp, default_tools_approval_mode: 'approve' } },
      ...lean },
      developerInstructions: lean.features.plugins && !job.nativeReview ? `${job.instructions}\n\n${PLUGIN_USER_APP}` : job.instructions,
      model: job.model ?? this.config.codex.model ?? null,
    };
  }

  private reviewer(job: Job) {
    return job.asksUser ? 'user' : this.config.codex.approvalsReviewer;
  }

  private openRun(ctl: JobCtl, threadId: string, pluginsEnabled = false): Run {
    const run: Run = { ctl, pluginsEnabled, turnId: null, awaitingTurn: false, interrupt: null, message: '', pending: [], crewCalls: new Set(), items: new Map() };
    this.runs.set(threadId, run);
    return run;
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
    run.message = '';
    run.items.clear();
    run.awaitingTurn = true;
    try {
      const res = await peer.request(method, params, RPC_TIMEOUT_MS);
      if (run.awaitingTurn) {
        run.turnId = res.turn.id;
        run.awaitingTurn = false;
      }
    } catch (err) {
      if (err instanceof RpcTimeoutError) {
        if (run.awaitingTurn) run.ctl.note(`${err.message}. The turn may have started. Check the worker session before retrying.`);
        return;
      }
      run.awaitingTurn = false;
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
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onExit: (reason) => {
        if (this.peer === peer) this.peer = null;
        this.loaded.clear();
        this.children.clear();
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
    return peer;
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
    const owner = this.runs.get(threadId) ?? this.children.get(threadId);
    if (method === 'turn/started' || method === 'thread/closed') {
      for (const key of owner?.items.keys() ?? []) if (key.startsWith(`${threadId}\0`)) owner?.items.delete(key);
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
    const run = this.runs.get(threadId);
    if (!run) {
      // Sub-agent work only proves the job is alive; its turns must not end the parent job.
      if (method === 'turn/completed') {
        for (const key of owner?.items.keys() ?? []) if (key.startsWith(`${threadId}\0`)) owner?.items.delete(key);
      }
      this.children.get(threadId)?.ctl.activity();
      return;
    }
    const { ctl } = run;
    this.lastUsed = Date.now();

    switch (method) {
      case 'turn/started':
        run.turnId = p.turn.id;
        run.awaitingTurn = false;
        run.message = '';
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
        ctl.tokens(p.tokenUsage.total.totalTokens, {
          input: p.tokenUsage.total.inputTokens ?? 0,
          cachedInput: p.tokenUsage.total.cachedInputTokens ?? 0,
          output: p.tokenUsage.total.outputTokens ?? 0,
        });
        break;
      case 'error':
        if (p.willRetry) ctl.progress(`retrying: ${p.error.message}`);
        break;
      case 'turn/completed': {
        run.turnId = null;
        run.awaitingTurn = false;
        run.crewCalls.clear();
        run.items.clear();
        for (const request of run.pending.splice(0)) request.resolve(null);
        const turn = p.turn;
        if (run.interrupt || turn.status === 'interrupted') ctl.cancelled();
        else if (turn.status === 'completed') ctl.done(run.message);
        else {
          const info = turn.error?.codexErrorInfo;
          ctl.fail(turn.error?.message ?? 'turn failed', { limit: typeof info === 'string' && LIMIT_ERRORS.includes(info) });
        }
        run.interrupt?.resolve();
        break;
      }
      default:
        // Streaming deltas and other chatter: proof of life, nothing to log.
        ctl.activity();
    }
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
    if (request.type === 'approval' && answer && !answer.cancelled && !answer.approve) {
      run.ctl.note(`The user declined an action: ${request.reason}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    }
    request.resolve(answer);
    if (index !== 0) return;
    const next = run.pending[0];
    if (next) run.ctl.waiting(next.type, next.reason);
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
    const ask = (type: 'approval' | 'question', reason: string) => {
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
        run.pending.push({ id, threadId, type, reason, resolve });
        if (run.pending.length === 1) run.ctl.waiting(type, reason);
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
          const answer = await ask('approval', toolRequest(p, item));
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

/** Bound free-form provider text before putting it in a report or approval prompt. */
function detail(text: string, limit = 4000): string {
  return text.length > limit ? `${text.slice(0, limit)}… (truncated)` : text;
}

/** Render only tool input; environment fields are never part of an approval display. */
function inputText(input: unknown): string {
  if (input === undefined) return 'input missing';
  let text = '';
  let truncated = false;
  const append = (part: string) => {
    const room = 4000 - text.length;
    text += part.slice(0, Math.max(0, room));
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
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
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
