import { spawn } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { tokenFile } from '../auth.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal, noteLeadDecline } from '../jobs.ts';
import type { Adapter, JobCtl, JobKind } from '../jobs.ts';
import { isGitPath, isInside } from '../git.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer } from '../rpc.ts';
import { pickEffort, pickModel } from '../tiers.ts';

type Grant = { program: string; subcommand: string; cwd?: string; label: string };

interface Run {
  ctl: JobCtl;
  /** Set from the moment a turn is taken, through the mode check and any restore, until it ends. */
  prompting: Promise<void> | null;
  /** The prompt has gone to agy. Updates before that are a restore replaying the session, not this turn. */
  sent: boolean;
  cancelling: boolean;
  /** Text since the last tool call. */
  message: string;
  /** Last non-empty text before that, in case the turn ends right after a tool call. */
  earlier: string;
  /** Approvals and questions waiting on the user, in arrival order. The first is the one shown. */
  pending: { type: 'approval' | 'question'; reason: string; grant?: Grant; resolve: (answer: Answer | null) => void }[];
  grants: Set<string>;
  /** The lead's reasons for declining requests in this turn, sent as the next prompt once it ends. */
  declined: string[];
  /** This turn's tool calls as agy reported them, and whether each came to Crew as a permission request. */
  calls: Map<string, ToolCall & { asked?: boolean; checked?: boolean }>;
  /** Why Crew stopped the turn: an action ran outside the role without asking, or agy would not leave a mode. */
  violation?: string;
  /** A mode agy switched the session to during this turn. */
  switched?: string;
  /** The switch back from it; the turn's outcome waits for it. Never rejects. */
  restoring?: Promise<void>;
  /** A message added during the turn: its prompt request carries the rest of the turn. */
  next?: Promise<any>;
}

type ToolCall = { kind?: string; title?: string; locations?: { path?: string }[]; rawInput?: unknown; _meta?: { mcpServerName?: string; mcpToolName?: string } };

/** The user's answer to a request; null when it can no longer be answered. */
interface Answer {
  approve: boolean;
  message?: string;
}

/** Names agy has used for a command in a tool call's input, by server version. */
const COMMAND_FIELDS = ['command', 'CommandLine', 'command_line', 'commandLine'];
const CWD_FIELDS = ['cwd', 'Cwd', 'workingDirectory', 'WorkingDirectory', 'working_directory'];

/** ACP tool kinds that cannot change anything. */
const PASSIVE_KINDS = ['read', 'search', 'think'];
/** Kinds whose run outside the role Crew stops the turn for; the rest are only reported. */
const CHANGING_KINDS = ['edit', 'delete', 'move', 'execute'];
/**
 * The only mode in which agy asks before edits and commands. Measured on agy 1.5.14: in "accept-edits" and "auto",
 * edits outside the workspace and in .git, commands, and network requests ran without a permission request.
 */
