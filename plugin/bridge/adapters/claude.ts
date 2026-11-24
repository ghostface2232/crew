import { execFile, spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { agentCommand, agentEnv } from '../config.ts';
import type { Config } from '../config.ts';
import { isGitPath, isInside } from '../git.ts';
import { noteLeadDecline } from '../jobs.ts';
import type { Adapter, Job, JobCtl, Probe } from '../jobs.ts';
import { treeKillCommand } from '../rpc.ts';
import { clip, clipEnd } from '../text.ts';

const IDLE_SHUTDOWN_MS = 10 * 60_000;
const CLOSE_GRACE_MS = 2_000;
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit'];
/**
 * Crew's worker MCP tools that only read or report. `browser` starts a process outside the worker's limits, so it asks
 * in the manual mode; the automatic mode judges it as it judges a command.
 */
const UNATTENDED_TOOLS = ['ask_lead', 'lead_answers', 'siblings', 'search', 'recent_changes', 'rate'].map((name) => `mcp__crew__${name}`);

type ToolInput = Record<string, unknown>;
type Approval = { id: string; input: ToolInput; reason: string; grant?: { key: string; label: string } };
type Decision = { behavior: 'allow'; updatedInput: ToolInput } | { behavior: 'deny'; message: string };
type Usage = {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens?: number;
};

function toolPath(input: ToolInput, tool?: string): string | undefined {
  const file = tool === 'NotebookEdit' ? input.notebook_path
    : tool === 'Write' || tool === 'Edit' ? input.file_path : input.file_path ?? input.notebook_path;
  return typeof file === 'string' ? file : undefined;
}

function canEdit(ctl: JobCtl, file: string | undefined): boolean {
  const { cwd, sandbox } = ctl.job;
  // Claude Code's file tools take absolute paths. A relative one would be judged against the evidence directory here
  // but written in the job's folder, `.git` included.
  if (!file || !path.isAbsolute(file)) return false;
  // Every job keeps its screenshots in its evidence directory, as a Codex job may, read-only or not.
  // The bridge runs git in the worker's tree itself, so `.git` is never the worker's to change.
  try {
    return inEvidence(ctl, file)
      || (sandbox === 'workspace-write' && isInside(cwd, file) && !isGitPath(cwd, file));
  } catch { return false; }
}

function inEvidence(ctl: JobCtl, file: string): boolean {
  const { evidenceDir } = ctl.job;
  try {
    return Boolean(evidenceDir && isInside(evidenceDir, file));
  } catch { return false; }
}

/**
 * Claude Code's automatic mode decides most actions itself, as Codex's automatic reviewer does for a Codex worker.
 * No OS sandbox holds a read-only job to reading, so only the manual mode keeps its commands from writing; and a
 * retry of a refused action, sent back a second time, is the user's to answer request by request.
 */
function permissionMode(job: Job): 'auto' | 'default' {
  return job.sandbox === 'workspace-write' && !job.asksUser ? 'auto' : 'default';
}

function oneLine(text: string): string {
  return text.replace(/\r/g, '\\r').replace(/\n/g, '\\n');
}

function toolDetail(tool: string, input: ToolInput): string {
  const target = typeof input.command === 'string' ? input.command : toolPath(input, tool);
  return target ? `${tool}: ${oneLine(target)}` : tool;
}

function commandGrantKey(tool: string, input: ToolInput, cwd: string): string | undefined {
  if (tool === 'Bash' && typeof input.command === 'string' && input.command.trim()) {
    return JSON.stringify([tool, input.command, input.cwd ?? cwd]);
  }
}

// Read from Claude Code 2.1.328's stream-json schema: `rate_limit_info.status` is allowed, allowed_warning or
// rejected, and a result's `api_error_status` is the HTTP status. Neither has been seen at a real limit.
function limitReached(message: any): boolean {
  return message.type === 'result' ? Number(message.api_error_status) === 429
    : message.rate_limit_info?.status === 'rejected';
}

function counted(ctl: JobCtl, usage: Usage): void {
  const before = ctl.job.tokenUse ?? { input: 0, cachedInput: 0, output: 0 };
  const cached = usage.cache_read_input_tokens ?? 0;
  const input = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + cached;
  const output = usage.output_tokens ?? 0;
  ctl.tokens((ctl.job.tokens ?? 0) + input + output, {
    input: before.input + input,
    cachedInput: before.cachedInput + cached,
    output: before.output + output,
  });
}

/**
 * What a Claude Code session sets for the processes it starts, which a daemon that session started keeps. Left in, a
 * worker takes itself for a child of that session (its desktop app's socket, its session id, its effort).
 */
const SESSION_VARS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|SESSION_ID|HOST_SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|CHILD_NOTES_DIR|LAUNCHED_BY_SESSION_IDS|MESSAGING_SOCKET|MESSAGING_TOKEN))$/;

