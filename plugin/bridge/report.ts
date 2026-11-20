import { api } from './client.ts';

/**
 * Reports a Claude Code hook event to the status board. A command hook rather than an http one, because the
 * daemon's port is known only once it has started. It never blocks Claude: without a daemon there is nothing to tell.
 */
try {
  process.stdin.setEncoding('utf8');
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  await api('POST', '/api/hooks/claude', JSON.parse(raw), AbortSignal.timeout(2000));
} catch {
  // Reporting is best-effort.
}
