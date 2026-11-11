import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import readline from 'node:readline';

export class RpcError extends Error {
  code: number;
  data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

export interface RpcHandlers {
  onNotification(method: string, params: any): void;
  /** Return a result, or throw RpcError. Unhandled methods should throw RpcError(-32601). */
  onRequest(method: string, params: any): Promise<unknown>;
  onExit(reason: string): void;
}

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

  constructor(child: ChildProcessWithoutNullStreams, handlers: RpcHandlers) {
    this.child = child;
    this.handlers = handlers;
    readline.createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-2000);
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

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) return Promise.reject(new Error('process is not running'));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.closed) this.write({ jsonrpc: '2.0', method, params });
  }

  close(): void {
    if (!this.closed) this.child.kill();
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
    if (typeof msg.method === 'string') {
      if (msg.id === undefined || msg.id === null) {
        this.handlers.onNotification(msg.method, msg.params);
        return;
      }
      this.handlers.onRequest(msg.method, msg.params).then(
        (result) => this.write({ jsonrpc: '2.0', id: msg.id, result: result ?? {} }),
        (err) => {
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
