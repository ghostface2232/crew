import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ClaudeSessions } from '../plugin/bridge/claude.ts';

function tracker() {
  const events: string[] = [];
  const attention: string[] = [];
  const sessions = new ClaudeSessions(300, {
    onSession: () => {},
    onEvent: (_s, kind, detail) => events.push(`${kind}:${detail}`),
    onAttention: (_s, kind) => attention.push(kind),
  });
  const hook = (name: string, extra: object = {}) => sessions.ingest({ session_id: 's1', cwd: '/work/app', hook_event_name: name, ...extra });
  return { sessions, events, attention, hook };
}

test('a turn moves the session from working to idle', () => {
  const { sessions, events, hook } = tracker();
  hook('UserPromptSubmit', { prompt: 'Fix the bug\nwith details', session_title: 'Bug fix' });
  hook('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/work/app/src/a.ts' } });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.state, 'working');
  assert.equal(s.title, 'Bug fix');
  assert.equal(s.phase, 'Edit a.ts');
  assert.equal(s.inTool, true);

  hook('PostToolUse', { tool_name: 'Edit' });
  hook('Stop', { last_assistant_message: 'Done.' });
  assert.equal(s.state, 'idle');
  assert.deepEqual(events, ['started:Fix the bug', 'done:Done.']);
});

test('permission prompts and rate limits surface as waiting and limit', () => {
  const { sessions, events, attention, hook } = tracker();
  hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.equal(sessions.sessions.get('s1')!.state, 'waiting');

  hook('StopFailure', { error: 'rate_limit', error_details: '429 Too Many Requests' });
  assert.equal(sessions.sessions.get('s1')!.state, 'error');
  assert.equal(events.at(-1), 'limit:rate_limit: 429 Too Many Requests');
  assert.deepEqual(attention, ['limit']);
});

test('repeated input requests have distinct identities even between desktop polls', () => {
  const { sessions, hook } = tracker();
  const prompt = { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' };
  hook('Notification', prompt);
  const first = structuredClone(sessions.sessions.get('s1')!);
  assert.ok(first.waitingId);

  hook('Notification', prompt);
  assert.equal(sessions.sessions.get('s1')!.waitingId, first.waitingId);

  hook('PreToolUse', { tool_name: 'Bash' });
  assert.equal(sessions.sessions.get('s1')!.waitingId, undefined);
  hook('Notification', prompt);
  const second = structuredClone(sessions.sessions.get('s1')!);
  assert.equal(second.waitingFor, first.waitingFor);
  assert.ok(second.waitingId);
  assert.notEqual(second.waitingId, first.waitingId);

  hook('Notification', { ...prompt, message: 'Allow another command?' });
  assert.notEqual(sessions.sessions.get('s1')!.waitingId, second.waitingId);

  hook('SessionEnd');
  hook('Notification', prompt);
  assert.notEqual(sessions.sessions.get('s1')!.waitingId, second.waitingId);
});

test('sub-agent tool calls do not change the main loop tool state, and SessionEnd forgets the session', () => {
  const { sessions, hook } = tracker();
  hook('PreToolUse', { tool_name: 'mcp__plugin_crew_crew__wait', tool_input: {} });
  hook('PostToolUse', { tool_name: 'Read', agent_id: 'sub-1' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.inTool, true);
  assert.equal(s.phase, 'crew wait');

  hook('SessionEnd', { reason: 'other' });
  assert.equal(sessions.sessions.has('s1'), false);
});

test('sub-agents are listed with their Agent call description and keep a finished turn working', () => {
  const { sessions, hook } = tracker();
  hook('UserPromptSubmit', { prompt: 'Look around' });
  hook('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Find the parser', subagent_type: 'Explore' } });
  hook('PreToolUse', { tool_name: 'Agent', tool_input: { description: 'Read the docs' } });
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'general-purpose' });
  hook('SubagentStart', { agent_id: 'a2', agent_type: 'Explore' });
  const s = sessions.sessions.get('s1')!;
  assert.deepEqual(s.agents.map((a) => [a.id, a.title]), [['a1', 'Read the docs'], ['a2', 'Find the parser']]);

  hook('PreToolUse', { agent_id: 'a2', agent_type: 'Explore', tool_name: 'Grep', tool_input: { pattern: 'parse' } });
  assert.equal(s.agents[1].phase, 'Grep parse');
  assert.equal(s.phase, 'Agent Read the docs');

  hook('Stop', { last_assistant_message: 'Started two.' });
  assert.equal(s.state, 'working');
  hook('SubagentStop', { agent_id: 'a1', agent_type: 'general-purpose' });
  assert.equal(s.state, 'working');
  hook('SubagentStop', { agent_id: 'a2', agent_type: 'Explore' });
  assert.equal(s.state, 'idle');
  assert.deepEqual(s.agents, []);
});