const ASKING_MODE = 'default';
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
  /** The mode agy last reported for each session, numbered so that a switch back cannot overwrite a newer report. */
  private modes = new Map<string, { mode: string; seq: number }>();
  private restoreMethod: 'session/resume' | 'session/load' | null = null;
  private canClose = false;
  /** The server takes instructions as an addition to its system prompt. */
  private appendsPrompt = false;
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
    const res = await peer.request('session/new', { cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)], ...this.instructions(ctl) }, RPC_TIMEOUT_MS);
    if (isTerminal(ctl.job)) return;
    ctl.capabilities({
      filesystem: ctl.job.sandbox === 'read-only' ? 'read-only; Crew refuses every edit' : 'edits inside the workspace only; Crew refuses the rest',
      network: 'agent-managed',
      plugins: [],
    });
    const sessionId: string = res.sessionId;
    const run: Run = newRun(ctl);
    this.runs.set(sessionId, run);
    this.loaded.add(sessionId);
    ctl.session(sessionId);

    // Every edit and command must reach onRequest. agy's saved Agent Mode does not reach ACP sessions as of 1.5.14,
    // but its default for other sessions became Auto in 1.5.7, so the mode is checked before every prompt.
    // A new session has no reports before this request; any it has now came in meanwhile.
    this.noteResponseMode(sessionId, res, undefined);
    const wanted = ctl.job.model ?? (ctl.job.agentDefault ? undefined : this.config.antigravity.model);
    // A tier names a family ("hydrogen"); the session lists the exact values this account has.
    // A family the session does not list is left to the agent's default; a model named outright is still sent, so a typo shows.
    const listed = wanted ? pickModel(res.configOptions?.find((o: any) => o.category === 'model' || o.id === 'model')?.options, wanted) : undefined;
    const model = listed ?? (ctl.job.tier ? undefined : wanted);
    let selected = model ? await peer.request('session/set_config_option', { sessionId, configId: 'model', value: model }, RPC_TIMEOUT_MS) : res;
    // The levels differ by model, so they are read from the session after the model is set.
    const level = ctl.job.effort ? pickEffort(configOption(selected, 'thought_level')?.options, ctl.job.effort) : undefined;
    if (level && level !== configOption(selected, 'thought_level')?.currentValue) {
      selected = await peer.request('session/set_config_option', { sessionId, configId: 'thought_level', value: level }, RPC_TIMEOUT_MS);
    }
    ctl.model(sessionModel(selected) ?? model, sessionEffort(selected));

    // Without a system prompt addition, the role travels with the first prompt.
    if (!isTerminal(ctl.job)) this.prompt(peer, run, this.appendsPrompt ? ctl.job.prompt : `${ctl.job.instructions}\n\n${ctl.job.prompt}`);
  }

  /**
   * The role as an addition to the system prompt, where the server takes one: there it holds for every turn and is
   * not mixed into the task. agy 1.5.9 kept it across a resume in a new process; it is sent again on restore for servers that do not.
   */
  private instructions(ctl: JobCtl): { _meta?: unknown } {
    return this.appendsPrompt ? { _meta: { antigravity: { systemPrompt: { append: ctl.job.instructions } } } } : {};
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const peer = await this.ensure();
    const sessionId = ctl.job.sessionId!;
    // A turn Crew stopped may still be winding down (stop). The follow-up is a turn of its own, not a message for that one.
    const stopping = this.runs.get(sessionId);
    if (stopping?.prompting && stopping.violation) {
      const stopped = await Promise.race([stopping.prompting.then(() => true), delay(6_000, false, { ref: false })]);
      if (!stopped && this.runs.get(sessionId) === stopping) throw new Error('Antigravity has not yet stopped the turn Crew ended. Send the message again in a moment.');
    }
    const restore = !this.loaded.has(sessionId);
    if (restore && !this.restoreMethod) throw new Error('This Antigravity server cannot restore sessions. Continue it from the Antigravity CLI.');
    if (isTerminal(ctl.job)) return;
    let run = this.runs.get(sessionId);
    if (!run) {
      run = newRun(ctl);
      this.runs.set(sessionId, run);
    }
    if (run.prompting) return this.steer(peer, run, message);
    this.prompt(peer, run, message, restore ? async () => {
      const before = this.modes.get(sessionId)?.seq;
      const res = await peer.request(this.restoreMethod!, { sessionId, cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)], ...this.instructions(ctl) }, RPC_TIMEOUT_MS);
      this.noteResponseMode(sessionId, res, before);
      // A server that restores a session at its default level would run the next turn above the job's effort.
      const level = ctl.job.effort ? pickEffort(configOption(res, 'thought_level')?.options, ctl.job.effort) : undefined;
      const restored = level && level !== configOption(res, 'thought_level')?.currentValue
        ? await peer.request('session/set_config_option', { sessionId, configId: 'thought_level', value: level }, RPC_TIMEOUT_MS) : res;
      ctl.model(sessionModel(restored) ?? sessionModel(res) ?? ctl.job.resolvedModel ?? ctl.job.model ?? this.config.antigravity.model, sessionEffort(restored) ?? ctl.job.resolvedEffort);
      this.loaded.add(sessionId);
    } : undefined);
  }

  async answer(ctl: JobCtl, approve: boolean, message?: string, opts?: { forJob?: boolean; by?: 'lead' }): Promise<void> {
    const run = this.runs.get(ctl.job.sessionId ?? '');
    const request = run?.pending[0];
    if (!run || !request) throw new Error('The request this job was waiting on is no longer pending.');
    const grant = opts?.forJob && ctl.job.sandbox !== 'read-only' ? request.grant : undefined;
    const key = grant && commandGrantKey(grant);
    if (opts?.forJob && !key) throw new Error('This request cannot be allowed for the whole job. Approve or deny it.');
    run.pending.shift();
    if (request.type === 'approval' && !approve) {
      // A permission answer carries no text, and agy 1.5.9 refuses a prompt while one is open and ends the turn
      // on a rejection. So the reason waits for the turn to end and is then sent as the next prompt.
      if (opts?.by === 'lead') {
        run.declined.push(noteLeadDecline(ctl, request.reason, message!.trim()));
        // What the worker wrote so far led up to the refused action, so it is no reply to the reason.
        run.message = '';
        run.earlier = '';
      }
      else ctl.note(`The user declined an action: ${request.reason}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    }
    request.resolve({ approve, message });
    if (approve && grant && key) {
      run.grants.add(key);
      ctl.progress(`allowed for this job: ${grant.label}`);
      for (let i = run.pending.length - 1; i >= 0; i--) {
        const queued = run.pending[i];
        if (!queued.grant || commandGrantKey(queued.grant) !== key) continue;
        run.pending.splice(i, 1);
        queued.resolve({ approve: true });
      }
    }
    const next = run.pending[0];
    if (next) ctl.waiting(next.type, next.reason, next.grant && commandGrantKey(next.grant) ? next.grant.label : undefined);
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
      this.modes.delete(sessionId);
    } finally {
      run.cancelling = false;
    }
  }

  shutdown(): void {
    this.peer?.close();
  }

  /**
   * Takes the turn at once, so that a cancel or a second message during the checks before it sees a turn under way.
   * A prompt request stays open for the whole turn; its response is the turn's outcome.
   */
  private prompt(peer: RpcPeer, run: Run, text: string, prepare?: () => Promise<void>): void {
    const { ctl } = run;
    const sessionId = ctl.job.sessionId!;
    run.message = '';
    run.earlier = '';
    run.calls.clear();
    run.violation = undefined;
    run.switched = undefined;
    run.restoring = undefined;
    run.next = undefined;
    run.sent = false;
    ctl.phase('working');
    const turn = async (): Promise<any> => {
      await prepare?.();
      // Every prompt goes out in the asking mode, whatever agy reported since the last one.
      await this.keepAsking(peer, sessionId);
      if (run.cancelling || isTerminal(ctl.job) || this.runs.get(sessionId) !== run) return { stopReason: 'cancelled' };
      run.sent = true;
      let res = await peer.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
      this.counted(run, res?.usage);
      // A message added meanwhile ended that request; the turn goes on under the message's own.
      while (run.next) {
        const next = run.next;
        run.next = undefined;
        const result = await next;
        if (result?.refused) throw result.refused;
        res = result;
        this.counted(run, res?.usage);
      }
      // A switch back that agy refused during the turn decides its outcome, even when the reply came first.
      await run.restoring;
      return res;
    };
    run.prompting = turn()
      .then(
        (res) => {
          if (this.runs.get(sessionId) !== run) return;
          if (run.violation) ctl.fail(run.violation);
          else if (res.stopReason === 'cancelled' || run.cancelling) ctl.cancelled();
          else if (res.stopReason === 'end_turn') {
            const report = run.message.trim() || run.earlier;
            // agy can end a rejected turn without a report, so send the lead's reason in the next prompt.
            if (!report && run.declined.length) return;
            run.declined.length = 0;
            ctl.done(plainLinks(report));
          } else ctl.fail(`Antigravity stopped early: ${res.stopReason}`);
        },
        (err) => {
          if (this.peer === peer && this.runs.get(sessionId) !== run) return;
          const detail = `${err.message}${err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : ''}`;
          ctl.fail(run.violation ?? detail, { limit: !run.violation && LIMIT_PATTERN.test(detail) });
        },
      )
      .finally(() => {
        run.prompting = null;
        run.sent = false;
        // The turn is over, so nothing it asked for can still be granted.
        drop(run);
        const reasons = run.declined.splice(0);
        if (reasons.length && this.peer === peer && this.runs.get(sessionId) === run && !isTerminal(ctl.job)) {
          ctl.resumed();
          this.prompt(peer, run, reasons.join('\n\n'));
        } else this.close(peer, sessionId);
      });
  }

  /**
   * Closes a session whose turn has ended. Since agy 1.5.10 that stops its subagents and background work too, which
   * would otherwise go on with no turn to answer their requests. A follow-up restores the session (reply).
   */
  private close(peer: RpcPeer, sessionId: string): void {
    if (!this.canClose || this.peer !== peer || !this.loaded.delete(sessionId)) return;
    this.modes.delete(sessionId);
    peer.request('session/close', { sessionId }, RPC_TIMEOUT_MS).catch(() => {});
  }

  /** agy reports each prompt's tokens; a job's are the sum over its prompts. Its input excludes what was read from cache. */
  private counted(run: Run, usage: any): void {
    if (!usage || typeof usage.totalTokens !== 'number') return;
    const { ctl } = run;
    const before = ctl.job.tokenUse ?? { input: 0, cachedInput: 0, output: 0 };
    const cached = usage.cachedReadTokens ?? 0;
    ctl.tokens((ctl.job.tokens ?? 0) + usage.totalTokens, {
      input: before.input + (usage.inputTokens ?? 0) + cached,
      cachedInput: before.cachedInput + cached,
      output: before.output + (usage.outputTokens ?? 0),
    });
  }

  /**
   * Adds a message to the turn under way. agy 1.5.14 then answers the running prompt request at once with end_turn and
   * carries the turn on, message included, under the new request. It refuses one at once while a permission or a
   * question waits.
   */
  private async steer(peer: RpcPeer, run: Run, message: string): Promise<void> {
    if (run.pending.length) throw new Error('Antigravity is waiting for an approval or an answer, and takes no message until it has one. Answer it first, or cancel.');
    if (!run.sent) throw new Error('Antigravity is still starting this turn. Send the message again in a moment.');
    const next = peer.request('session/prompt', { sessionId: run.ctl.job.sessionId, prompt: [{ type: 'text', text: message }] })
      .then((res) => res, (refused) => ({ refused }));
    // Taken before the earlier request is answered, so the turn waits for this one.
    run.next = next;
    const early = await Promise.race([next, delay(2_000, undefined, { ref: false })]);
    if (early?.refused) {
      if (run.next === next) run.next = undefined;
      throw early.refused;
    }
    run.ctl.progress('message added to the running turn');
  }

  private noteMode(sessionId: string, mode: string | undefined): void {
    if (mode) this.modes.set(sessionId, { mode, seq: (this.modes.get(sessionId)?.seq ?? 0) + 1 });
  }

  /**
   * The mode a response reports, unless agy reported one while the request was out: a report read after the response
   * may be the newer of the two. Either way a mode that does not ask wins, so the next prompt checks it.
   */
  private noteResponseMode(sessionId: string, response: any, before: number | undefined): void {
    const mode = sessionMode(response);
    if (this.modes.get(sessionId)?.seq === before || (mode && mode !== ASKING_MODE)) this.noteMode(sessionId, mode);
  }

  /** Puts a session back in the mode where agy asks before edits and commands, or throws when agy refuses. */
  private async keepAsking(peer: RpcPeer, sessionId: string): Promise<void> {
    const known = this.modes.get(sessionId);
    if (!known || known.mode === ASKING_MODE) return;
    try {
      await peer.request('session/set_mode', { sessionId, modeId: ASKING_MODE }, RPC_TIMEOUT_MS);
    } catch (err) {
      throw new Error(`Antigravity's session is in "${known.mode}" mode, where it does not ask before edits and commands, and it refused to switch to "${ASKING_MODE}": ${(err as Error).message}`);
    }
    // A report that came in meanwhile is newer than this switch, and is checked again before the next prompt.
    if (this.modes.get(sessionId)?.seq === known.seq) this.noteMode(sessionId, ASKING_MODE);
  }

  /**
   * Ends the turn for a reason Crew found. The job fails now, whether or not agy confirms the cancel: agy may go on
   * past a cancel it ignores, and closing the session stops it and its background work.
   */
  private stop(run: Run, message: string): void {
    if (run.violation) return;
    run.violation = message;
    // Nothing the turn asks for after this can be granted.
    drop(run);
    run.ctl.fail(message);
    const peer = this.peer;
    const sessionId = run.ctl.job.sessionId!;
    const prompting = run.prompting;
    if (!peer || !prompting) return;
    peer.notify('session/cancel', { sessionId });
    if (!this.canClose) return;
    void Promise.race([prompting.then(() => true), delay(5_000, false, { ref: false })]).then(async (stopped) => {
      if (stopped || this.runs.get(sessionId) !== run) return;
      this.runs.delete(sessionId);
      this.loaded.delete(sessionId);
      this.modes.delete(sessionId);
      await peer.request('session/close', { sessionId }, RPC_TIMEOUT_MS);
    }).catch(() => {});
  }

  /**
   * agy runs some actions without asking: commands that the user's own Antigravity allow rules cover, and file reads
   * that its Non-Workspace Access setting permits. Crew sees them only once they have run, so it checks them against
   * the role then. One that the role would refuse stops the turn; an engineer's command is the user's own rule, so it is reported.
   */
  private unasked(run: Run, call: ToolCall): void {
    const { ctl } = run;
    const { job } = ctl;
    let verdict = decide(job.kind, job.cwd, call, job.sandbox === 'read-only');
    // A report may omit the input that a request must carry. That rule keeps the user from approving what they cannot
    // see; here nothing is left to approve, so the action is reported like any other the engineer ran unasked.
    if (typeof verdict === 'object' && verdict.refuse === `${call.kind ?? 'other'} request without its input`) verdict = 'ask';
    if (verdict === 'allow') return;
    const what = `${call.kind ?? 'other'}: ${call.title ?? 'tool call'}`;
    // In the asking mode only the user's own rules let an action through; after a switch, the switch did.
    const switched = run.switched && `its session had switched to "${run.switched}" mode`;
    if (verdict === 'ask') {
      const cause = switched || "a rule in the user's Antigravity settings allows it";
      ctl.progress(`ran without asking, because ${cause} (${what})`);
      ctl.note(`Antigravity ran an action without asking Crew, because ${cause}: ${what}`);
      return;
    }
    const cause = switched || "the user's Antigravity settings allow it";
    const role = `${job.sandbox === 'read-only' ? 'read-only ' : ''}${ROLE_NAMES[job.kind]}`;
    const reason = verdict.refuse === call.kind ? what : `${verdict.refuse}: ${what}`;
    const message = `Antigravity ran an action outside the ${role} role without asking Crew (${reason}), because ${cause}.`;
    // A turn being cancelled is ending anyway, and a cancel must not read as a violation; what ran is still reported.
    const stop = !run.cancelling && (CHANGING_KINDS.includes(call.kind ?? '') || verdict.refuse === 'the Crew token file');
    ctl.progress(`${stop ? 'stopped' : 'reported'}: ${message}`);
    if (!stop) {
      ctl.note(message);
      return;
    }
    this.stop(run, `${message} Crew stopped the turn. ${run.switched
      ? 'Crew could not keep the session in its asking mode, so give this role to another agent if it happens again.'
      : "Narrow the matching allow rule or Non-Workspace Access in Antigravity's /permissions and /config, or give this role to another agent."}`);
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
        this.modes.clear();
        // In-flight prompts reject through the peer and fail their jobs there.
        for (const run of this.runs.values()) drop(run);
        this.runs.clear();
      },
    }, shell);
    this.peer = peer;
    // No fs or terminal capabilities: the agent uses its own tools, gated by request_permission.
    // Declaring forms makes a question arrive as a request that waits for its answer. Without it, agy 1.5.9
    // printed the question and ended the turn, so the job finished with a question for a report.
    const { agentCapabilities } = await peer.initialize({
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, elicitation: { form: {} } },
      clientInfo: { name: 'crew', title: 'Crew', version: VERSION },
    });
    const resume = agentCapabilities?.sessionCapabilities?.resume;
    this.restoreMethod = resume && typeof resume === 'object' ? 'session/resume'
      : agentCapabilities?.loadSession === true ? 'session/load' : null;
    const close = agentCapabilities?.sessionCapabilities?.close;
    this.canClose = Boolean(close && typeof close === 'object');
    this.appendsPrompt = agentCapabilities?._meta?.antigravity?.systemPrompt?.append === true;
    return peer;
  }

  private onNotification(method: string, p: any): void {
    if (method !== 'session/update') return;
    // Kept for every session, between turns and during a restore too; the next prompt undoes a switch.
    if (p.update?.sessionUpdate === 'current_mode_update') this.noteMode(p.sessionId, p.update.currentModeId);
    const run = this.runs.get(p.sessionId);
    if (!run || !run.prompting || !run.sent || isTerminal(run.ctl.job)) return;
    const { ctl } = run;
    this.lastUsed = Date.now();
    ctl.activity();
    const update = p.update ?? {};

    switch (update.sessionUpdate) {
      case 'config_option_update': {
        const model = sessionModel(update);
        const hasConfig = Array.isArray(update.configOptions);
        if (model || hasConfig) ctl.model(model ?? ctl.job.resolvedModel, hasConfig ? sessionEffort(update) : ctl.job.resolvedEffort);
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
        this.track(run, update);
        break;
      case 'tool_call_update':
        if (update.status === 'completed' && update.kind !== 'read') {
          for (const loc of update.locations ?? []) if (loc.path) ctl.touched(loc.path);
        }
        if (update.status === 'failed') ctl.progress(`failed: ${update.title ?? 'tool call'}`);
        else ctl.activity();
        this.track(run, update);
        break;
      case 'current_mode_update':
        // The agent's own switch_mode is refused in onRequest; a switch that still lands is undone.
        if (update.currentModeId && update.currentModeId !== ASKING_MODE && this.peer) {
          run.switched = update.currentModeId;
          ctl.progress(`Antigravity switched to "${update.currentModeId}" mode; switching back to "${ASKING_MODE}"`);
          const earlier = run.restoring;
          run.restoring = this.keepAsking(this.peer, p.sessionId).then(() => earlier, (err) => {
            this.stop(run, (err as Error).message);
          });
        }
        break;
      case 'usage_update':
        if (typeof update.used === 'number' && typeof update.size === 'number') ctl.context(update.used, update.size);
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

  /** Merges what agy reports about a tool call, and checks one that ran without coming to Crew first. */
  private track(run: Run, update: any): void {
    const id = update.toolCallId;
    if (typeof id !== 'string') return;
    const call = run.calls.get(id) ?? {};
    // An ACP update replaces the fields it carries.
    for (const key of ['kind', 'title', 'locations', 'rawInput', '_meta'] as const) if (update[key] !== undefined) (call as any)[key] = update[key];
    run.calls.set(id, call);
    // agy reports a call as in progress before it asks, so only a completed one is known to have run unasked. A failed
    // one may never have run, and calls end failed when the turn is cancelled.
    if (update.status === 'completed' && !call.asked && !call.checked) {
      call.checked = true;
      this.unasked(run, call);
    }
  }

  /** Puts a request before the user and resolves with their answer, or null once the turn can no longer use one. */
  private ask(run: Run, type: 'approval' | 'question', reason: string, grant?: Grant): Promise<Answer | null> {
    return new Promise((resolve) => {
      run.pending.push({ type, reason, grant, resolve });
      if (run.pending.length === 1) run.ctl.waiting(type, reason, grant?.label);
    });
  }

  /** A question the agent asks through a form. The user answers it, as they do a Codex worker's. */
  private async onQuestion(p: any): Promise<unknown> {
    const run = this.runs.get(p.sessionId);
    if (!run || run.cancelling || run.violation || !run.sent || isTerminal(run.ctl.job)) return { action: 'cancel' };
    const questions = formQuestions(p.requestedSchema);
    if (p.mode !== 'form' || !questions.length) return { action: 'decline' };
    const unsupported = questions.filter((q) => !q.choices.length && !q.other);
    if (unsupported.length) {
      run.ctl.note(`Crew could not show the Antigravity form because it has no supported answer field for ${unsupported.map((q) => q.title).join(' / ')}.`);
      return { action: 'decline' };
    }
    const reason = (questions.length > 1 ? 'Your answer applies to every question.\n' : '') + questions.map(questionText).join('\n\n');
    const answer = await this.ask(run, 'question', reason);
    if (!answer) return { action: 'cancel' };
    const message = answer.message?.trim();
    // A decision without words answers only a form whose every question offers that word; a deny with words is still a deny.
    const quick = answer.approve ? 'Yes' : 'No';
    const offered = questions.every((q) => q.choices.some((c) => c.title.trim().toLowerCase() === quick.toLowerCase()));
    if (!answer.approve && message || !message && !offered) {
      if (answer.approve) run.ctl.note(`Antigravity's question needs an answer in words: ${questions.map((q) => q.title).join(' / ')}`);
      return { action: 'decline' };
    }
    const text = message || quick;
    const content = formAnswer(questions, text);
    if (content) return { action: 'accept', content };
    run.ctl.note(`Antigravity's form could not use the answer to ${questions.map((q) => q.title).join(' / ')}\nAnswer: ${text}`);
    return { action: 'decline' };
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    if (method === 'elicitation/create') return this.onQuestion(p ?? {});
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported by Crew`);
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const run = this.runs.get(p.sessionId);
    const toolCall = p.toolCall ?? {};
    if (run && typeof toolCall.toolCallId === 'string') {
      const call = run.calls.get(toolCall.toolCallId) ?? {};
      run.calls.set(toolCall.toolCallId, { ...call, asked: true });
    }
    // Outside a turn there is nobody to act on an answer, and a queued request would never be settled.
    if (run && (run.cancelling || run.violation || !run.sent || isTerminal(run.ctl.job))) return cancelled;
    const verdict = run ? decide(run.ctl.job.kind, run.ctl.job.cwd, toolCall, run.ctl.job.sandbox === 'read-only') : { refuse: 'unknown session' };

    let allow = verdict === 'allow';
    if (run && verdict === 'ask') {
      const grant = run.ctl.job.sandbox === 'read-only' ? undefined : commandGrant(toolCall);
      const key = grant && commandGrantKey(grant);
      if (grant && key && run.grants.has(key)) {
        allow = true;
        run.ctl.progress(`allowed for this job: ${grant.label}`);
      } else {
        const reason = describeRequest(toolCall, run.ctl.job.cwd);
        const answer = await this.ask(run, 'approval', reason, key ? grant : undefined);
        if (answer === null) return cancelled;
        allow = answer.approve;
      }
    }
    if (run && typeof verdict === 'object') {
      const what = `${verdict.refuse}: ${describeRequest(toolCall, run.ctl.job.cwd)}`;
      run.ctl.progress(`refused (${what})`);
      run.ctl.note(`The bridge refused an action outside the ${ROLE_NAMES[run.ctl.job.kind]} role (${what}). Do it another way within the role permissions, or ask the lead to reassign the work.`, { declined: true });
    }
    // Never "always": each action must come back here for Crew's role policy and job grants.
    // A refusal is for this request only, so "reject always" is used just when it is the only way to say no.
    const options: any[] = p.options ?? [];
    const option = (allow ? ['allow_once'] : ['reject_once', 'reject_always']).map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
    if (run && allow && !option) run.ctl.note(`An allowed action was not carried out because Antigravity offered no one-time approval: ${describeRequest(toolCall, run.ctl.job.cwd)}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    // Without a matching option the answer is "cancelled", which grants nothing.
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
  }
}

function newRun(ctl: JobCtl): Run {
  return { ctl, prompting: null, sent: false, cancelling: false, message: '', earlier: '', pending: [], grants: new Set(), declined: [], calls: new Map() };
}

/** The session's mode, from ACP's modes or from a config option of the mode category. */
function sessionMode(response: any): string | undefined {
  const mode = response?.modes?.currentModeId ?? configOption(response, 'mode')?.currentValue;
  return typeof mode === 'string' && mode ? mode : undefined;
}

function configOption(response: any, id: string): { currentValue?: unknown; options?: { value?: unknown }[] } | undefined {
  return response?.configOptions?.find((o: any) => o.category === id || o.id === id);
}

function sessionModel(response: any): string | undefined {
  const model = configOption(response, 'model')?.currentValue ?? response.models?.currentModelId;
  return typeof model === 'string' && model ? model : undefined;
}

/** The thinking level the session runs at; undefined for a model that offers none. */
function sessionEffort(response: any): string | undefined {
  const level = configOption(response, 'thought_level')?.currentValue;
  return typeof level === 'string' && level ? level : undefined;
}

interface FormQuestion {
  key: string;
  title: string;
  choices: { value: string; title: string }[];
  /** The answer is a list of choices. */
  many: boolean;
  /** The field that takes an answer in the user's own words, when the form has one. */
  other?: string;
}

/**
 * The questions in a form's schema. agy sends each as a property with the question as its title and the choices
 * under oneOf (anyOf inside items when several may be picked), plus a "<key>_other" field for a written answer.
 */
export function formQuestions(schema: any): FormQuestion[] {
  const properties: Record<string, any> = schema?.properties && typeof schema.properties === 'object' ? schema.properties : {};
  const written = (key: string) => key.endsWith('_other') && key.slice(0, -'_other'.length) in properties;
  return Object.entries(properties).filter(([key]) => !written(key)).map(([key, field]) => {
    const many = field?.type === 'array';
    const listed: any[] = (many ? field.items?.anyOf ?? field.items?.oneOf : field?.oneOf ?? field?.anyOf) ?? [];
    const choices = listed.filter((c) => c && c.const !== undefined).map((c) => ({ value: String(c.const), title: String(c.title ?? c.const) }));
    if (!choices.length && field?.type === 'string' && Array.isArray(field.enum)) {
      for (const value of field.enum) if (typeof value === 'string') choices.push({ value, title: value });
    }
    const otherKey = `${key}_other`;
    const other = properties[otherKey]?.type === 'string' ? otherKey : !choices.length && field?.type === 'string' ? key : undefined;
    return { key, title: String(field?.title ?? field?.description ?? key), choices, many, ...(other ? { other } : {}) };
  });
}

function questionText(question: FormQuestion): string {
  const choices = question.choices.map((choice, i) => `${i + 1}. ${choice.title}`);
  return [question.title, ...choices].join('\n');
}

/** Applies one reply to the whole form because Crew collects one answer per request. */
export function formAnswer(questions: FormQuestion[], text: string): Record<string, string | string[]> | undefined {
  const content: Record<string, string | string[]> = {};
  const said = text.toLowerCase();
  for (const question of questions) {
    const parts = question.many ? said.split(',') : [said];
    const picked = parts.map((part) => {
      const name = part.trim();
      const choice = question.choices.find((c) => c.title.trim().toLowerCase() === name) ?? (/^\d+$/.test(name) ? question.choices[Number(name) - 1] : undefined);
      return choice?.value;
    });
    if (picked.every((value) => value !== undefined)) content[question.key] = question.many ? picked : picked[0];
    else if (question.other) content[question.other] = text.trim();
    else return undefined;
  }
  return content;
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

/** A grant names a literal program and its first argument. */
function commandGrant(toolCall: { kind?: string; rawInput?: unknown; _meta?: { mcpServerName?: string; mcpToolName?: string } }): Grant | undefined {
  if (toolCall.kind !== 'execute' || toolCall._meta?.mcpServerName || toolCall._meta?.mcpToolName) return;
  // The checks below model a POSIX shell; cmd and PowerShell quote, expand and chain differently.
  if (process.platform === 'win32') return;
  const input = toolCall.rawInput;
  let rawCommand: unknown = input;
  let cwd: string | undefined;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const fields = input as Record<string, unknown>;
    const commands = COMMAND_FIELDS.filter((field) => field in fields);
    const directories = CWD_FIELDS.filter((field) => field in fields);
    if (commands.length !== 1 || directories.length > 1) return;
    // Fields agy 1.5 sends beside the command that change neither what runs nor where (seen live on 2026-11-21).
    const known = Object.keys(fields).filter((field) => !commands.includes(field) && !directories.includes(field));
    if (!known.every((field) => (field === 'WaitMsBeforeAsync' && typeof fields[field] === 'number') || (field === 'toolSummary' && typeof fields[field] === 'string'))) return;
    rawCommand = fields[commands[0]];
    if (directories.length) {
      const directory = fields[directories[0]];
      if (typeof directory !== 'string' || !directory.trim() || /[\r\n]/.test(directory)) return;
      cwd = directory;
    }
  }
  if (typeof rawCommand !== 'string') return;
  let command = rawCommand;
  // agy runs every command as `cd <workspace> && <command>`: a literal directory there is the working directory.
  const moved = /^[ \t]*cd[ \t]+([A-Za-z0-9_./][A-Za-z0-9_./+-]*)[ \t]*&&[ \t]*/.exec(command);
  if (moved) {
    if (cwd !== undefined && cwd !== moved[1]) return;
    cwd = moved[1];
    command = command.slice(moved[0].length);
  }
  if (cwd !== undefined && (!cwd.startsWith('/') || /\/\/|\/\.{1,2}(?:\/|$)/.test(cwd))) return;
  if (/[;&|`<>\r\n\0()]/.test(command)) return;
  // Variable, tilde and brace expansion turn literal text into paths the checks below cannot see.
  if (/[$~{}]/.test(command)) return;
  // A leading assignment (PATH=…, NODE_OPTIONS=…) can change what the named program runs, so it gets no grant.
  const match = /^[ \t]*([A-Za-z0-9_./+-]+)[ \t]+([A-Za-z0-9][A-Za-z0-9_.:+-]*)(?=[ \t]|$)/.exec(command);
  if (!match) return;
  const [, program, subcommand] = match;
  // Quotes and escapes can split a literal path across multiple shell fragments.
  const args = command.slice(match[0].length).replace(/['"\\]/g, '');
  if (/(?:^|[ \t=,:@])(?:-[A-Za-z]+)?\//.test(args)) return;
  if (/(?:^|[/ \t=,:@])(?:-[A-Za-z]+)?\.\.(?=$|[/ \t=,:@])/.test(args)) return;
  const name = path.posix.basename(program).toLowerCase().replace(/\.exe$/, '');
  if (['cd', 'pushd', 'popd'].includes(name)) return;
  // Programs whose job is to run another command: a grant for them would cover whatever they are given.
  if ([
    'sudo', 'doas', 'su', 'env', 'xargs', 'eval', 'exec', 'command', 'builtin', 'time', 'source', '.', 'nohup',
    'nice', 'timeout', 'gtimeout', 'caffeinate', 'watch', 'stdbuf', 'unbuffer',
    'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'busybox', 'cmd', 'powershell', 'pwsh',
    'ssh', 'arch', 'flock', 'script', 'find', 'osascript',
  ].includes(name)) return;
  return { program, subcommand, cwd, label: `running "${program} ${subcommand}" in ${cwd ?? 'the job workspace'}` };
}

function commandGrantKey({ program, subcommand, cwd }: Grant): string | undefined {
  if (cwd === undefined) return JSON.stringify([program, subcommand, cwd]);
  try {
    // Use filesystem semantics even when a symlink target contains a parent component.
    const directory = realpathSync.native(cwd);
    if (statSync(directory).isDirectory()) return JSON.stringify([program, subcommand, directory]);
  } catch {
    return undefined;
  }
}

/**
 * Role policy for a permission request.
 * - Reading, searching, and thinking are allowed for every role.
 * - Edits are refused in a review, and otherwise allowed only inside the job's workspace.
 * - Switching mode is refused: "accept-edits" was measured to apply edits outside the workspace without asking.
 * - Anything else (execute, delete, move, fetch, unknown kinds) is refused for a reviewer or editor. For an engineer it is
 *   the user's call, provided the request says exactly what it will do.
 * - A read-only job changes nothing whatever its role: a question is answered by the engineer, with a reviewer's limits.
 */
export function decide(role: JobKind, cwd: string, toolCall: ToolCall, readOnly = false): 'allow' | 'ask' | { refuse: string } {
  if (toolCall._meta?.mcpServerName === 'crew' && ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes', 'rate'].includes(toolCall._meta.mcpToolName ?? '')) return 'allow';
  const kind = toolCall.kind ?? 'other';
  // The daemon's secret is not a worker's to read, whatever the role. Commands are the user's to approve as before.
  const secret = tokenFile(HOME);
  if ((toolCall.locations ?? []).some((l) => l.path && path.resolve(l.path) === secret)) return { refuse: 'the Crew token file' };
  // A qualified title can identify an MCP call, but must never disguise a command. One agy process serves every job, and
  // each job's server is another one named crew to it: from the second on it tells them apart by eight hex digits in the name.
  const input = toolCall.rawInput;
  const command = typeof input === 'string' || (input !== null && typeof input === 'object' && COMMAND_FIELDS.some((field) => field in input));
  if (!toolCall._meta?.mcpServerName && !toolCall._meta?.mcpToolName && kind === 'other' && !command
    && /^(?:Run )?mcp_crew_(?:[0-9a-f]{8}_)?(?:ask_lead|lead_answers|siblings|search|recent_changes|rate)$/.test(toolCall.title ?? '')) return 'allow';
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
  if (!paths.every((f) => isInside(cwd, f))) return { refuse: 'edit outside the workspace' };
  return paths.some((f) => isGitPath(cwd, f)) ? { refuse: 'edit inside .git' } : 'allow';
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
