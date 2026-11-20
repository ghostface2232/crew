import { readToken } from './auth.ts';
import { baseUrl, HOME } from './config.ts';

/**
 * Reports a Claude Code hook event to the status board. A command hook rather than an http one, because the
 * daemon's port is known only once it has started. It never blocks Claude: without a daemon there is nothing to tell.
 */
// Decoded as one text: a character split across two reads would otherwise be lost.
process.stdin.setEncoding('utf8');
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const token = readToken(HOME);
try {
  await fetch(`${baseUrl()}/api/hooks/claude`, {
    method: 'POST',
    // The daemon takes what a prompt hook reports as the user's own words, so it must know the user's program sent it.
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: raw,
    signal: AbortSignal.timeout(2000),
  });
} catch {
  /* No daemon is running. */
}