test('a sub-agent moving on clears the prompt it raised', () => {
  const { sessions, hook } = tracker();
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?', agent_id: 'a1' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.state, 'waiting');
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.equal(s.state, 'working');
  assert.equal(s.waitingFor, null);
  assert.equal(s.waitingId, undefined);
});

test('workflow agents take their run and label from the run journal', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-claude-'));
  try {
    const session = path.join(projects, 's1');
    const run = path.join(session, 'subagents', 'workflows', 'wf_1');
    fs.mkdirSync(run, { recursive: true });
    fs.mkdirSync(path.join(session, 'workflows', 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(session, 'workflows', 'scripts', 'hook-probe-wf_1.js'), '');
    const { sessions, hook } = tracker();
    const transcript_path = path.join(projects, 's1.jsonl');
    hook('SubagentStart', { agent_id: 'w1', agent_type: 'workflow-subagent', transcript_path });
    const s = sessions.sessions.get('s1')!;
    assert.equal(s.agents[0].title, 'workflow-subagent');

    fs.writeFileSync(path.join(run, 'journal.jsonl'), `${JSON.stringify({ type: 'started', agentId: 'w1', label: 'probe-1' })}\n`);
    // The journals are read again only after a pause, however many events come in.
    hook('PostToolUse', { agent_id: 'w1', agent_type: 'workflow-subagent', transcript_path, tool_name: 'Bash' });
    assert.equal(s.agents[0].title, 'workflow-subagent');
    t.mock.timers.tick(2_000);
    hook('PreToolUse', { agent_id: 'w1', agent_type: 'workflow-subagent', transcript_path, tool_name: 'Bash', tool_input: { command: 'echo' } });
    assert.equal(s.agents[0].title, 'probe-1');
    assert.equal(s.agents[0].workflow, 'wf_1');
    assert.deepEqual(s.workflows.map((w) => [w.id, w.name, w.done]), [['wf_1', 'hook-probe', 0]]);

    hook('SubagentStop', { agent_id: 'w1', agent_type: 'workflow-subagent', transcript_path });
    assert.deepEqual(s.agents, []);
    assert.equal(s.workflows[0].done, 1);
  } finally {
    fs.rmSync(projects, { recursive: true, force: true });
  }
});

test('a sub-agent clears only the prompt it raised', () => {
  const { sessions, hook } = tracker();
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('SubagentStart', { agent_id: 'a2', agent_type: 'Explore' });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow Edit?' });
  const s = sessions.sessions.get('s1')!;
  hook('PostToolUse', { agent_id: 'a1', tool_name: 'Read' });
  assert.equal(s.state, 'waiting');

  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?', agent_id: 'a1' });
  hook('PreToolUse', { agent_id: 'a2', tool_name: 'Grep' });
  assert.equal(s.waitingFor, 'Allow Bash?');
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash' });
  assert.equal(s.state, 'working');
});

