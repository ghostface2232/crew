import type { BoardJob, BoardState, ClaudeSession, CrewEvent, Mission, Snapshot } from './types.ts';
import { onUnauthorized, stream } from './api.ts';

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
          roleSettings: state.roleSettings,
          roleInfo: state.roleInfo,
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
      case 'roleSettings':
        this.update({ roleSettings: value as BoardState['roleSettings'] });
        break;
      case 'usage':
        this.update({ usage: value as BoardState['usage'] });
        break;
      case 'preset': {
        const { preset, presets } = value as Pick<BoardState, 'preset' | 'presets'>;
        this.update({ preset, presets });
        break;
      }
      case 'modelScores':
        this.update({ modelScores: value as BoardState['modelScores'] });
        break;
      case 'peerRatings':
        this.update({ peerRatings: value as boolean });
        break;
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
  connect(read = stream) {
    let generation = 0;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      generation++;
      controller?.abort();
      clearTimeout(timer);
    };
    const unsubscribe = onUnauthorized(() => {
      stop();
      this.signOut();
    });
    const open = async () => {
      const current = ++generation;
      controller = new AbortController();
      try {
        // The stream opens with the whole state, so each connection replaces what the one before it left.
        await read('/api/stream', (type, data) => {
          if (current !== generation) return;
          try {
            this.receive(type, JSON.parse(data));
          } catch {
            this.update({ connection: 'lost' });
          }
        }, controller.signal);
      } catch {
        // An outage. A refused credential has already signed the board out and stopped this connection.
      }
      if (current !== generation) return;
      this.update({ connection: 'lost' });
      timer = setTimeout(() => void open(), 3000);
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
