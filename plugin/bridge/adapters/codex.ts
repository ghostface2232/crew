import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { tokenFile } from '../auth.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, Job, JobCtl } from '../jobs.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer, RpcTimeoutError } from '../rpc.ts';

type Answer = { approve: boolean; message?: string; cancelled?: boolean };
interface Pending {
  id: string | number;
  threadId: string;
  type: 'approval' | 'question';
  reason: string;
  resolve(answer: Answer | null): void;
}

interface Run {
  ctl: JobCtl;
  /** Id of the turn in flight, or null between turns. */
  turnId: string | null;
  awaitingTurn: boolean;
  interrupt: ReturnType<typeof Promise.withResolvers<void>> | null;
  message: string;
  pending: Pending[];
  crewCalls: Set<string>;
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
  /** Ids of the plugins the user's Codex has installed ("name@marketplace"), asked once per server process. */
  private pluginIds: Promise<string[]> | null = null;
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
    const res = await peer.request('thread/start', await this.threadParams(ctl, peer), RPC_TIMEOUT_MS);
    if (isTerminal(ctl.job)) return;
    const threadId: string = res.thread.id;
    const run = this.openRun(ctl, threadId);
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
    if (!this.loaded.has(threadId)) {
      const res = await peer.request('thread/resume', { threadId, ...await this.threadParams(ctl, peer), excludeTurns: true }, RPC_TIMEOUT_MS);
      ctl.model(res.model ?? res.thread?.model ?? ctl.job.model ?? this.config.codex.model, ctl.job.effort ?? this.config.codex.effort ?? res.reasoningEffort ?? undefined);
      this.loaded.add(threadId);
    }
    if (isTerminal(ctl.job)) return;
    const run = this.runs.get(threadId) ?? this.openRun(ctl, threadId);
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

  shutdown(): void {
    this.peer?.close();
  }

  /**
   * The lean settings, opened up for the plugins a job is to have. Codex can only switch plugins on as a whole,
   * so every installed plugin the job did not ask for is switched off by id.
   */
  private async lean(ctl: JobCtl, peer: RpcPeer) {
    const wanted = ctl.job.plugins ?? [];
    if (!wanted.length) return LEAN;
    this.pluginIds ??= peer.request('plugin/installed', {}, RPC_TIMEOUT_MS)
      .then((res) => ((res.marketplaces ?? []) as any[]).flatMap((marketplace) => ((marketplace.plugins ?? []) as any[]).filter((plugin) => plugin.installed).map((plugin) => plugin.id as string)));
    // A Codex that cannot list its plugins has none to give; the job is still worth running without them.
    const ids = await this.pluginIds.catch(() => {
      this.pluginIds = null;
      return [] as string[];
    });
    const named = (id: string, name: string) => id === name || id.startsWith(`${name}@`);
    // The ones a job that runs the app gets by default are not there on every machine; only a name the lead gave is worth a note.
    const missing = wanted.filter((name) => !this.config.codex.appPlugins.includes(name) && !ids.some((id) => named(id, name)));
    if (missing.length) ctl.note(`Codex has no plugin named ${missing.join(', ')}; the job runs without it.`);
    if (!ids.some((id) => wanted.some((name) => named(id, name)))) return LEAN;
    return {
      // A plugin's skill is how the worker learns to use its tools, so the skill list is kept for these jobs.
      features: { ...LEAN.features, plugins: true },
      plugins: Object.fromEntries(ids.map((id) => [id, { enabled: wanted.some((name) => named(id, name)) }])),
    };
  }

  private async threadParams(ctl: JobCtl, peer: RpcPeer) {
    const { job } = ctl;
    const lean = await this.lean(ctl, peer);
    // Read-only with one writable directory is not a sandbox mode; it is a permissions profile, which replaces the mode.
    // Either profile also denies the daemon's token file. A job with the network open could otherwise read it and
    // call the daemon as the user; a job with neither profile has no network to use it with.
    const secret = { [tokenFile(HOME)]: 'deny' };
    const scratch = job.sandbox === 'read-only' && job.scratch
      ? {
          default_permissions: 'crew_read_only',
          permissions: { crew_read_only: { filesystem: { ':root': 'read', [job.scratch]: 'write', ...secret } } },
          shell_environment_policy: { set: { TMPDIR: job.scratch } },
        }
      : null;
    // What "workspace-write" with network access allowed, spelled out so that one file can be excepted.
    const app = job.runsApp && job.sandbox === 'workspace-write'
      ? {
          default_permissions: 'crew_app',
          permissions: { crew_app: { filesystem: { ':root': 'read', [job.cwd]: 'write', ':tmpdir': 'write', ':slash_tmp': 'write', ...secret }, network: { enabled: true } } },
        }
      : null;
    return {
      cwd: job.cwd,
      sandbox: scratch || app ? null : job.sandbox,
      // A read-only job (a static review, a question) must never block on a prompt, and has nothing to approve.
      approvalPolicy: job.sandbox === 'read-only' ? 'never' : this.config.codex.approvalPolicy,
      approvalsReviewer: this.reviewer(job),
      config: { ...(app ?? scratch), // Its three tools only talk to the bridge. Without this a job with approval policy "never" (a review, a question)
      // is refused the call outright, and any other job would stop to ask.
      mcp_servers: { crew: { ...ctl.mcp, default_tools_approval_mode: 'approve' } },
      ...lean },
      developerInstructions: job.instructions,
      model: job.model ?? this.config.codex.model ?? null,
    };
  }