test('a sub-agent whose stop was missed is dropped after an hour of silence, and a new process starts with none', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_000_000 });
  const { sessions, hook } = tracker();
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash' });
  hook('Stop');
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.state, 'working');
  t.mock.timers.tick(60 * 60_000);
  assert.deepEqual(s.agents, []);
  assert.equal(s.state, 'idle');

  hook('SubagentStart', { agent_id: 'a2', agent_type: 'Explore' });
  hook('SessionStart', { source: 'resume' });
  assert.deepEqual(s.agents, []);
});

test('a failed Agent call gives its title to no sub-agent, nor does one of another type', () => {
  const { sessions, hook } = tracker();
  hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 't1', tool_input: { description: 'Old', subagent_type: 'Explore' } });
  hook('PostToolUseFailure', { tool_name: 'Agent', tool_use_id: 't1' });
  hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 't2', tool_input: { description: 'New', subagent_type: 'Explore' } });
  hook('PreToolUse', { tool_name: 'Agent', tool_use_id: 't3', tool_input: { description: 'Plan it', subagent_type: 'Plan' } });
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('SubagentStart', { agent_id: 'a2', agent_type: 'general-purpose' });
  const s = sessions.sessions.get('s1')!;
  assert.deepEqual(s.agents.map((a) => a.title), ['New', 'general-purpose']);
});

test('a sub-agent first seen without its type takes it from a later event', () => {
  const { sessions, hook } = tracker();
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'Read' });
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  const agent = sessions.sessions.get('s1')!.agents[0];
  assert.equal(agent.type, 'Explore');
  assert.equal(agent.title, 'Explore');
});

test('a question asked in the wrap-up box keeps the session waiting after the turn ends, until the turn goes on', () => {
  const { sessions, events, hook } = tracker();
  hook('UserPromptSubmit', { prompt: 'Review it' });
  hook('PostToolUse', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'Done.', ask: 'Which finding first?\n' } });
  hook('Stop', { last_assistant_message: 'Done.' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitingFor, 'Which finding first?');
  assert.ok(s.waitingId);
  assert.ok(events.includes('waiting:Which finding first?'));
  hook('Notification', { notification_type: 'idle_prompt' });
  assert.equal(s.state, 'waiting');
  hook('UserPromptSubmit', { prompt: 'The first' });
  assert.equal(s.state, 'working');
  assert.equal(s.waitingFor, null);
  // A recap with no question leaves the turn as finished.
  hook('PostToolUse', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'Done.' } });
  hook('Stop', {});
  assert.equal(s.state, 'idle');
  // A question the turn moved past, by a tool call or a restart of the session, is not asked again at the next stop.
  for (const moved of [() => hook('PreToolUse', { tool_name: 'Read', tool_input: {} }), () => hook('SessionStart', { source: 'compact' })]) {
    hook('PostToolUse', { tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { recap: 'Done.', ask: 'Again?' } });
    hook('Stop', {});
    assert.equal(s.state, 'waiting');
    moved();
    hook('Stop', {});
    assert.equal(s.state, 'idle');
  }
});

test('a permission prompt carries the call it asks about, and a question its choices', () => {
  const { sessions, events, hook } = tracker();
  hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main', description: 'Push' } });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.waitingFor, 'Claude needs your permission to use Bash');
  assert.deepEqual(s.ask, { tool: 'Bash', input: 'git push origin main' });

  hook('PostToolUse', { tool_name: 'Bash' });
  assert.equal(s.ask, undefined);

  hook('PreToolUse', {
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ header: 'Layout', question: 'Which layout?', options: [{ label: 'Tabs', description: 'x' }, { label: 'Single column' }], multiSelect: false }] },
  });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission to use AskUserQuestion' });
  assert.equal(s.waitingFor, 'Which layout?');
  assert.deepEqual(s.ask, { questions: [{ header: 'Layout', question: 'Which layout?', options: ['Tabs', 'Single column'] }] });
  assert.equal(events.at(-1), 'waiting:Which layout?');

  // A sub-agent's prompt is about its own call, not the main loop's.
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'mcp__plugin_crew_crew__delegate', tool_input: { task: 'Build it' } });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow?', agent_id: 'a1' });
  // Read again: the assertions above narrowed s.ask for the type checker.
  const delegated = sessions.sessions.get('s1')!.ask;
  assert.equal(delegated?.tool, 'crew delegate');
  assert.match(delegated?.input ?? '', /"task": "Build it"/);

  // A prompt that is not about a tool call shows only its message.
  hook('Notification', { notification_type: 'elicitation_dialog', message: 'Sign in' });
  assert.equal(s.ask, undefined);
});

