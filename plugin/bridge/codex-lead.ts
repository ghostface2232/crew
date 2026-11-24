import { execFile } from 'node:child_process';
import { agentCommand, agentEnv } from './config.ts';
import type { Delivery, Offer } from './delivery.ts';

/** How long a queue command may take before it is given up; the offer it carried is retried once its lease ends. */
const QUEUE_TIMEOUT_MS = 30_000;

/**
 * Wakes idle Codex lead sessions. Codex has no hook that can start a turn later, as Claude Code's asyncRewake does,
 * but `codex queue` hands a message to a thread, and an open interactive session runs it as its next turn
 * (docs/mcp-compatibility.md#5-codex-as-a-lead-host). So the daemon plays the watcher for those sessions: it takes
 * automatic offers like a hook watcher would, under the same lease and retry budget, and queues a short note. A
 * queued note is durable, so news it named is not offered automatically again (Delivery.settle).
 *
 * The note only names the news. On Windows `codex` is a .cmd file run through cmd.exe, which cannot carry the line
 * breaks and quotes an offer's text has, so the lead reads the news itself with `status`, which offers it again.
 */
export class CodexLeads {
  private delivery: Delivery;
  private queue: (thread: string, message: string) => Promise<void>;
  private stopped = new AbortController();

  constructor(delivery: Delivery, queue: (thread: string, message: string) => Promise<void>) {
    this.delivery = delivery;
    this.queue = queue;
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped.abort();
  }

  /** One pass over the waiting sessions; returns how long until a lease it waited on ends. Exposed for tests. */
  async pass(now = Date.now()): Promise<number> {
    let next = 20_000;
    for (const session of this.delivery.codexWaiting()) {
      let offer: Offer | null = null;
      try {
        offer = this.delivery.offer(session, { automatic: true }, now);
      } catch {
        // A save that failed leaves the news unoffered; the next pass tries again.
      }
      if (offer) {
        // A failed command leaves the second automatic offer for a later pass or the Stop hook.
        await this.queue(session, note(offer)).then(() => this.delivery.settle(offer)).catch(() => {});
        continue;
      }
      const lease = this.delivery.state.offering[session];
      if (lease && lease.expiresAt > now) next = Math.min(next, lease.expiresAt - now);
    }
    return next;
  }

  private async loop(): Promise<void> {
    while (!this.stopped.signal.aborted) {
      // A pass that throws must not end waking for good; the next change or timeout tries again.
      const next = await this.pass().catch(() => 20_000);
      await this.delivery.wait(next, this.stopped.signal);
    }
  }
}

/** One line, free of the characters cmd.exe cannot pass on. */
export function note(offer: Offer): string {
  const ids = [...new Set(offer.items.map((item) => item.jobId))];
  return `Crew has news for ${ids.join(', ')}. Call the Crew status tool to read it, then act on it.`.replace(/["%\r\n]/g, ' ');
}

/** Runs `codex queue` for a thread, as the user's own Codex install would. */
export function codexQueue(bin: string): (thread: string, message: string) => Promise<void> {
  return (thread, message) => {
    const env = agentEnv();
    const command = agentCommand(bin, ['queue', '--thread', thread, '--message', message], env);
    return new Promise((resolve, reject) => {
      execFile(command.bin, command.args, { env, shell: command.shell, timeout: QUEUE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
        if (err) reject(new Error(`codex queue failed: ${(stderr || stdout || err.message).trim().split('\n').pop()}`));
        else resolve();
      });
    });
  };
}
