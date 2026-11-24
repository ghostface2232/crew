import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { QUEUED_NOTE } from './codex-lead.ts';
import type { EventKind } from './jobs.ts';
import { clip } from './text.ts';

/** A lead session reported by Claude Code's hooks or, with host `codex`, by Codex's, whose payloads carry the same fields. */
export interface ClaudeSession {
  id: string;
  /** Absent for Claude Code. */
  host?: 'codex';
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
  /** The open mission this session last acted on as its lead. With several open, the board shows the session on that card alone. Memory only. */
  mission?: string;
  /** The Claude desktop app's id for the session (local_…), which `claude://code/continue?session=` opens. Absent for a CLI session. */
  desktopId?: string;
  /** Details of what the waiting prompt asks, when hooks provide more than a single summary line. Present only while waiting. */
  ask?: ClaudeAsk;
}

/** A waiting prompt's content. The user still answers it in Claude: hooks cannot answer it for them. */
export interface ClaudeAsk {
  /** Questions with their choices, from AskUserQuestion or the desktop app's end-of-turn box. */
  questions?: AskQuestion[];
  /** For an approval: the formatted tool name (matching phase) and what it would act on (a command, path, URL, or input). */
  tool?: string;
  input?: string;
}

export interface AskQuestion {
  header?: string;
  question: string;
  options: string[];
  multiSelect?: boolean;
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
/** The desktop app's end-of-turn box; its ask is a question to the user. */
const WRAP_UP = 'mcp__ccd_turn__wrap_up';
/** A run with no agent running is kept this long, through the gap between its phases, then dropped. */
const KEEP_WORKFLOW_MS = 10 * 60_000;
/** A sub-agent with no event for this long is dropped: its SubagentStop was missed, say across a daemon restart. */
const FORGET_AGENT_MS = 60 * 60_000;
/** How often an unknown workflow agent may send the journals to be read again. */
const RESCAN_JOURNALS_MS = 2_000;
/** The id the desktop app's claude:// links accept for a session. */
const DESKTOP_ID = /^local_[A-Za-z0-9-]{1,64}$/;
/** Display limits for a waiting prompt's tool input, questions, and choices. */
const MAX_ASK_INPUT = 2000;
const MAX_ASK_TEXT = 500;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 8;

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
  /**
   * The question a session's turn ended on, from the desktop app's wrap-up box. No hook reports it as a prompt,
   * and Stop would clear it, so it is kept to show the session as waiting until the user answers.
   */
  private asked = new Map<string, AskQuestion>();
  /**
   * The tool calls under way in each session, by caller (the main loop '', or a sub-agent's id) and then by call id.
   * PreToolUse runs before the permission check, so a permission prompt asks about one of its caller's open calls;
   * with several open at once, which one is unknown.
   */
  private calls = new Map<string, Map<string, Map<string, { name: unknown; input: any }>>>();
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
      const codex = p.host === 'codex';
      s = { id, ...(codex ? { host: 'codex' as const } : {}), cwd, title: path.basename(cwd) || (codex ? 'Codex' : 'Claude'), state: 'idle', phase: '', waitingFor: null, inTool: false, stalled: false, startedAt: now, activeAt: now, agents: [], workflows: [] };
      this.sessions.set(id, s);
    }
    if (typeof p.session_title === 'string' && p.session_title) s.title = p.session_title;
    if (typeof p.desktop_session_id === 'string' && DESKTOP_ID.test(p.desktop_session_id)) s.desktopId = p.desktop_session_id;
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
        this.asked.delete(id);
        s.state = 'idle';
        s.phase = p.source === 'compact' ? 'context compacted' : 'session started';
        break;
      case 'UserPromptSubmit':
        this.resting.delete(id);
        this.asked.delete(id);
        s.state = 'working';
        s.waitingFor = null;
        s.phase = 'reading the prompt';
        // Only what the user typed: Codex reports Crew's own queued note as a prompt too.
        if (typeof p.prompt === 'string' && p.prompt.trim() && !(s.host === 'codex' && QUEUED_NOTE.test(p.prompt.trim()))) {
          const kept = this.prompts.get(id) ?? [];
          kept.push({ text: clip(p.prompt.trim(), MAX_PROMPT), at: now });
          this.prompts.set(id, kept.slice(-KEEP_PROMPTS));
        }
        this.hooks.onEvent(s, 'started', oneLine(p.prompt ?? 'prompt'));
        break;
      case 'PreToolUse':
        this.resting.delete(id);
        // The main loop went on, so the question was answered, whatever path the answer took.
        this.asked.delete(id);
        s.state = 'working';
        s.waitingFor = null;
        s.inTool = true;
        s.phase = describeTool(p.tool_name, p.tool_input);
        this.call(id, '', p);
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
        // The call a prompt asked about is over, answered or not.
        s.waitingFor = null;
        this.ended(id, '', p);
        if (p.tool_name === WRAP_UP && typeof p.tool_input?.ask === 'string' && p.tool_input.ask.trim()) this.asked.set(id, wrapUpQuestion(p.tool_input));
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
          if (this.asked.has(id)) break;
          s.state = s.agents.length ? 'working' : 'idle';
        } else if (type === 'permission_prompt' || type === 'agent_needs_input' || type === 'elicitation_dialog') {
          const from = typeof p.agent_id === 'string' ? p.agent_id : '';
          const open = type === 'permission_prompt' ? this.calls.get(id)?.get(from) : undefined;
          const call = open?.size === 1 ? [...open.values()][0] : undefined;
          this.wait(s, from, call && askOf(call.name, call.input), p.message ?? 'needs input');
        }
        break;
      }
      case 'PermissionRequest': {
        // Codex's counterpart of the permission prompt, naming the call it asks about.
        const ask = askOf(p.tool_name, p.tool_input);
        this.wait(s, typeof p.agent_id === 'string' ? p.agent_id : '', ask, `needs your permission to use ${ask?.tool ?? 'a tool'}`);
        break;
      }
      case 'Interrupt':
        // Codex: the user stopped the turn.
        this.resting.add(id);
        this.asked.delete(id);
        s.state = s.agents.length ? 'working' : 'idle';
        s.inTool = false;
        s.waitingFor = null;
        s.phase = 'turn interrupted';
        this.calls.delete(id);
        break;
      case 'Stop':
        this.resting.add(id);
        s.state = s.agents.length ? 'working' : 'idle';
        s.inTool = false;
        s.waitingFor = null;
        s.phase = 'finished the turn';
        this.hooks.onEvent(s, 'done', oneLine(p.last_assistant_message ?? 'turn finished'));
        if (this.asked.has(id)) {
          const asked = this.asked.get(id)!;
          s.waitingId = randomUUID();
          this.waitingFrom.set(id, '');
          s.state = 'waiting';
          s.waitingFor = oneLine(asked.question);
          if (asked.options.length) s.ask = { questions: [asked] };
          else delete s.ask;
          this.hooks.onEvent(s, 'waiting', s.waitingFor);
        }
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
    if (s.state !== 'waiting') {
      delete s.waitingId;
      delete s.ask;
    }
    this.hooks.onSession(s);
  }

  /** Shows the session waiting on a prompt raised by `from` (a sub-agent's id, or '' for the main loop). */
  private wait(s: ClaudeSession, from: string, ask: ClaudeAsk | undefined, fallback: string): void {
    // A question reads better than the prompt's "needs your permission to use AskUserQuestion".
    const message = ask?.questions ? oneLine(ask.questions[0].question) : oneLine(fallback);
    if (s.state !== 'waiting' || s.waitingFor !== message || !s.waitingId) s.waitingId = randomUUID();
    this.waitingFrom.set(s.id, from);
    s.state = 'waiting';
    s.waitingFor = message;
    if (ask) s.ask = ask;
    else delete s.ask;
    this.hooks.onEvent(s, 'waiting', s.waitingFor);
  }

  /** Records the open mission a lead session just acted on, or that it has none any more. */
  focus(id: string, mission: string | undefined): void {
    const s = this.sessions.get(id);
    if (!s || s.mission === mission) return;
    if (mission) s.mission = mission;
    else delete s.mission;
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
    this.asked.delete(id);
    this.calls.delete(id);
    this.waitingFrom.delete(id);
    this.journals.delete(id);
  }

  /** Handles what happens inside a sub-agent; false leaves the event to the session, as a permission prompt is. */
  private ingestAgent(s: ClaudeSession, id: string, p: any, now: number): boolean {
    switch (p.hook_event_name) {
      case 'SubagentStart':
        this.agent(s, id, p, now);
        return true;
      case 'UserPromptSubmit':
        // Codex reports a sub-agent's task as its prompt: the sub-agent's start, not the user's turn or words.
        this.agent(s, id, p, now).phase = 'reading the prompt';
        return true;
      case 'SubagentStop': {
        this.calls.get(s.id)?.delete(id);
        // A prompt the sub-agent raised ends with it, answered or not.
        this.answered(s, id);
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
        this.call(s.id, id, p);
        this.answered(s, id);
        return true;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        this.agent(s, id, p, now).inTool = false;
        this.ended(s.id, id, p);
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
    delete s.ask;
  }

  /** Keeps a tool call open for the permission prompt that may follow it. A payload without a call id replaces the caller's open calls. */
  private call(sessionId: string, caller: string, p: any): void {
    let callers = this.calls.get(sessionId);
    if (!callers) this.calls.set(sessionId, (callers = new Map()));
    let open = callers.get(caller);
    if (!open) callers.set(caller, (open = new Map()));
    if (typeof p.tool_use_id !== 'string') open.clear();
    open.set(typeof p.tool_use_id === 'string' ? p.tool_use_id : '', { name: p.tool_name, input: p.tool_input });
  }

  private ended(sessionId: string, caller: string, p: any): void {
    const open = this.calls.get(sessionId)?.get(caller);
    if (!open) return;
    if (typeof p.tool_use_id === 'string') open.delete(p.tool_use_id);
    else open.clear();
    if (!open.size) this.calls.get(sessionId)!.delete(caller);
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
  return line.length > 140 ? `${clip(line, 139)}…` : line;
}

/** Builds prompt details from the tool call being approved: its questions and choices, or the tool and what it acts on. */
function askOf(name: unknown, input: any): ClaudeAsk | undefined {
  if (name === 'AskUserQuestion') {
    const questions = (Array.isArray(input?.questions) ? input.questions : [])
      .filter((q: any) => typeof q?.question === 'string' && q.question.trim())
      .slice(0, MAX_QUESTIONS)
      .map((q: any): AskQuestion => ({
        ...(typeof q.header === 'string' && q.header.trim() ? { header: clip(q.header.trim(), MAX_ASK_TEXT) } : {}),
        question: clip(q.question.trim(), MAX_ASK_TEXT),
        options: (Array.isArray(q.options) ? q.options : [])
          .map((o: any) => (typeof o === 'string' ? o : o?.label))
          .filter((label: unknown): label is string => typeof label === 'string' && !!label.trim())
          .slice(0, MAX_OPTIONS)
          .map((label: string) => clip(label.trim(), MAX_ASK_TEXT)),
        ...(q.multiSelect === true ? { multiSelect: true } : {}),
      }));
    return questions.length ? { questions } : undefined;
  }
  if (typeof name !== 'string' || !name) return undefined;
  const mcp = /^mcp__(?:plugin_[^_]+_)?(.+?)__(.+)$/.exec(name);
  const tool = mcp ? `${mcp[1]} ${mcp[2]}` : name;
  const value = [input?.command, input?.file_path, input?.notebook_path, input?.url, input?.path].find((v) => typeof v === 'string' && v.trim());
  let text = value as string | undefined;
  if (!text && input && typeof input === 'object' && Object.keys(input).length) text = JSON.stringify(input, null, 2);
  return text ? { tool, input: clip(text.trim(), MAX_ASK_INPUT) } : { tool };
}

/** Extracts the desktop app's end-of-turn question and its button choices, falling back to the action name when an action has no label. */
function wrapUpQuestion(input: any): AskQuestion {
  const options = (Array.isArray(input.actions) ? input.actions : [])
    .map((a: any) => (typeof a?.label === 'string' && a.label.trim() ? a.label : typeof a?.action === 'string' ? a.action.replace(/_/g, ' ') : ''))
    .filter((label: string) => label.trim())
    .slice(0, MAX_OPTIONS)
    .map((label: string) => clip(label.trim(), MAX_ASK_TEXT));
  return { question: clip(input.ask.trim(), MAX_ASK_TEXT), options };
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