test('a prompt shows a call only while it is the one open call of its caller', () => {
  const { sessions, hook } = tracker();
  const prompt = { notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' };
  const ask = () => sessions.sessions.get('s1')!.ask;
  // A finished call is not what a later prompt asks about, even when that prompt's own PreToolUse was lost.
  hook('PreToolUse', { tool_name: 'Read', tool_use_id: 't1', tool_input: { file_path: '/w/a.ts' } });
  hook('PostToolUse', { tool_name: 'Read', tool_use_id: 't1' });
  hook('Notification', prompt);
  assert.equal(ask(), undefined);
  // Two calls running side by side leave it unknown which one asks.
  hook('PreToolUse', { tool_name: 'WebFetch', tool_use_id: 't2', tool_input: { url: 'https://a.example' } });
  hook('PreToolUse', { tool_name: 'WebFetch', tool_use_id: 't3', tool_input: { url: 'https://b.example' } });
  hook('Notification', prompt);
  assert.equal(ask(), undefined);
  hook('PostToolUse', { tool_name: 'WebFetch', tool_use_id: 't2' });
  hook('Notification', prompt);
  assert.deepEqual(ask(), { tool: 'WebFetch', input: 'https://b.example' });
});

test('a sub-agent that stops ends the prompt it raised', () => {
  const { sessions, hook } = tracker();
  hook('SubagentStart', { agent_id: 'a1', agent_type: 'Explore' });
  hook('PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_use_id: 't1', tool_input: { command: 'rm x' } });
  hook('Notification', { notification_type: 'permission_prompt', message: 'Allow Bash?', agent_id: 'a1' });
  const s = sessions.sessions.get('s1')!;
  assert.deepEqual(s.ask, { tool: 'Bash', input: 'rm x' });
  hook('SubagentStop', { agent_id: 'a1', agent_type: 'Explore' });
  assert.notEqual(s.state, 'waiting');
  assert.equal(s.ask, undefined);
});

test('the wrap-up box offers its buttons as the question\'s choices', () => {
  const { sessions, hook } = tracker();
  hook('PostToolUse', {
    tool_name: 'mcp__ccd_turn__wrap_up',
    tool_input: { recap: 'Done.', ask: 'Commit this?', actions: [{ action: 'commit' }, { label: 'Not now' }] },
  });
  hook('Stop', {});
  const s = sessions.sessions.get('s1')!;
  assert.deepEqual(s.ask, { questions: [{ question: 'Commit this?', options: ['commit', 'Not now'] }] });
  hook('UserPromptSubmit', { prompt: 'yes' });
  assert.equal(s.ask, undefined);
});

test('a desktop session keeps the id its claude:// links open, and a malformed one is ignored', () => {
  const { sessions, hook } = tracker();
  hook('SessionStart', { source: 'startup', desktop_session_id: 'local_e97eb8b4-b9ff-4551-b625-3c06c77253c7' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.desktopId, 'local_e97eb8b4-b9ff-4551-b625-3c06c77253c7');
  hook('UserPromptSubmit', { prompt: 'x', desktop_session_id: 'local_../../evil' });
  assert.equal(s.desktopId, 'local_e97eb8b4-b9ff-4551-b625-3c06c77253c7');
});

test('a Codex session gets its desktop id only when marked as a desktop thread, and a Claude session never does', () => {
  const { sessions, hook } = tracker();
  hook('SessionStart', { source: 'startup', host: 'codex' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.desktopId, undefined);
  sessions.desktop('s1');
  assert.equal(s.desktopId, 's1');
  sessions.desktop('unknown');
  assert.equal(sessions.sessions.has('unknown'), false);
  const claude = tracker();
  claude.hook('SessionStart', { source: 'startup' });
  claude.sessions.desktop('s1');
  assert.equal(claude.sessions.sessions.get('s1')!.desktopId, undefined);
});

test('a Codex lead session is tracked from the same hooks, with its own prompts, approvals and interruptions', () => {
  const { sessions, events, hook } = tracker();
  const codex = (name: string, extra: object = {}) => hook(name, { host: 'codex', turn_id: 't1', model: 'gpt-6.2-sol', ...extra });
  codex('SessionStart', { source: 'startup' });
  const s = sessions.sessions.get('s1')!;
  assert.equal(s.host, 'codex');
  assert.equal(s.title, 'app');

  codex('UserPromptSubmit', { prompt: 'Ship the fix; pushing is fine' });
  // A sub-agent's task and Crew's own queued note are not the user's words.
  codex('UserPromptSubmit', { prompt: 'Review the diff', agent_id: 'a1', agent_type: 'default' });
  codex('UserPromptSubmit', { prompt: 'Crew has news for cx-1, cx-2. Call the Crew status tool to read it, then act on it.' });
  assert.deepEqual(sessions.recentPrompts('s1').map((p) => p.text), ['Ship the fix; pushing is fine']);

  codex('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'c1' });
  codex('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'git push' } });
  assert.equal(s.state, 'waiting');
  assert.equal(s.waitingFor, 'needs your permission to use Bash');
  assert.deepEqual(s.ask, { tool: 'Bash', input: 'git push' });
  // A sub-agent's task starts the sub-agent; the lead's prompt still waits.
  codex('UserPromptSubmit', { prompt: 'Check the tests', agent_id: 'a3', agent_type: 'default' });
  assert.equal(s.state, 'waiting');
  assert.ok(s.waitingId);
  codex('PostToolUse', { tool_name: 'Bash', tool_use_id: 'c1' });
  assert.equal(s.state, 'working');
  assert.equal(s.waitingFor, null);
  assert.equal(s.ask, undefined);

  // Codex's own sub-agent tools, as Codex 0.172 names them in hooks.
  codex('PreToolUse', { tool_name: 'collaborationwait_agent', tool_input: { targets: ['a1'] } });
  assert.equal(s.phase, 'wait agent');
  codex('PostToolUse', { tool_name: 'collaborationwait_agent' });
  codex('SubagentStart', { agent_id: 'a2', agent_type: 'explorer' });
  assert.deepEqual(s.agents.map((a) => a.id).sort(), ['a1', 'a2', 'a3']);
  for (const agent of ['a1', 'a3']) codex('SubagentStop', { agent_id: agent, agent_type: 'default', last_assistant_message: 'ok' });
  codex('SubagentStop', { agent_id: 'a2', agent_type: 'explorer', last_assistant_message: 'ok' });
  codex('Interrupt');
  assert.equal(s.state, 'idle');
  assert.equal(s.phase, 'turn interrupted');
  assert.ok(events.includes('waiting:needs your permission to use Bash'));
  assert.ok(!events.some((e) => e.startsWith('done:')));
});

test('only a Codex session leaves out a prompt that reads like the queued note Crew sends', () => {
  const { sessions, hook } = tracker();
  const note = 'Crew has news for cx-1. Call the Crew status tool to read it, then act on it.';
  hook('UserPromptSubmit', { prompt: note });
  assert.deepEqual(sessions.recentPrompts('s1').map((p) => p.text), [note]);
});
