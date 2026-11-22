import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { browserProfile } from './browser.ts';
import { agentCommand, agentEnv } from './config.ts';
import { clipEnd } from './text.ts';

/** A check the lead asked for, run by the bridge itself so its result is observed, not reported by the worker. */
export interface CheckResult {
  command: string;
  /** Exit status; null when the command was stopped or could not start. */
  exit: number | null;
  timedOut: boolean;
  /** The end of the combined output, where failures usually are. */
  output: string;
  ms: number;
  /** Ran with writes limited to the worktree and its temp directory. */
  sandboxed: boolean;
  /** Why it did not run at all, when it could not be held to the worker's limits. */
  skipped?: string;
}

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const KEEP_OUTPUT = 4000;
const runningChecks = new Set<() => Promise<void>>();

/** Each stop signals the group or job host synchronously, before the daemon exits. */
export function stopChecks(): void {
  for (const stop of runningChecks) void stop();
}

/** The worker's own limits for the check: writes only where it may write, the token hidden, and no outside network unless it had network. */
function checkProfile(cwd: string, tmp: string, unreadable: string[], network: boolean): string {
  const quote = (value: string) => JSON.stringify(value);
  const both = (dir: string) => [...new Set([dir, real(dir)])];
  const profile = browserProfile([cwd, tmp], unreadable);
  if (network) return profile;
  // Local servers stay reachable for test suites; other local sockets (an SSH agent, Docker) do not.
  // The socket rules come first: on macOS 27 a later `remote unix-socket` denial also refuses TCP to localhost.
  return `${profile}
(deny network-outbound (remote unix-socket))
(allow network-outbound (remote unix-socket ${[...both(cwd), ...both(tmp)].map((dir) => `(subpath ${quote(dir)})`).join(' ')}))
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))`;
}

