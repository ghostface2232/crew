import { baseUrl } from './config.ts';

/**
 * Reports a Claude Code hook event to the status board. A command hook rather than an http one, because the
 * daemon's port is known only once it has started. It never blocks Claude: without a daemon there is nothing to tell.
 */
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
try {
  await fetch(`${baseUrl()}/api/hooks/claude`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
    signal: AbortSignal.timeout(2000),
  });
} catch {
  /* No daemon is running. */
}
