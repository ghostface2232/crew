import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { readToken, tokenFile } from './auth.ts';
import { agentEnv, baseUrl, HOME, installed, nodeEnv, PLUGIN_ROOT } from './config.ts';
import { execTimed } from './rpc.ts';

export async function api<T = any>(method: 'GET' | 'POST', route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const send = (token: string | null) => fetch(`${baseUrl()}${route}`, {
    method,
    signal,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let res = await send(readToken(HOME));
  // The daemon makes the token file on its first start, which may be a moment after this process first looked.
  if (res.status === 401) {
    await delay(200, undefined, { signal });
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
  /** Started by a client whose own environment was filtered, so its workers miss the user's variables. */
  partialEnv?: boolean;
}

export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/health`, { signal: AbortSignal.timeout(1000) });
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
 * Falls back to SIGTERM if the daemon rejects the token on disk, and throws if it stays up.
 */
export async function stopDaemon(): Promise<void> {
  const running = await health();
  if (!running) return;
  const down = async () => (await health()) === null;
  const asked = await api('POST', '/api/shutdown', {}).then(() => true, () => false);
  if (asked && await waitFor(down, 5000)) return;
  const stuck = new Error(`The Crew daemon (process ${running.pid}) is still running at ${baseUrl()}. Stop that process yourself, then start Crew again.`);
  // Any local listener can report an arbitrary PID on /api/health; only signal the PID
  // that this home's daemon recorded on disk.
  let recorded: unknown;
  const file = path.join(HOME, 'daemon.json');
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
  if (recorded === undefined) throw new Error(`The Crew daemon's PID could not be confirmed from ${file}. Stop the process listening at ${baseUrl()} yourself, then start Crew again.`);
  if (!Number.isInteger(recorded) || (recorded as number) <= 0 || recorded !== running.pid) throw stuck;
  try {
    process.kill(running.pid, 'SIGTERM');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw stuck;
  }
  if (!(await waitFor(down, 5000))) throw stuck;
  // Windows SIGTERM is a hard kill: shutdown cannot flush or remove its own PID file.
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === running.pid) fs.rmSync(file, { force: true });
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
  const vars: [string, string][] = [['CREW_HOME', home], ['CREW_PARTIAL_ENV', partialEnv ? '1' : ''], ...DAEMON_VARS.map((name): [string, string] => [name, value(name) ?? ''])];
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
  const command = outsideJobCommand(process.execPath, script, path.join(HOME, 'daemon.log'), path.resolve(HOME), env, partial);
  if (!command) return false;
  // PowerShell also ends a single-quoted string at a curly quote, so each is doubled like the straight one.
  const literal = (text: string) => `'${text.replace(/['\u2018-\u201B]/g, '$&$&')}'`;
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    '$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }',
    `$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ${literal(command)}; CurrentDirectory = ${literal(HOME)}; ProcessStartupInformation = $startup }`,
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
      await api('POST', '/api/shutdown', { ifIdle: true });
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
  const spawnHere = () => {
    const out = fs.openSync(path.join(HOME, 'daemon.log'), 'a');
    const child = spawn(process.execPath, [script], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });
    child.on('error', (error) => { spawnError = error; });
    child.unref();
    fs.closeSync(out);
  };
  const started = () => waitFor(async () => {
    if (spawnError) throw new Error(`Could not start the Crew daemon: ${spawnError.message}`);
    return (await health()) !== null;
  }, 8000);
  const outside = inCodexJob && process.platform === 'win32' && await startOutsideJob(script, env);
  if (!outside) spawnHere();
  // WMI vouches only that cmd.exe was created, so a daemon that did not come up from there is started the usual way.
  // One that comes up late finds this one recorded and exits (daemon.ts bind).
  if (!(await started()) && !(outside && (spawnHere(), await started()))) {
    throw new Error(`The Crew daemon did not start. See ${path.join(HOME, 'daemon.log')}.`);
  }
}
