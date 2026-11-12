import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEnv, BASE_URL, HOME, installed, PLUGIN_ROOT } from './config.ts';

export async function api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json();
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

async function startDaemon(): Promise<void> {
  const running = await health();
  if (running) {
    // Compare with the code on disk, not the code this process loaded: a long-lived session
    // still running old code must not keep restarting a daemon that is already current.
    if (!shouldReplace(running, installed(), PLUGIN_ROOT)) return;
    await api('POST', '/api/shutdown', {}).catch(() => {});
    await waitFor(async () => (await health()) === null, 5000);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, `daemon${path.extname(import.meta.filename)}`)], {
    detached: true,
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
