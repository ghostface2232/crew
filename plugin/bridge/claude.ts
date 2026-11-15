import fs from 'node:fs';
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
  /** Sub-agents still running, including workflow agents and background agents that outlive the turn. */
  agents: SubAgent[];
  /** Workflow runs with agents running now, or with one that stopped in the last few minutes. */
  workflows: WorkflowRun[];
}

export interface SubAgent {
  id: string;
  type: string;
  /** The Agent call's description, or a workflow agent's label; the type until either is known. */
  title: string;
  phase: string;
  /** Inside a tool call; keeps a quiet sub-agent from marking the session stalled. */
  inTool: boolean;
  startedAt: number;
  /** Its last hook event; a sub-agent silent too long is taken as stopped, since SubagentStop can be missed. */
  activeAt: number;
  /** The id of the workflow run it belongs to, once its journal names it. */
  workflow?: string;
  /** The workflow phase it was started in. */
  stage?: string;
}

/** One run of a Workflow script; its running agents are the session's agents that name it. */
export interface WorkflowRun {
  id: string;
  /** The script's meta name, or the run id when the saved script is not found. */
  name: string;
  startedAt: number;
  /** When an agent of the run last started or stopped. */
  activeAt: number;
  /** Agents of the run that have stopped. */
  done: number;
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
/** Agent calls whose sub-agent has not started yet, per session; a denied call never starts one. */
const KEEP_PENDING = 20;
const WORKFLOW_AGENT = 'workflow-subagent';
/** A run with no agent running is kept this long, through the gap between its phases, then dropped. */
const KEEP_WORKFLOW_MS = 10 * 60_000;
/** A sub-agent with no event for this long is dropped: its SubagentStop was missed, say across a daemon restart. */
const FORGET_AGENT_MS = 60 * 60_000;
/** How often an unknown workflow agent may send the journals to be read again. */
const RESCAN_JOURNALS_MS = 2_000;

interface JournalEntry {
  run: string;
  dir: string;
  label: string;
  stage?: string;
}

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
  /** Descriptions of Agent calls, claimed by the sub-agent each one starts. */
  private pending = new Map<string, { type?: string; title: string; call?: string }[]>();
  /** Who raised the prompt a waiting session shows: a sub-agent's id, or '' for the main loop. */
  private waitingFrom = new Map<string, string>();
  /** The session's workflow journals by agent id, read again at most every RESCAN_JOURNALS_MS. */
  private journals = new Map<string, { entries: Map<string, JournalEntry>; readAt: number }>();
  /** Sessions whose main loop has ended its turn; they stay working while sub-agents run. */
  private resting = new Set<string>();
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
      s = { id, cwd, title: path.basename(cwd) || 'Claude', state: 'idle', phase: '', waitingFor: null, inTool: false, stalled: false, startedAt: now, activeAt: now, agents: [], workflows: [] };
      this.sessions.set(id, s);
    }
    if (typeof p.session_title === 'string' && p.session_title) s.title = p.session_title;
    s.activeAt = now;
    s.stalled = false;
    // Sub-agents run beside the main loop, so their tool calls go to the sub-agent, not the session.
    if (typeof p.agent_id === 'string' && p.agent_id && this.ingestAgent(s, p.agent_id, p, now)) {
      this.hooks.onSession(s);
      return;
    }

    switch (p.hook_event_name) {
      case 'SessionStart':
        // A new process has none of the old one's sub-agents.
        if (p.source === 'startup' || p.source === 'resume') {
          s.agents = [];
          this.resting.add(id);
        }
        s.state = 'idle';
        s.phase = p.source === 'compact' ? 'context compacted' : 'session started';
        break;
      case 'UserPromptSubmit':
        this.resting.delete(id);
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
        this.resting.delete(id);
        s.state = 'working';
        s.waitingFor = null;
        s.inTool = true;
        s.phase = describeTool(p.tool_name, p.tool_input);
        if ((p.tool_name === 'Agent' || p.tool_name === 'Task') && typeof p.tool_input?.description === 'string') {
          const type = typeof p.tool_input.subagent_type === 'string' ? p.tool_input.subagent_type : undefined;
          const call = typeof p.tool_use_id === 'string' ? p.tool_use_id : undefined;
          const kept = this.pending.get(id) ?? [];
          kept.push({ type, title: oneLine(p.tool_input.description), call });
          this.pending.set(id, kept.slice(-KEEP_PENDING));
        }
        break;
      case 'PostToolUse':
      case 'PostToolUseFailure':
        s.state = 'working';
        s.inTool = false;
        // A failed Agent call starts no sub-agent, so its title must not go to the next one.
        if (p.hook_event_name === 'PostToolUseFailure' && typeof p.tool_use_id === 'string') {
          this.pending.set(id, (this.pending.get(id) ?? []).filter((c) => c.call !== p.tool_use_id));
        }
        break;
      case 'PreCompact':
        s.phase = 'compacting context';
        break;
      case 'Notification': {
        const type = p.notification_type;
        if (type === 'idle_prompt') {
          this.resting.add(id);
          s.state = s.agents.length ? 'working' : 'idle';
        } else if (type === 'permission_prompt' || type === 'agent_needs_input' || type === 'elicitation_dialog') {
          const message = oneLine(p.message ?? 'needs input');
          if (s.state !== 'waiting' || s.waitingFor !== message || !s.waitingId) s.waitingId = randomUUID();
          this.waitingFrom.set(id, typeof p.agent_id === 'string' ? p.agent_id : '');
          s.state = 'waiting';
          s.waitingFor = message;
          this.hooks.onEvent(s, 'waiting', s.waitingFor);
        }
        break;
      }
      case 'Stop':
        this.resting.add(id);
        s.state = s.agents.length ? 'working' : 'idle';
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
        this.forget(id);
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

  private forget(id: string): void {
    this.sessions.delete(id);
    this.prompts.delete(id);
    this.pending.delete(id);
    this.resting.delete(id);
    this.waitingFrom.delete(id);
    this.journals.delete(id);
  }

  /** Handles what happens inside a sub-agent; false leaves the event to the session, as a permission prompt is. */
  private ingestAgent(s: ClaudeSession, id: string, p: any, now: number): boolean {
    switch (p.hook_event_name) {
      case 'SubagentStart':
        this.agent(s, id, p, now);
        return true;
      case 'SubagentStop': {
        const agent = s.agents.find((a) => a.id === id);
        if (agent) this.placeInWorkflow(s, agent, p, now);
        const run = agent?.workflow && s.workflows.find((w) => w.id === agent.workflow);
        if (run) {
          run.done += 1;
          run.activeAt = now;
        }
        s.agents = s.agents.filter((a) => a.id !== id);
        if (!s.agents.length && this.resting.has(s.id) && s.state === 'working') s.state = 'idle';
        return true;
      }
      case 'PreToolUse': {
        const agent = this.agent(s, id, p, now);
        agent.inTool = true;
        agent.phase = describeTool(p.tool_name, p.tool_input);
        this.answered(s, id);
        return true;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.agent(s, id, p, now).inTool = false;
        this.answered(s, id);
        return true;
    }
    return false;
  }

  /** The running sub-agent, added on its first event so one started before the daemon still shows. */
  private agent(s: ClaudeSession, id: string, p: any, now: number): SubAgent {
    let agent = s.agents.find((a) => a.id === id);
    if (!agent) {
      const type = typeof p.agent_type === 'string' && p.agent_type ? p.agent_type : 'sub-agent';
      agent = { id, type, title: (type !== WORKFLOW_AGENT && this.claimTitle(s.id, type)) || type, phase: 'started', inTool: false, startedAt: now, activeAt: now };
      s.agents.push(agent);
      if (this.resting.has(s.id) && s.state === 'idle') s.state = 'working';
    } else if (agent.type === 'sub-agent' && typeof p.agent_type === 'string' && p.agent_type) {
      // First seen through an event without its type.
      if (agent.title === agent.type) agent.title = p.agent_type;
      agent.type = p.agent_type;
    }
    agent.activeAt = now;
    this.placeInWorkflow(s, agent, p, now);
    return agent;
  }

  /** A sub-agent moving on means a prompt it raised was answered; a prompt from the main loop or another agent stands. */
  private answered(s: ClaudeSession, agentId: string): void {
    if (s.state !== 'waiting' || this.waitingFrom.get(s.id) !== agentId) return;
    s.state = 'working';
    s.waitingFor = null;
    delete s.waitingId;
  }

  /** Finds a workflow agent's run and label; the journal is written around the agent's start, so it looks again until found. */
  private placeInWorkflow(s: ClaudeSession, agent: SubAgent, p: any, now: number): void {
    if (agent.type !== WORKFLOW_AGENT || agent.workflow) return;
    const found = this.journalEntry(s.id, agent.id, [p.agent_transcript_path, p.transcript_path], now);
    if (!found) return;
    agent.workflow = found.run;
    agent.title = found.label;
    agent.stage = found.stage;
    let run = s.workflows.find((w) => w.id === found.run);
    if (!run) {
      run = { id: found.run, name: workflowName(found.dir) ?? found.run, startedAt: agent.startedAt, activeAt: now, done: 0 };
      s.workflows.push(run);
    }
    run.activeAt = now;
  }

  /** Dozens of agents can be unknown at once, so the journals are read for all of them together, and not too often. */
  private journalEntry(sessionId: string, agentId: string, paths: unknown[], now: number): JournalEntry | undefined {
    const cached = this.journals.get(sessionId);
    const hit = cached?.entries.get(agentId);
    if (hit || (cached && now - cached.readAt < RESCAN_JOURNALS_MS)) return hit;
    const entries = readWorkflowJournals(paths, sessionId);
    this.journals.set(sessionId, { entries, readAt: now });
    return entries.get(agentId);
  }

  /** Takes the oldest Agent call of this type, else one that named no type; a call of another type is never taken. */
  private claimTitle(sessionId: string, type: string): string | undefined {
    const kept = this.pending.get(sessionId);
    if (!kept?.length) return undefined;
    let index = kept.findIndex((c) => c.type === type);
    if (index < 0) index = kept.findIndex((c) => !c.type);
    return index < 0 ? undefined : kept.splice(index, 1)[0].title;
  }

  private sweep(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      const agents = s.agents.filter((a) => now - a.activeAt < FORGET_AGENT_MS);
      if (agents.length !== s.agents.length) {
        s.agents = agents;
        if (!agents.length && this.resting.has(s.id) && s.state === 'working') s.state = 'idle';
        this.hooks.onSession(s);
      }
      const runs = s.workflows.filter((w) => s.agents.some((a) => a.workflow === w.id) || now - w.activeAt < KEEP_WORKFLOW_MS);
      if (runs.length !== s.workflows.length) {
        s.workflows = runs;
        this.hooks.onSession(s);
      }
      if (now - s.activeAt > FORGET_IDLE_MS) {
        // SessionEnd never arrives when the app is killed.
        this.forget(s.id);
        this.hooks.onSession(s, true);
      } else if (s.state === 'working' && !s.inTool && !s.agents.some((a) => a.inTool) && !s.stalled && now - s.activeAt > this.stallMs) {
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

/**
 * Every workflow agent the session's run journals name, by agent id; hooks carry neither the run nor the label.
 * `paths` are the transcripts the hook names, the agent's own or the session's.
 */
function readWorkflowJournals(paths: unknown[], sessionId: string): Map<string, JournalEntry> {
  const runs = new Set<string>();
  for (const file of paths) {
    if (typeof file !== 'string' || !file) continue;
    const dir = path.dirname(file);
    if (path.basename(path.dirname(dir)) === 'workflows') runs.add(dir);
    const all = path.join(dir, sessionId, 'subagents', 'workflows');
    try {
      for (const run of fs.readdirSync(all)) runs.add(path.join(all, run));
    } catch {}
  }
  const entries = new Map<string, JournalEntry>();
  for (const dir of runs) {
    let journal: string;
    try {
      journal = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of journal.split('\n')) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== 'started' || typeof entry.agentId !== 'string' || typeof entry.label !== 'string') continue;
      entries.set(entry.agentId, { run: path.basename(dir), dir, label: oneLine(entry.label), stage: typeof entry.phase === 'string' ? entry.phase : undefined });
    }
  }
  return entries;
}

/** The workflow's meta name, from its saved script `<session>/workflows/scripts/<name>-<run id>.js`. */
function workflowName(run: string): string | undefined {
  const id = path.basename(run);
  const scripts = path.join(run, '..', '..', '..', 'workflows', 'scripts');
  try {
    const file = fs.readdirSync(scripts).find((f) => f.endsWith(`-${id}.js`));
    return file?.slice(0, -`-${id}.js`.length) || undefined;
  } catch {
    return undefined;
  }
}
