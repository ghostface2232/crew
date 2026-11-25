import type { BoardJob, BoardPull, BoardState, ClaudeSession, CrewEvent, Mission, ProjectSettings, Snapshot } from './types.ts';
import { onUnauthorized, stream } from './api.ts';
import type { Notifier } from './notify.ts';

const replace = <T extends { id: string }>(items: T[], next: T) =>
  items.some((item) => item.id === next.id)
    ? items.map((item) => (item.id === next.id ? next : item))
    : [...items, next];
export function mergeEvents(events: CrewEvent[], incoming: CrewEvent[], limit = 400) {
  if (
    incoming.length === 1 && Number.isSafeInteger(limit) && limit > 0 &&
    incoming[0].seq > (events.at(-1)?.seq ?? -Infinity) &&
    events.every((event, index) => index === 0 || event.seq > events[index - 1].seq)
  ) {
    const merged = events.slice(Math.max(0, events.length + 1 - limit));
    merged.push(incoming[0]);
    return merged;
  }
  return [...new Map([...events, ...incoming].map((event) => [event.seq, event])).values()]
    .sort((a, b) => a.seq - b.seq)
    .slice(-limit);
}

function notificationsChanged(type: string, value: unknown, previous: Snapshot) {
  if (type === 'state') return true;
  if (type === 'job') {
    const job = value as BoardJob;
    const old = previous.jobs.find((item) => item.id === job.id);
    return !old || old.state !== job.state || old.turns !== job.turns || old.waiting?.id !== job.waiting?.id;
  }
  if (type === 'claude') {
    const { session, removed } = value as { session: ClaudeSession; removed: boolean };
    const old = previous.claude.find((item) => item.id === session.id);
    if (removed) return old?.state === 'waiting';
    return (old?.state === 'waiting') !== (session.state === 'waiting') ||
      (session.state === 'waiting' && (old?.waitingId ?? old?.waitingFor ?? '') !== (session.waitingId ?? session.waitingFor ?? ''));
  }
  return false;
}

/** One transport, independent of React. Snapshots replace history after a daemon restart. */
export class BoardStore {
  private listeners = new Set<() => void>();
  private cancelNotification?: () => void;
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
      if (!this.listeners.size) this.clearNotification();
    };
  };
  private clearNotification() {
    this.cancelNotification?.();
    this.cancelNotification = undefined;
  }
  private notify = () => {
    this.clearNotification();
    this.listeners.forEach((listener) => listener());
  };
  private scheduleNotification = () => {
    const doc = typeof document === 'undefined' ? undefined : document;
    const reschedule = () => {
      this.clearNotification();
      this.scheduleNotification();
    };
    const cancel = doc?.hidden || typeof requestAnimationFrame !== 'function'
      ? (() => {
          const timer = setTimeout(this.notify, 0);
          return () => clearTimeout(timer);
        })()
      : (() => {
          const frame = requestAnimationFrame(this.notify);
          return () => cancelAnimationFrame(frame);
        })();
    doc?.addEventListener('visibilitychange', reschedule);
    this.cancelNotification = () => {
      doc?.removeEventListener('visibilitychange', reschedule);
      cancel();
    };
  };
  private presetRevision = 0;
  getPresetRevision = () => this.presetRevision;
  private budgetRevision = 0;
  getBudgetRevision = () => this.budgetRevision;

  private update(patch: Partial<Snapshot>) {
    if ('preset' in patch) this.presetRevision++;
    if ('turnTokenBudget' in patch) this.budgetRevision++;
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.connection !== undefined) this.notify();
    else if (this.listeners.size && !this.cancelNotification) this.scheduleNotification();
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
          pulls: state.pulls,
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
      case 'pull':
        this.update({ pulls: replace(current.pulls ?? [], value as BoardPull) });
        break;
      case 'claude': {
        const { session, removed } = value as { session: ClaudeSession; removed: boolean };
        this.update({
          claude: removed ? current.claude.filter((s) => s.id !== session.id) : replace(current.claude, session),
        });
        break;
      }
      case 'agents':
        this.update({ agents: value as BoardState['agents'] });
        break;
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
      case 'turnTokenBudget':
        this.update({ turnTokenBudget: value as BoardState['turnTokenBudget'] });
        break;
      case 'projects':
        this.update({ projects: value as Record<string, ProjectSettings> });
        break;
      case 'language':
        this.update({ language: (value as Pick<BoardState, 'language'>).language });
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
  connect(read = stream, notifier?: Pick<Notifier, 'update'>) {
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
            const previous = this.snapshot;
            const value: unknown = JSON.parse(data);
            this.receive(type, value);
            if (notifier && this.snapshot.connection === 'live' && notificationsChanged(type, value, previous)) {
              notifier.update(this.snapshot, document.hasFocus());
            }
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
