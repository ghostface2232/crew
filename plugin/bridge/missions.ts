import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'] as const;
export type Stage = (typeof STAGES)[number];
export type MissionState = 'active' | 'done' | 'abandoned';

export interface Mission {
  id: string;
  title: string;
  project: string;
  root: string;
  stage: Stage;
  state: MissionState;
  outcome: string;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export const STALE_MS = 12 * 60 * 60_000;
const KEEP_MISSIONS = 100;
/** Finished missions kept for each project whatever the overall limit, since the board shows that many per project. */
export const KEEP_PER_PROJECT = 2;

/** First line of a title, as stored. Lets a caller tell whether a title names a mission that already exists. */
export function normalizeTitle(text: unknown): string {
  return typeof text === 'string' ? text.split(/\r\n|\r|\n/)[0].trim().slice(0, 120).trim() : '';
}

/** A stored record is rendered on the board, so one with the wrong shape is refused rather than trusted. */
function isMission(m: any): m is Mission {
  return Boolean(m) && typeof m === 'object'
    && ['id', 'title', 'project', 'root', 'outcome'].every((key) => typeof m[key] === 'string')
    && STAGES.includes(m.stage) && ['active', 'done', 'abandoned'].includes(m.state)
    && Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt) && (m.endedAt === null || Number.isFinite(m.endedAt));
}

function titleOf(text: string): string {
  const title = normalizeTitle(text);
  if (!title) throw new Error('A mission needs a title: the command it carries out.');
  return title;
}

export class Missions {
  private missions = new Map<string, Mission>();
  private saveTimer: NodeJS.Timeout | null = null;
  private home: string;
  private onChange: (mission: Mission) => void;

  constructor(home: string, onChange: (mission: Mission) => void) {
    this.home = home;
    this.onChange = onChange;
    this.load();
  }

  list(): Mission[] {
    return [...this.missions.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): Mission {
    const mission = this.missions.get(id);
    if (!mission) throw new Error(`No mission with id "${id}".`);
    return mission;
  }

  start(input: { title: string; project: string; root: string }): Mission {
    const title = titleOf(input.title);
    let id: string;
    do {
      id = `m-${randomBytes(3).toString('hex')}`;
    } while (this.missions.has(id));
    const now = Date.now();
    const mission: Mission = {
      id,
      title,
      project: input.project,
      root: input.root,
      stage: 'plan',
      state: 'active',
      outcome: '',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    this.missions.set(id, mission);
    this.changed(mission);
    return mission;
  }

  update(id: string, input: { stage?: string; title?: string }): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') throw new Error(`Mission ${id} is already ${mission.state}.`);
    if (input.stage !== undefined && !STAGES.includes(input.stage as Stage)) {
      throw new Error(`Invalid mission stage "${input.stage}"; use one of: ${STAGES.join(', ')}.`);
    }
    const title = input.title === undefined ? mission.title : titleOf(input.title);
    if (input.stage !== undefined) mission.stage = input.stage as Stage;
    mission.title = title;
    mission.updatedAt = Date.now();
    this.changed(mission);
    return mission;
  }

  finish(id: string, input: { outcome?: string; abandoned?: boolean } = {}): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') return mission;
    const outcome = (input.outcome ?? '').split(/\r\n|\r|\n/)[0].trim().slice(0, 200).trim();
    mission.state = input.abandoned ? 'abandoned' : 'done';
    if (mission.state === 'done') mission.stage = 'final';
    mission.outcome = outcome;
    mission.updatedAt = Date.now();
    mission.endedAt = mission.updatedAt;
    this.changed(mission);
    return mission;
  }

  touch(id: string): void {
    const mission = this.missions.get(id);
    if (!mission || mission.state !== 'active') return;
    mission.updatedAt = Date.now();
    this.changed();
  }

  sweep(now: number, isBusy: (id: string) => boolean): Mission[] {
    const abandoned: Mission[] = [];
    for (const mission of this.missions.values()) {
      if (mission.state === 'active' && now - mission.updatedAt >= STALE_MS && !isBusy(mission.id)) {
        abandoned.push(this.finish(mission.id, { abandoned: true, outcome: 'No update for 12 hours.' }));
      }
    }
    return abandoned;
  }

  private changed(mission?: Mission): void {
    if (mission) this.onChange(mission);
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, 500).unref();
  }

  /**
   * The missions that are written to disk: every open one, the most recently ended ones overall, and
   * the last few of each project, so a quiet project keeps what the board shows for it.
   */
  saved(): Mission[] {
    const ended = this.list().filter((mission) => mission.state !== 'active').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const perProject = new Map<string, number>();
    const keep = new Set(ended.filter((mission, index) => {
      const seen = perProject.get(mission.root) ?? 0;
      perProject.set(mission.root, seen + 1);
      return index < KEEP_MISSIONS || seen < KEEP_PER_PROJECT;
    }));
    return this.list().filter((mission) => mission.state === 'active' || keep.has(mission));
  }

  private save(): void {
    const keep = this.saved();
    const file = path.join(this.home, 'missions.json');
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify({ missions: keep }));
    fs.renameSync(`${file}.tmp`, file);
  }

  flush(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = null;
    this.save();
  }

  private load(): void {
    const file = path.join(this.home, 'missions.json');
    let saved: { missions: Mission[] } | null;
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error(`Could not load ${file}, so it was left untouched: ${(err as Error).message}`);
    }
    if (!saved || !Array.isArray(saved.missions)) {
      throw new Error(`${file} does not hold a missions array, so it was left untouched.`);
    }
    if (!saved.missions.every(isMission)) throw new Error(`${file} holds a record that is not a mission, so it was left untouched.`);
    for (const mission of saved.missions) this.missions.set(mission.id, mission);
  }
}
