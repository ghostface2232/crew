import { execFile } from 'node:child_process';
import { agentCommand, agentEnv } from './config.ts';
import type { Delivery, Offer } from './delivery.ts';

/** How long a queue command may take before it is given up; the offer it carried is retried once its lease ends. */
const QUEUE_TIMEOUT_MS = 30_000;
/** The first wait after a failed queue command, doubled after each further failure up to the cap. */
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

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

  /** Sessions whose last queue command failed: how many times in a row, and when to try again. */
  private failing = new Map<string, { count: number; at: number }>();

  /** One pass over the waiting sessions; returns how long until a lease or retry it waited on ends. Exposed for tests. */
  async pass(now = Date.now()): Promise<number> {
    let next = 20_000;
    for (const session of this.delivery.codexWaiting()) {
      const failed = this.failing.get(session);
      if (failed && failed.at > now) {
        next = Math.min(next, failed.at - now);
        continue;
      }
      let offer: Offer | null = null;
      try {
        offer = this.delivery.offer(session, { automatic: true }, now);
      } catch {
        // A save that failed leaves the news unoffered; the next pass tries again.
      }
      if (offer) {
        try {
          await this.queue(session, note(offer));
          this.failing.delete(session);
          this.delivery.settle(offer);
        } catch {
          // Codex never got the note, so the offer stays unspent and the command is tried again, backing off while
          // it keeps failing (Codex missing or updating), so the news can still wake the lead once Codex recovers.
          const count = (failed?.count ?? 0) + 1;
          this.failing.set(session, { count, at: now + Math.min(RETRY_MS * 2 ** (count - 1), RETRY_MAX_MS) });
          try {
            this.delivery.retract(offer);
          } catch {
            // The offer then counts as spent; the Stop hook and the lead's own calls still carry the news.
          }
        }
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

/** What note() queues, which then reaches the lead's hooks as a prompt the user did not type. */
export const QUEUED_NOTE = /^Crew has news for [^.]*\. Call the Crew status tool to read it, then act on it\.$/;

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
