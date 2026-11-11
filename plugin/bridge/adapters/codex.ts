import { spawn } from 'node:child_process';
import { agentEnv, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, JobCtl } from '../jobs.ts';
import { RpcError, RpcPeer } from '../rpc.ts';

interface Run {
  ctl: JobCtl;
  /** Id of the turn in flight, or null between turns. */
  turnId: string | null;
  message: string;
  /** Resolves the server request that put the job in the waiting state. */
  pending: ((answer: { approve: boolean; message?: string }) => void) | null;
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
    const res = await peer.request('thread/start', this.threadParams(ctl));
    const threadId: string = res.thread.id;
    const run: Run = { ctl, turnId: null, message: '', pending: null };
    this.runs.set(threadId, run);
    this.loaded.add(threadId);
    ctl.session(threadId);
    // Makes the thread recognizable in the Codex app and `codex resume`.
    peer.request('thread/name/set', { threadId, name: `Crew · ${ctl.job.title}` }).catch(() => {});

    if (ctl.job.nativeReview) {
      const target = ctl.job.nativeReview;
      await peer.request('review/start', { threadId, target: target.type === 'commit' ? { ...target, title: null } : target });
    } else {
      await this.startTurn(peer, run, ctl.job.prompt);
    }
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const peer = await this.ensure();
    const threadId = ctl.job.sessionId!;
    if (!this.loaded.has(threadId)) {
      await peer.request('thread/resume', { threadId, ...this.threadParams(ctl), excludeTurns: true });
      this.loaded.add(threadId);
    }
    let run = this.runs.get(threadId);
    if (!run) {
      run = { ctl, turnId: null, message: '', pending: null };
      this.runs.set(threadId, run);
    }
    if (run.turnId) {
      await peer.request('turn/steer', { threadId, input: [textInput(message)], expectedTurnId: run.turnId });
    } else {
      await this.startTurn(peer, run, message);
    }
  }

  async answer(ctl: JobCtl, approve: boolean, message?: string): Promise<void> {
    const run = this.runs.get(ctl.job.sessionId ?? '');
    if (!run?.pending) throw new Error('The request this job was waiting on is no longer pending.');
    run.pending({ approve, message });
  }

  async cancel(ctl: JobCtl): Promise<void> {
    const threadId = ctl.job.sessionId;
    const run = threadId ? this.runs.get(threadId) : undefined;
    if (!run) return;
    run.pending?.({ approve: false });
    if (run.turnId && this.peer) await this.peer.request('turn/interrupt', { threadId, turnId: run.turnId });
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

  private async startTurn(peer: RpcPeer, run: Run, text: string): Promise<void> {
    run.message = '';
    const { job } = run.ctl;
    const res = await peer.request('turn/start', {
      threadId: job.sessionId,
      input: [textInput(text)],
      effort: job.effort ?? this.config.codex.effort ?? null,
    });
    run.turnId = res.turn.id;
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
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: (reason) => {
        if (this.peer === peer) this.peer = null;
        this.loaded.clear();
        this.children.clear();
        for (const run of this.runs.values()) {
          run.turnId = null;
          run.pending = null;
          run.ctl.fail(`codex app-server ${reason}`);
        }
        this.runs.clear();
      },
    });
    await peer.request('initialize', { clientInfo: { name: 'crew', title: 'Crew', version: VERSION }, capabilities: null });
    peer.notify('initialized');
    this.peer = peer;
    peer.request('account/rateLimits/read').then((res) => this.setLimits(res.rateLimits), () => {});
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
      case 'serverRequest/resolved':
        // Resolved on the server side (e.g. the turn was interrupted) while we were still waiting.
        if (run.pending) {
          run.pending = null;
          ctl.resumed();
        }
        break;
      case 'turn/completed': {
        run.turnId = null;
        const turn = p.turn;
        if (turn.status === 'completed') ctl.done(run.message);
        else if (turn.status === 'interrupted') ctl.cancelled();
        else {
          const info = turn.error?.codexErrorInfo;
          ctl.fail(turn.error?.message ?? 'turn failed', { limit: typeof info === 'string' && LIMIT_ERRORS.includes(info) });
        }
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

  private async onRequest(method: string, p: any): Promise<unknown> {
    const run = this.runs.get(p?.threadId);
    const ask = (type: 'approval' | 'question', reason: string) => {
      if (!run) return Promise.resolve({ approve: false, message: undefined as string | undefined });
      run.ctl.waiting(type, reason);
      return new Promise<{ approve: boolean; message?: string }>((resolve) => {
        run.pending = (answer) => {
          run.pending = null;
          run.ctl.resumed();
          resolve(answer);
        };
      });
    };
    const why = p?.reason ? ` (${p.reason})` : '';

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const { approve } = await ask('approval', `run: ${shortCommand(p.command ?? 'command')}${why}`);
        return { decision: approve ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        const { approve } = await ask('approval', `write files${p.grantRoot ? ` under ${p.grantRoot}` : ''}${why}`);
        return { decision: approve ? 'accept' : 'decline' };
      }
      case 'item/permissions/requestApproval': {
        const wants = [p.permissions?.network && 'network access', p.permissions?.fileSystem && 'extra file access'].filter(Boolean).join(' and ');
        const { approve } = await ask('approval', `grant ${wants || 'extra permissions'}${why}`);
        const granted: Record<string, unknown> = {};
        if (approve && p.permissions?.network) granted.network = p.permissions.network;
        if (approve && p.permissions?.fileSystem) granted.fileSystem = p.permissions.fileSystem;
        return { permissions: granted, scope: 'turn' };
      }
      case 'item/tool/requestUserInput': {
        const questions: any[] = p.questions ?? [];
        const { approve, message } = await ask('question', questions.map((q) => q.question).join(' / ') || 'the worker asked a question');
        const text = message ?? (approve ? 'Yes.' : 'No.');
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
