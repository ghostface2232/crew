export async function request<T>(route: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(route, {
    method: body === undefined ? 'GET' : 'POST',
    signal,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}). Try again.`);
  return data as T;
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
  async run(key: string, work: () => Promise<unknown>, { once = true, done = 'Sent' } = {}) {
    const previous = this.get(key);
    if (previous.pending || previous.accepted) return false;
    this.set(key, { pending: true, text: 'Sending…' });
    try {
      await work();
      this.set(key, { accepted: once, text: done });
      return true;
    } catch (error) {
      this.set(key, { text: error instanceof Error ? error.message : 'Could not send. Try again.', tone: 'failed' });
      return false;
    }
  }
}
export const actions = new Actions();
export const answerKey = (job: string, requestId: string) => `answer:${job}:${requestId}`;
