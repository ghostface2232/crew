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
}

export const CHECK_TIMEOUT_MS = 10 * 60_000;
const KEEP_OUTPUT = 4000;

/**
 * Runs `command` in `cwd` through the shell. The worktree holds code the worker wrote, so on macOS it runs
 * under the same file limits as the worker: writes only in `cwd` and `tmp`, and `unreadable` hidden.
 */
export function runCheck(command: string, cwd: string, tmp: string, unreadable: string[], timeoutMs = CHECK_TIMEOUT_MS, platform = process.platform): Promise<CheckResult> {
  const sandboxed = platform === 'darwin';
  const [file, args] = sandboxed
    ? ['/usr/bin/sandbox-exec', ['-p', browserProfile([cwd, tmp], unreadable), '/bin/sh', '-c', command]]
    : [platform === 'win32' ? 'cmd.exe' : '/bin/sh', platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]];
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
      detached: platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp, CI: '1' },
    });
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (platform === 'win32') child.kill();
        else process.kill(-child.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    const finish = (exit: number | null) => {
      clearTimeout(timer);
      resolve({ command, exit, timedOut, output: output.trimEnd(), ms: Date.now() - started, sandboxed });
    };
    child.on('error', (err) => {
      keep(Buffer.from(`\n${err.message}`));
      finish(null);
    });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}

/** One line for the lead: whether the check passed, observed by the bridge. */
export function checkLine(check: CheckResult): string {
  const how = check.timedOut ? `timed out after ${Math.round(check.ms / 1000)} s` : check.exit === 0 ? 'passed' : check.exit === null ? 'could not run' : `failed (exit ${check.exit})`;
  return `\`${check.command}\` ${how}${check.sandboxed ? '' : ', run without a sandbox'}`;
}
