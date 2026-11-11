import assert from 'node:assert/strict';
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