export function workerEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = agentEnv(process.platform, source);
  for (const key of Object.keys(env)) if (SESSION_VARS.test(key.toUpperCase())) delete env[key];
  return env;
}

function launchClaude(config: Config, ctl: JobCtl, resume?: string) {
  const env = workerEnv();
  const { cwd, sandbox, scratch, evidenceDir, instructions, model, effort } = ctl.job;
  const mcp = JSON.stringify({ mcpServers: { crew: { type: 'stdio', ...ctl.mcp } } });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permissionMode(ctl.job), '--permission-prompt-tool', 'stdio', '--restricted', '--tools',
    // A read-only job gets Write for its evidence directory alone (canEdit).
    sandbox === 'workspace-write' ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Write,Glob,Grep,Bash', '--strict-mcp-config'];
  // Restricted mode keeps the file tools to the working directories; the lead's attachments and the worker's
  // screenshots are in the evidence directory.
  if (evidenceDir) args.push('--add-dir', evidenceDir);
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  if (resume) args.push('--resume', resume);
  let files: string | undefined;
  const cleanup = () => {
    if (!files) return;
    for (const name of ['mcp.json', 'instructions.txt']) rmSync(path.join(files, name), { force: true, maxRetries: 5 });
    rmdirSync(files);
    files = undefined;
  };
  try {
    // The MCP config carries the job's token, which a command line would show to every local process, so it always
    // goes in a file only the user can read. cmd.exe shims cannot take the newlines in role instructions either.
    if (scratch) mkdirSync(scratch, { recursive: true });
    files = mkdtempSync(path.join(scratch ?? os.tmpdir(), 'crew-claude-'));
    const mcpFile = path.join(files, 'mcp.json');
    writeFileSync(mcpFile, mcp, { mode: 0o600 });
    args.push('--mcp-config', mcpFile);
    if (agentCommand(config.claude.bin, [], env).shell) {
      const promptFile = path.join(files, 'instructions.txt');
      writeFileSync(promptFile, instructions, { mode: 0o600 });
      args.push('--append-system-prompt-file', promptFile);
    } else {
      args.push('--append-system-prompt', instructions);
    }
    const launch = agentCommand(config.claude.bin, args, env);
    const child = spawn(launch.bin, launch.args ?? [], {
      cwd, env, shell: launch.shell, detached: process.platform !== 'win32',
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { child, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

function killTree(child: ChildProcessWithoutNullStreams, synchronous = false): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const command = treeKillCommand(child.pid, true);
  if (command) {
    if (synchronous) {
      const result = spawnSync(command.bin, command.args, { windowsHide: true, stdio: 'ignore', timeout: CLOSE_GRACE_MS });
      if (result.status !== 0) child.kill('SIGKILL');
    } else {
      execFile(command.bin, command.args, { windowsHide: true }, (err) => { if (err) child.kill('SIGKILL'); });
    }
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); }
  catch { child.kill('SIGKILL'); }
}

class Session {
  ctl: JobCtl;
  readonly child: ChildProcessWithoutNullStreams;
  readonly closed = Promise.withResolvers<void>();
  readonly pending: Approval[] = [];
  readonly grants: Set<string>;
  /** This turn's tool calls by id, so a refusal, which names only the id, can say what was refused. */
  private readonly uses = new Map<string, { name: string; input: ToolInput }>();
  /** The mode this session was last asked for; unknown for a resumed session until it is set, since one may bring back the mode it was saved in. */
  private mode?: 'auto' | 'default';
  private modeRequest?: string;
  /** Claude Code left automatic mode for the manual one, as where the model or plan does not offer it. */
  private manualOnly = false;
  private modeRequests = 0;
  /** Messages held until Claude Code confirms the mode they are to be read in. */
  private held: string[] = [];
  turns = 0;
  stopping = false;
  private idle?: NodeJS.Timeout;
  private forceClose?: NodeJS.Timeout;
  private readonly cleanup: () => void;

  constructor(config: Config, ctl: JobCtl, grants: Set<string>, onClose: () => void, resume?: string) {
    this.ctl = ctl;
    this.grants = grants;
    if (!resume) this.mode = permissionMode(ctl.job);
    const { child, cleanup } = launchClaude(config, ctl, resume);
    this.child = child;
    this.cleanup = cleanup;
    let error = '';
    let stderr = '';
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr = clipEnd(stderr + chunk, 2000); });
    child.on('error', (err) => { error = err.message; });
    child.stdin.on('error', (err) => {
      // A dead child can close stdin before its last result reaches stdout.
      error ||= err.message;
    });
    child.on('close', (code, signal) => {
      clearTimeout(this.idle);
      clearTimeout(this.forceClose);
      const failed = !this.stopping && this.turns > 0;
      this.turns = 0;
      this.pending.length = 0;
      onClose();
      this.cleanLaunchFiles();
      this.closed.resolve();
      if (failed) {
        const detail = stderr.trim().split(/\r?\n/).pop() || error;
        this.ctl.fail(`Claude Code exited during a turn (${signal ?? code ?? 'launch failed'})${detail ? `: ${detail}` : ''}.`);
      }
    });
  }

  get alive(): boolean {
    return !this.stopping && this.running && this.child.stdin.writable;
  }

  get running(): boolean {
    return this.child.pid !== undefined && this.child.exitCode === null && this.child.signalCode === null;
  }

  send(ctl: JobCtl, text: string): void {
    clearTimeout(this.idle);
    this.ctl = ctl;
    if (this.turns++ === 0) ctl.phase('working');
    // A session outlives its turns, so a turn that needs another mode switches it before the message is read.
    const mode = permissionMode(ctl.job);
    if (mode !== this.mode) {
      this.mode = mode;
      this.modeRequest = `crew-mode-${++this.modeRequests}`;
      this.write({ type: 'control_request', request_id: this.modeRequest, request: { subtype: 'set_permission_mode', mode } });
    }
    if (this.modeRequest) this.held.push(text);
    else this.write({ type: 'user', message: { role: 'user', content: text } });
  }

  stop(mode: 'graceful' | 'cancel' | 'shutdown' = 'graceful'): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      clearTimeout(this.idle);
      this.pending.length = 0;
      if (mode !== 'cancel') this.child.stdin.end();
      if (mode === 'graceful') {
        this.forceClose = setTimeout(() => killTree(this.child), CLOSE_GRACE_MS).unref();
      }
    }
    if (mode !== 'graceful') {
      clearTimeout(this.forceClose);
      killTree(this.child, mode === 'shutdown');
    }
    if (mode === 'shutdown') this.cleanLaunchFiles();
    return this.closed.promise;
  }

  private cleanLaunchFiles(): void {
    try { this.cleanup(); }
    catch (err) { this.ctl.note(`Claude Code's temporary launch files could not be removed: ${(err as Error).message}`); }
  }

  answer(approve: boolean, message?: string, opts?: { forJob?: boolean; by?: 'lead' }): void {
    const request = this.pending[0];
    if (!this.alive || !request) throw new Error('The request this job was waiting on is no longer pending.');
    if (opts?.forJob && (!approve || !request.grant)) {
      throw new Error('This request cannot be allowed for the whole job. Approve or deny it.');
    }
    const ctl = this.ctl;
    this.pending.shift();
    if (approve) this.allow(request);
    else {
      const reason = message?.trim() || 'The user declined this action.';
      this.respond(request.id, { behavior: 'deny', message: reason });
      if (opts?.by === 'lead') noteLeadDecline(ctl, request.reason, reason);
      else ctl.note(`The user declined an action: ${request.reason}\nReason: ${reason}`, { declined: true });
    }
    if (opts?.forJob && request.grant) {
      const { key, label } = request.grant;
      this.grants.add(key);
      ctl.progress(`allowed for this job: ${label}`);
      for (let i = this.pending.length - 1; i >= 0; i--) {
        if (this.pending[i].grant?.key === key) this.allow(this.pending.splice(i, 1)[0]);
      }
    }
    if (this.pending.length) this.waiting();
    else ctl.resumed();
  }

  private write(message: unknown): void {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private respond(id: string, response: Decision): void {
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  }

  private allow({ id, input }: Approval): void {
    this.respond(id, { behavior: 'allow', updatedInput: input });
  }

  private waiting(): void {
    const { reason, grant } = this.pending[0];
    this.ctl.waiting('approval', reason, grant?.label);
  }

  private permission(id: string, request: any): void {
    const ctl = this.ctl;
    const tool = request.tool_name;
    const input: ToolInput = request.input ?? {};
    const reason = toolDetail(tool, input);
    const approval = { id, input, reason };
    if (UNATTENDED_TOOLS.includes(tool)) return this.allow(approval);
    if (EDIT_TOOLS.includes(tool)) {
      if (canEdit(ctl, toolPath(input, tool))) return this.allow(approval);
      const message = ctl.job.sandbox === 'read-only' ? 'This job is read-only.' : 'Edit paths must be inside the job workspace.';
      this.respond(id, { behavior: 'deny', message });
      ctl.note(`The bridge refused ${reason}. ${message}`);
      return;
    }
    const key = commandGrantKey(tool, input, ctl.job.cwd);
    if (key && this.grants.has(key)) return this.allow(approval);
    this.pending.push({ ...approval, grant: key ? { key, label: oneLine(input.command as string) } : undefined });
    if (this.pending.length === 1) this.waiting();
  }

  private onLine(line: string): void {
    if (this.stopping || !this.turns) return;
    let message: any;
    try { message = JSON.parse(line); }
    catch { return; }
    if (!message || typeof message.type !== 'string') return;
    const ctl = this.ctl;
    ctl.activity();
    switch (message.type) {
      case 'system':
        if (message.subtype === 'init') {
          if (typeof message.session_id === 'string') ctl.session(message.session_id);
          ctl.model(message.model, message.effort ?? ctl.job.effort);
          const actual = message.permissionMode;
          if (typeof actual === 'string' && actual !== this.mode) {
            // The manual mode only asks more than the automatic one; any other mismatch could ask less than intended.
            if (this.mode === 'auto' && actual === 'default') this.fellBack();
            else this.fail(`Claude Code started the turn in ${actual} permissions, not ${this.mode}.`, false, true);
          }
        } else if (message.subtype === 'permission_denied') {
          const use = typeof message.tool_use_id === 'string' ? this.uses.get(message.tool_use_id) : undefined;
          const tool = typeof message.tool_name === 'string' ? message.tool_name : use?.name ?? 'an action';
          const input: ToolInput = use?.input ?? message.input ?? {};
          const reason = typeof message.decision_reason === 'string' ? message.decision_reason.trim() : '';
          // Only the automatic mode's classifier judges an action the lead can send back with the user's approval;
          // the others, such as `--restricted` keeping a file tool inside the job, are the job's limits.
          if (message.decision_reason_type === 'classifier') {
            ctl.refused(toolDetail(tool, input), reason || 'no reason given');
          } else {
            const target = typeof message.blocked_path === 'string' ? message.blocked_path : toolPath(input, tool);
            ctl.note(`Claude Code refused ${tool}${target ? `: ${oneLine(target)}` : ''}${reason ? ` (${reason})` : ''}.`);
          }
        }
        break;
      case 'assistant':
        if (!Array.isArray(message.message?.content)) break;
        for (const block of message.message.content) {
          if (block?.type === 'tool_use' && typeof block.name === 'string') {
            const input = block.input ?? {};
            if (typeof block.id === 'string') this.uses.set(block.id, { name: block.name, input });
            ctl.progress(toolDetail(block.name, input));
            const file = toolPath(input, block.name);
            // A screenshot saved in the evidence directory is no change to the job's files.
            if (EDIT_TOOLS.includes(block.name) && file && canEdit(ctl, file) && !inEvidence(ctl, file)) ctl.touched(file);
          } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            ctl.phase('writing response');
            ctl.progress(clip(block.text.trim().split(/\r?\n/, 1)[0], 120));
          } else if (block?.type === 'thinking') ctl.phase('thinking');
        }
        break;
      case 'control_request':
        if (typeof message.request_id === 'string' && message.request?.subtype === 'can_use_tool' && typeof message.request.tool_name === 'string') {
          this.permission(message.request_id, message.request);
        }
        break;
      case 'control_response':
        if (!this.modeRequest || message.response?.request_id !== this.modeRequest) break;
        this.modeRequest = undefined;
        if (message.response.subtype === 'success' || this.mode === 'auto') {
          if (message.response.subtype !== 'success') this.fellBack();
          for (const text of this.held.splice(0)) this.write({ type: 'user', message: { role: 'user', content: text } });
        } else {
          // Left in the old mode, the turn would decide what the user was to be asked about, so it is never sent.
          this.held.length = 0;
          this.fail(`Claude Code could not switch to ${this.mode} permissions: ${message.response.error ?? 'no reason given'}.`, false, true);
        }
        break;
      case 'control_cancel_request': {
        const index = this.pending.findIndex((request) => request.id === message.request_id);
        if (index < 0) break;
        this.pending.splice(index, 1);
        if (index === 0) {
          if (this.pending.length) this.waiting();
          else ctl.resumed();
        }
        break;
      }
      case 'rate_limit_event':
        if (limitReached(message)) this.fail('Claude Code reached its rate limit.', true);
        break;
      case 'result':
        if (typeof message.session_id === 'string' && message.session_id !== ctl.job.sessionId) ctl.session(message.session_id);
        if (message.usage) counted(ctl, message.usage);
        // A request still open when its turn ends is stale; it is denied rather than left without an answer.
        if (this.pending.length) {
          for (const request of this.pending.splice(0)) this.respond(request.id, { behavior: 'deny', message: 'The turn ended before this was answered.' });
          ctl.resumed();
        }
        // Messages sent while a turn ran may be read together in one turn, so the count comes from Claude Code when it
        // gives one: the sends still queued, plus any held here for a mode switch.
        this.turns = typeof message.queued_turn_count === 'number'
          ? Math.max(0, message.queued_turn_count) + this.held.length
          : Math.max(0, this.turns - 1);
        if (!this.turns) this.uses.clear();
        if (message.is_error || message.subtype !== 'success') {
          const errors = Array.isArray(message.errors) ? message.errors.join('\n') : '';
          const detail = message.result || errors || `Claude Code ended with ${message.subtype ?? 'an error'}.`;
          this.fail(detail, limitReached(message));
        } else if (!this.turns) {
          this.idle = setTimeout(() => void this.stop(), IDLE_SHUTDOWN_MS).unref();
          ctl.done(message.result ?? '');
        }
        break;
    }
  }

  private fellBack(): void {
    if (this.manualOnly) return;
    this.manualOnly = true;
    this.ctl.note('Claude Code runs this job in its manual permission mode, as automatic mode is not available to it (for this model or plan). Actions it would have judged itself go to the user.');
  }

  /** `now` stops the process at once, for a turn that must not go on running. */
  private fail(message: string, limit: boolean, now = false): void {
    if (this.turns) void this.stop(now ? 'cancel' : 'graceful');
    else this.idle = setTimeout(() => void this.stop(), IDLE_SHUTDOWN_MS).unref();
    this.turns = 0;
    this.ctl.fail(message, limit ? { limit: true } : undefined);
  }
}

