import { spawn } from 'node:child_process';
import { agentEnv, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, JobCtl } from '../jobs.ts';
import { isInside } from '../git.ts';
import { RpcError, RpcPeer } from '../rpc.ts';

interface Run {
  ctl: JobCtl;
  prompting: boolean;
  /** Text since the last tool call. */
  message: string;
  /** Last non-empty text before that, in case the turn ends right after a tool call. */
  earlier: string;
}

/** ACP tool kinds the editor role may use. Everything else (execute, delete, move, fetch, ...) is refused. */
const ALLOWED_KINDS = ['read', 'edit', 'search', 'think'];
const LIMIT_PATTERN = /quota|rate.?limit|resource.?exhausted|\b429\b|credits? balance/i;
const IDLE_SHUTDOWN_MS = 10 * 60_000;

/**
 * Drives Antigravity through `agy acp`, its Agent Client Protocol server.
 * ACP is the interface Google documents for third-party clients; the headless
 * `agy -p` mode is documented as unsupported inside other agents.
 */
export class AntigravityAdapter implements Adapter {
  private peer: RpcPeer | null = null;
  private starting: Promise<RpcPeer> | null = null;
  private runs = new Map<string, Run>();
  /** Sessions the current server process has in memory. */
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
    const res = await peer.request('session/new', { cwd: ctl.job.cwd, mcpServers: [] });
    const sessionId: string = res.sessionId;
    const run: Run = { ctl, prompting: false, message: '', earlier: '' };
    this.runs.set(sessionId, run);
    this.loaded.add(sessionId);
    ctl.session(sessionId);

    // Stay in the default mode, where every edit asks first and onRequest decides it.
    // "accept-edits" was measured to apply edits outside the workspace without asking.
    const model = ctl.job.model ?? this.config.antigravity.model;
    if (model) await peer.request('session/set_config_option', { sessionId, configId: 'model', value: model });

