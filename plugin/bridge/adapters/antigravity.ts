import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { tokenFile } from '../auth.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal } from '../jobs.ts';
import type { Adapter, JobCtl, JobKind } from '../jobs.ts';
import { isInside } from '../git.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer } from '../rpc.ts';

interface Run {
  ctl: JobCtl;
  prompting: Promise<void> | null;
  cancelling: boolean;
  /** Text since the last tool call. */
  message: string;
  /** Last non-empty text before that, in case the turn ends right after a tool call. */
  earlier: string;
  /** Permission requests waiting on the user, in arrival order. The first is the one shown. */
  pending: { reason: string; resolve: (approve: boolean | null) => void }[];
}

/** ACP tool kinds that cannot change anything. */
const PASSIVE_KINDS = ['read', 'search', 'think'];
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
  private restoreMethod: 'session/resume' | 'session/load' | null = null;
  private canClose = false;
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
    const res = await peer.request('session/new', { cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)] }, RPC_TIMEOUT_MS);
    if (isTerminal(ctl.job)) return;
    const sessionId: string = res.sessionId;
    const run: Run = { ctl, prompting: null, cancelling: false, message: '', earlier: '', pending: [] };
    this.runs.set(sessionId, run);
    this.loaded.add(sessionId);
    ctl.session(sessionId);

    // Stay in the default mode, where every edit asks first and onRequest decides it.
    // "accept-edits" was measured to apply edits outside the workspace without asking.
    const model = ctl.job.model ?? this.config.antigravity.model;
    const selected = model ? await peer.request('session/set_config_option', { sessionId, configId: 'model', value: model }, RPC_TIMEOUT_MS) : res;
    ctl.model(sessionModel(selected) ?? model);

    // ACP has no separate instruction channel, so the role travels with the first prompt.
    if (!isTerminal(ctl.job)) this.prompt(peer, run, `${ctl.job.instructions}\n\n${ctl.job.prompt}`);
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const peer = await this.ensure();
    const sessionId = ctl.job.sessionId!;
    if (!this.loaded.has(sessionId)) {
      if (!this.restoreMethod) throw new Error('This Antigravity server cannot restore sessions. Continue it from the Antigravity CLI.');
      const res = await peer.request(this.restoreMethod, { sessionId, cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)] }, RPC_TIMEOUT_MS);
      ctl.model(sessionModel(res) ?? ctl.job.resolvedModel ?? ctl.job.model ?? this.config.antigravity.model);
      this.loaded.add(sessionId);
    }
    if (isTerminal(ctl.job)) return;
    let run = this.runs.get(sessionId);
    if (!run) {
      run = { ctl, prompting: null, cancelling: false, message: '', earlier: '', pending: [] };
      this.runs.set(sessionId, run);
    }
    if (run.prompting) throw new Error('Antigravity is still working on the previous message. Wait for it to finish, or cancel first.');
    this.prompt(peer, run, message);
  }

  async answer(ctl: JobCtl, approve: boolean): Promise<void> {
    const run = this.runs.get(ctl.job.sessionId ?? '');
    const request = run?.pending.shift();
    if (!run || !request) throw new Error('The request this job was waiting on is no longer pending.');
    request.resolve(approve);
    const next = run.pending[0];
    if (next) ctl.waiting('approval', next.reason);
    else ctl.resumed();
  }

  async cancel(ctl: JobCtl): Promise<void> {
    const sessionId = ctl.job.sessionId;
    if (!sessionId) return;
    const run = this.runs.get(sessionId);
    const peer = this.peer;
    if (!run?.prompting || !peer) return;
    run.cancelling = true;
    drop(run);
    // Whether or not the agent confirms the cancel, nothing is waiting on the user any more.
    ctl.resumed();
    try {
      peer.notify('session/cancel', { sessionId });
      const stopped = await Promise.race([run.prompting.then(() => true), delay(5_000, false, { ref: false })]);
      if (stopped) return;
      if (!this.canClose) throw new Error('Antigravity did not confirm cancellation. The job is still active.');
      await peer.request('session/close', { sessionId }, RPC_TIMEOUT_MS).catch((err) => {
        if (!(err instanceof RpcError && err.code === -32002)) throw err;
      });
      this.runs.delete(sessionId);
      this.loaded.delete(sessionId);
    } finally {
      run.cancelling = false;
    }
  }

  shutdown(): void {
    this.peer?.close();
  }

  /** A prompt request stays open for the whole turn; its response is the turn's outcome. */
  private prompt(peer: RpcPeer, run: Run, text: string): void {
    const { ctl } = run;
    run.message = '';
    run.earlier = '';
    ctl.phase('working');
    run.prompting = peer
      .request('session/prompt', { sessionId: ctl.job.sessionId, prompt: [{ type: 'text', text }] })
      .then(
        (res) => {
          if (this.runs.get(ctl.job.sessionId!) !== run) return;
          if (res.stopReason === 'cancelled' || run.cancelling) ctl.cancelled();
          else if (res.stopReason === 'end_turn') ctl.done(plainLinks(run.message.trim() || run.earlier));
          else ctl.fail(`Antigravity stopped early: ${res.stopReason}`);
        },
        (err) => {
          if (this.peer === peer && this.runs.get(ctl.job.sessionId!) !== run) return;
          const detail = `${err.message}${err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : ''}`;
          ctl.fail(detail, { limit: LIMIT_PATTERN.test(detail) });
        },
      )
      .finally(() => {
        run.prompting = null;
        // The turn is over, so nothing it asked for can still be granted.
        drop(run);
      });
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
    const { bin, args, shell } = agentCommand(this.config.antigravity.bin, ['acp'], env);
    const child = spawn(bin, args, { env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const peer = new RpcPeer(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: () => {
        if (this.peer === peer) this.peer = null;
        this.loaded.clear();
        // In-flight prompts reject through the peer and fail their jobs there.
        for (const run of this.runs.values()) drop(run);
        this.runs.clear();
      },
    }, shell);
    this.peer = peer;
    // No fs or terminal capabilities: the agent uses its own tools, gated by request_permission.
    const { agentCapabilities } = await peer.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'crew', title: 'Crew', version: VERSION },
    });
    const resume = agentCapabilities?.sessionCapabilities?.resume;
    this.restoreMethod = resume && typeof resume === 'object' ? 'session/resume'
      : agentCapabilities?.loadSession === true ? 'session/load' : null;
    const close = agentCapabilities?.sessionCapabilities?.close;
    this.canClose = Boolean(close && typeof close === 'object');
    return peer;
  }

  private onNotification(method: string, p: any): void {
    if (method !== 'session/update') return;
    const run = this.runs.get(p.sessionId);
    if (!run || !run.prompting || isTerminal(run.ctl.job)) return;
    const { ctl } = run;
    this.lastUsed = Date.now();
    ctl.activity();
    const update = p.update ?? {};

    switch (update.sessionUpdate) {
      case 'config_option_update': {
        const model = sessionModel(update);
        if (model) ctl.model(model);
        break;
      }
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
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const run = this.runs.get(p.sessionId);
    // Outside a turn there is nobody to act on an answer, and a queued request would never be settled.
    if (run && (run.cancelling || !run.prompting || isTerminal(run.ctl.job))) return cancelled;
    const toolCall = p.toolCall ?? {};
    const verdict = run ? decide(run.ctl.job.kind, run.ctl.job.cwd, toolCall, run.ctl.job.sandbox === 'read-only') : { refuse: 'unknown session' };

    let allow = verdict === 'allow';
    if (run && verdict === 'ask') {
      const reason = describeRequest(toolCall, run.ctl.job.cwd);
      const answer = await new Promise<boolean | null>((resolve) => {
        run.pending.push({ reason, resolve });
        if (run.pending.length === 1) run.ctl.waiting('approval', reason);
      });
      if (answer === null) return cancelled;
      allow = answer;
      if (!answer) run.ctl.note(`The user declined an action: ${describeRequest(toolCall, run.ctl.job.cwd)}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    }
    if (run && typeof verdict === 'object') {
      const what = `${verdict.refuse}: ${describeRequest(toolCall, run.ctl.job.cwd)}`;
      run.ctl.progress(`refused (${what})`);
      run.ctl.note(`The bridge refused an action outside the ${ROLE_NAMES[run.ctl.job.kind]} role (${what}). Do it another way within the role permissions, or ask the lead to reassign the work.`, { declined: true });
    }
    // Never "always": each action must come back here so its path is checked and the user sees every command.
    // A refusal is for this request only, so "reject always" is used just when it is the only way to say no.
    const options: any[] = p.options ?? [];
    const option = (allow ? ['allow_once'] : ['reject_once', 'reject_always']).map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
    if (run && allow && !option) run.ctl.note(`An allowed action was not carried out because Antigravity offered no one-time approval: ${describeRequest(toolCall, run.ctl.job.cwd)}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    // Without a matching option the answer is "cancelled", which grants nothing.
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
  }
}

function sessionModel(response: any): string | undefined {
  const option = response.configOptions?.find((o: any) => o.category === 'model' || o.id === 'model');
  const model = option?.currentValue ?? response.models?.currentModelId;
  return typeof model === 'string' && model ? model : undefined;
}

function crewServer(ctl: JobCtl) {
  const { command, args, env } = ctl.mcp;
  return { name: 'crew', command, args, env: Object.entries(env).map(([name, value]) => ({ name, value })) };
}

/** Unblocks permission requests that can no longer be answered. */
function drop(run: Run): void {
  for (const request of run.pending.splice(0)) request.resolve(null);
}

const ROLE_NAMES: Record<JobKind, string> = { delegate: 'engineer', review: 'reviewer', polish: 'editor' };

/**
 * Role policy for a permission request.
 * - Reading, searching, and thinking are allowed for every role.
 * - Edits are refused in a review, and otherwise allowed only inside the job's workspace.
 * - Switching mode is refused: "accept-edits" was measured to apply edits outside the workspace without asking.
 * - Anything else (execute, delete, move, fetch, unknown kinds) is refused for a reviewer or editor. For an engineer it is
 *   the user's call, provided the request says exactly what it will do.
 * - A read-only job changes nothing whatever its role: a question is answered by the engineer, with a reviewer's limits.
 */
export function decide(role: JobKind, cwd: string, toolCall: { kind?: string; title?: string; locations?: { path?: string }[]; rawInput?: unknown; _meta?: { mcpServerName?: string; mcpToolName?: string } }, readOnly = false): 'allow' | 'ask' | { refuse: string } {
  if (toolCall._meta?.mcpServerName === 'crew' && ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes'].includes(toolCall._meta.mcpToolName ?? '')) return 'allow';
  const kind = toolCall.kind ?? 'other';
  // The daemon's secret is not a worker's to read, whatever the role. Commands are the user's to approve as before.
  const secret = tokenFile(HOME);
  if ((toolCall.locations ?? []).some((l) => l.path && path.resolve(l.path) === secret)) return { refuse: 'the Crew token file' };
  // A qualified title can identify an MCP call, but must never disguise a command.
  const input = toolCall.rawInput;
  const command = typeof input === 'string' || (input !== null && typeof input === 'object' && ('command' in input || 'CommandLine' in input));
  if (!toolCall._meta?.mcpServerName && !toolCall._meta?.mcpToolName && kind === 'other' && !command
    && /^(?:Run )?mcp_crew_(?:ask_lead|lead_answers|siblings|search|recent_changes)$/.test(toolCall.title ?? '')) return 'allow';
  if (PASSIVE_KINDS.includes(kind)) return 'allow';
  if (kind === 'switch_mode') return { refuse: kind };
  if (readOnly && role !== 'review') return { refuse: kind === 'edit' ? 'edit in a read-only job' : kind };
  if (kind !== 'edit') {
    if (role !== 'delegate') return { refuse: kind };
    // A title alone may be a shortened form; the user must not approve what they cannot see in full.
    return toolCall.rawInput == null || toolCall.rawInput === '' ? { refuse: `${kind} request without its input` } : 'ask';
  }
  if (role === 'review') return { refuse: 'edit during a read-only review' };
  const paths = (toolCall.locations ?? []).map((l) => l.path).filter((f): f is string => Boolean(f));
  // An edit that does not say where it writes cannot be shown to stay inside.
  if (paths.length === 0) return { refuse: 'edit without a path' };
  return paths.every((f) => isInside(cwd, f)) ? 'allow' : { refuse: 'edit outside the workspace' };
}

/** What the user is asked to approve: the whole request, never a shortened form. */
function describeRequest(toolCall: any, cwd: string): string {
  const lines = [`${toolCall.kind ?? 'other'}: ${toolCall.title ?? 'tool call'}`];
  const input = toolCall.rawInput;
  // A lone command reads best as itself; anything with more fields is shown entire, so no argument is hidden.
  const bare = input && typeof input === 'object' && Object.keys(input).length === 1 && typeof input.command === 'string';
  lines.push(typeof input === 'string' ? input : bare ? input.command : JSON.stringify(input, null, 2) ?? '(input missing; exact action unavailable)');
  const paths = (toolCall.locations ?? []).map((l: any) => l.path).filter(Boolean);
  if (paths.length) lines.push(`Paths: ${paths.join(', ')}`);
  lines.push(`Job workspace: ${cwd}`);
  return lines.join('\n');
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
