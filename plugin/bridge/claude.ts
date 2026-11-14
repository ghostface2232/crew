import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventKind } from './jobs.ts';

export interface ClaudeSession {
  id: string;
  cwd: string;
  /** Main working tree of the repository `cwd` is in, so a session in a worktree or subfolder groups with its project. Set once looked up. */
  root?: string;
  title: string;
  state: 'working' | 'waiting' | 'idle' | 'error';
  phase: string;
  waitingFor: string | null;
  /** Identifies a waiting episode even if desktop polling misses the intervening work. */
  waitingId?: string;
  /** Inside a tool call; silence here is the tool running, not a stall. */
  inTool: boolean;
  stalled: boolean;
  startedAt: number;
  activeAt: number;
}

export interface ClaudeHooks {
  onSession(session: ClaudeSession, removed?: boolean): void;
  onEvent(session: ClaudeSession, kind: EventKind, detail: string): void;
  onAttention(session: ClaudeSession, kind: EventKind, detail: string): void;
}

/** Sessions silent this long are dropped, whatever state they were last seen in. */
const FORGET_IDLE_MS = 6 * 60 * 60_000;
/** What the user typed recently, per session: enough to show a worker's reviewer the user's own words behind a relayed approval. */
const KEEP_PROMPTS = 5;
const MAX_PROMPT = 2000;

export interface UserPrompt {
  text: string;
  at: number;
}

/**
 * Tracks Claude Code sessions from the hook payloads the plugin forwards.
 * Hooks are push-based and cover Desktop sessions, unlike polling `claude agents --json`.
 */
export class ClaudeSessions {
  readonly sessions = new Map<string, ClaudeSession>();
  /** Kept apart from the session so the prompts never reach the board's state. Memory only. */
  private prompts = new Map<string, UserPrompt[]>();
  private hooks: ClaudeHooks;
  private stallMs: number;

  constructor(stallSeconds: number, hooks: ClaudeHooks) {
    this.hooks = hooks;
    this.stallMs = stallSeconds * 1000;
    setInterval(() => this.sweep(), 15_000).unref();
  }

  ingest(p: any): void {
    const id: unknown = p?.session_id;
    if (typeof id !== 'string' || typeof p.hook_event_name !== 'string') return;
    const now = Date.now();
    let s = this.sessions.get(id);
    if (!s) {
      const cwd = typeof p.cwd === 'string' ? p.cwd : '';
      s = { id, cwd, title: path.basename(cwd) || 'Claude', state: 'idle', phase: '', waitingFor: null, inTool: false, stalled: false, startedAt: now, activeAt: now };
      this.sessions.set(id, s);
    }
    if (typeof p.session_title === 'string' && p.session_title) s.title = p.session_title;
    s.activeAt = now;
    s.stalled = false;
    // Sub-agent tool calls run concurrently with the main loop and must not flip its tool state.
    const main = !p.agent_id;

    switch (p.hook_event_name) {
      case 'SessionStart':
        s.state = 'idle';
        s.phase = p.source === 'compact' ? 'context compacted' : 'session started';
        break;
      case 'UserPromptSubmit':
        s.state = 'working';
        s.waitingFor = null;
        s.phase = 'reading the prompt';
        if (typeof p.prompt === 'string' && p.prompt.trim()) {
          const kept = this.prompts.get(id) ?? [];
          kept.push({ text: p.prompt.trim().slice(0, MAX_PROMPT), at: now });
          this.prompts.set(id, kept.slice(-KEEP_PROMPTS));
        }
        this.hooks.onEvent(s, 'started', oneLine(p.prompt ?? 'prompt'));
        break;
      case 'PreToolUse':
        s.state = 'working';
        s.waitingFor = null;
        if (main) s.inTool = true;
        s.phase = describeTool(p.tool_name, p.tool_input);
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        s.state = 'working';
        if (main) s.inTool = false;
        break;
      case 'SubagentStart':
        s.phase = `sub-agent ${p.agent_type ?? ''} started`.replace('  ', ' ');
        break;
      case 'SubagentStop':
        s.phase = `sub-agent ${p.agent_type ?? ''} finished`.replace('  ', ' ');
        break;
      case 'PreCompact':
        s.phase = 'compacting context';
        break;
      case 'Notification': {
        const type = p.notification_type;
        if (type === 'idle_prompt') {
          s.state = 'idle';
        } else if (type === 'permission_prompt' || type === 'agent_needs_input' || type === 'elicitation_dialog') {
          const message = oneLine(p.message ?? 'needs input');
          if (s.state !== 'waiting' || s.waitingFor !== message || !s.waitingId) s.waitingId = randomUUID();
          s.state = 'waiting';
          s.waitingFor = message;
          this.hooks.onEvent(s, 'waiting', s.waitingFor);
        }
        break;
      }
      case 'Stop':
        s.state = 'idle';
        s.inTool = false;
        s.waitingFor = null;
        s.phase = 'finished the turn';
        this.hooks.onEvent(s, 'done', oneLine(p.last_assistant_message ?? 'turn finished'));
        break;
      case 'StopFailure': {
        const limit = p.error === 'rate_limit' || p.error === 'billing_error';
        const detail = oneLine([p.error, p.error_details].filter(Boolean).join(': ') || 'turn failed');
        s.state = 'error';
        s.inTool = false;
        s.phase = limit ? 'usage limit reached' : detail;
        const kind: EventKind = limit ? 'limit' : 'error';
        this.hooks.onEvent(s, kind, detail);
        this.hooks.onAttention(s, kind, detail);
        break;
      }
      case 'SessionEnd':
        this.sessions.delete(id);
        this.prompts.delete(id);
        this.hooks.onSession(s, true);
        return;
    }
    if (s.state !== 'waiting') delete s.waitingId;
    this.hooks.onSession(s);
  }

  /** The session's recent prompts, oldest first. */
  recentPrompts(id: string): UserPrompt[] {
    return [...(this.prompts.get(id) ?? [])];
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (now - s.activeAt > FORGET_IDLE_MS) {
        // SessionEnd never arrives when the app is killed.
        this.sessions.delete(s.id);
        this.prompts.delete(s.id);
        this.hooks.onSession(s, true);
      } else if (s.state === 'working' && !s.inTool && !s.stalled && now - s.activeAt > this.stallMs) {
        s.stalled = true;
        const detail = `no activity for ${Math.round(this.stallMs / 60_000)} min`;
        this.hooks.onEvent(s, 'stalled', detail);
        this.hooks.onAttention(s, 'stalled', detail);
        this.hooks.onSession(s);
      }
    }
  }
}

function oneLine(text: string): string {
  const line = String(text).trim().split('\n')[0];
  return line.length > 140 ? `${line.slice(0, 139)}…` : line;
}

function describeTool(name: unknown, input: any): string {
  const tool = String(name ?? 'tool');
  const mcp = /^mcp__(?:plugin_[^_]+_)?(.+?)__(.+)$/.exec(tool);
  if (mcp) return `${mcp[1]} ${mcp[2]}`;
  const subject =
    (typeof input?.file_path === 'string' && path.basename(input.file_path)) ||
    input?.description ||
    input?.command ||
    input?.pattern ||
    input?.query ||
    '';
  return oneLine(subject ? `${tool} ${subject}` : tool);
}