function real(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * The same limits on Windows, through Codex's sandbox and a permissions profile: reads anywhere but the token,
 * writes only in the worktree and its temp directory, `.git` read-only, and the network off unless the job had
 * it (local servers stay reachable either way). Null when a path cannot be written as a TOML literal string,
 * the only kind that reaches Codex through cmd.exe intact.
 */
export function windowsSandboxArgs(cwd: string, tmp: string, unreadable: string[], network: boolean): string[] | null {
  const both = (file: string) => [...new Set([file, real(file)])];
  const rules = new Map<string, string>([[':root', 'read']]);
  for (const dir of [...both(cwd), ...both(tmp)]) rules.set(dir, 'write');
  for (const dir of both(cwd)) rules.set(path.win32.join(dir, '.git'), 'read');
  for (const file of unreadable.flatMap(both)) rules.set(file, 'deny');
  if ([...rules.keys()].some((key) => /['\r\n]/.test(key))) return null;
  const table = [...rules].map(([key, value]) => `'${key}'='${value}'`).join(',');
  return ['sandbox', '-c', "default_permissions='crew_check'", '-c', `permissions.crew_check.filesystem={${table}}`, '-c', `permissions.crew_check.network.enabled=${network}`];
}

/**
 * Codex waits for every process holding its output pipes, so a server the check left behind would keep Codex
 * running, and its exit status could come from a process the command killed. The wrapper runs the command in a
 * shell of its own, with the utilities on PATH that macOS's /bin/sh has, and prints the status on a line marked
 * with a secret read from stdin; the command's processes never get the secret, so only that line counts.
 */
const WRAPPER = `IFS= read -r crew_mark
PATH="/mingw64/bin:/usr/bin:$PATH"
export PATH
crew_command=$(cat "$1") || exit 126
/usr/bin/sh -c "$crew_command" </dev/null
crew_status=$?
printf '\\n%s %s\\n' "$crew_mark" "$crew_status"
exit "$crew_status"
`;

/**
 * Holds the check in a job object that kills every process in it when the job closes: when the host exits or
 * is stopped. A process whose parent exited first is still in the job, where a tree kill cannot find it.
 * Windows PowerShell 5.1 because it ships with Windows; the command line arrives in CREW_CHECK_LINE.
 */
const JOB_HOST = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CrewCheckJob {
  [StructLayout(LayoutKind.Sequential)] struct Basic { public long a, b; public uint Flags; public UIntPtr c, d; public uint e; public UIntPtr f; public uint g, h; }
  [StructLayout(LayoutKind.Sequential)] struct Io { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr p, q, r, s; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Extended info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  public static void Join() {
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    Extended info = new Extended();
    info.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (job == IntPtr.Zero || !SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(typeof(Extended))) || !AssignProcessToJobObject(job, GetCurrentProcess())) {
      throw new Exception("job object: error " + Marshal.GetLastWin32Error());
    }
  }
}
'@
[CrewCheckJob]::Join()
$start = New-Object Diagnostics.ProcessStartInfo $env:ComSpec, ('/d /s /c "' + $env:CREW_CHECK_LINE + '"')
$start.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($start)
$child.WaitForExit()
exit $child.ExitCode
`;

let gitShell: Promise<string | null> | undefined;

/** Git for Windows' sh, so a check is the same POSIX command on both systems. */
function windowsShell(): Promise<string | null> {
  gitShell ??= new Promise((resolve) => {
    execFile('git', ['--exec-path'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      // The exec path is <root>/mingw64/libexec/git-core.
      const root = path.resolve(stdout.trim(), '..', '..', '..');
      resolve([path.join(root, 'usr', 'bin', 'sh.exe'), path.join(root, 'bin', 'sh.exe')].find((file) => fs.existsSync(file)) ?? null);
    });
  });
  return gitShell;
}

const skip = (command: string, skipped: string): CheckResult => ({ command, exit: null, timedOut: false, output: '', ms: 0, sandboxed: false, skipped });

/**
 * Runs `command` in `cwd` through the POSIX shell. The worktree holds code the worker wrote, so it must not run
 * with more than the worker could do: on macOS and Windows under the same file and network limits, and elsewhere
 * not at all. Windows uses the sandbox of `codex`, the configured Codex binary.
 */
export async function runCheck(command: string, cwd: string, tmp: string, unreadable: string[], options: { network?: boolean; timeoutMs?: number; platform?: NodeJS.Platform; signal?: AbortSignal; codex?: string } = {}): Promise<CheckResult> {
  const { network = false, timeoutMs = CHECK_TIMEOUT_MS, platform = process.platform, signal, codex = 'codex' } = options;
  if (platform !== 'darwin' && platform !== 'win32') return skip(command, 'only macOS and Windows can hold the check to the worker\'s limits; run it yourself');
  let launch: { bin: string; args: string[]; env: NodeJS.ProcessEnv };
  // Windows only: the secret that marks the wrapper's status line, and the files it reads.
  let mark: string | null = null;
  const files: string[] = [];
  const removeFiles = () => {
    for (const file of files) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // A scanner holding it open; it is in the system temp directory, which is cleaned anyway.
      }
    }
  };
  if (platform === 'win32') {
    const sh = await windowsShell();
    if (!sh) return skip(command, 'no sh from Git for Windows to run it with; run it yourself');
    const sandbox = windowsSandboxArgs(cwd, tmp, unreadable, network);
    // Beside the temp directory rather than in it, so the check can read them but not rewrite them.
    const wrapper = `${tmp}.check.sh`;
    const script = `${tmp}.command.sh`;
    // The same PATH the Codex adapter runs with, which npm's codex.cmd also needs to find node.
    const env = agentEnv();
    let line: string;
    try {
      if (!sandbox) throw new Error('unquotable path');
      const codexCommand = agentCommand(codex, [...sandbox, '--', sh, wrapper, script], env);
      // agentCommand searches PATH only for a name without an extension, such as codex but not codex.exe.
      if (!codexCommand.shell && !path.win32.isAbsolute(codexCommand.bin)) {
        const found = (env.PATH ?? '').split(';').filter(Boolean).map((dir) => path.win32.join(dir.replace(/^"(.*)"$/, '$1'), codexCommand.bin)).find((file) => fs.existsSync(file));
        if (found) codexCommand.bin = found;
      }
      if (!codexCommand.shell && !fs.existsSync(codexCommand.bin)) return skip(command, 'Codex, whose sandbox it runs in on Windows, is not installed; run it yourself');
      const parts = codexCommand.shell ? [] : [codexCommand.bin, ...(codexCommand.args ?? [])];
      // cmd.exe runs the line, so the rules for an npm shim's arguments hold for an executable's too.
      if (parts.some((value) => /["%\r\n]/.test(value))) throw new Error('unquotable path');
      line = codexCommand.shell ? codexCommand.bin : parts.map((value) => `"${value}"`).join(' ');
    } catch {
      return skip(command, 'a path it needs cannot be passed to Codex\'s sandbox; run it yourself');
    }
    files.push(wrapper, script);
    try {
      fs.writeFileSync(wrapper, WRAPPER);
      fs.writeFileSync(script, command);
    } catch (err) {
      removeFiles();
      return skip(command, `its script could not be written (${(err as Error).message}); run it yourself`);
    }
    mark = `crew-check-${randomBytes(16).toString('hex')}`;
    const root = env.SystemRoot ?? env.SYSTEMROOT ?? 'C:\\Windows';
    launch = {
      bin: path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(JOB_HOST, 'utf16le').toString('base64')],
      env: { ...env, CREW_CHECK_LINE: line },
    };
  } else {
    launch = { bin: '/usr/bin/sandbox-exec', args: ['-p', checkProfile(cwd, tmp, unreadable, network), '/bin/sh', '-c', command], env: process.env };
  }
  const sandboxed = true;
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    // The status the wrapper reported, and the end of stdout searched for its line.
    let reported: number | null = null;
    let tail = '';
    const keep = (chunk: Buffer) => {
      output = clipEnd(output + chunk.toString(), KEEP_OUTPUT);
    };
    const child = spawn(launch.bin, launch.args, {
      cwd,
      // On macOS its own process group, so a timeout stops what the command started too.
      detached: !mark,
      windowsHide: true,
      stdio: [mark ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { ...launch.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: '1' },
    });
    if (mark) {
      // A child that failed to start fails its stdin too; 'error' below reports that.
      child.stdin!.on('error', () => {});
      child.stdin!.end(`${mark}\n`);
    }
    child.stdout!.on('data', (chunk: Buffer) => {
      keep(chunk);
      if (!mark || reported !== null) return;
      // The whole chunk is searched: output after the line, in the same chunk, must not push it out.
      const text = tail + chunk.toString();
      tail = text.slice(-(mark.length + 32));
      const line = new RegExp(`${mark} (\\d+)\\n`).exec(text);
      if (!line) return;
      reported = Number(line[1]);
      // What the command left running gets the same grace as on macOS, then is stopped.
      setTimeout(() => finish(timedOut ? null : reported), 2000).unref();
    });
    child.stderr!.on('data', keep);
    /** Resolves once the tree is stopped, so nothing it held changes the worktree after the result. */
    const stop = (): Promise<void> => {
      if (!mark) {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          // Already gone.
        }
        return Promise.resolve();
      }
      // Ending the host (TerminateProcess, through no other program) closes its job, which ends everything in it.
      // A host that has exited closed it already.
      if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
      return new Promise((done) => {
        child.once('exit', () => done());
        child.kill('SIGKILL');
      });
    };
    runningChecks.add(stop);
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    const cancel = () => {
      keep(Buffer.from('\nstopped: the job was cancelled'));
      stop();
    };
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let finished = false;
    const finish = (exit: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      // Whatever the check left running in the background could still change the worktree after the receipt.
      // On macOS a process that left the group (setsid) escapes this, though it keeps the sandbox's write limits.
      void stop().then(() => {
        runningChecks.delete(stop);
        removeFiles();
        if (mark) output = output.replace(new RegExp(`\\n?${mark} \\d+\\n?`), '');
        resolve({ command, exit: signal?.aborted ? null : exit, timedOut, output: output.trimEnd(), ms: Date.now() - started, sandboxed });
      });
    };
    child.on('error', (err) => {
      keep(Buffer.from(`\n${err.message}`));
      finish(null);
    });
    // On Windows only the wrapper's line counts: a process in the sandbox can end the wrapper so Codex exits 0.
    const status = (code: number | null) => (timedOut ? null : mark ? reported : code);
    child.on('close', (code) => finish(status(code)));
    // A process the check left running in the background can hold the pipes open, so 'close' may never come.
    child.on('exit', (code) => setTimeout(() => finish(status(code)), 2000).unref());
  });
}

/** One line for the lead: whether the check passed, observed by the bridge. */
export function checkLine(check: CheckResult): string {
  if (check.skipped) return `\`${check.command}\` not run: ${check.skipped}`;
  const how = check.timedOut ? `timed out after ${Math.round(check.ms / 1000)} s` : check.exit === 0 ? 'passed' : check.exit === null ? 'could not run' : `failed (exit ${check.exit})`;
  return `\`${check.command}\` ${how}`;
}
