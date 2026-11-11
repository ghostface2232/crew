import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { agentEnv, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, JobCtl } from '../jobs.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer, RpcTimeoutError } from '../rpc.ts';

type Answer = { approve: boolean; message?: string };
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
}

export interface CodexLimits {
  plan: string | null;
  windows: { minutes: number | null; usedPercent: number; resetsAt: number | null }[];
  reached: boolean;
}

const LIMIT_ERRORS = ['usageLimitExceeded', 'rateLimitExceeded', 'sessionBudgetExceeded'];
const IDLE_SHUTDOWN_MS = 10 * 60_000;

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
    const res = await peer.request('thread/start', this.threadParams(ctl), RPC_TIMEOUT_MS);
    if (isTerminal(ctl.job)) return;
    const threadId: string = res.thread.id;
    const run = this.openRun(ctl, threadId);
    this.loaded.add(threadId);
    ctl.session(threadId);
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
      await peer.request('thread/resume', { threadId, ...this.threadParams(ctl), excludeTurns: true }, RPC_TIMEOUT_MS);
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
    for (const request of run.pending.splice(0)) request.resolve({ approve: false });
    run.ctl.resumed();
    try {
      await this.peer.request('turn/interrupt', { threadId, turnId: run.turnId }, RPC_TIMEOUT_MS);
      const stopped = await Promise.race([interrupt.promise.then(() => true), delay(5_000, false, { ref: false })]);
      if (!stopped) throw new Error('Codex did not confirm cancellation. The job is still active.');
    } finally {
      run.interrupt = null;
    }
  }

  shutdown(): void {
    this.peer?.close();
  }

  private threadParams(ctl: JobCtl) {
    const { job } = ctl;
    return {
      cwd: job.cwd,
      sandbox: job.sandbox,
      // A review must never block on a prompt; it has nothing to approve in a read-only sandbox.
      approvalPolicy: job.kind === 'review' ? 'never' : this.config.codex.approvalPolicy,
      approvalsReviewer: this.config.codex.approvalsReviewer ?? null,
      developerInstructions: job.instructions,
      model: job.model ?? this.config.codex.model ?? null,
    };
  }

  private openRun(ctl: JobCtl, threadId: string): Run {
    const run: Run = { ctl, turnId: null, awaitingTurn: false, interrupt: null, message: '', pending: [] };
    this.runs.set(threadId, run);
    return run;
  }

  private startTurn(peer: RpcPeer, run: Run, text: string): Promise<void> {
    const { job } = run.ctl;
    return this.sendTurn(peer, run, 'turn/start', {
      threadId: job.sessionId,
      input: [textInput(text)],
      effort: job.effort ?? this.config.codex.effort ?? null,
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
    if (this.peer?.alive) return Promise.resolve(this.peer);
    this.starting ??= this.launch().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async launch(): Promise<RpcPeer> {
    const child = spawn(this.config.codex.bin, ['app-server'], { env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
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
    });
    await peer.initialize({ clientInfo: { name: 'crew', title: 'Crew', version: VERSION }, capabilities: null });
    peer.notify('initialized');
    this.peer = peer;
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
    if (method === 'serverRequest/resolved') {
      const owner = this.runs.get(threadId) ?? this.children.get(threadId);
      const index = owner?.pending.findIndex((request) => request.threadId === threadId && request.id === p.requestId) ?? -1;
      if (owner && index >= 0) this.settleRequest(owner, index, null);
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
        this.onItemStarted(ctl, p.item);
        break;
      case 'item/completed':
        this.onItemCompleted(run, p.item);
        break;
      case 'turn/plan/updated': {
        const step = p.plan?.find((s: any) => s.status === 'inProgress');
        if (step) ctl.phase(step.step);
        break;
      }
      case 'thread/tokenUsage/updated':
        ctl.tokens(p.tokenUsage.total.totalTokens);
        break;
      case 'error':
        if (p.willRetry) ctl.progress(`retrying: ${p.error.message}`);
        break;
      case 'turn/completed': {
        run.turnId = null;
        run.awaitingTurn = false;
        for (const request of run.pending.splice(0)) request.resolve(null);
        for (const [child, owner] of this.children) if (owner === run) this.children.delete(child);
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
      if (!run || run.interrupt || isTerminal(run.ctl.job)) return Promise.resolve<Answer>({ approve: false });
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
        return answer ? { decision: answer.approve ? 'accept' : deny } : undefined;
      }
      case 'item/fileChange/requestApproval': {
        const answer = await ask('approval', `write files${p.grantRoot ? ` under ${p.grantRoot}` : ''}${why}`);
        return answer ? { decision: answer.approve ? 'accept' : 'decline' } : undefined;
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
        const answer = await ask('question', questions.map((q) => q.question).join(' / ') || 'the worker asked a question');
        if (!answer) return;
        const text = answer.message ?? (answer.approve ? 'Yes.' : 'No.');
        return { answers: Object.fromEntries(questions.map((q) => [q.id, { answers: [text] }])) };
      }
      case 'mcpServer/elicitation/request':
        return { action: 'decline', content: null, _meta: null };
      default:
        throw new RpcError(-32601, `${method} is not supported by Crew`);
    }
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
