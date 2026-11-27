import { api } from './client.ts';

/**
 * Reports a Claude Code or Codex hook event to the status board (`report.ts codex` for Codex, whose payloads carry the
 * same fields). A command hook rather than an http one, because the daemon's port is known only once it has started.
 * It never blocks the lead: without a daemon there is nothing to tell.
 */
try {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  // The sync wake hook reports the main Stop and asks for news in one request.
  if (payload.hook_event_name === 'Stop' && !payload.agent_id) process.exit(0);
  if (process.argv[2] === 'codex') payload.host = 'codex';
  // The desktop app's own id for the session (local_…), which its claude:// links open. A CLI session has none, and a
  // Codex started from a Claude Code terminal inherits the variable, so only Claude's hooks pass it.
  else if (process.env.CLAUDE_CODE_HOST_SESSION_ID) payload.desktop_session_id = process.env.CLAUDE_CODE_HOST_SESSION_ID;
  await api('POST', '/api/hooks/claude', payload, AbortSignal.timeout(2000));
} catch {
  // Reporting is best-effort.
}
