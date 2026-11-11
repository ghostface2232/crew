import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { agentEnv, BASE_URL, HOME, VERSION } from './config.ts';

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

export async function health(): Promise<{ version: string; pid: number; active: number } | null> {
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

/** Starts the daemon if it is not running, and upgrades an idle one left over from an older plugin version. */
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

async function startDaemon(): Promise<void> {
  const running = await health();
  if (running) {
    // Only ever upgrade: if two installs of different versions each replaced the other's daemon,
    // they would take turns killing it. And never under running jobs, which a restart would fail.
    if (!isNewer(VERSION, running.version) || running.active > 0) return;
    await api('POST', '/api/shutdown', {}).catch(() => {});
    await waitFor(async () => (await health()) === null, 5000);
  }
  fs.mkdirSync(HOME, { recursive: true });
  const out = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'daemon.ts')], {
    detached: true,
    stdio: ['ignore', out, out],
    env: agentEnv(),
  });
  child.unref();
  if (!(await waitFor(async () => (await health()) !== null, 8000))) {
    throw new Error(`The Crew daemon did not start. See ${path.join(HOME, 'daemon.log')}.`);
  }
}
