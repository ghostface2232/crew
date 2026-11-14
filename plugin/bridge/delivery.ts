import { randomUUID } from 'node:crypto';
import type { Job, JobState } from './jobs.ts';

export const LEAD_BYTES = 8192;
export const OFFER_ITEMS = 8;
export const OFFER_MS = 30_000;
export const WATCH_MS = 60_000;
export const WATCH_REPLACE_MS = 15_000;
export const HOOK_SECONDS = 86_400;

/** Immutable notification content; progress and later turns cannot change what a receipt covers. */
export interface News {
  seq: number;
  eventSeq: number;
  kind: 'done' | 'failed' | 'question' | 'waiting';
  state: JobState;
  turn: number;
  reason: string;
  question?: string;
  request?: string;
  acked: boolean;
  offers: number;
}

interface Item { jobId: string; newsSeq: number }
interface Receipt { session: string; items: Item[]; text: string; acknowledged?: boolean }
interface Lease { generation: string; expiresAt: number }
interface Watch extends Lease { deadline: number }
export interface DeliveryState {
  receipts: Record<string, Receipt>;
  offering: Record<string, Lease>;
}
export interface Offer { receipt: string; text: string; items: Item[] }

/** Count escaped text too: limits apply to the serialized response, not JS string length. */
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

export function textPage(text: string, offset: number, bytes: number): string {
  let lo = 0;
  let hi = Math.min(text.length - offset, bytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (jsonBytes(text.slice(offset, offset + mid)) <= bytes) lo = mid;
    else hi = mid - 1;
  }
  // Do not split a UTF-16 surrogate pair between pages.
  if (lo && /[\uD800-\uDBFF]/.test(text[offset + lo - 1])) lo--;
  return text.slice(offset, offset + lo);
}

export function clipped(text: string, bytes: number): string {
  if (jsonBytes(text) <= bytes) return text;
  return `${textPage(text, 0, bytes - 32)}\n… (truncated)`;
}

export function unread(job: Pick<Job, 'news'>): News[] {
  return (job.news ?? []).filter((item) => !item.acked);
}

/** Old board/native clients compare event seq to delivered. Keep that projection, never use it as an ACK. */
export function deliveryPosition(job: Job): void {
  const pending = unread(job);
  job.ackedSeq = pending.length ? Math.min(...pending.map((item) => item.seq)) - 1 : job.newsSeq ?? 0;
  job.delivered = pending.length ? Math.min(...pending.map((item) => item.eventSeq)) - 1 : job.seq;
}

export function addNews(job: Job, kind: News['kind'], reason: string, refs: { question?: string; request?: string } = {}): void {
  job.newsSeq = (job.newsSeq ?? 0) + 1;
  (job.news ??= []).push({ seq: job.newsSeq, eventSeq: job.seq, kind, state: job.state, turn: job.turns,
    reason: clipped(reason, 600), ...refs, acked: false, offers: 0 });
  deliveryPosition(job);
}

export function leadSession(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('A lead session id is required.');
  return value;
}

/** All durable changes use the Jobs snapshot, so receipts and the news they cover commit together. */
export class Delivery {
  state: DeliveryState = { receipts: Object.create(null), offering: Object.create(null) };
  private watching = new Map<string, Watch>();
  private waiters = new Set<() => void>();
  private jobs: () => Job[];
  private save: () => void;

  constructor(jobs: () => Job[], save: () => void) {
    this.jobs = jobs;
    this.save = save;
  }

  restore(state?: DeliveryState): void {
    // A restarted daemon must fence every old process, but issued receipts remain valid.
    this.state = { receipts: Object.assign(Object.create(null), state?.receipts), offering: Object.create(null) };
    this.watching.clear();
  }

  changed(): void {
    for (const wake of [...this.waiters]) wake();
  }

