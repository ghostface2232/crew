import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { tokenFile } from '../auth.ts';
import { browserProfile } from '../browser.ts';
import { agentCommand, agentEnv, HOME, VERSION } from '../config.ts';
import type { Config } from '../config.ts';
import { isTerminal, noteLeadDecline } from '../jobs.ts';
import type { Adapter, JobCtl, JobKind } from '../jobs.ts';
import { isGitPath, isInside } from '../git.ts';
import { RPC_TIMEOUT_MS, RpcError, RpcPeer } from '../rpc.ts';
import { pickEffort, pickModel } from '../tiers.ts';

type Grant = { program: string; subcommand: string; cwd?: string; label: string };

class Session {
  id: string;
  loaded = false;
  mode?: { id: string };
  grants = new Set<string>();
  /** The lead's latest turn, including one queued behind the previous turn's close. */
  turn?: Turn;
  /** The turn agy still holds. Only its prompts settling or a confirmed close releases it. */
  owner?: Turn;
  private tail = Promise.resolve();

  constructor(id: string) { this.id = id; }

  enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.then(() => {}, () => {});
    return next;
  }

  release(turn: Turn): void {
    if (this.owner === turn) this.owner = undefined;
  }

  end(turn: Turn, phase: 'stopping' | 'stopped' | 'ended' = 'ended'): void {
    turn.phase = phase;
    if (this.turn === turn) this.turn = undefined;
    turn.handover?.resolve();
  }
}

/** How many times a turn that a role refusal ended with nothing is sent the reason and continued. */
const REFUSAL_RESENDS = 2;
const TURN_ENDED = new Error('Antigravity is ending this turn. Send the message again once it has ended.');
type TurnPhase = 'starting' | 'working' | 'finishing' | 'cancelling' | 'stopping' | 'stopped' | 'ended';

class Turn {
  readonly ctl: JobCtl;
  private readonly controller: JobCtl;
  private readonly number: number;
  phase: TurnPhase = 'starting';
  message = '';
  earlier = '';
  pending: { type: 'approval' | 'question'; reason: string; grant?: Grant; resolve: (answer: Answer | null) => void }[] = [];
  declined: string[] = [];
  /** Turns resent after a role refusal ended one with nothing, carried to each continuation so a repeat cannot loop. */
  refusalResends = 0;
  calls = new Map<string, ToolCall & { asked?: boolean; checked?: boolean; mode?: string }>();
  prompts: Promise<PromptAnswer>[] = [];
  /** Steers wait for each other without occupying the session queue needed by mode changes and close. */
  nextSteer = Promise.resolve();
  handover?: PromiseWithResolvers<void>;
  cancelViolation?: string;
  readonly drained = Promise.withResolvers<void>();
  abandonControl?: () => void;

  constructor(ctl: JobCtl, number = ctl.job.turns) {
    this.number = number;
    this.controller = ctl;
    // Replies, timers and permission answers can outlive their turn. None can publish to its successor.
    this.ctl = new Proxy(ctl, {
      get: (target, key: keyof JobCtl) => {
        const value = target[key];
        if (typeof value !== 'function') return value;
        return (...args: unknown[]) => { if (this.alive) Reflect.apply(value, target, args); };
      },
    });
  }

  continuation(): Turn {
    const next = new Turn(this.controller, this.number);
    next.refusalResends = this.refusalResends;
    return next;
  }

  get alive(): boolean {
    return this.phase !== 'ended' && this.phase !== 'stopping' && this.phase !== 'stopped' && this.controller.job.turns === this.number && !isTerminal(this.controller.job);
  }

  /** Session mutations and sends run inside their turn's scope, including the application of RPC answers. */
  act<T>(work: () => T): T {
    if (!this.alive || this.phase === 'cancelling') throw TURN_ENDED;
    return work();
  }

  async control(peer: RpcPeer, method: string, params: object, apply?: (res: any) => void): Promise<any> {
    const request = this.act(() => peer.request(method, params, RPC_TIMEOUT_MS));
    const abandoned = Promise.withResolvers<never>();
    this.abandonControl = () => abandoned.reject(TURN_ENDED);
    try {
      const res = await Promise.race([request, abandoned.promise]);
      return this.act(() => { apply?.(res); return res; });
    } finally {
      this.abandonControl = undefined;
    }
  }
}

type PromptAnswer = { res?: any; error?: Error; refused?: boolean };

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
const CANCEL_TIMEOUT_MS = 5_000;
const CLOSE_QUEUE_GRACE_MS = 2_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;

/**
 * Drives Antigravity through `agy acp`, its Agent Client Protocol server.
 * ACP is the interface Google documents for third-party clients; the headless
 * `agy -p` mode is documented as unsupported inside other agents.
 */
export class AntigravityAdapter implements Adapter {
  private peer: RpcPeer | null = null;
  private starting: Promise<RpcPeer> | null = null;
  private sessions = new Map<string, Session>();
  private restoreMethod: 'session/resume' | 'session/load' | null = null;
  private canClose = false;
  /** The server takes instructions as an addition to its system prompt. */
  private appendsPrompt = false;
  private lastUsed = Date.now();
  private config: Config;
  /** The Seatbelt profile the server runs under, when it is confined (`serverProfile`). */
  private profile: string | null;

  constructor(config: Config, profile: string | null = null) {
    this.config = config;
    this.profile = profile;
    setInterval(() => {
      const busy = [...this.sessions.values()].some((session) => session.turn?.alive);
      if (this.peer && !busy && Date.now() - this.lastUsed > IDLE_SHUTDOWN_MS) this.peer.close();
    }, 60_000).unref();
  }