    this.prompt(peer, run, ctl.job.prompt);
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const peer = await this.ensure();
    const sessionId = ctl.job.sessionId!;
    if (!this.loaded.has(sessionId)) {
      await peer.request('session/resume', { sessionId, cwd: ctl.job.cwd, mcpServers: [] });
      this.loaded.add(sessionId);
    }
    let run = this.runs.get(sessionId);
    if (!run) {
      run = { ctl, prompting: false, message: '', earlier: '' };
      this.runs.set(sessionId, run);
    }
    if (run.prompting) throw new Error('Antigravity is still working on the previous message. Wait for it to finish, or cancel first.');
    this.prompt(peer, run, message);
  }

  async answer(): Promise<void> {
    // Permission requests are decided by role policy in onRequest, so this adapter never waits.
    throw new Error('Antigravity jobs do not wait for decisions.');
  }

  async cancel(ctl: JobCtl): Promise<void> {
    if (ctl.job.sessionId) this.peer?.notify('session/cancel', { sessionId: ctl.job.sessionId });
  }

  shutdown(): void {
    this.peer?.close();
  }

  /** A prompt request stays open for the whole turn; its response is the turn's outcome. */
  private prompt(peer: RpcPeer, run: Run, text: string): void {
    const { ctl } = run;
    run.prompting = true;
    run.message = '';
    run.earlier = '';
    ctl.phase('working');
    peer
      .request('session/prompt', { sessionId: ctl.job.sessionId, prompt: [{ type: 'text', text }] })
      .then(
        (res) => {
          if (res.stopReason === 'cancelled') ctl.cancelled();
          else if (res.stopReason === 'end_turn') ctl.done(plainLinks(run.message.trim() || run.earlier));
          else ctl.fail(`Antigravity stopped early: ${res.stopReason}`);
        },
        (err) => {
          const detail = `${err.message}${err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : ''}`;
          ctl.fail(detail, { limit: LIMIT_PATTERN.test(detail) });
        },
      )
      .finally(() => {
        run.prompting = false;
      });
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
    const child = spawn(this.config.antigravity.bin, ['acp'], { env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    const peer = new RpcPeer(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: () => {
        if (this.peer === peer) this.peer = null;
        this.loaded.clear();
        // In-flight prompts reject through the peer and fail their jobs there.
        this.runs.clear();
      },
    });
    // No fs or terminal capabilities: the agent uses its own tools, gated by request_permission.
    await peer.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'crew', title: 'Crew', version: VERSION },
    });
    this.peer = peer;
    return peer;
  }

  private onNotification(method: string, p: any): void {
    if (method !== 'session/update') return;
    const run = this.runs.get(p.sessionId);
    if (!run) return;
    const { ctl } = run;
    this.lastUsed = Date.now();
    const update = p.update ?? {};

    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content?.type === 'text') run.message += update.content.text;
        ctl.phase('writing');
        break;
      case 'agent_thought_chunk':
        ctl.phase('thinking');
        break;
      case 'tool_call':
        // Text before a tool call is narration; the report is what follows the last one.
        if (run.message.trim()) run.earlier = run.message.trim();
        run.message = '';
        ctl.progress(describeCall(update));
        break;
      case 'tool_call_update':
        if (update.status === 'completed' && update.kind !== 'read') {
          for (const loc of update.locations ?? []) if (loc.path) ctl.touched(loc.path);
        }
        if (update.status === 'failed') ctl.progress(`failed: ${update.title ?? 'tool call'}`);
        else ctl.activity();
        break;
      case 'plan': {
        const step = update.entries?.find((e: any) => e.status === 'in_progress');
        if (step) ctl.phase(step.content);
        break;
      }
      default:
        ctl.activity();
    }
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported by Crew`);
    const run = this.runs.get(p.sessionId);
    const refusal = run ? refuse(run.ctl.job.cwd, p.toolCall ?? {}) : 'unknown session';
    // Never "always": each edit must come back here so its path is checked.
    const wanted = refusal ? ['reject_once', 'reject_always'] : ['allow_once'];
    const option = (p.options ?? []).find((o: any) => wanted.includes(o.kind));
    if (refusal && run) {
      const what = `${refusal}: ${p.toolCall?.title ?? 'tool call'}`;
      run.ctl.progress(`refused (${what})`);
      run.ctl.note(`The bridge refused an action outside the editor role (${what}).`);
    }
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
  }
}

/**
 * Role policy for a permission request: the reason to refuse it, or null to allow.
 * Reading is allowed anywhere; editing only inside the job's workspace.
 */
export function refuse(cwd: string, toolCall: { kind?: string; locations?: { path?: string }[] }): string | null {
  const kind = toolCall.kind ?? 'other';
  if (!ALLOWED_KINDS.includes(kind)) return kind;
  if (kind !== 'edit') return null;
  const paths = (toolCall.locations ?? []).map((l) => l.path).filter((f): f is string => Boolean(f));
  // An edit that does not say where it writes cannot be shown to stay inside.
  if (paths.length === 0) return 'edit without a path';
  return paths.every((f) => isInside(cwd, f)) ? null : 'edit outside the workspace';
}

const VERBS: Record<string, string> = { read: 'reading', edit: 'editing', search: 'searching', execute: 'running', delete: 'deleting', move: 'moving', fetch: 'fetching' };

/** ACP titles are terse ("File <path>"); lead with what is being done to which file. */
function describeCall(update: any): string {
  const file = update.locations?.[0]?.path?.split('/').pop();
  const verb = VERBS[update.kind];
  return verb && file ? `${verb} ${file}` : update.title || update.kind || 'tool call';
}

/** Antigravity links every file mention to an absolute file:// URL; keep only the label. */
function plainLinks(text: string): string {
  return text.replace(/\[([^\]]+)\]\(file:\/\/[^)]*\)/g, '$1');
}
