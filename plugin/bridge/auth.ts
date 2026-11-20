import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * The daemon starts agents and writes files, and it listens on a local port that any process on the
 * machine can reach, including a worker whose sandbox has the network open. Every request therefore
 * carries a secret that only the user's own programs can read: the file below, readable by the user alone
 * and denied to workers by their sandbox.
 */

/** The cookie that once carried the secret itself. It is no longer read; the name stays so it can be cleared. */
export const SESSION_COOKIE = 'crew_session';

export function tokenFile(home: string): string {
  return path.join(home, 'token');
}

/**
 * A secret made before boards signed in with tickets may have been written where a worker can read it: a browser's
 * cookie file or history, or the transcript of a session that printed the board's address. Such a secret is replaced
 * once, and this number, kept beside it, says that it has been.
 */
const TOKEN_VERSION = 2;

/** The secret, made on first use. It is kept across restarts so an open board or app stays signed in. */
export function ensureToken(home: string): string {
  const file = tokenFile(home);
  const version = `${file}.version`;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing) && Number(fs.readFileSync(version, 'utf8')) >= TOKEN_VERSION) {
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
  // After the secret: a stop between the two replaces the secret once more at the next start, which costs nothing.
  fs.writeFileSync(version, `${TOKEN_VERSION}\n`, { mode: 0o600 });
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

// The parts are sealed as JSON, so no two lists of parts make the same text.
const seal = (token: string, ...parts: (string | number)[]) => createHmac('sha256', token).update(JSON.stringify(parts)).digest('hex');

/** How long a board page stays signed in. It holds the credential in memory only, so closing or reloading it ends it sooner. */
const BOARD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * What a board page holds once it has traded in its ticket. It is sealed with the secret rather than recorded, so an
 * open board outlives a daemon restart, and it stops working when it lapses or the secret is replaced. It is not the
 * secret: the daemon lets it do what the board's pages do and nothing else.
 */
export function boardCredential(token: string, now = Date.now()): { credential: string; expires: number } {
  const expires = now + BOARD_LIFETIME_MS;
  return { credential: `board.${expires}.${seal(token, 'board', expires)}`, expires };
}

/** When a board credential lapses, or null for anything that is not one still in force. */
export function boardExpiry(given: unknown, token: string, now = Date.now()): number | null {
  const [kind, expires, sealed, ...rest] = typeof given === 'string' ? given.split('.') : [];
  // One spelling for each moment, and few enough digits to be an exact number.
  if (kind !== 'board' || rest.length || !/^[1-9]\d{0,14}$/.test(expires ?? '') || !sameToken(sealed, seal(token, 'board', Number(expires)))) return null;
  return Number(expires) > now ? Number(expires) : null;
}

/**
 * Lets an image or video element, which cannot send a header, load one recorded file. It covers the file's recorded
 * modification time, so it stops opening the name once a newer file is recorded under it.
 */
export function evidenceSeal(token: string, job: string, file: string, modified: number): string {
  return seal(token, 'evidence', job, file, modified);
}

/** The board's address with a sign-in ticket in the fragment, which a browser keeps to itself and never sends. */
export function boardUrl(base: string, ticket: string | null): string {
  return ticket ? `${base}/#ticket=${ticket}` : base;
}
