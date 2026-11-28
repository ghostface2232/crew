import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { healthProof, readToken, sameToken, tokenFile } from './auth.ts';
import { agentEnv, baseUrl, HOME, installed, nodeEnv, PLUGIN_ROOT, PORTS } from './config.ts';
import { execTimed } from './rpc.ts';

export async function api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const origin = baseUrl();
  const send = async () => {
    signal?.throwIfAborted();
    const daemon = await verifiedDaemon(origin);
    if (!daemon) throw new Error(`The listener at ${origin} is not a verified Crew daemon.`);
    try {
      return await fetch(`${origin}${route}`, {
        method,
        signal,
        redirect: 'error',
        headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(daemon.token ? { authorization: `Bearer ${daemon.token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      forgetDaemon(origin);
      throw err;
    }
  };
  let res = await send();
  // A daemon may start or the token may change while a request is in flight.
  if (res.status === 401) {
    forgetDaemon(origin);
    await delay(200, undefined, { signal });
    res = await send();
  }
  const data: any = await res.json().catch((err) => {
    forgetDaemon(origin);
    throw err;
  });
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
  /** Started by a client whose own environment was filtered, so its workers miss the user's variables. */
  partialEnv?: boolean;
}

export const DAEMON_PORT_GRACE_MS = 10_000;
const DAEMON_PROBE_TIMEOUT_MS = 1000;

/** Whether something accepts connections on the port, as opposed to the system holding it with nothing behind it. */
export function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.setTimeout(DAEMON_PROBE_TIMEOUT_MS, () => { socket.destroy(); resolve(true); });
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

/** The port and PID recorded by this Crew home's daemon, while the process is alive. */
export function daemonRecord(): { port: number; pid: number } | null {
  try {
    const { port, pid } = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isSafeInteger(pid) || pid < 1) return null;
    try {
      process.kill(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EPERM') return null;
    }
    return { port, pid };
  } catch {
    return null;
  }
}

interface VerifiedDaemon {
  health: Health;
  token: string | null;
}

/** A fresh, unauthenticated probe. Startup also uses it to identify another daemon before giving up a port. */
export async function probeDaemon(origin: string): Promise<VerifiedDaemon | null> {
  try {
    const challenge = randomBytes(32).toString('hex');
    const res = await fetch(`${origin}/api/health?challenge=${challenge}`, { redirect: 'error', signal: AbortSignal.timeout(DAEMON_PROBE_TIMEOUT_MS) });
    if (!res.ok) return null;
    const data = await res.json();
    if (data?.name !== 'crew' || !Number.isSafeInteger(data.pid) || data.pid < 1) return null;
    const token = readToken(HOME);
    // With no token, callers can identify Crew by name without sending a credential.
    if (!token) return { health: { ...data, active: data.active ?? 0 }, token: null };
    if (Object.hasOwn(data, 'proof')) {
      const expected = healthProof(token, challenge);
      if (!expected || !sameToken(data.proof, expected)) return null;
    } else {
      const recorded = daemonRecord();
      if (!recorded || origin !== `http://127.0.0.1:${recorded.port}` || recorded.pid !== data.pid) return null;
    }
    return { health: { ...data, active: data.active ?? 0 }, token };
  } catch {
    return null;
  }
}

let cached: { origin: string; daemon: VerifiedDaemon } | undefined;
let probing: { origin: string; result: Promise<VerifiedDaemon | null> } | undefined;
let probeGeneration = 0;

export function forgetDaemon(origin: string): void {
  if (cached?.origin === origin) cached = undefined;
  if (probing?.origin === origin) {
    probing = undefined;
    probeGeneration++;
  }
}

async function checkDaemon(origin: string): Promise<VerifiedDaemon | null> {
  if (probing?.origin === origin) return probing.result;
  const generation = ++probeGeneration;
  const result = probeDaemon(origin).then((daemon) => {
    if (generation === probeGeneration) {
      if (daemon) cached = { origin, daemon };
      else if (cached?.origin === origin) cached = undefined;
    }
    return daemon;
  }).finally(() => {
    if (probing?.result === result) probing = undefined;
  });
  probing = { origin, result };
  return result;
}

/** Reuse a verification only while the port, live recorded PID and token still match. */
export async function verifiedDaemon(origin: string): Promise<VerifiedDaemon | null> {
  if (origin !== baseUrl()) return null;
  if (cached?.origin === origin) {
    const record = daemonRecord();
    if (record && origin === `http://127.0.0.1:${record.port}` && record.pid === cached.daemon.health.pid && readToken(HOME) === cached.daemon.token) return cached.daemon;
    forgetDaemon(origin);
  }
  const daemon = await checkDaemon(origin);
  return origin === baseUrl() ? daemon : null;
}

export async function health(): Promise<Health | null> {
  // Lifecycle callers need current activity and PID, even when credentialed requests can reuse a verification.
  return (await checkDaemon(baseUrl()))?.health ?? null;
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
/** This process got a filtered environment from its host (a Codex MCP server), so a daemon it starts says so. */
let partial = false;
/** This process runs in Codex's Windows job object, which ends a daemon it spawns when Codex exits. */
let inCodexJob = false;

export function partialEnvironment(): void {
  partial = true;
  inCodexJob = true;
}

/** For a Codex hook: its environment is whole, but under `codex exec` what it spawns ends with Codex. */
export function codexJob(): void {
  inCodexJob = true;
}

/** Starts the daemon if it is not running, and replaces an idle one that runs code other than what is installed. */
export function ensureDaemon(): Promise<void> {
  // Concurrent callers share one attempt, so a cold start spawns a single daemon.
  ensuring ??= startDaemon().then(async () => {
    // A Codex MCP server starting at the same moment may have won the start; its daemon gives way to this whole
    // environment now, rather than on some later call, if it is still idle.
    if (!partial && (await health())?.partialEnv) await startDaemon();
  }).finally(() => {
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
export function shouldReplace(running: Health, disk: { version: string; build: string }, root: string, partialClient = false): boolean {
  if (running.active !== 0) return false;
  // A daemon started with a filtered environment gives way to a client with the whole one, from any install not older:
  // a newer partial client and an older whole one would otherwise replace each other in turn.
  if (running.partialEnv && !partialClient && !isNewer(running.version, disk.version)) return true;
  // Another install owns the daemon. Only a newer version takes over, even with the same build: a release may change
  // only the version, and an older copy's daemon would otherwise keep the newer install from registering. The older
  // install never takes over from the newer, so two installs do not take turns replacing each other's daemon.
  const foreign = running.root !== undefined && running.root !== root;
  if (foreign) return isNewer(disk.version, running.version);
  return running.build !== disk.build;
}

/**
 * Stops the running daemon even if jobs are active, for `crew daemon stop` and `restart`.
 * Falls back to SIGTERM for a live recorded daemon when authenticated shutdown is unavailable or fails.
 */
export async function stopDaemon(): Promise<void> {
  const running = await health();
  const record = running ? null : daemonRecord();
  if (!running && (!record || !await listening(record.port))) return;
  const pid = running?.pid ?? record!.pid;
  const origin = record ? `http://127.0.0.1:${record.port}` : baseUrl();
  const recordedHere = () => {
    const current = daemonRecord();
    return current?.pid === pid && `http://127.0.0.1:${current.port}` === origin ? current : null;
  };
  const down = async () => {
    if (running && await health()) return false;
    const current = recordedHere();
    return !current || !await listening(current.port);
  };
  const asked = running && await api('POST', '/api/shutdown', {}).then(() => true, () => false);
  if (asked && await waitFor(down, 5000)) return;
  const stuck = new Error(`The Crew daemon (process ${pid}) is still running at ${origin}. Stop that process yourself, then start Crew again.`);
  // Any local listener can report an arbitrary PID on /api/health; only signal the PID
  // that this home's daemon recorded on disk.
  const file = path.join(HOME, 'daemon.json');
  if (running) {
    let recorded: unknown;
    await waitFor(async () => {
      if (await down()) return true;
      try {
        recorded = JSON.parse(fs.readFileSync(file, 'utf8')).pid;
        return true;
      } catch {
        return false;
      }
    }, 1000);
    if (await down()) return;
    if (recorded === undefined) throw new Error(`The Crew daemon's PID could not be confirmed from ${file}. Stop the process listening at ${origin} yourself, then start Crew again.`);
    if (recorded !== pid) throw stuck;
  } else if (!recordedHere()) {
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw stuck;
  }
  if (!(await waitFor(down, 5000))) throw stuck;
  // Windows SIGTERM is a hard kill: shutdown cannot flush or remove its own PID file.
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === pid) fs.rmSync(file, { force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** What the daemon reads besides `CREW_HOME` and `CREW_PARTIAL_ENV`. */
const DAEMON_VARS = ['CREW_PORT', 'CREW_AGENTGAUGE_DIR', 'ELECTRON_RUN_AS_NODE'];

/**
 * The command that starts the daemon outside Codex's job, or null when cmd.exe could not carry it as written. The new
 * process starts from the user's own environment, which is whole, so the variables that point it at a Crew are set to
 * this client's, and cleared where this client has none: a value only the user's environment holds would send the
 * daemon to a Crew this client does not use. Windows names are case-insensitive, so they are looked up that way.
 */
export function outsideJobCommand(node: string, script: string, log: string, home: string, env: NodeJS.ProcessEnv, partialEnv: boolean): string | null {
  const value = (name: string) => env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name];
  const vars: [string, string][] = [['CREW_HOME', value('CREW_HOME') !== undefined ? home : ''], ['CREW_PARTIAL_ENV', partialEnv ? '1' : ''], ...DAEMON_VARS.map((name): [string, string] => [name, value(name) ?? ''])];
  if ([node, script, log, ...vars.flat()].some((text) => /["%\r\n]/.test(text))) return null;
  // /v:off: a user's delayed expansion would read `!name!` in a path as a variable.
  return `cmd.exe /d /v:off /s /c "${vars.map(([key, text]) => `set "${key}=${text}"&& `).join('')}"${node}" "${script}" >> "${log}" 2>&1"`;
}

/**
 * Starts the daemon through WMI, outside the job object Codex runs its MCP servers in on Windows: that job ends every
 * process in it when Codex exits, which took a daemon this server spawned, and its workers, down with the lead
 * session. False when WMI created nothing, to spawn it as usual instead.
 */
async function startOutsideJob(script: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  const home = path.resolve(HOME);
  const command = outsideJobCommand(process.execPath, script, path.join(home, 'daemon.log'), home, env, partial);
  if (!command) return false;
  // PowerShell also ends a single-quoted string at a curly quote, so each is doubled like the straight one.
  const literal = (text: string) => `'${text.replace(/['\u2018-\u201B]/g, '$&$&')}'`;
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${literal(command)}; CurrentDirectory = ${literal(home)}; ProcessStartupInformation = $startup }`,
    'if ($result.ReturnValue -ne 0 -or -not $result.ProcessId) { exit 1 }',
    'exit 0',
  ].join('; ');
  return new Promise((resolve) => {
    execTimed('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')],
      { timeout: 20_000, windowsHide: true }, (err) => resolve(!err));
  });
}

async function startDaemon(): Promise<void> {
  const running = await health();
  if (running) {
    // Compare with the code on disk, not the code this process loaded: a long-lived session
    // still running old code must not keep restarting a daemon that is already current.
    if (!shouldReplace(running, installed(), PLUGIN_ROOT, partial)) return;
    // A job may have started since the health check, or the daemon may reject our token.
    // Either way, leave the running daemon alone; a token mismatch is reported on the next call.
    try {
      await api('POST', '/api/shutdown', { ifIdle: true, expectedPid: running.pid });
    } catch {
      return;
    }
    // Wait for that process to go, not for silence: another client may start the replacement in between.
    if (!(await waitFor(async () => (await health())?.pid !== running.pid, 5000))) {
      throw new Error(`The previous Crew daemon (process ${running.pid}) did not stop at ${baseUrl()}. Try crew daemon restart again after it exits.`);
    }
    if (await health()) return;
  }
  fs.mkdirSync(HOME, { recursive: true });
  const script = path.join(import.meta.dirname, `daemon${path.extname(import.meta.filename)}`);
  const env = { ...agentEnv(), ...nodeEnv(), ...(partial ? { CREW_PARTIAL_ENV: '1' } : {}) };
  let spawnError: Error | undefined;
  const log = path.join(HOME, 'daemon.log');
  /**
   * Opens the log for a new daemon. On Windows a daemon started through WMI writes it through cmd.exe, which holds it
   * unshared until that daemon exits, and another cmd.exe cannot redirect to it then either. So a daemon still stopping
   * is waited for, and undefined is returned once one answers instead, as one still starting there does.
   */
  const openLog = async (): Promise<number | undefined> => {
    let out: number | undefined;
    let busy: unknown;
    const free = await waitFor(async () => {
      try {
        out = fs.openSync(log, 'a');
        return true;
      } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EBUSY') throw error;
        busy = error;
        return (await health()) !== null;
      }
    }, 8000);
    if (!free) throw new Error(`The Crew daemon could not start: another process still holds ${log}.`, { cause: busy });
    return out;
  };
  const spawnHere = async () => {
    const out = await openLog();
    if (out === undefined) return;
    const child = spawn(process.execPath, [script], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    fs.closeSync(out);
  };
  // Each occupied fallback candidate may need a probe, a socket check and time for its daemon to record itself.
  const startTimeout = 8000 + PORTS.length * (DAEMON_PORT_GRACE_MS + 2 * DAEMON_PROBE_TIMEOUT_MS);
  const started = () => waitFor(async () => {
    if (spawnError) throw new Error(`Could not start the Crew daemon: ${spawnError.message}`);
    return (await health()) !== null;
  }, startTimeout);
  let outside = false;
  if (inCodexJob && process.platform === 'win32') {
    // Checked before WMI starts cmd.exe, whose redirect would fail on a busy log and leave only the fallback below,
    // which spawns the daemon inside the job.
    const out = await openLog();
    if (out === undefined) return;
    fs.closeSync(out);
    outside = await startOutsideJob(script, env);
  }
  if (!outside) await spawnHere();
  // WMI vouches only that cmd.exe was created, so a daemon that did not come up from there is started the usual way.
  // One that comes up late finds this one recorded and exits (daemon.ts bind).
  if (!(await started()) && !(outside && (await spawnHere(), await started()))) {
    throw new Error(`The Crew daemon did not start. See ${log}.`);
  }
}
