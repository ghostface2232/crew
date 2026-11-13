import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The daemon starts agents and writes files, and it listens on a local port that any process on the
 * machine can reach, including a worker whose sandbox has the network open. Every request therefore
 * carries a secret that only the user's own programs can read: the file below, readable by the user alone
 * and denied to workers by their sandbox.
 */

export const SESSION_COOKIE = 'crew_session';

export function tokenFile(home: string): string {
  return path.join(home, 'token');
}

/** The secret, made on first use. It is kept across restarts so an open board or app stays signed in. */
export function ensureToken(home: string): string {
  const file = tokenFile(home);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) {
      fs.chmodSync(file, 0o600);
      return existing;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const token = randomBytes(32).toString('hex');
  fs.mkdirSync(home, { recursive: true });
  // Written under another name first: a reader never sees a half-written secret, and a planted link is not followed.
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
  return token;
}

/** The secret as a client reads it; null before any daemon has run. */
export function readToken(home: string): string | null {
  try {
    return fs.readFileSync(tokenFile(home), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

export function sameToken(given: unknown, expected: string): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The board's address with the secret in the fragment, which a browser keeps to itself and never sends. */
export function boardUrl(base: string, token: string | null): string {
  return token ? `${base}/#token=${token}` : base;
}
