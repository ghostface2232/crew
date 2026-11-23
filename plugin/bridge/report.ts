import { api } from './client.ts';

/**
 * Reports a Claude Code hook event to the status board. A command hook rather than an http one, because the
 * daemon's port is known only once it has started. It never blocks Claude: without a daemon there is nothing to tell.
 */
try {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const payload = JSON.parse(raw);
  // The desktop app's own id for the session (local_…), which its claude:// links open. A CLI session has none.
  if (process.env.CLAUDE_CODE_HOST_SESSION_ID) payload.desktop_session_id = process.env.CLAUDE_CODE_HOST_SESSION_ID;
  await api('POST', '/api/hooks/claude', payload, AbortSignal.timeout(2000));
} catch {
  // Reporting is best-effort.
}