export function claudeAdapter(config: Config): Adapter {
  const sessions = new Map<string, Session>();
  const grants = new Map<string, Set<string>>();
  let shuttingDown = false;

  async function send(ctl: JobCtl, message: string, resume?: string): Promise<void> {
    const { id } = ctl.job;
    let session = sessions.get(id);
    while (session && !session.alive) {
      await session.closed.promise;
      session = sessions.get(id);
    }
    if (shuttingDown) throw new Error('The Claude Code adapter is shutting down.');
    if (!session) {
      let jobGrants = grants.get(id);
      if (!jobGrants) grants.set(id, jobGrants = new Set());
      session = new Session(config, ctl, jobGrants, () => sessions.delete(id), resume);
      sessions.set(id, session);
      ctl.capabilities({
        filesystem: ctl.job.sandbox === 'workspace-write' ? 'file edits inside the workspace; commands as automatic mode judges them' : 'read-only edits policy',
        network: 'agent-managed', plugins: [],
      });
    }
    session.send(ctl, message);
  }

  return {
    start: (ctl) => send(ctl, ctl.job.prompt),
    async reply(ctl, message) {
      if (!sessions.get(ctl.job.id)?.alive && !ctl.job.sessionId) throw new Error('The job has no Claude Code session to resume.');
      await send(ctl, message, ctl.job.sessionId ?? undefined);
    },
    async answer(ctl, approve, message, opts) {
      const session = sessions.get(ctl.job.id);
      if (!session) throw new Error('The request this job was waiting on is no longer pending.');
      session.answer(approve, message, opts);
    },
    async cancel(ctl) {
      await sessions.get(ctl.job.id)?.stop('cancel');
      ctl.cancelled();
    },
    async release(ctl) {
      await sessions.get(ctl.job.id)?.stop();
    },
    async probe(ctl): Promise<Probe> {
      const session = sessions.get(ctl.job.id);
      if (!session?.running) return { verdict: 'ended', detail: 'The Claude Code process is gone.' };
      if (session.alive && session.turns) return { verdict: 'working', detail: 'Claude Code has an open turn.' };
      return { verdict: 'unknown', detail: 'Claude Code is running without an open turn.' };
    },
    shutdown() {
      shuttingDown = true;
      for (const session of sessions.values()) void session.stop('shutdown');
      grants.clear();
    },
  };
}
