import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'] as const;
export type Stage = (typeof STAGES)[number];
export type MissionState = 'active' | 'done' | 'abandoned';

/** Information the user pinned to a mission from the board; it starts no work. */
export interface MissionNote {
  text: string;
  at: number;
}

export interface Mission {
  id: string;
  title: string;
  project: string;
  root: string;
  /** The lead session that opened it, when known. Only that session may take it up again after losing track of it. */
  owner?: string;
  stage: Stage;
  /** Planned order; absent on missions using the original full track. */
  stages?: Stage[];
  /** Current occurrence in the plan; stage mirrors this entry for older clients. */
  stageIndex?: number;
  state: MissionState;
  outcome: string;
  /** Oldest first; absent on missions without any. */
  notes?: MissionNote[];
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export const STALE_MS = 12 * 60 * 60_000;
const MAX_NOTE = 2000;
const MAX_NOTES = 20;
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
    && (m.owner === undefined || typeof m.owner === 'string')
    && (m.stages === undefined || isPlan(m.stages))
    && (m.stageIndex === undefined || (m.stages && Number.isInteger(m.stageIndex) && m.stageIndex >= 0
      && m.stageIndex < m.stages.length && m.stages[m.stageIndex] === m.stage))
    && (m.notes === undefined || (Array.isArray(m.notes) && m.notes.every((n: any) => n && typeof n.text === 'string' && Number.isFinite(n.at))))
    && STAGES.includes(m.stage) && ['active', 'done', 'abandoned'].includes(m.state)
    && Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt) && (m.endedAt === null || Number.isFinite(m.endedAt));
}

function isPlan(stages: unknown, allowEmpty = false): stages is Stage[] {
  return Array.isArray(stages) && (allowEmpty || stages.length > 0)
    && stages.every((stage) => STAGES.includes(stage));
}

function planOf(stages: unknown, allowEmpty = false): Stage[] | undefined {
  if (stages === undefined) return undefined;
  if (!isPlan(stages, allowEmpty)) throw new Error(`stages must be ${allowEmpty ? 'an' : 'a nonempty'} array using: ${STAGES.join(', ')}.`);
  return [...stages];
}

function stageOf(stage: string): Stage {
  if (!STAGES.includes(stage as Stage)) throw new Error(`Invalid mission stage "${stage}"; use one of: ${STAGES.join(', ')}.`);
  return stage as Stage;
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

  start(input: { title: string; project: string; root: string; owner?: string; stage?: string; stages?: unknown }): Mission {
    const title = titleOf(input.title);
    const stages = planOf(input.stages);
    const first = stages?.[0] ?? 'plan';
    const stage = input.stage === undefined ? first : stageOf(input.stage);
    let stageIndex = stages?.indexOf(stage) ?? 0;
    if (stages && stageIndex < 0) {
      stages.splice(1, 0, stage);
      stageIndex = 1;
    }
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
      ...(input.owner ? { owner: input.owner } : {}),
      stage,
      ...(stages ? { stages, stageIndex } : {}),
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

  update(id: string, input: { stage?: string; stages?: unknown; title?: string }): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') throw new Error(`Mission ${id} is already ${mission.state}.`);
    const title = input.title === undefined ? mission.title : titleOf(input.title);
    const remaining = planOf(input.stages, true);
    const stage = input.stage === undefined ? undefined : stageOf(input.stage);
    let stages = mission.stages?.slice();
    let index = mission.stageIndex ?? Math.max(0, (stages ?? STAGES).indexOf(mission.stage));
    if (remaining) {
      // Revisions replace only the future: passed steps and jobs' recorded indices stay stable.
      stages = [...(stages ?? STAGES).slice(0, index + 1), ...remaining];
    }
    if (stages) {
      // Reporting the current step again (as a resumed lead does) is not a new round.
      if (stage !== undefined && stage !== stages[index]) {
        const next = stages.indexOf(stage, index + 1);
        if (next < 0) stages.splice(index + 1, 0, stage);
        index = next < 0 ? index + 1 : next;
      }
      mission.stages = stages;
      mission.stageIndex = index;
      mission.stage = stages[index];
    } else if (stage !== undefined) mission.stage = stage;
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
    if (mission.state === 'done' && !mission.stages) mission.stage = 'final';
    mission.outcome = outcome;
    mission.updatedAt = Date.now();
    mission.endedAt = mission.updatedAt;
    this.changed(mission);
    return mission;
  }

  /** Pins a piece of information to an open mission. It starts no work and does not count as a step. */
  note(id: string, text: string): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') throw new Error(`Mission ${id} is already ${mission.state}.`);
    const note = text.trim().slice(0, MAX_NOTE);
    if (!note) throw new Error('A note needs some text.');
    if ((mission.notes?.length ?? 0) >= MAX_NOTES) throw new Error(`Mission ${id} already has ${MAX_NOTES} notes.`);
    (mission.notes ??= []).push({ text: note, at: Date.now() });
    mission.updatedAt = Date.now();
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
