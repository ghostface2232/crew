import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalPath, isPresetName, PRESET_NAMES } from './config.ts';
import type { PresetName } from './config.ts';

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
  /** The lead's own names for stops, one entry per stage; absent when no stop has one. */
  labels?: (string | null)[];
  state: MissionState;
  outcome: string;
  /** What the lead recorded when it finished: decisions taken, approaches that failed, prerequisites. For the runbook. */
  record?: string;
  /** Set when the lead itself finished it as done, not the user on the board, who may mark it done while the lead works on. */
  doneByLead?: true;
  /** Oldest first; absent on missions without any. */
  notes?: MissionNote[];
  /** The preset this mission's new jobs run under instead of the global one; absent to use the global one. */
  preset?: PresetName;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export const STALE_MS = 12 * 60 * 60_000;
const MAX_NOTE = 2000;
const MAX_RECORD = 6000;
const MAX_NOTES = 20;
const KEEP_MISSIONS = 100;
/** Finished missions kept for each project whatever the overall limit, since the board shows that many per project. */
export const KEEP_PER_PROJECT = 2;

/** Cuts to a length without leaving half of a surrogate pair, which the app's JSON decoder refuses with the whole state. */
const clip = (text: string, length: number) => text.slice(0, length).replace(/[\ud800-\udbff]$/, '');

/** First line of a title, as stored. Lets a caller tell whether a title names a mission that already exists. */
export function normalizeTitle(text: unknown): string {
  return typeof text === 'string' ? clip(text.split(/\r\n|\r|\n/)[0].trim(), 120).trim() : '';
}

/** A follow-up's title in the language of the mission it follows: Korean for a Korean title, English otherwise. */
export function followUpTitle(title: string): string {
  const base = title.replace(/^(후속 작업|Follow-up): /, '');
  return /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(base) ? `후속 작업: ${base}` : `Follow-up: ${base}`;
}

/** A stored record is rendered on the board, so one with the wrong shape is refused rather than trusted. */
function isMission(m: any): m is Mission {
  return Boolean(m) && typeof m === 'object'
    && ['id', 'title', 'project', 'root', 'outcome'].every((key) => typeof m[key] === 'string')
    && (m.owner === undefined || typeof m.owner === 'string')
    && (m.record === undefined || typeof m.record === 'string')
    && (m.doneByLead === undefined || m.doneByLead === true)
    && (m.stages === undefined || isPlan(m.stages))
    && (m.stageIndex === undefined || (m.stages && Number.isInteger(m.stageIndex) && m.stageIndex >= 0
      && m.stageIndex < m.stages.length && m.stages[m.stageIndex] === m.stage))
    && (m.labels === undefined || (m.stages && Array.isArray(m.labels) && m.labels.length === m.stages.length
      && m.labels.every((label: unknown) => label === null || (typeof label === 'string' && label.length > 0 && label.length <= MAX_LABEL))))
    && (m.preset === undefined || isPresetName(m.preset))
    && (m.notes === undefined || (Array.isArray(m.notes) && m.notes.every((n: any) => n && typeof n.text === 'string' && Number.isFinite(n.at))))
    && STAGES.includes(m.stage) && ['active', 'done', 'abandoned'].includes(m.state)
    && Number.isFinite(m.createdAt) && Number.isFinite(m.updatedAt) && (m.endedAt === null || Number.isFinite(m.endedAt));
}

/** Every stop is drawn on the board and in the app. */
export const MAX_PLAN = 30;
/** A label sits on a stop of the track, where a long one would push its neighbors apart. */
export const MAX_LABEL = 24;

/** One stop of a plan. Its label names what this occurrence is for, which the stage alone cannot: a sample, then the rest. */
interface Step {
  stage: Stage;
  label: string | null;
}

function isPlan(stages: unknown): stages is Stage[] {
  return Array.isArray(stages) && stages.length > 0 && stages.length <= MAX_PLAN && stages.every((stage) => STAGES.includes(stage));
}

/** `implement`, or `implement: Sample` to name the stop. Null when it is neither. */
function stepOf(entry: unknown): Step | null {
  if (typeof entry !== 'string') return null;
  const colon = entry.indexOf(':');
  const stage = (colon < 0 ? entry : entry.slice(0, colon)).trim();
  if (!STAGES.includes(stage as Stage)) return null;
  const label = colon < 0 ? '' : clip(entry.slice(colon + 1).replace(/\s+/g, ' ').trim(), MAX_LABEL).trim();
  return { stage: stage as Stage, label: label || null };
}

