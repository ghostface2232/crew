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
/** Crew's worker MCP tools that only read or report. `browser` starts a process outside the worker's limits, so it asks. */
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
  const { cwd, sandbox, evidenceDir } = ctl.job;
  if (!file) return false;
  // Every job keeps its screenshots in its evidence directory, as a Codex job may, read-only or not.
  // The bridge runs git in the worker's tree itself, so `.git` is never the worker's to change.
  try {
    return Boolean(evidenceDir && isInside(evidenceDir, file))
      || (sandbox === 'workspace-write' && isInside(cwd, file) && !isGitPath(cwd, file));
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

// Error status and rate-limit event mappings are assumed until observed on the live CLI.
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

function launchClaude(config: Config, ctl: JobCtl, resume?: string) {
  const env = agentEnv();
  const { cwd, sandbox, scratch, evidenceDir, instructions, model, effort } = ctl.job;
  const mcp = JSON.stringify({ mcpServers: { crew: { type: 'stdio', ...ctl.mcp } } });
  const args = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--permission-mode', permissionMode(ctl.job), '--permission-prompt-tool', 'stdio', '--restricted', '--tools',
    sandbox === 'workspace-write' ? 'Read,Edit,Write,Glob,Grep,Bash' : 'Read,Glob,Grep,Bash', '--strict-mcp-config'];
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
  private mode: 'auto' | 'default';
  private modeRequest?: string;
  private modeRequests = 0;
  turns = 0;
  stopping = false;
  private idle?: NodeJS.Timeout;
  private forceClose?: NodeJS.Timeout;
  private readonly cleanup: () => void;

  constructor(config: Config, ctl: JobCtl, grants: Set<string>, onClose: () => void, resume?: string) {
    this.ctl = ctl;
    this.grants = grants;
    this.mode = permissionMode(ctl.job);
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
    this.write({ type: 'user', message: { role: 'user', content: text } });
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
        } else if (message.subtype === 'permission_denied') {
          const use = typeof message.tool_use_id === 'string' ? this.uses.get(message.tool_use_id) : undefined;
          const tool = typeof message.tool_name === 'string' ? message.tool_name : use?.name ?? 'an action';
          const input: ToolInput = use?.input ?? message.input ?? {};
          const reason = typeof message.decision_reason === 'string' ? message.decision_reason.trim() : '';
          // `--restricted` keeping a file tool inside the job is the job's limit, not a judgment to send back.
          if (/^--restricted/.test(reason) || typeof message.blocked_path === 'string') {
            const target = typeof message.blocked_path === 'string' ? message.blocked_path : toolPath(input, tool);
            ctl.note(`Claude Code refused ${tool}${target ? `: ${oneLine(target)}` : ''}.`);
          } else {
            ctl.refused(toolDetail(tool, input), reason || 'no reason given');
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
            if (EDIT_TOOLS.includes(block.name) && file && canEdit(ctl, file)) ctl.touched(file);
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
        // Left in automatic mode, the turn would decide what the user was to be asked about.
        if (message.response?.request_id === this.modeRequest && message.response?.subtype !== 'success') {
          this.fail(`Claude Code could not switch to ${this.mode} permissions: ${message.response?.error ?? 'no reason given'}.`, false);
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
        this.turns--;
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

  private fail(message: string, limit: boolean): void {
    if (this.turns) void this.stop();
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
        filesystem: ctl.job.sandbox === 'workspace-write' ? 'edits inside the workspace only' : 'read-only edits policy',
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
