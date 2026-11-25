import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { agentCommand, agentEnv, VERSION } from './config.ts';
import type { Delivery, Item, Offer } from './delivery.ts';
import { execTimed, RpcError, RpcPeer } from './rpc.ts';

/** How long a queue command or request may take before it is given up; the offer it carried is retried once its lease ends. */
const QUEUE_TIMEOUT_MS = 30_000;
/** The first wait after a failed queue command, doubled after each further failure up to the cap. */
const RETRY_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;

/**
 * Wakes idle Codex lead sessions. Codex has no hook that can start a turn later, as Claude Code's asyncRewake does,
 * but a message queued to a thread is run by an open interactive session as its next turn
 * (docs/mcp-compatibility.md#5-codex-as-a-lead-host). So the daemon plays the watcher for those sessions: it takes
 * automatic offers like a hook watcher would, under the same lease and retry budget, and queues a short note. A
 * queued note is durable, so news it named is not offered automatically again (Delivery.settle).
 *
 * A session inside a turn is left alone: a note queued then sits in the thread's composer until the turn ends, and
 * the turn's Stop hook offers the same news anyway. Only the session's hooks say whether it is in a turn, so a
 * session they have not reported (hooks untrusted, or the daemon restarted) is queued to as if idle.
 *
 * A note whose news the lead has acknowledged some other way (a tool response, the Stop hook) is taken back
 * before the thread runs it, so it leaves no pending message and no turn for news already read. Which notes are
 * waiting is kept in memory only: after a daemon restart, those queued before it stay until the thread runs them.
 *
 * The note only names the news. On Windows `codex` is a .cmd file run through cmd.exe, which cannot carry the line
 * breaks and quotes an offer's text has, so the lead reads the news itself with `status`, which offers it again.
 */
export class CodexLeads {
  private delivery: Delivery;
  private queue: CodexQueue;
  private inTurn: (session: string, now: number) => boolean;
  private stopped = new AbortController();
  /** Notes Codex gave an id for, until their news is acknowledged. */
  private queued: { thread: string; id: string; items: Item[] }[] = [];

  constructor(delivery: Delivery, queue: CodexQueue, inTurn: (session: string, now: number) => boolean = () => false) {
    this.delivery = delivery;
    this.queue = queue;
    this.inTurn = inTurn;
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
    for (const queued of this.queued.filter((note) => this.delivery.acknowledged(note.items))) {
      this.queued.splice(this.queued.indexOf(queued), 1);
      // Best effort: a note the thread already ran is gone, and one that cannot be taken back costs only a turn.
      await this.queue.remove(queued.thread, queued.id).catch(() => {});
    }
    for (const session of this.delivery.codexWaiting()) {
      const failed = this.failing.get(session);
      if (failed && failed.at > now) {
        next = Math.min(next, failed.at - now);
        continue;
      }
      if (this.inTurn(session, now)) continue;
      let offer: Offer | null = null;
      try {
        offer = this.delivery.offer(session, { automatic: true }, now);
      } catch {
        // A save that failed leaves the news unoffered; the next pass tries again.
      }
      if (offer) {
        try {
          const id = await this.queue.add(session, note(offer));
          if (id) this.queued.push({ thread: session, id, items: offer.items });
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

export interface CodexQueue {
  /** Queues a message to a thread; resolves to its id, or null when Codex gave none. */
  add(thread: string, message: string): Promise<string | null>;
  /** Takes a queued message back; one the thread already ran is gone and needs nothing. */
  remove(thread: string, id: string): Promise<void>;
}

/**
 * Queues through the app-server's queue API, which gives the id a note is taken back by. Those methods need the
 * experimental API, which the workers' server is not given, so each request runs on a short-lived server of its own.
 * A Codex that refuses them still has `codex queue`, which wakes the lead the same way but cannot take a note back.
 */
export function codexQueue(bin: string): CodexQueue {
  return {
    async add(thread, message) {
      let res: any;
      try {
        res = await appServer(bin, 'thread/queue/add', { threadId: thread, clientUserMessageId: randomUUID(), input: [{ type: 'text', text: message, text_elements: [] }] });
      } catch (err) {
        // Only a refusal is known not to have queued anything; after a timeout, a second note could double the first.
        if (!(err instanceof RpcError)) throw err;
        await queueCommand(bin, thread, message);
        return null;
      }
      return typeof res?.queuedSubmission?.id === 'string' ? res.queuedSubmission.id : null;
    },
    async remove(thread, id) {
      await appServer(bin, 'thread/queue/delete', { threadId: thread, queuedSubmissionId: id });
    },
  };
}

async function appServer(bin: string, method: string, params: unknown): Promise<any> {
  const env = agentEnv();
  const command = agentCommand(bin, ['app-server'], env);
  const child = spawn(command.bin, command.args ?? [], { env, shell: command.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const peer = new RpcPeer(child, { onNotification: () => {}, onRequest: async () => undefined, onExit: () => {} }, command.shell);
  try {
    await peer.initialize({ clientInfo: { name: 'crew', title: 'Crew', version: VERSION }, capabilities: { experimentalApi: true } });
    peer.notify('initialized');
    return await peer.request(method, params, QUEUE_TIMEOUT_MS);
  } finally {
    peer.close();
  }
}

/** Runs `codex queue` for a thread, as the user's own Codex install would. */
function queueCommand(bin: string, thread: string, message: string): Promise<void> {
  const env = agentEnv();
  const command = agentCommand(bin, ['queue', '--thread', thread, '--message', message], env);
  return new Promise((resolve, reject) => {
    execTimed(command.bin, command.args ?? [], { env, shell: command.shell, timeout: QUEUE_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(`codex queue failed: ${(stderr || stdout || err.message).trim().split('\n').pop()}`));
      else resolve();
    });
  });
}