const STAGE_FORM = `${STAGES.join(', ')}, each optionally followed by a colon and a name for that stop ("implement: Sample")`;

function planOf(stages: unknown, allowEmpty = false): Step[] | undefined {
  if (stages === undefined) return undefined;
  const steps = Array.isArray(stages) ? stages.map(stepOf) : [];
  if (!Array.isArray(stages) || (!allowEmpty && !stages.length) || stages.length > MAX_PLAN || steps.includes(null)) {
    throw new Error(`stages must be ${allowEmpty ? 'an' : 'a nonempty'} array of at most ${MAX_PLAN} using: ${STAGE_FORM}.`);
  }
  return steps as Step[];
}

function stageOf(stage: unknown): Step {
  const step = stepOf(stage);
  if (!step) throw new Error(`Invalid mission stage "${String(stage)}"; use one of: ${STAGE_FORM}.`);
  return step;
}

const sameLabel = (a: string | null, b: string | null) => a?.toLowerCase() === b?.toLowerCase();

/** A mission's plan as steps; undefined for one on the original full track. */
function stepsOf(mission: Pick<Mission, 'stages' | 'labels'>): Step[] | undefined {
  return mission.stages?.map((stage, at) => ({ stage, label: mission.labels?.[at] ?? null }));
}

function setSteps(mission: Mission, steps: Step[], index: number): void {
  mission.stages = steps.map((step) => step.stage);
  mission.stageIndex = index;
  mission.stage = steps[index].stage;
  if (steps.some((step) => step.label)) mission.labels = steps.map((step) => step.label);
  else delete mission.labels;
}

/** The plan as the lead writes it, for showing it back: `implement: Sample → self-review`. */
export function planText(mission: Pick<Mission, 'stages' | 'labels'>, mark?: (at: number) => string): string {
  return (stepsOf(mission) ?? STAGES.map((stage) => ({ stage, label: null })))
    .map((step, at) => `${step.stage}${step.label ? `: ${step.label}` : ''}${mark?.(at) ?? ''}`).join(' → ');
}

/** Omitted leaves the preset as it is, null clears it so the global one applies, and a name sets it. */
function presetOf(value: unknown): PresetName | null | undefined {
  if (value === undefined || value === null || isPresetName(value)) return value;
  throw new Error(`preset must be one of: ${PRESET_NAMES.join(', ')}, or null to use the global one.`);
}

function setPreset(mission: Mission, value: PresetName | null | undefined): void {
  if (value === null) delete mission.preset;
  else if (value !== undefined) mission.preset = value;
}

