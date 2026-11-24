import { execFile, spawn } from 'node:child_process';
import type { ChildProcess, ChildProcessWithoutNullStreams, SpawnOptions } from 'node:child_process';
import readline from 'node:readline';
import { clipEnd } from './text.ts';

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export class RpcTimeoutError extends Error {}

export interface RpcHandlers {
  onNotification(method: string, params: any): void;
  /** Return a result, or undefined if the server has already withdrawn the request. */
  onRequest(method: string, params: any, id: string | number): Promise<unknown>;
  onExit(reason: string): void;
}

export const RPC_TIMEOUT_MS = 30_000;

/**
 * Newline-delimited JSON-RPC 2.0 over a child's stdio. Both `codex app-server`
 * and `agy acp` use this framing, with requests flowing in both directions.
 */
export class RpcPeer {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private closed = false;
  private stderrTail = '';
  private child: ChildProcessWithoutNullStreams;
  private handlers: RpcHandlers;
  private shell: boolean;

  constructor(child: ChildProcessWithoutNullStreams, handlers: RpcHandlers, shell = false) {
    this.child = child;
    this.handlers = handlers;
    this.shell = shell;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = clipEnd(this.stderrTail + String(chunk), 2000);
    });
    child.on('error', (err) => this.onClose(`failed to start: ${err.message}`));
    child.on('exit', (code, signal) => {
      const tail = this.stderrTail.trim().split('\n').pop();
      this.onClose(`exited (${signal ?? code})${tail ? `: ${tail}` : ''}`);
    });
    // A dead child surfaces through 'exit'; an EPIPE here must not crash the daemon.
    child.stdin.on('error', () => {});
  }

  get alive(): boolean {
    return !this.closed;
  }

  request<T = any>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (this.closed) return Promise.reject(new Error('process is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcTimeoutError(`${method} timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); },
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params });
  }

  async initialize(params: unknown): Promise<any> {
    try {
      return await this.request('initialize', params, RPC_TIMEOUT_MS);
    } catch (err) {
      this.close('SIGKILL');
      throw err;
    }
  }

  close(signal: NodeJS.Signals = 'SIGTERM'): void {
    if (this.closed) return;
    const command = treeKillCommand(this.child.pid, this.shell);
    if (command) execFile(command.bin, command.args, { windowsHide: true }, (err) => { if (err) this.child.kill(signal); });
    else this.child.kill(signal);
    this.onClose('was closed');
  }

  private write(message: unknown): void {
    this.child.stdin.write(JSON.stringify(message) + '\n');
  }

  private onLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // Not protocol output (stray log line).
    }
    if (this.closed || !msg || typeof msg !== 'object') return;
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        this.handlers.onNotification(msg.method, msg.params);
        return;
      }
      this.handlers.onRequest(msg.method, msg.params, msg.id).then(
        (result) => {
          if (!this.closed && result !== undefined) this.write({ jsonrpc: '2.0', id: msg.id, result });
        },
        (err) => {
          if (this.closed) return;
          const code = err instanceof RpcError ? err.code : -32603;
          this.write({ jsonrpc: '2.0', id: msg.id, error: { code, message: String(err?.message ?? err) } });
        },
      );
      return;
    }
    const waiter = this.pending.get(msg.id);
    if (!waiter) return;
    this.pending.delete(msg.id);
    if (msg.error) waiter.reject(new RpcError(msg.error.code ?? -32603, msg.error.message ?? 'request failed', msg.error.data));
    else waiter.resolve(msg.result);
  }

  private onClose(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(new Error(reason));
    this.pending.clear();
    this.handlers.onExit(reason);
  }
}

/** Killing cmd.exe alone leaves the agent it launched running. */
export function treeKillCommand(pid: number | undefined, shell: boolean, platform: NodeJS.Platform = process.platform): { bin: string; args: string[] } | null {
  return platform === 'win32' && shell && pid !== undefined ? { bin: 'taskkill', args: ['/pid', String(pid), '/T', '/F'] } : null;
}

type TimedOptions = Pick<SpawnOptions, 'cwd' | 'env' | 'shell' | 'windowsHide'> & { timeout: number; maxBuffer?: number };

/**
 * Runs a command like `execFile`, with a timeout that ends the whole command. Node's own timeout signals only the
 * process it started, which for a Windows `.cmd` shim is cmd.exe, so the agent the shim ran was left running; elsewhere
 * a wrapper script's child kept running and holding the output, so the call did not return until it ended. So on
 * Windows the tree is ended with taskkill, and elsewhere the command runs in its own process group, which is signalled
 * as a whole. execFile cannot start one: it does not pass `detached` on.
 */
export function execTimed(bin: string, args: readonly string[], options: TimedOptions,
  callback: (err: Error | null, stdout: string, stderr: string) => void): ChildProcess {
  const { timeout, maxBuffer = 1024 * 1024, ...rest } = options;
  const group = process.platform !== 'win32';
  const child = spawn(bin, args, { ...rest, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let failure: Error | null = null;
  let finished = false;
  const stop = () => {
    const kill = treeKillCommand(child.pid, Boolean(rest.shell));
    if (kill) execFile(kill.bin, kill.args, { windowsHide: true }, (err) => { if (err) child.kill(); });
    else if (group && child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill(); }
    } else child.kill();
  };
  const collect = (append: (text: string) => void) => (chunk: string) => {
    append(chunk);
    if (!failure && stdout.length + stderr.length > maxBuffer) {
      failure = new Error('maxBuffer exceeded');
      stop();
    }
  };
  child.stdout.setEncoding('utf8').on('data', collect((text) => { stdout += text; }));
  child.stderr.setEncoding('utf8').on('data', collect((text) => { stderr += text; }));
  const finish = (err: Error | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    callback(timedOut ? new Error(`timed out after ${timeout / 1000}s`) : failure ?? err, stdout, stderr);
  };
  // A command that cannot start (ENOENT) keeps its code, as execFile's error does.
  child.on('error', finish);
  child.on('close', (code, signal) => finish(code === 0 ? null : Object.assign(new Error(`Command failed: ${bin} ${args.join(' ')}`.trim()), { code, signal })));
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeout);
  return child;
}