  async start(ctl: JobCtl): Promise<void> {
    const turn = new Turn(ctl);
    const peer = await this.ensure();
    if (!turn.alive) return;
    const res = await peer.request('session/new', { cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)], ...this.instructions(ctl) }, RPC_TIMEOUT_MS).catch((err) => {
      if (turn.alive) throw err;
    });
    if (!turn.alive) {
      if (res?.sessionId) await this.close(peer, new Session(res.sessionId)).catch(() => {});
      return;
    }
    ctl.capabilities({
      filesystem: ctl.job.sandbox === 'read-only' ? 'read-only; Crew refuses every edit'
        : this.profile ? "edits inside the workspace only; a sandbox holds commands to Crew's worktrees, temp and agy's own state"
          : 'edits inside the workspace only; Crew refuses the rest',
      // A confined engineer's commands run unasked, in a sandbox that leaves the network open.
      network: this.profile && ctl.job.sandbox !== 'read-only' && ctl.job.kind === 'delegate' ? 'on' : 'agent-managed',
      ...(this.profile ? { confined: true } : {}),
      plugins: [],
    });
    const session = this.session(res.sessionId);
    session.loaded = true;
    session.grants.clear();
    session.turn = turn;
    ctl.session(session.id);
    this.noteResponseMode(session, res, undefined);
    // Without a system prompt addition, the role travels with the first prompt.
    await this.begin(peer, session, turn, this.appendsPrompt ? ctl.job.prompt : `${ctl.job.instructions}\n\n${ctl.job.prompt}`, async () => {
      const wanted = ctl.job.model ?? (ctl.job.agentDefault ? undefined : this.config.antigravity.model);
      // A tier names a family ("hydrogen"); the session lists the exact values this account has.
      // A family the session does not list is left to the agent's default; a model named outright is still sent, so a typo shows.
      const listed = wanted ? pickModel(res.configOptions?.find((o: any) => o.category === 'model' || o.id === 'model')?.options, wanted) : undefined;
      const model = listed ?? (ctl.job.tier ? undefined : wanted);
      let selected = model ? await this.configure(peer, session, turn, 'model', model) : res;
      // The levels differ by model, so they are read from the session after the model is set.
      const level = ctl.job.effort ? pickEffort(configOption(selected, 'thought_level')?.options, ctl.job.effort) : undefined;
      if (level && level !== configOption(selected, 'thought_level')?.currentValue) selected = await this.configure(peer, session, turn, 'thought_level', level);
      turn.ctl.model(sessionModel(selected) ?? model, sessionEffort(selected));
    });
  }

  /** Sets a session option. Its answer lists every option, the mode among them, so it reports the mode too. */
  private configure(peer: RpcPeer, session: Session, turn: Turn, configId: string, value: string): Promise<any> {
    const before = session.mode;
    return turn.control(peer, 'session/set_config_option', { sessionId: session.id, configId, value }, (res) => this.noteResponseMode(session, res, before));
  }

  private session(id: string): Session {
    let session = this.sessions.get(id);
    if (!session) this.sessions.set(id, session = new Session(id));
    return session;
  }

  /**
   * The role as an addition to the system prompt, where the server takes one: there it holds for every turn and is
   * not mixed into the task. agy 1.5.9 kept it across a resume in a new process; it is sent again on restore for servers that do not.
   */
  private instructions(ctl: JobCtl): { _meta?: unknown } {
    return this.appendsPrompt ? { _meta: { antigravity: { systemPrompt: { append: ctl.job.instructions } } } } : {};
  }

  async reply(ctl: JobCtl, message: string): Promise<void> {
    const session = this.session(ctl.job.sessionId!);
    if (session.turn?.alive) return this.steer(session, session.turn, message);
    const turn = new Turn(ctl);
    session.turn = turn;
    try {
      const peer = await this.ensure();
      await this.begin(peer, session, turn, message, async () => {
        if (session.loaded) return;
        if (!this.restoreMethod) throw new Error(`This Antigravity server cannot restore sessions. ${this.profile ? 'Start a new job: the Antigravity CLI cannot open a confined session.' : 'Continue it from the Antigravity CLI.'}`);
        const before = session.mode;
        const res = await turn.control(peer, this.restoreMethod, { sessionId: session.id, cwd: ctl.job.cwd, mcpServers: [crewServer(ctl)], ...this.instructions(ctl) }, (res) => {
          session.loaded = true;
          this.noteResponseMode(session, res, before);
        });
        // A restored session can come back on another model than the job ran on (seen with agy 1.5.14: a job on
        // Argon resumed on Neon), so the model is set again, then the level, whose choices depend on the model.
        const wanted = ctl.job.resolvedModel ?? ctl.job.model;
        const model = wanted && sessionModel(res) !== wanted ? pickModel(configOption(res, 'model')?.options, wanted) : undefined;
        let restored = model && model !== sessionModel(res) ? await this.configure(peer, session, turn, 'model', model) : res;
        const level = ctl.job.effort ? pickEffort(configOption(restored, 'thought_level')?.options, ctl.job.effort) : undefined;
        if (level && level !== configOption(restored, 'thought_level')?.currentValue) restored = await this.configure(peer, session, turn, 'thought_level', level);
        turn.ctl.model(sessionModel(restored) ?? sessionModel(res) ?? ctl.job.resolvedModel ?? ctl.job.model ?? this.config.antigravity.model, sessionEffort(restored) ?? ctl.job.resolvedEffort);
      });
    } catch (err) {
      if (turn.alive) throw err;
    }
  }

  async answer(ctl: JobCtl, approve: boolean, message?: string, opts?: { forJob?: boolean; by?: 'lead' }): Promise<void> {
    const session = this.sessions.get(ctl.job.sessionId ?? '');
    const turn = session?.turn;
    const request = turn?.pending[0];
    if (!session || !turn?.alive || !request) throw new Error('The request this job was waiting on is no longer pending.');
    const grant = opts?.forJob && ctl.job.sandbox !== 'read-only' ? request.grant : undefined;
    const key = grant && commandGrantKey(grant);
    if (opts?.forJob && !key) throw new Error('This request cannot be allowed for the whole job. Approve or deny it.');
    turn.pending.shift();
    if (request.type === 'approval' && !approve) {
      // A permission answer carries no text, and agy 1.5.9 refuses a prompt while one is open and ends the turn
      // on a rejection. So the reason waits for the turn to end and is then sent as the next prompt.
      if (opts?.by === 'lead') {
        turn.declined.push(noteLeadDecline(ctl, request.reason, message!.trim()));
        // What the worker wrote so far led up to the refused action, so it is no reply to the reason.
        turn.message = '';
        turn.earlier = '';
      }
      else ctl.note(`The user declined an action: ${request.reason}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    }
    request.resolve({ approve, message });
    if (approve && grant && key) {
      session.grants.add(key);
      ctl.progress(`allowed for this job: ${grant.label}`);
      for (let i = turn.pending.length - 1; i >= 0; i--) {
        const queued = turn.pending[i];
        if (!queued.grant || commandGrantKey(queued.grant) !== key) continue;
        turn.pending.splice(i, 1);
        queued.resolve({ approve: true });
      }
    }
    const next = turn.pending[0];
    if (next) ctl.waiting(next.type, next.reason, next.grant && commandGrantKey(next.grant) ? next.grant.label : undefined);
    else ctl.resumed();
  }

  async cancel(ctl: JobCtl): Promise<void> {
    const session = this.sessions.get(ctl.job.sessionId ?? '');
    const turn = session?.turn;
    if (!session || !turn?.alive) return;
    if (session.owner !== turn) {
      session.end(turn);
      return;
    }
    turn.phase = 'cancelling';
    drop(turn);
    turn.ctl.resumed();
    await this.interrupt(session, turn);
  }

  shutdown(): void {
    this.peer?.close();
  }

  /** Take the turn before setup. Only the send is serialized; its answer stays open for steers and cancel. */
  private begin(peer: RpcPeer, session: Session, turn: Turn, text: string, prepare?: () => Promise<void>): Promise<void> {
    return session.enqueue(() => {
      if (!turn.alive) return;
      if (session.owner) throw new Error('Antigravity has not yet stopped the turn Crew ended. Send the message again in a moment.');
      session.owner = turn;
      turn.ctl.phase('working');
      void session.enqueue(async () => {
        try {
          await turn.act(() => prepare?.());
          await this.inAskingMode(peer, session, turn, () => {
            turn.phase = 'working';
            this.sendPrompt(peer, session, turn, text);
            void this.collect(peer, session, turn);
          });
        } catch (err) {
          turn.drained.resolve();
          session.release(turn);
          this.finish(peer, session, turn, { error: err as Error });
        }
      });
    });
  }

  private async collect(peer: RpcPeer, session: Session, turn: Turn): Promise<void> {
    let outcome: PromptAnswer = {};
    for (const prompt of turn.prompts) {
      const answer = await prompt;
      if (answer.refused) continue;
      outcome = answer;
      if (answer.error && turn.phase === 'working') this.finish(peer, session, turn, answer);
      this.counted(turn, answer.res?.usage);
    }
    turn.drained.resolve();
    try {
      if (!turn.alive || turn.phase !== 'working') {
        if (session.owner === turn && turn.phase === 'stopped') {
          void session.enqueue(() => this.close(peer, session)).catch(() => {});
        }
        return;
      }
      turn.phase = 'finishing';
      await this.enforceMode(peer, session, turn, () => this.finish(peer, session, turn, outcome));
    } finally {
      session.release(turn);
    }
  }

  private finish(peer: RpcPeer, session: Session, turn: Turn, answer: PromptAnswer): void {
    if (!turn.alive || turn.phase === 'cancelling') return;
    drop(turn);
    const { ctl } = turn;
    const report = turn.message.trim() || turn.earlier;
    if (answer.res?.stopReason === 'end_turn' && !report && turn.declined.length) {
      ctl.resumed();
      session.release(turn);
      session.end(turn);
      session.turn = turn.continuation();
      if (turn.declined.some((note) => note.startsWith('The bridge refused'))) session.turn.refusalResends++;
      void this.begin(peer, session, session.turn, turn.declined.join('\n\n'));
      return;
    }
    void session.enqueue(() => this.close(peer, session)).catch(() => {});
    if (answer.error) {
      const err = answer.error;
      const detail = `${err.message}${err instanceof RpcError && err.data ? ` ${JSON.stringify(err.data)}` : ''}`;
      ctl.fail(detail, { limit: LIMIT_PATTERN.test(detail) });
    } else if (answer.res?.stopReason === 'cancelled') ctl.cancelled();
    else if (answer.res?.stopReason === 'end_turn') ctl.done(plainLinks(report));
    else ctl.fail(`Antigravity stopped early: ${answer.res?.stopReason}`);
    session.end(turn);
  }

  private async close(peer: RpcPeer, session: Session): Promise<void> {
    if (!this.canClose || this.peer !== peer) return;
    try {
      await peer.request('session/close', { sessionId: session.id }, RPC_TIMEOUT_MS);
    } catch (err) {
      if (!(err instanceof RpcError && err.code === -32002)) throw err;
    }
    session.loaded = false;
    session.mode = undefined;
    session.owner = undefined;
  }

  /** Cancel goes straight to agy. The close is ordered with session setup, with a bounded wait for a stuck option RPC. */
  private interrupt(session: Session, turn: Turn): Promise<void> {
    const peer = this.peer;
    if (!peer) return Promise.resolve();
    peer.notify('session/cancel', { sessionId: session.id });
    const stopped = Promise.race([turn.drained.promise.then(() => true), delay(CANCEL_TIMEOUT_MS, false, { ref: false })]);
    const watchdog = setTimeout(() => turn.abandonControl?.(), CANCEL_TIMEOUT_MS + CLOSE_QUEUE_GRACE_MS).unref();
    const result = Promise.withResolvers<void>();
    void session.enqueue(async () => {
      const confirmed = await stopped;
      try {
        if (confirmed) result.resolve();
        else if (!this.canClose) throw new Error('Antigravity did not confirm cancellation. The job is still active.');
        await this.close(peer, session);
        session.end(turn);
        result.resolve();
      } catch (err) {
        if (confirmed || session.owner !== turn) {
          session.end(turn);
          result.resolve();
        } else {
          if (turn.cancelViolation) turn.ctl.fail(turn.cancelViolation);
          if (turn.phase === 'stopping' || turn.cancelViolation) session.end(turn, 'stopped');
          else {
            turn.phase = 'working';
            void this.enforceMode(peer, session, turn);
          }
          result.reject(err);
        }
      } finally {
        clearTimeout(watchdog);
      }
    });
    return result.promise;
  }

  /**
   * agy reports each prompt's tokens; a job's are the sum over its prompts. Its input excludes what was read from cache.
   * A turn that ended without its answer cannot have the tokens added later: they would count toward the next turn.
   */
  private counted(turn: Turn, usage: any): void {
    if (!usage || typeof usage.totalTokens !== 'number') return;
    const { ctl } = turn;
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
  private async steer(session: Session, turn: Turn, message: string): Promise<void> {
    const open = () => {
      if (turn.pending.length) throw new Error('Antigravity is waiting for an approval or an answer, and takes no message until it has one. Answer it first, or cancel.');
      if (turn.phase === 'starting') throw new Error('Antigravity is still starting this turn. Send the message again in a moment.');
      if (!turn.alive || turn.phase !== 'working') throw new Error('Antigravity is ending this turn. Send the message again once it has ended.');
    };
    open();
    const peer = this.peer!;
    const previous = turn.nextSteer;
    const handover = Promise.withResolvers<void>();
    turn.nextSteer = handover.promise;
    const { next } = await previous.then(() => {
      open();
      return session.enqueue(() => this.inAskingMode(peer, session, turn, () => {
        open();
        return { next: this.sendPrompt(peer, session, turn, message, handover) };
      }));
    }).catch((err) => {
      handover.resolve();
      throw err;
    });
    const answer = await Promise.race([next, delay(2_000, undefined, { ref: false })]);
    if (answer?.refused) throw answer.error;
    if (!answer) void next.then((late) => {
      if (late.refused) turn.ctl.note(`A message sent during the turn did not reach Antigravity: ${late.error!.message}`);
    });
    turn.ctl.progress('message added to the running turn');
  }

  private sendPrompt(peer: RpcPeer, session: Session, turn: Turn, text: string, handover?: PromiseWithResolvers<void>): Promise<PromptAnswer> {
    turn.handover = handover;
    const answer = peer.request('session/prompt', { sessionId: session.id, prompt: [{ type: 'text', text }] }).then(
      (res) => {
        // Only the preceding request's end_turn confirms the pending steer.
        if (res?.stopReason === 'end_turn' && turn.handover !== handover) {
          turn.handover?.resolve();
          turn.handover = undefined;
        }
        return { res };
      },
      (error: Error) => {
        const refused = !!handover && turn.handover === handover && peer.alive;
        if (refused) {
          handover.resolve();
          turn.handover = undefined;
        }
        return { error, refused };
      },
    );
    turn.prompts.push(answer);
    return answer;
  }

  private noteResponseMode(session: Session, response: any, before?: { id: string }): void {
    const mode = sessionMode(response);
    if (mode && (session.mode === before || mode !== ASKING_MODE)) session.mode = { id: mode };
  }

  private async inAskingMode<T>(peer: RpcPeer, session: Session, turn: Turn, work: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const known = session.mode;
      if (!known || known.id === ASKING_MODE) return turn.act(work);
      if (attempt === 3) throw new Error(`Antigravity kept switching its session out of "${ASKING_MODE}" mode, most recently to "${known.id}".`);
      try {
        await turn.control(peer, 'session/set_mode', { sessionId: session.id, modeId: ASKING_MODE }, () => {
          if (session.mode === known) session.mode = { id: ASKING_MODE };
        });
      } catch (err) {
        if (err === TURN_ENDED) throw err;
        throw new Error(`Antigravity's session is in "${known.id}" mode, where it does not ask before edits and commands, and it refused to switch to "${ASKING_MODE}": ${(err as Error).message}`);
      }
    }
  }

  /** A turn cannot finish until every reported switch ahead of it on the session queue has been undone. */
  private enforceMode(peer: RpcPeer, session: Session, turn: Turn, work = () => {}): Promise<void> {
    return session.enqueue(async () => {
      try {
        await this.inAskingMode(peer, session, turn, work);
      } catch (err) {
        if (err !== TURN_ENDED) this.stop(session, turn, (err as Error).message);
      }
    });
  }

  private stop(session: Session, turn: Turn, message: string): void {
    if (!turn.alive) return;
    if (turn.phase === 'cancelling') {
      turn.cancelViolation ??= message;
      return;
    }
    drop(turn);
    void this.interrupt(session, turn).catch(() => {});
    turn.ctl.fail(message);
    session.end(turn, 'stopping');
  }

  /**
   * agy runs some actions without asking: commands that the user's own Antigravity allow rules cover, and file reads
   * that its Non-Workspace Access setting permits. Crew sees them only once they have run, so it checks them against
   * the role then. One that the role would refuse stops the turn; an engineer's command is the user's own rule, so it is reported.
   */
  private unasked(session: Session, turn: Turn, call: ToolCall, mode?: string): void {
    const { ctl } = turn;
    const { job } = ctl;
    // Judged as the request would be without the sandbox: what ran unasked is reported either way.
    let verdict = decide(job.kind, job.cwd, call, job.sandbox === 'read-only');
    // A report may omit the input that a request must carry. That rule keeps the user from approving what they cannot
    // see; here nothing is left to approve, so the action is reported like any other the engineer ran unasked.
    if (typeof verdict === 'object' && verdict.refuse === `${call.kind ?? 'other'} request without its input`) verdict = 'ask';
    if (verdict === 'allow') return;
    const what = `${call.kind ?? 'other'}: ${call.title ?? 'tool call'}`;
    // In the asking mode only the user's own rules let an action through; after a switch, the switch did.
    const switched = mode && mode !== ASKING_MODE && `its session had switched to "${mode}" mode`;
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
    const violation = CHANGING_KINDS.includes(call.kind ?? '') || verdict.refuse === 'the Crew token file';
    ctl.progress(`${violation && turn.phase !== 'cancelling' ? 'stopped' : 'reported'}: ${message}`);
    if (!violation || turn.phase === 'cancelling') ctl.note(message);
    if (!violation) return;
    const reasonToStop = `${message} Crew stopped the turn. ${switched
      ? 'Crew could not keep the session in its asking mode, so give this role to another agent if it happens again.'
      : "Narrow the matching allow rule or Non-Workspace Access in Antigravity's /permissions and /config, or give this role to another agent."}`;
    this.stop(session, turn, reasonToStop);
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
    const env = this.profile ? confinedEnv(agentEnv()) : agentEnv();
    const { bin, args, shell } = agentCommand(this.config.antigravity.bin, ['acp'], env);
    // Confined, the server and every command it runs share one sandbox, and it keeps its state in a folder of its own.
    // agy's own terminal sandbox cannot start inside another, and its ACP sessions do not let it write the workspace
    // (agy 1.5.14), so it is turned off here.
    const child = this.profile
      ? spawn('/usr/bin/sandbox-exec', ['-p', this.profile, bin, ...(args ?? []), '--sandbox=false', '--app-data-dir', CONFINED_STATE], { env, stdio: ['pipe', 'pipe', 'pipe'] })
      : spawn(bin, args, { env, shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const peer = new RpcPeer(child, {
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onExit: () => {
        if (this.peer === peer) this.peer = null;
        for (const session of this.sessions.values()) if (session.turn) drop(session.turn);
        this.sessions.clear();
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
    // Kept for every session, between turns and during a restore too; the next prompt undoes a switch. The mode is also
    // one of the session's options, so an options update reports it.
    const kind = p.update?.sessionUpdate;
    const reported = kind === 'current_mode_update' ? p.update.currentModeId : kind === 'config_option_update' ? sessionMode(p.update) : undefined;
    const session = this.session(p.sessionId);
    if (typeof reported === 'string') session.mode = { id: reported };
    const turn = session.owner;
    if (!turn?.alive || !turn.prompts.length) return;
    const { ctl } = turn;
    this.lastUsed = Date.now();
    ctl.activity();
    const update = p.update ?? {};
    localLocations(update);
    if (typeof reported === 'string' && reported !== ASKING_MODE && this.peer) {
      const peer = this.peer;
      ctl.progress(`Antigravity switched to "${reported}" mode; switching back to "${ASKING_MODE}"`);
      void this.enforceMode(peer, session, turn);
    }

    switch (update.sessionUpdate) {
      case 'config_option_update': {
        const model = sessionModel(update);
        const hasConfig = Array.isArray(update.configOptions);
        if (model || hasConfig) ctl.model(model ?? ctl.job.resolvedModel, hasConfig ? sessionEffort(update) : ctl.job.resolvedEffort);
        break;
      }
      case 'agent_message_chunk':
        if (update.content?.type === 'text') turn.message += update.content.text;
        ctl.phase('writing');
        break;
      case 'agent_thought_chunk':
        ctl.phase('thinking');
        break;
      case 'tool_call':
        // Text before a tool call is narration; the report is what follows the last one.
        if (turn.message.trim()) turn.earlier = turn.message.trim();
        turn.message = '';
        ctl.progress(describeCall(update));
        this.track(session, turn, update);
        this.touched(turn, update);
        break;
      case 'tool_call_update':
        if (update.status === 'failed') ctl.progress(`failed: ${update.title ?? 'tool call'}`);
        else ctl.activity();
        this.track(session, turn, update);
        this.touched(turn, update);
        break;
      case 'current_mode_update':
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

  /** Records the files a completed call wrote, from all agy said about it: the completion may carry only its status. */
  private touched(turn: Turn, update: any): void {
    if (update.status !== 'completed') return;
    const call = (typeof update.toolCallId === 'string' && turn.calls.get(update.toolCallId)) || update;
    if (call.kind === 'read') return;
    for (const location of call.locations ?? []) if (location?.path) turn.ctl.touched(location.path);
  }

  /** Merges what agy reports about a tool call, and checks one that ran without coming to Crew first. */
  private track(session: Session, turn: Turn, update: any): void {
    const id = update.toolCallId;
    if (typeof id !== 'string') return;
    const call = turn.calls.get(id) ?? { mode: session.mode?.id };
    // An ACP update replaces the fields it carries.
    for (const key of ['kind', 'title', 'locations', 'rawInput', '_meta'] as const) if (update[key] !== undefined) (call as any)[key] = update[key];
    turn.calls.set(id, call);
    // agy reports a call as in progress before it asks, so only a completed one is known to have run unasked. A failed
    // one may never have run, and calls end failed when the turn is cancelled.
    if (update.status === 'completed' && !call.asked && !call.checked) {
      call.checked = true;
      this.unasked(session, turn, call, call.mode);
    }
  }

  /** Puts a request before the user and resolves with their answer, or null once the turn can no longer use one. */
  private ask(turn: Turn, type: 'approval' | 'question', reason: string, grant?: Grant): Promise<Answer | null> {
    return new Promise((resolve) => {
      turn.pending.push({ type, reason, grant, resolve });
      if (turn.pending.length === 1) turn.ctl.waiting(type, reason, grant?.label);
    });
  }

  /** A question the agent asks through a form. The user answers it, as they do a Codex worker's. */
  private async onQuestion(p: any): Promise<unknown> {
    const session = this.sessions.get(p.sessionId);
    const turn = session?.owner;
    if (!turn?.alive || turn.phase !== 'working') return { action: 'cancel' };
    const questions = formQuestions(p.requestedSchema);
    if (p.mode !== 'form' || !questions.length) return { action: 'decline' };
    const unsupported = questions.filter((q) => !q.choices.length && !q.other);
    if (unsupported.length) {
      turn.ctl.note(`Crew could not show the Antigravity form because it has no supported answer field for ${unsupported.map((q) => q.title).join(' / ')}.`);
      return { action: 'decline' };
    }
    const reason = (questions.length > 1 ? 'Your answer applies to every question.\n' : '') + questions.map(questionText).join('\n\n');
    const answer = await this.ask(turn, 'question', reason);
    if (!answer || !turn.alive) return { action: 'cancel' };
    const message = answer.message?.trim();
    // A decision without words answers only a form whose every question offers that word; a deny with words is still a deny.
    const quick = answer.approve ? 'Yes' : 'No';
    const offered = questions.every((q) => q.choices.some((c) => c.title.trim().toLowerCase() === quick.toLowerCase()));
    if (!answer.approve && message || !message && !offered) {
      if (answer.approve) turn.ctl.note(`Antigravity's question needs an answer in words: ${questions.map((q) => q.title).join(' / ')}`);
      return { action: 'decline' };
    }
    const text = message || quick;
    const content = formAnswer(questions, text);
    if (content) return { action: 'accept', content };
    turn.ctl.note(`Antigravity's form could not use the answer to ${questions.map((q) => q.title).join(' / ')}\nAnswer: ${text}`);
    return { action: 'decline' };
  }

  private async onRequest(method: string, p: any): Promise<unknown> {
    if (method === 'elicitation/create') return this.onQuestion(p ?? {});
    if (method !== 'session/request_permission') throw new RpcError(-32601, `${method} is not supported by Crew`);
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const session = this.sessions.get(p.sessionId);
    const turn = session?.owner;
    const toolCall = p.toolCall ?? {};
    localLocations(toolCall);
    if (turn && typeof toolCall.toolCallId === 'string') {
      const call = turn.calls.get(toolCall.toolCallId) ?? {};
      turn.calls.set(toolCall.toolCallId, { ...call, asked: true });
    }
    // Outside a turn there is nobody to act on an answer, and a queued request would never be settled.
    if (!session || !turn?.alive || turn.phase !== 'working') return cancelled;
    const verdict = decide(turn.ctl.job.kind, turn.ctl.job.cwd, toolCall, turn.ctl.job.sandbox === 'read-only', this.profile !== null);

    let allow = verdict === 'allow';
    if (verdict === 'ask') {
      const grant = turn.ctl.job.sandbox === 'read-only' ? undefined : commandGrant(toolCall);
      const key = grant && commandGrantKey(grant);
      if (grant && key && session.grants.has(key)) {
        allow = true;
        turn.ctl.progress(`allowed for this job: ${grant.label}`);
      } else {
        const reason = describeRequest(toolCall, turn.ctl.job.cwd);
        const answer = await this.ask(turn, 'approval', reason, key ? grant : undefined);
        if (answer === null || !turn.alive) return cancelled;
        allow = answer.approve;
      }
    }
    if (typeof verdict === 'object') {
      const what = `${verdict.refuse}: ${describeRequest(toolCall, turn.ctl.job.cwd)}`;
      const note = `The bridge refused an action outside the ${ROLE_NAMES[turn.ctl.job.kind]} role (${what}). Do it another way within the role permissions, or ask the lead to reassign the work.`;
      turn.ctl.progress(`refused (${what})`);
      turn.ctl.note(note, { declined: true });
      // agy ends a turn on a rejection, often before the worker has done anything, and the rejection carries no
      // words. As with the lead's decline, the reason then goes back as the next prompt so the work goes on, a few
      // times at most, so a worker that keeps trying the same thing ends with the refusal in its notes.
      if (turn.refusalResends < REFUSAL_RESENDS && !turn.declined.includes(note)) turn.declined.push(note);
    }
    // Never "always": each action must come back here for Crew's role policy and job grants.
    // A refusal is for this request only, so "reject always" is used just when it is the only way to say no.
    const options: any[] = p.options ?? [];
    const option = (allow ? ['allow_once'] : ['reject_once', 'reject_always']).map((kind) => options.find((o) => o.kind === kind)).find(Boolean);
    if (allow && !option) turn.ctl.note(`An allowed action was not carried out because Antigravity offered no one-time approval: ${describeRequest(toolCall, turn.ctl.job.cwd)}\nDo it another way within the job permissions, or report what could not be verified.`, { declined: true });
    // Without a matching option the answer is "cancelled", which grants nothing.
    return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled;
  }
}

/**
 * What a confined server may not read: where credentials for other services usually live. It is a list, not a wall:
 * the keychain stays reachable, since agy reads its own sign-in from it (without `~/Library/Keychains` every session
 * fails with "Authentication required"), and with it whatever a keychain helper hands out without a prompt.
 */
const PRIVATE_PATHS = [
  '.ssh', '.aws', '.azure', '.gnupg', '.kube', '.docker', '.netrc', '.git-credentials', '.pypirc', '.codex',
  '.config/gh', '.config/gcloud', '.claude/.credentials.json',
];
/** agy takes its state folder only as a name under `~/.gemini`. The confined server's is its own. */
const CONFINED_STATE = 'antigravity-crew';
/** Variables agy signs in with, kept where the rest that look like secrets are dropped. */
const AGY_SIGN_IN = ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'];

/**
 * The environment of a confined server, and so of its commands, which run unasked with the network open: without the
 * variables that look like secrets (the names Codex's own shell policy drops) and without the SSH agent.
 */
export function confinedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => AGY_SIGN_IN.includes(name) || (name !== 'SSH_AUTH_SOCK' && !/KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(name))));
}

/**
 * The sandbox for an `agy acp` server on macOS, and so for every command it runs: agy starts its commands itself, and
 * neither lets a client run them (it ignores ACP's terminal capability) nor lets its own terminal sandbox write an ACP
 * session's workspace (agy 1.5.14, measured 2026-11-23). Writes are held to Crew's worktrees and evidence, the temp
 * directories and a state folder the server has to itself, so nothing an agy outside the sandbox runs or reads is in
 * reach. The network stays open, since the server needs it to reach its model. It is there to keep a command's
 * writes where they belong, not to keep a determined one from reading: see docs/sandbox.md for what stays reachable.
 * Null when a path cannot be written into a profile.
 */
export function serverProfile(home: string = HOME, user: string = os.homedir(), tmp: string = os.tmpdir(), agent: string | undefined = process.env.SSH_AUTH_SOCK): string | null {
  const real = (file: string) => {
    try {
      return realpathSync(file);
    } catch {
      return file;
    }
  };
  const both = (file: string) => [...new Set([file, real(file)])];
  const quote = (value: string) => JSON.stringify(value);
  const pattern = (dir: string) => dir.replace(/[.*+?^${}()|[\]]/g, '\\$&');
  const worktrees = path.join(home, 'worktrees');
  const evidence = path.join(home, 'evidence');
  const state = path.join(user, '.gemini', CONFINED_STATE);
  if ([home, worktrees, evidence, state, tmp, agent ?? ''].some((dir) => both(dir).some((file) => /["\\\r\n]/.test(file)))) return null;
  return [
    browserProfile([worktrees, evidence, state, tmp, '/tmp'], [tokenFile(home)]),
    // A home under a temp directory would have its ledger and settings writable with it.
    ...both(home).map((dir) => `(deny file-write* (subpath ${quote(dir)}))`),
    ...[worktrees, evidence].flatMap(both).map((dir) => `(allow file-write* (subpath ${quote(dir)}))`),
    // A worktree is <worktrees>/<repository>/<job>/<name>. The bridge runs git in it outside the sandbox, so neither
    // its .git pointer nor any folder above it may be written: a renamed folder brings a .git of its own with it.
    ...both(worktrees).flatMap((dir) => [
      `(deny file-write* (regex #"^${pattern(dir)}(/[^/]+)?(/[^/]+)?(/[^/]+)?$"))`,
      `(deny file-write* (regex #"^${pattern(dir)}/[^/]+/[^/]+/[^/]+/\\.git(/|$)"))`,
    ]),
    // Replaced by a link, the state or temp folder would be resolved into the next profile as a writable one.
    ...[state, tmp].flatMap(both).map((dir) => `(deny file-write* (literal ${quote(dir)}))`),
    ...PRIVATE_PATHS.flatMap((name) => both(path.join(user, name))).map((file) => `(deny file-read* (literal ${quote(file)}) (subpath ${quote(file)}))`),
    // The SSH agent signs with keys the files above only store: launchd's, and the one the daemon was given.
    '(deny network-outbound (remote unix-socket (regex #"^(/private)?/(tmp|var/run)/com\\.apple\\.launchd\\.[^/]+/Listeners$")))',
    ...(agent ? both(agent).map((file) => `(deny network-outbound (remote unix-socket (literal ${quote(file)})))`) : []),
    // A container engine's socket runs anything, anywhere, for whoever reaches it.
    '(deny network-outbound (remote unix-socket (regex #"/(docker|podman)[^/]*\\.sock$")))',
  ].join('\n');
}

/**
 * Whether a job belongs on the confined server. One that has a session stays where the session was opened, since each
 * server keeps its own. A new one goes there when its files are Crew's to hold: it writes nothing, or it works in a
 * worktree of the current layout (an older one has the worktree in the job's own folder, which the profile keeps whole).
 */
export function confines(job: Pick<JobCtl['job'], 'sandbox' | 'worktree' | 'sessionId' | 'capabilities'>, home: string = HOME): boolean {
  if (job.sessionId) return job.capabilities?.confined === true;
  if (job.sandbox === 'read-only') return true;
  return job.worktree !== null && path.resolve(job.worktree.path, '..', '..', '..') === path.resolve(home, 'worktrees');
}

/**
 * Antigravity for the daemon. On macOS a job that writes only inside Crew's worktrees, or not at all, goes to a server
 * confined by `serverProfile`, where an engineer's commands need no approval. A job that edits the user's own
 * directory keeps a server without that sandbox, which asks before each command, as every job does elsewhere and
 * wherever the sandbox is turned off (`antigravity.sandbox: false`) or cannot start.
 */
export function antigravityAdapter(config: Config, home: string = HOME, user: string = os.homedir()): Adapter {
  const open = new AntigravityAdapter(config);
  if (process.platform !== 'darwin') return open;
  const enabled = config.antigravity.sandbox !== false;
  // Prepared with the first job that needs it, so a machine that never runs one gets no folder and a failure here
  // costs only the sandbox. undefined: not tried yet; null: no sandbox can be had.
  let confined: AntigravityAdapter | null | undefined;
  const prepare = (): AntigravityAdapter | null => {
    try {
      // The profile names real paths, which a directory has only once it exists.
      for (const dir of [path.join(home, 'worktrees'), path.join(user, '.gemini', CONFINED_STATE)]) mkdirSync(dir, { recursive: true });
      const profile = serverProfile(home, user);
      // A daemon that is itself sandboxed cannot start another sandbox.
      return profile && spawnSync('/usr/bin/sandbox-exec', ['-p', profile, '/usr/bin/true']).status === 0 ? new AntigravityAdapter(config, profile) : null;
    } catch {
      return null;
    }
  };
  const pick = ({ job }: JobCtl, turn = false): AntigravityAdapter => {
    if (!confines(job, home)) return open;
    if (confined === undefined && enabled) confined = prepare();
    // A session the confined server opened is not in the other one's store, so a turn there would restore nothing.
    if (!confined && turn && job.sessionId) {
      const why = enabled ? 'could not start. Start a new job.' : 'is turned off (antigravity.sandbox). Turn it back on and restart Crew, or start a new job.';
      throw new Error(`Job ${job.id} ran on Antigravity's confined server, whose sessions the other server cannot restore, and that server ${why}`);
    }
    return confined ?? open;
  };
  return {
    start: (ctl) => pick(ctl, true).start(ctl),
    reply: (ctl, message) => pick(ctl, true).reply(ctl, message),
    answer: (ctl, approve, message, opts) => pick(ctl).answer(ctl, approve, message, opts),
    cancel: (ctl) => pick(ctl).cancel(ctl),
    shutdown: () => {
      open.shutdown();
      confined?.shutdown();
    },
  };
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
function drop(turn: Turn): void {
  for (const request of turn.pending.splice(0)) request.resolve(null);
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
 * - An engineer's command is allowed when the server is confined: the sandbox, not the user, then keeps it to the job.
 * - A read-only job changes nothing whatever its role: a question is answered by the engineer, with a reviewer's limits.
 */
export function decide(role: JobKind, cwd: string, toolCall: ToolCall, readOnly = false, confined = false): 'allow' | 'ask' | { refuse: string } {
  if (toolCall._meta?.mcpServerName === 'crew' && ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes', 'rate'].includes(toolCall._meta.mcpToolName ?? '')) return 'allow';
  const kind = toolCall.kind ?? 'other';
  // The daemon's secret is not a worker's to read, whatever the role. Commands are the user's to approve as before.
  const secret = tokenFile(HOME);
  // Windows names one file in any case, starting with the drive letter.
  const same = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() === secret.toLowerCase() : path.resolve(file) === secret;
  if ((toolCall.locations ?? []).some((l) => l.path && same(l.path))) return { refuse: 'the Crew token file' };
  // A qualified title can identify an MCP call, but must never disguise a command. One agy process serves many jobs, and
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
    // A command Crew's sandbox holds needs nobody's approval. agy's own tools for the other kinds run in the server
    // itself, with its network, so they stay the user's call, as does a request that names no command.
    const line = typeof input === 'string' ? input : input !== null && typeof input === 'object' ? COMMAND_FIELDS.map((field) => (input as Record<string, unknown>)[field]).find((value) => typeof value === 'string') : undefined;
    if (confined && kind === 'execute' && !toolCall._meta?.mcpServerName && !toolCall._meta?.mcpToolName && typeof line === 'string' && line.trim()) return 'allow';
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

/**
 * agy writes a Windows path as a URL path (`/C:/Users/...`) when it reports a tool call finished, though natively when
 * it starts or asks for one. Read as a native path, the URL form lands outside every workspace.
 */
export function localPath(file: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' && /^\/[A-Za-z]:[\\/]/.test(file) ? file.slice(1) : file;
}

/** Puts a tool call's paths in native form, before anything judges or records them. */
function localLocations(call: { locations?: unknown }): void {
  if (!Array.isArray(call.locations)) return;
  for (const location of call.locations) if (typeof location?.path === 'string') location.path = localPath(location.path);
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