/** The preset a mission's new jobs run under: its own, else the global one. */
export function missionPreset(mission: Pick<Mission, 'preset'> | undefined, global: PresetName | null): PresetName | null {
  return mission?.preset ?? global;
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

  start(input: { title: string; project: string; root: string; owner?: string; stage?: string; stages?: unknown; preset?: unknown }): Mission {
    const title = titleOf(input.title);
    const preset = presetOf(input.preset);
    const steps = planOf(input.stages);
    const first = input.stage === undefined ? steps?.[0] ?? { stage: 'plan' as const, label: null } : stageOf(input.stage);
    let stageIndex = steps ? this.find(steps, first, 0) : 0;
    if (steps && stageIndex < 0) {
      steps.splice(1, 0, first);
      stageIndex = 1;
    }
    if (steps && steps.length > MAX_PLAN) throw new Error(`A mission plan has at most ${MAX_PLAN} steps.`);
    let id: string;
    do {
      id = `m-${randomBytes(3).toString('hex')}`;
    } while (this.missions.has(id));
    const now = Date.now();
    const mission: Mission = {
      id,
      title,
      project: canonicalPath(input.project),
      root: canonicalPath(input.root),
      ...(input.owner ? { owner: input.owner } : {}),
      stage: first.stage,
      ...(preset ? { preset } : {}),
      state: 'active',
      outcome: '',
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    if (steps) setSteps(mission, steps, stageIndex);
    this.missions.set(id, mission);
    this.changed(mission);
    return mission;
  }

  update(id: string, input: { stage?: string; stages?: unknown; title?: string; preset?: unknown }): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') throw new Error(`Mission ${id} is already ${mission.state}.`);
    const title = input.title === undefined ? mission.title : titleOf(input.title);
    const preset = presetOf(input.preset);
    const remaining = planOf(input.stages, true);
    const stage = input.stage === undefined ? undefined : stageOf(input.stage);
    let steps = stepsOf(mission);
    let index = mission.stageIndex ?? Math.max(0, (mission.stages ?? STAGES).indexOf(mission.stage));
    if (remaining) {
      // Revisions replace only the future: passed steps and jobs' recorded indices stay stable.
      steps = [...(steps ?? STAGES.map((name) => ({ stage: name, label: null }))).slice(0, index + 1), ...remaining];
    }
    if (steps) {
      // Reporting the current step again (as a resumed lead does) is not a new round. A different name is another
      // step, which is how the lead moves between two steps of one stage.
      const current = steps[index];
      if (stage !== undefined && (stage.stage !== current.stage || (stage.label !== null && !sameLabel(stage.label, current.label)))) {
        const next = this.find(steps, stage, index + 1);
        // Steps jumped over were not done, so they leave the plan instead of showing as passed.
        if (next > index + 1) steps.splice(index + 1, next - index - 1);
        else if (next < 0) {
          if (steps.length >= MAX_PLAN) throw new Error(`A mission plan has at most ${MAX_PLAN} steps; drop some with stages first.`);
          steps.splice(index + 1, 0, stage);
        }
        index += 1;
      }
      if (steps.length > MAX_PLAN) throw new Error(`A mission plan has at most ${MAX_PLAN} steps.`);
      setSteps(mission, steps, index);
    } else if (stage !== undefined) mission.stage = stage.stage;
    mission.title = title;
    setPreset(mission, preset);
    mission.updatedAt = Date.now();
    this.changed(mission);
    return mission;
  }

  /** The first step from `from` on that `wanted` means: its stage, and its name when it gives one. */
  private find(steps: Step[], wanted: Step, from: number): number {
    return steps.findIndex((step, at) => at >= from && step.stage === wanted.stage && (wanted.label === null || sameLabel(step.label, wanted.label)));
  }

  finish(id: string, input: { outcome?: string; abandoned?: boolean; record?: string; reopen?: boolean; byLead?: boolean } = {}): Mission {
    const mission = this.get(id);
    // A finished mission stays as it ended. Only an explicit reopen marks an abandoned one done: a lead's late
    // `done`, or a board still showing it active, must not undo the user's Stop tracking.
    if (mission.state !== 'active' && !(mission.state === 'abandoned' && input.reopen && !input.abandoned)) return mission;
    const outcome = (input.outcome ?? '').split(/\r\n|\r|\n/)[0].trim().slice(0, 200).trim();
    mission.state = input.abandoned ? 'abandoned' : 'done';
    if (mission.state === 'done' && !mission.stages) mission.stage = 'final';
    mission.outcome = outcome;
    const record = input.record?.trim().slice(0, MAX_RECORD);
    if (record) mission.record = record;
    if (mission.state === 'done' && input.byLead) mission.doneByLead = true;
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

  /**
   * Added to each prompt of a lead session whose latest mission it finished as done. Work the lead then does itself
   * starts no job, so the follow-up fallback in the MCP server never sees it; only a reminder at the prompt can catch it.
   * It reminds rather than opens: only the lead can tell a request for work from a question. A mission the user
   * marked done on the board gets none, since the lead is told to carry on with that work without a new mission.
   * Any open mission of the session suppresses it: after a restart the MCP server reattaches to an older open
   * mission even when a newer one is done.
   */
  followUpHint(owner: string, now = Date.now()): string {
    const mine = this.list().filter((mission) => mission.owner === owner);
    if (mine.some((mission) => mission.state === 'active')) return '';
    const latest = mine[0];
    if (latest?.state !== 'done' || !latest.doneByLead || now - (latest.endedAt ?? 0) >= STALE_MS) return '';
    return `Crew: your mission "${latest.title}" is done. Only if this message clearly asks for new work (changing files, or starting a job), call \`mission\` with a title and stages before you start it, even work you will do yourself: "${followUpTitle(latest.title)}" for more of the same command, or a title of its own for a new one. A question, an explanation, or a reply opens none, even about that mission.`;
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
    // A daemon from before names changes a plan without them, leaving names that fit no stop: the plan is kept, they are not.
    for (const m of saved.missions as any[]) if (Array.isArray(m?.labels) && m.labels.length !== m.stages?.length) delete m.labels;
    if (!saved.missions.every(isMission)) throw new Error(`${file} holds a record that is not a mission, so it was left untouched.`);
    for (const mission of saved.missions) {
      // Saved before keys were canonical; a Windows mission may hold git's `C:/x` spelling.
      mission.project = canonicalPath(mission.project);
      mission.root = canonicalPath(mission.root);
      this.missions.set(mission.id, mission);
    }
  }
}
