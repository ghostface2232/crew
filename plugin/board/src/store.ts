import type { BoardJob, BoardState, ClaudeSession, CrewEvent, Mission, Snapshot } from './types.ts';
import { onUnauthorized, request } from './api.ts';

const replace = <T extends { id: string }>(items: T[], next: T) =>
  items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
export function mergeEvents(events: CrewEvent[], incoming: CrewEvent[], limit = 400) {
  return [...new Map([...events, ...incoming].map((event) => [event.seq, event])).values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}

/** One transport, independent of React. Snapshots replace history after a daemon restart. */
export class BoardStore {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = {
    now: 0,
    jobs: [],
    missions: [],
    claude: [],
    agents: {} as BoardState['agents'],
    roles: {} as BoardState['roles'],
    limits: {},
    events: [],
    connection: 'connecting',
    revision: 0,
    clockSkew: 0,
  };
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  receive(type: string, value: unknown) {
    const current = this.snapshot;
    switch (type) {
      case 'state': {
        const state = value as BoardState;
        this.update({
          ...state,
          usage: state.usage,
          preset: state.preset,
          presets: state.presets,
          missions: state.missions ?? [],
          agents: state.agents ?? {},
          roles: state.roles ?? {},
          connection: 'live',
          revision: current.revision + 1,
          clockSkew: state.now - Date.now(),
        });
        break;
      }
      case 'job':
        this.update({ jobs: replace(current.jobs, value as BoardJob) });
        break;
      case 'mission':
        this.update({ missions: replace(current.missions, value as Mission) });
        break;
      case 'claude': {
        const { session, removed } = value as { session: ClaudeSession; removed: boolean };
        this.update({
          claude: removed ? current.claude.filter((s) => s.id !== session.id) : replace(current.claude, session),
        });
        break;
      }
      case 'roles':
        this.update({ roles: value as BoardState['roles'] });
        break;
      case 'usage':
        this.update({ usage: value as BoardState['usage'] });
        break;
      case 'preset': {
        const { preset, presets } = value as Pick<BoardState, 'preset' | 'presets'>;
        this.update({ preset, presets });
        break;
      }
      case 'limits':
        this.update({ limits: { ...current.limits, ...(value as BoardState['limits']) } });
        break;
      case 'event':
        this.update({ events: mergeEvents(current.events, [value as CrewEvent]) });
        break;
    }
  }
  private reconnect?: () => void;
  retry = () => this.reconnect?.();
  signOut = () => this.update({ connection: 'unauthorized' });
  connect(create = (url: string) => new EventSource(url)) {
    let generation = 0;
    let stream: EventSource | undefined;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      generation++;
      controller?.abort();
      stream?.close();
      stream = undefined;
      clearTimeout(timer);
    };
    const unsubscribe = onUnauthorized(() => {
      stop();
      this.signOut();
    });
    const open = async () => {
      const current = ++generation;
      controller = new AbortController();
      const signal = controller.signal;
      const reconnectLater = () => {
        if (current === generation) timer = setTimeout(() => void open(), 3000);
      };
      try {
        const state = await request<BoardState>('/api/state', undefined, signal);
        if (current !== generation) return;
        this.receive('state', state);
        const source = create('/api/stream');
        stream = source;
        for (const type of ['state', 'job', 'mission', 'claude', 'roles', 'limits', 'usage', 'preset', 'event']) {
          source.addEventListener(type, (event) => {
            if (current !== generation || source !== stream) return;
            try {
              this.receive(type, JSON.parse((event as MessageEvent).data));
            } catch {
              this.update({ connection: 'lost' });
            }
          });
        }
        source.onerror = () => {
          if (current !== generation || source !== stream) return;
          // Stop native retries while a fetch distinguishes an expired session from an outage.
          source.close();
          stream = undefined;
          this.update({ connection: 'lost' });
          void request('/api/state', undefined, signal).catch(() => {}).finally(reconnectLater);
        };
      } catch {
        if (current !== generation) return;
        this.update({ connection: 'lost' });
        reconnectLater();
      }
    };
    this.reconnect = () => {
      stop();
      this.update({ connection: 'connecting' });
      void open();
    };
    if (this.snapshot.connection !== 'unauthorized') void open();
    return () => {
      stop();
      unsubscribe();
      this.reconnect = undefined;
    };
  }
}
export const board = new BoardStore();
