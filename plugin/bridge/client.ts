import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { readToken, tokenFile } from './auth.ts';
import { agentEnv, BASE_URL, HOME, installed, PLUGIN_ROOT } from './config.ts';

export async function api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const send = (token: string | null) => fetch(`${BASE_URL}${route}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await send(readToken(HOME));
  // The daemon makes the token file on its first start, which may be a moment after this process first looked.
  if (res.status === 401) {
    await new Promise((r) => setTimeout(r, 200));
    res = await send(readToken(HOME));
  }
  const data: any = await res.json();
  if (res.status === 401) throw new Error(`The Crew daemon refused this request: ${tokenFile(HOME)} is missing or is not the running daemon's. Restart the daemon with \`crew daemon restart\`.`);
  if (!res.ok) throw new Error(data.error ?? `bridge returned ${res.status}`);
  return data;
}

export interface Health {
  version: string;
  /** Code fingerprint; absent on daemons from before it was reported. */
  build?: string;
  /** Plugin folder the daemon runs from; absent on daemons from before it was reported. */
  root?: string;
  pid: number;
  active: number;
}

export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(1000) });
    const data: any = await res.json();
    return data.name === 'crew' ? { ...data, active: data.active ?? 0 } : null;
  } catch {
    return null;
  }
}

async function waitFor(check: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let ensuring: Promise<void> | null = null;

/** Starts the daemon if it is not running, and replaces an idle one that runs code other than what is installed. */
export function ensureDaemon(): Promise<void> {
  // Concurrent callers share one attempt, so a cold start spawns a single daemon.
  ensuring ??= startDaemon().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

/** Compares dotted numeric versions. */
export function isNewer(candidate: string, current: string): boolean {
  const a = candidate.split('.').map(Number);
  const b = current.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

/**
 * Whether a running daemon should be replaced by one spawned from `root`.
 * Never while jobs run: a restart would fail them.
 */
export function shouldReplace(running: Health, disk: { version: string; build: string }, root: string): boolean {
  if (running.build === disk.build) return false;
  // Another install owns the daemon. Only a newer version takes over; otherwise two installs
  // with different code would take turns replacing each other's daemon.
  const foreign = running.root !== undefined && running.root !== root;
  if (foreign && !isNewer(disk.version, running.version)) return false;
  return running.active === 0;
}

/**
 * Stops the running daemon even if jobs are active, for `crew daemon stop` and `restart`.
 * Falls back to SIGTERM if the daemon rejects the token on disk, and throws if it stays up.
 */
export async function stopDaemon(): Promise<void> {
  const running = await health();
  if (!running) return;
  const down = async () => (await health()) === null;
  const asked = await api('POST', '/api/shutdown', {}).then(() => true, () => false);
  if (asked && await waitFor(down, 5000)) return;
  const stuck = new Error(`The Crew daemon (process ${running.pid}) is still running at ${BASE_URL}. Stop that process yourself, then start Crew again.`);
  // Any local listener can report an arbitrary PID on /api/health; only signal the PID
  // that this home's daemon recorded on disk.
  let recorded: unknown;
  try {
    recorded = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8')).pid;
  } catch {
    throw stuck;
  }
  if (!Number.isInteger(recorded) || (recorded as number) <= 0 || recorded !== running.pid) throw stuck;
  try {
    process.kill(running.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw stuck;
  }
  if (!(await waitFor(down, 5000))) throw stuck;
}

async function startDaemon(): Promise<void> {
  const running = await health();
  if (running) {
    // Compare with the code on disk, not the code this process loaded: a long-lived session
    // still running old code must not keep restarting a daemon that is already current.
    if (!shouldReplace(running, installed(), PLUGIN_ROOT)) return;
    // A job may have started since the health check, or the daemon may reject our token.
    // Either way, leave the running daemon alone; a token mismatch is reported on the next call.
    try {
      await api('POST', '/api/shutdown', { ifIdle: true });
    } catch {
      return;
    }
    await waitFor(async () => (await health()) === null, 5000);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, `daemon${path.extname(import.meta.filename)}`)], {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...agentEnv(), ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
  });
  let spawnError: Error | undefined;
  child.on('error', (error) => { spawnError = error; });
  child.unref();
  fs.closeSync(out);
  if (!(await waitFor(async () => {
    if (spawnError) throw new Error(`Could not start the Crew daemon: ${spawnError.message}`);
    return (await health()) !== null;
  }, 8000))) {
    throw new Error(`The Crew daemon did not start. See ${path.join(HOME, 'daemon.log')}.`);
  }
}
