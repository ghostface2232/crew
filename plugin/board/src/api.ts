import { t } from './i18n.ts';

export class UnauthorizedError extends Error {
  constructor() {
    super(t('The board is not signed in.'));
  }
}
const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void) {
  unauthorizedListeners.add(listener);
  return () => { unauthorizedListeners.delete(listener); };
}
export function ticketFromFragment(fragment: string) {
  const ticket = new URLSearchParams(fragment.replace(/^#/, '')).get('ticket');
  return ticket && /^[a-f0-9]{64}$/i.test(ticket) ? ticket : null;
}
/**
 * What the daemon gave this page for its ticket. It is kept here and nowhere else: whatever a browser stores is
 * written to disk, where a worker can read it. So a reload signs the page out. A page in the desktop app holds
 * none; the app signs its requests.
 */
let credential: string | null = null;
const authorization = (): Record<string, string> => (credential ? { authorization: `Bearer ${credential}` } : {});
/**
 * Trade the launch ticket for the credential before rendering. The ticket leaves the address first, and so does
 * the secret an older launcher still puts there.
 */
export async function initializeSession() {
  const ticket = ticketFromFragment(location.hash);
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (fragment.has('ticket') || fragment.has('token')) {
    history.replaceState(null, '', location.pathname + location.search);
  }
  if (ticket) credential = (await request<{ credential: string }>('/api/session', { ticket })).credential;
}
function refused(): never {
  unauthorizedListeners.forEach((listener) => listener());
  throw new UnauthorizedError();
}
export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    signal,
    headers: { ...authorization(), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 401) refused();
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? t('Request failed ({status}). Try again.', { status: response.status }));
  return data as T;
}
/**
 * Reads the daemon's event stream until it ends. An EventSource cannot send the credential, so the stream is read
 * from a fetch; a refused credential then shows as itself rather than as an outage.
 */
export async function stream(route: string, receive: (type: string, data: string) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(route, { headers: authorization(), signal });
  if (response.status === 401) refused();
  if (!response.ok || !response.body) throw new Error(t('Request failed ({status}). Try again.', { status: response.status }));
  const reader = response.body.getReader();
  // One decoder for the whole stream: a chunk may end inside a character, or inside an event.
  const decoder = new TextDecoder();
  const parts: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    const chunk = decoder.decode(value, { stream: true });
    if (!chunk) continue;
    let start = 0;
    const last = parts.at(-1) ?? '';
    // A separator can start in the previous chunk, before the search range.
    const crossesBoundary = last.endsWith('\n') && chunk.startsWith('\n');
    if (crossesBoundary) parts[parts.length - 1] = last.slice(0, -1);
    let end = crossesBoundary ? -1 : chunk.indexOf('\n\n');
    while (end !== -1 || (crossesBoundary && start === 0)) {
      if (end > start) parts.push(chunk.slice(start, end));
      const frame = parts.join('');
      parts.length = 0;
      start = end + 2;
      end = chunk.indexOf('\n\n', start);
      const lines = frame.split('\n');
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).replace(/^ /, ''));
      if (data.length) receive(lines.find((line) => line.startsWith('event:'))?.slice(6).trim() ?? 'message', data.join('\n'));
    }
    if (start < chunk.length) parts.push(chunk.slice(start));
  }
}
export interface ActionState {
  pending?: boolean;
  accepted?: boolean;
  text: string;
  tone?: 'failed';
}
const EMPTY: ActionState = { text: '' };
/** A request is shared by every surface and remains locked until its identity changes. */
export class Actions {
  private states = new Map<string, ActionState>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.states.get(key) ?? EMPTY;
  private set(key: string, state: ActionState) {
    this.states.set(key, state);
    this.listeners.forEach((listener) => listener());
  }
  async run(key: string, work: () => Promise<unknown>, { once = true, done = t('Sent') } = {}) {
    const previous = this.get(key);
    if (previous.pending || previous.accepted) return false;
    this.set(key, { pending: true, text: t('Sending…') });
    try {
      await work();
      this.set(key, { accepted: once, text: done });
      return true;
    } catch (error) {
      this.set(key, { text: error instanceof Error ? error.message : t('Could not send. Try again.'), tone: 'failed' });
      return false;
    }
  }
}
export const actions = new Actions();
export const answerKey = (job: string, requestId: string) => `answer:${job}:${requestId}`;
/** Unsent text shared by every surface showing the same request, as the app's drafts are. */
export class Drafts {
  private texts = new Map<string, string>();
  private listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  get = (key: string) => this.texts.get(key) ?? '';
  set = (key: string, text: string) => {
    if (text) this.texts.set(key, text);
    else this.texts.delete(key);
    this.listeners.forEach((listener) => listener());
  };
}
export const drafts = new Drafts();