  private reviewer(job: Job) {
    return job.asksUser ? 'user' : this.config.codex.approvalsReviewer;
  }

  private openRun(ctl: JobCtl, threadId: string): Run {
    const run: Run = { ctl, turnId: null, awaitingTurn: false, interrupt: null, message: '', pending: [], crewCalls: new Set() };
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
    const { bin, shell } = agentCommand(this.config.codex.bin, env);
    const child = spawn(bin, ['app-server'], { env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const peer = new RpcPeer(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params, id) => this.onRequest(method, params, id),
      onExit: (reason) => {
        if (this.peer === peer) this.peer = null;
        this.pluginIds = null;
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
    });
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
        const reason = p.review.rationale ?? (status === 'timedOut' ? 'the review timed out' : 'no reason given');
        (this.runs.get(threadId) ?? this.children.get(threadId))?.ctl.refused(reviewedAction(p.action), reason);
      }
      return;
    }
    const run = this.runs.get(threadId);
    if (!run) {
      // Sub-agent work only proves the job is alive; its turns must not end the parent job.
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
    request.resolve(answer);
    if (index !== 0) return;
    const next = run.pending[0];
    if (next) run.ctl.waiting(next.type, next.reason);
    else run.ctl.resumed();
  }

  private async onRequest(method: string, p: any, id: string | number): Promise<unknown> {
    const threadId = p?.threadId;
    const run = this.runs.get(threadId) ?? this.children.get(threadId);
    const ask = (type: 'approval' | 'question', reason: string) => {
      if (!run || isTerminal(run.ctl.job)) return Promise.resolve<Answer>({ approve: false });
      if (run.interrupt) return Promise.resolve<Answer>({ approve: false, cancelled: true });
      // Nothing in a read-only job is the user's to allow: a question or a static review that asks to write is declined.
      if (type === 'approval' && run.ctl.job.sandbox === 'read-only') {
        run.ctl.note(`Declined in a read-only job: ${reason.split('\n')[0].slice(0, 120)}`);
        return Promise.resolve<Answer>({ approve: false });
      }
      if (this.children.has(threadId)) reason = `Sub-agent request\n${reason}`;
      return new Promise<Answer | null>((resolve) => {
        run.pending.push({ id, threadId, type, reason, resolve });
        if (run.pending.length === 1) run.ctl.waiting(type, reason);
      });
    };
    const why = p?.reason ? `\nReason: ${p.reason}` : '';

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const deny = p.availableDecisions && !p.availableDecisions.includes('decline') ? 'cancel' : 'decline';
        if (p.availableDecisions && !p.availableDecisions.includes('accept')) return { decision: deny };
        const command = p.command ? `Run:\n${p.command}` : '';
        const network = p.networkApprovalContext ? `Network access: ${JSON.stringify(p.networkApprovalContext)}` : '';
        if (!command && !network) {
          run?.ctl.note('The bridge declined a command approval that omitted the command.');
          return { decision: deny };
        }
        const cwd = p.cwd ? `Working directory: ${p.cwd}` : '';
        const permissions = p.additionalPermissions ? `Additional permissions: ${JSON.stringify(p.additionalPermissions)}` : '';
        const answer = await ask('approval', [command, cwd, network, permissions].filter(Boolean).join('\n') + why);
        if (!answer) return;
        const cancel = !p.availableDecisions || p.availableDecisions.includes('cancel') ? 'cancel' : deny;
        return { decision: answer.cancelled ? cancel : answer.approve ? 'accept' : deny };
      }
      case 'item/fileChange/requestApproval': {
        const answer = await ask('approval', `write files${p.grantRoot ? ` under ${p.grantRoot}` : ''}${why}`);
        return answer ? { decision: answer.cancelled ? 'cancel' : answer.approve ? 'accept' : 'decline' } : undefined;
      }
      case 'item/permissions/requestApproval': {
        const answer = await ask('approval', `Grant permissions:\n${JSON.stringify(p.permissions ?? {}, null, 2)}${why}`);
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
        // A plugin the job was given asks before its tool runs. Like a command, that is the user's to allow,
        // not something to refuse unseen; a job without plugins has no business with another server.
        if (run?.ctl.job.plugins?.length && p._meta?.codex_approval_kind === 'mcp_tool_call') {
          const answer = await ask('approval', `Use the tool ${p.serverName}.${p._meta.tool_name ?? '(unnamed)'}${p.message ? `\n${p.message}` : ''}`);
          if (!answer) return;
          return { action: answer.cancelled ? 'cancel' : answer.approve ? 'accept' : 'decline', content: answer.approve ? {} : null, _meta: null };
        }
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `${method} is not supported by Crew`);
    }
  }
}

/** The action an automatic review was about, in full: it may be sent back for approval as written. */
function reviewedAction(action: any): string {
  switch (action?.type) {
    case 'command':
      return action.command;
    case 'execve':
      return [action.program, ...(action.argv ?? [])].join(' ');
    case 'applyPatch':
      return `write files: ${(action.files ?? []).join(', ')}`;
    case 'networkAccess':
      return `network access to ${action.target}`;
    case 'mcpToolCall':
      return `tool ${action.server}.${action.toolName}`;
    default:
      return JSON.stringify(action ?? {});
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
