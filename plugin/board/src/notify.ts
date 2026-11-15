import { NAMES } from './model.ts';
import type { BoardJob, Snapshot } from './types.ts';

export function notificationPermission(): NotificationPermission | 'unsupported' {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function notificationsWanted(): boolean {
  try {
    return localStorage.getItem('crew.notify') === '1';
  } catch {
    return false;
  }
}

export function setNotificationsWanted(on: boolean): void {
  try {
    if (on) localStorage.setItem('crew.notify', '1');
    else localStorage.removeItem('crew.notify');
  } catch {
    // Storage can be unavailable even when notifications are supported.
  }
}

export async function requestNotifications(): Promise<NotificationPermission | 'unsupported'> {
  if (notificationPermission() === 'unsupported') return 'unsupported';
  setNotificationsWanted(true);
  return Notification.requestPermission();
}

export interface Notice {
  key: string;
  title: string;
  body: string;
  jobId?: string;
}

export interface PlanMemory {
  waiting?: ReadonlySet<string>;
  done?: ReadonlySet<string>;
  jobs?: ReadonlyMap<string, Pick<BoardJob, 'state' | 'turns'>>;
}

export function planNotifications(previous: PlanMemory, state: Snapshot, options: { onDone: boolean }): {
  show: Notice[];
  expire: string[];
  memory: PlanMemory;
} {
  const show: Notice[] = [];
  const waiting = new Set<string>();
  const done = new Set(previous.done);
  const jobs = new Map<string, Pick<BoardJob, 'state' | 'turns'>>();
  const request = (notice: Notice) => {
    if (!waiting.has(notice.key) && !previous.waiting?.has(notice.key)) show.push(notice);
    waiting.add(notice.key);
  };
  for (const job of state.jobs) {
    const old = previous.jobs?.get(job.id);
    jobs.set(job.id, { state: job.state, turns: job.turns });
    if (options.onDone && job.state === 'done' && old && (old.state !== 'done' || old.turns < job.turns)) {
      const key = `done:${job.id}:${job.turns}`;
      if (!done.has(key)) {
        done.add(key);
        show.push({ key, title: `${NAMES[job.agent]} finished`, body: job.title, jobId: job.id });
      }
    }
    if (job.state === 'waiting' && job.waiting) {
      request({ key: `${job.id}:${job.waiting.id}`, title: `${NAMES[job.agent]} needs your input`, body: job.waiting.reason, jobId: job.id });
    }
  }
  for (const session of state.claude) {
    if (session.state === 'waiting') {
      request({ key: `session:${session.id}:${session.waitingFor ?? ''}`, title: 'Claude needs your input', body: session.waitingFor ?? session.title });
    }
  }
  return {
    show,
    expire: [...previous.waiting ?? []].filter((key) => !waiting.has(key)),
    memory: { waiting, done, jobs },
  };
}

export class Notifier {
  onOpen: (jobId?: string) => void = () => {};
  private memory: PlanMemory = {};
  private notifications = new Map<string, Notification>();
  private options: { onDone?: boolean };

  constructor(options: { onDone?: boolean } = {}) {
    this.options = options;
  }

  update(state: Snapshot, focused: boolean): void {
    const settings = (state as Snapshot & { notifications?: { onDone?: boolean } }).notifications;
    const plan = planNotifications(this.memory, state, { onDone: settings?.onDone ?? this.options.onDone ?? false });
    this.memory = plan.memory;
    for (const key of plan.expire) {
      this.notifications.get(key)?.close();
      this.notifications.delete(key);
    }
    if (notificationPermission() !== 'granted' || !notificationsWanted() || focused) return;
    for (const notice of plan.show) {
      try {
        const notification = new Notification(notice.title, { body: notice.body, tag: notice.key });
        this.notifications.set(notice.key, notification);
        notification.onclose = () => {
          if (this.notifications.get(notice.key) === notification) this.notifications.delete(notice.key);
        };
        notification.onclick = () => {
          try {
            window.focus();
            this.onOpen(notice.jobId);
          } finally {
            notification.close();
            if (this.notifications.get(notice.key) === notification) this.notifications.delete(notice.key);
          }
        };
      } catch {
        // Some browsers expose Notification but do not allow its constructor.
      }
    }
  }
}
