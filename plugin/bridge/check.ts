import { spawn } from 'node:child_process';
import { browserProfile } from './browser.ts';

/** A check the lead asked for, run by the bridge itself so its result is observed, not reported by the worker. */
export interface CheckResult {
  command: string;
  /** Exit status; null when the command was stopped or could not start. */
  exit: number | null;
  timedOut: boolean;
  /** The end of the combined output, where failures usually are. */
  output: string;
  ms: number;
  /** Ran with writes limited to the worktree and its temp directory (macOS only). */
  sandboxed: boolean;
  /** Why it did not run at all, when it could not be held to the worker's limits. */
  skipped?: string;
}

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const KEEP_OUTPUT = 4000;

/** The worker's own limits for the check: writes only where it may write, the token hidden, and no outside network unless it had network. */
function checkProfile(cwd: string, tmp: string, unreadable: string[], network: boolean): string {
  const profile = browserProfile([cwd, tmp], unreadable);
  // Local sockets stay open: test suites start servers on localhost.
  return network ? profile : `${profile}
(deny network-outbound (remote ip "*:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))`;
}

/**
 * Runs `command` in `cwd` through the shell. The worktree holds code the worker wrote, so it must not run with
 * more than the worker could do: on macOS under the same file and network limits, and elsewhere not at all.
 */
export function runCheck(command: string, cwd: string, tmp: string, unreadable: string[], options: { network?: boolean; timeoutMs?: number; platform?: NodeJS.Platform } = {}): Promise<CheckResult> {
  const { network = false, timeoutMs = CHECK_TIMEOUT_MS, platform = process.platform } = options;
  if (platform !== 'darwin') {
    return Promise.resolve({ command, exit: null, timedOut: false, output: '', ms: 0, sandboxed: false, skipped: 'only macOS can hold the check to the worker\'s limits; run it yourself' });
  }
  const file = '/usr/bin/sandbox-exec';
  const args = ['-p', checkProfile(cwd, tmp, unreadable, network), '/bin/sh', '-c', command];
  const sandboxed = true;
  const started = Date.now();
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-KEEP_OUTPUT);
    };
    const child = spawn(file, args, {
      cwd,
      // Its own process group, so a timeout stops what the command started too.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: '1' },
    });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    let finished = false;
    const finish = (exit: number | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ command, exit, timedOut, output: output.trimEnd(), ms: Date.now() - started, sandboxed });
    };
    child.on('error', (err) => {
      keep(Buffer.from(`\n${err.message}`));
      finish(null);
    });
    child.on('close', (code) => finish(timedOut ? null : code));
    // A process the check left running in the background can hold the pipes open, so 'close' may never come.
    child.on('exit', (code) => setTimeout(() => finish(timedOut ? null : code), 2000).unref());
  });
}

/** One line for the lead: whether the check passed, observed by the bridge. */
export function checkLine(check: CheckResult): string {
  if (check.skipped) return `\`${check.command}\` not run: ${check.skipped}`;
  const how = check.timedOut ? `timed out after ${Math.round(check.ms / 1000)} s` : check.exit === 0 ? 'passed' : check.exit === null ? 'could not run' : `failed (exit ${check.exit})`;
  return `\`${check.command}\` ${how}`;
}