  wait(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) finish();
    });
  }

  pending(session: string, ids?: string[]): { job: Job; news: News }[] {
    leadSession(session);
    return this.jobs().filter((job) => job.lead === session && (!ids || ids.includes(job.id)))
      .flatMap((job) => unread(job).map((news) => ({ job, news })));
  }

  context(session: string): string {
    const pending = this.pending(session);
    if (!pending.length) return '';
    const ids = pending.slice(0, OFFER_ITEMS).map(({ job, news }) => `${job.id}#${news.seq}`);
    return `Crew unacknowledged news: ${ids.join(', ')}${pending.length > ids.length ? `; ${pending.length - ids.length} more` : ''}. Read with status or wait; echo received receipt ids in ack.`;
  }

  watch(session: string, deadline: number, now = Date.now()): Watch | null {
    leadSession(session);
    if (!Number.isFinite(deadline) || deadline <= now || deadline > now + HOOK_SECONDS * 1000) throw new Error('Invalid watcher deadline.');
    const current = this.watching.get(session);
    if (current && current.expiresAt > now && current.deadline - now > WATCH_REPLACE_MS) return null;
    const watch = { generation: randomUUID(), deadline, expiresAt: Math.min(deadline, now + WATCH_MS) };
    this.watching.set(session, watch);
    this.changed();
    return { ...watch };
  }

  private watcher(session: string, generation: string, now: number): Watch {
    const watch = this.watching.get(session);
    if (!watch || watch.generation !== generation || watch.expiresAt <= now || watch.deadline <= now) throw new Error('Watcher lease expired or replaced.');
    return watch;
  }

  heartbeat(session: string, generation: string, now = Date.now()): Watch {
    const watch = this.watcher(session, generation, now);
    watch.expiresAt = Math.min(watch.deadline, now + WATCH_MS);
    return { ...watch };
  }

  release(session: string, generation: string, now = Date.now()): void {
    this.watcher(session, generation, now);
    this.watching.delete(session);
    this.changed();
  }

  offer(session: string, options: { automatic?: boolean; watcher?: string; ids?: string[]; bytes?: number } = {}, now = Date.now()): Offer | null {
    leadSession(session);
    if (options.watcher !== undefined) this.watcher(session, options.watcher, now);
    if (options.ids !== undefined && (!Array.isArray(options.ids) || options.ids.some((id) => typeof id !== 'string'))) throw new Error('job_ids must be strings.');
    const bytes = options.bytes ?? LEAD_BYTES - 512;
    if (!Number.isInteger(bytes) || bytes < 1024 || bytes > LEAD_BYTES - 512) throw new Error('Invalid digest budget.');
    const active = this.state.offering[session];
    if (options.automatic && active?.expiresAt > now) return null;
    const candidates = this.pending(session, options.ids).filter(({ news }) => !options.automatic || news.offers < 2);
    const receipt = randomUUID();
    const suffix = `\nReceipt: ${receipt}\nPass ack: "${receipt}" with your next Crew call (or an array for several receipts). Reading this is not an ACK.`;
    let text = 'Crew news (snapshots; use status with job_id to read the current job):';
    const selected: typeof candidates = [];
    for (const item of candidates) {
      const { job, news } = item;
      const line = `\n[${job.id}] news ${news.seq} · ${news.state.toUpperCase()} · turn ${news.turn} · ${news.kind}${news.question ? ` · ASKS YOU [${news.question}]` : ''}${news.request ? ` · request ${news.request}` : ''}: ${news.reason}`;
      if (selected.length === OFFER_ITEMS || jsonBytes(text + line + suffix) > bytes) break;
      selected.push(item);
      text += line;
    }
    if (!selected.length) return null;
    text += suffix;
    const items = selected.map(({ job, news }) => ({ jobId: job.id, newsSeq: news.seq }));
    const previous = this.state.offering[session];
    const counts = selected.map(({ news }) => news.offers);
    this.state.receipts[receipt] = { session, items, text };
    this.state.offering[session] = { generation: receipt, expiresAt: now + OFFER_MS };
    if (options.automatic) for (const { news } of selected) news.offers++;
    try {
      this.save();
    } catch (error) {
      delete this.state.receipts[receipt];
      if (previous) this.state.offering[session] = previous;
      else delete this.state.offering[session];
      selected.forEach(({ news }, i) => { news.offers = counts[i]; });
      throw error;
    }
    this.changed();
    return { receipt, text, items };
  }

  ack(session: string, value: unknown): void {
    leadSession(session);
    const ids = typeof value === 'string' ? [value] : value;
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some((id) => typeof id !== 'string')) throw new Error('ack must be a receipt id or an array of receipt ids.');
    const receipts = [...new Set<string>(ids)].map((id) => {
      const receipt = this.state.receipts[id];
      if (!receipt || receipt.session !== session) throw new Error('Unknown receipt or wrong lead session.');
      return receipt;
    });
    const changed = new Map<Job, { ackedSeq?: number; delivered: number; acked: boolean[] }>();
    const jobs = new Map(this.jobs().map((job) => [job.id, job]));
    // Validate the entire request before changing any position. Previously ACKed receipts survive history pruning.
    for (const receipt of receipts.filter((r) => !r.acknowledged)) {
      for (const item of receipt.items) {
        const job = jobs.get(item.jobId);
        if (!job || job.lead !== session || !Number.isSafeInteger(item.newsSeq) || item.newsSeq < 1 || item.newsSeq > (job.newsSeq ?? 0) || !job.news?.some((news) => news.seq === item.newsSeq)) throw new Error('Receipt does not match the job revision or owner.');
        changed.set(job, { ackedSeq: job.ackedSeq, delivered: job.delivered, acked: job.news.map((news) => news.acked) });
      }
    }
    const acknowledgements = receipts.map((r) => r.acknowledged);
    const offering = this.state.offering[session];
    for (const receipt of receipts) {
      if (receipt.acknowledged) continue;
      for (const item of receipt.items) jobs.get(item.jobId)!.news!.find((news) => news.seq === item.newsSeq)!.acked = true;
      receipt.acknowledged = true;
    }
    for (const job of changed.keys()) deliveryPosition(job);
    if (offering && this.state.receipts[offering.generation]?.acknowledged) delete this.state.offering[session];
    try {
      this.save();
    } catch (error) {
      for (const [job, before] of changed) {
        job.ackedSeq = before.ackedSeq;
        job.delivered = before.delivered;
        job.news!.forEach((news, i) => { news.acked = before.acked[i]; });
      }
      receipts.forEach((receipt, i) => { receipt.acknowledged = acknowledgements[i]; });
      if (offering) this.state.offering[session] = offering;
      throw error;
    }
    this.changed();
  }
}
