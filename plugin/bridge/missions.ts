import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonicalPath, isPresetName, PRESET_NAMES } from './config.ts';
import type { PresetName } from './config.ts';
import type { Job } from './jobs.ts';
import type { PullWatch } from './pulls.ts';

export const STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'] as const;
export type Stage = (typeof STAGES)[number];
export type MissionState = 'active' | 'done' | 'abandoned';

/** Information the user pinned to a mission from the board; it starts no work. */
export interface MissionNote {
  text: string;
  at: number;
}

export const TASK_STATES = ['todo', 'doing', 'done', 'dropped'] as const;
export type TaskState = (typeof TASK_STATES)[number];

/**
 * One piece of a mission's work, as the lead split it. The lead writes it and reports on it; nothing runs from it.
 * It is kept with the mission so the plan outlasts the session's context: a lead that resumes is shown it again.
 * A job done for a task names it (`Job.taskId`), so the job's state is read from the job, never copied here.
 */
export interface MissionTask {
  /** The lead's own short name for it. */
  id: string;
  title: string;
  /** The tasks this one waits for; absent when it waits for none. */
  after?: string[];
  state: TaskState;
  /** One line on how it was verified, or why it was dropped. */
  result?: string;
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
  /** In the order the lead gave them; absent on missions without any. */
  tasks?: MissionTask[];
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
}

export const STALE_MS = 12 * 60 * 60_000;
/** A mission with a task still open or a pull request still watched is waited for longer: overnight, or over a weekend. */
export const STALE_HELD_MS = 72 * 60 * 60_000;
const MAX_TASKS = 40;
const MAX_TASK_TITLE = 120;
const MAX_RESULT = 300;
const TASK_ID = /^[\w.-]{1,24}$/;
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
    && (m.tasks === undefined || (Array.isArray(m.tasks) && m.tasks.every((task: any) => task && typeof task.id === 'string' && typeof task.title === 'string'
      && TASK_STATES.includes(task.state) && (task.result === undefined || typeof task.result === 'string')
      && (task.after === undefined || (Array.isArray(task.after) && task.after.every((id: unknown) => typeof id === 'string'))))))
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

const TASK_FORM = `tasks is a list of { id, title, after, state, result }: id is your short name for the task, after lists the ids it waits for, state is one of ${TASK_STATES.join(', ')}. An id the mission already has updates that task with the fields given; a new id needs a title.`;

const oneLine = (text: string, length: number) => clip(text.split(/\r\n|\r|\n/)[0].trim(), length).trim();

/**
 * The mission's tasks with these entries laid over them, by id. The result is checked as a whole, so a refused
 * list changes nothing: every `after` names a task of the list, and no task waits, through others, for itself.
 */
function mergeTasks(current: MissionTask[] | undefined, input: unknown): MissionTask[] {
  if (!Array.isArray(input)) throw new Error(TASK_FORM);
  const tasks = (current ?? []).map((task) => ({ ...task }));
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') throw new Error(TASK_FORM);
    const { id, title, after, state, result } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !TASK_ID.test(id)) throw new Error(`A task id is 1 to 24 letters, digits, ".", "_" or "-", not ${JSON.stringify(id)}. ${TASK_FORM}`);
    let task = tasks.find((known) => known.id === id);
    if (!task) {
      if (typeof title !== 'string') throw new Error(`Task "${id}" is new to this mission, so it needs a title.`);
      task = { id, title: '', state: 'todo' };
      tasks.push(task);
    }
    if (title !== undefined) {
      if (typeof title !== 'string' || !oneLine(title, MAX_TASK_TITLE)) throw new Error(`Task "${id}" needs a title of some text.`);
      task.title = oneLine(title, MAX_TASK_TITLE);
    }
    if (state !== undefined) {
      if (!TASK_STATES.includes(state as TaskState)) throw new Error(`Task "${id}" has state ${JSON.stringify(state)}; use one of: ${TASK_STATES.join(', ')}.`);
      task.state = state as TaskState;
    }
    if (after !== undefined) {
      if (!Array.isArray(after) || after.some((dep) => typeof dep !== 'string')) throw new Error(`Task "${id}": after is a list of task ids.`);
      if (after.length) task.after = [...new Set(after as string[])];
      else delete task.after;
    }
    if (result !== undefined) {
      if (typeof result !== 'string') throw new Error(`Task "${id}": result is one line of text.`);
      if (oneLine(result, MAX_RESULT)) task.result = oneLine(result, MAX_RESULT);
      else delete task.result;
    }
  }
  if (tasks.length > MAX_TASKS) throw new Error(`A mission has at most ${MAX_TASKS} tasks; fold the small ones together.`);
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dep of task.after ?? []) if (!byId.has(dep)) throw new Error(`Task "${task.id}" waits for "${dep}", which is not a task of this mission.`);
  }
  // A task that is reached again while its own chain is still being followed waits for itself.
  const settled = new Set<string>();
  const follow = (task: MissionTask, chain: string[]): void => {
    if (chain.includes(task.id)) throw new Error(`Tasks wait for each other in a circle: ${[...chain.slice(chain.indexOf(task.id)), task.id].join(' → ')}. Take one of them out of after.`);
    if (settled.has(task.id)) return;
    for (const dep of task.after ?? []) follow(byId.get(dep)!, [...chain, task.id]);
    settled.add(task.id);
  };
  for (const task of tasks) follow(task, []);
  return tasks;
}

/** The tasks an unfinished task still waits for. A dropped one never gets done, so the lead has to take it out of `after`. */
export function waitsFor(tasks: MissionTask[], task: MissionTask): MissionTask[] {
  return (task.after ?? []).flatMap((id) => tasks.find((other) => other.id === id) ?? []).filter((other) => other.state !== 'done');
}

const openTasks = (mission: Pick<Mission, 'tasks'>) => (mission.tasks ?? []).filter((task) => task.state === 'todo' || task.state === 'doing');

type TaskJob = Pick<Job, 'id' | 'mission' | 'taskId' | 'state' | 'receipts' | 'createdAt'>;

/** The lead's check as the bridge ran it after the job's last turn, when the job has one. */
function checkText(job: TaskJob): string {
  const check = job.receipts?.at(-1)?.check;
  if (!check) return '';
  if (check.skipped) return ', check not run';
  return check.exit === 0 ? ', check passed' : check.exit === null ? ', check stopped' : `, check failed with exit ${check.exit}`;
}

const ago = (ms: number) => (ms < 90_000 ? 'just now' : ms < 90 * 60_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`);

/**
 * A mission's tasks and pull requests as its lead reads them: in a mission reply, and again when its session
 * starts, resumes or is compacted. Empty for a mission with neither.
 */
export function missionDetail(mission: Mission, jobs: TaskJob[], pulls: PullWatch[], now = Date.now()): string {
  const lines: string[] = [];
  const tasks = mission.tasks ?? [];
  if (tasks.length) {
    const kept = tasks.filter((task) => task.state !== 'dropped');
    lines.push(`Tasks (${kept.filter((task) => task.state === 'done').length} of ${kept.length} done):`);
    const ready: string[] = [];
    for (const task of tasks) {
      const waits = task.state === 'todo' ? waitsFor(tasks, task) : [];
      if (task.state === 'todo' && !waits.length) ready.push(task.id);
      // Every job still under way, and the last one that ended: an older success must not hide a later failure.
      const linked = jobs.filter((job) => job.mission === mission.id && job.taskId === task.id).sort((a, b) => a.createdAt - b.createdAt);
      const shown = linked.filter((job, at) => job.state === 'running' || job.state === 'waiting' || at === linked.length - 1);
      const standing = task.state !== 'todo' ? '' : waits.length
        ? ` · waits for ${waits.map((other) => (other.state === 'dropped' ? `${other.id} (dropped: take it out of after)` : other.id)).join(', ')}`
        : ' · ready';
      lines.push(`- [${task.state}] ${task.id}: ${task.title}${task.result ? ` — ${task.result}` : ''}${standing}${shown.map((job) => ` · ${job.id} ${job.state}${checkText(job)}`).join('')}`);
    }
    if (ready.length > 1) lines.push(`${ready.join(', ')} wait for nothing: those that touch different files can go at the same time.`);
  }
  const watched = pulls.filter((pull) => pull.mission === mission.id);
  if (watched.length) {
    lines.push('Pull requests:');
    for (const pull of watched) {
      const standing = pull.state !== 'open' ? '' : [
        ` · checks ${pull.checks}${pull.checks === 'failing' && pull.told.checks.length ? ` (${pull.told.checks.slice(0, 4).join(', ')}${pull.told.checks.length > 4 ? ', …' : ''})` : ''}`,
        pull.review ? ` · ${pull.review.replace(/_/g, ' ')}` : '',
        pull.conflict ? ' · conflicts with its base' : '',
        pull.held ? ' · check failures held back after three failing heads; pass pr again to hear of them' : '',
      ].join('');
      const checked = pull.ended ? 'no longer watched' : pull.error ? `could not be read: ${pull.error}` : `checked ${ago(now - pull.checkedAt)}`;
      lines.push(`- ${pull.id} ${pull.repo}#${pull.number} ${pull.state}${standing} · ${checked}`);
    }
  }
  return lines.join('\n');
}

/** A mission's id, where it stands and its plan, as every reply about it begins. */
export function missionHead(mission: Mission): string {
  const stages = mission.stages ?? STAGES;
  const index = mission.stageIndex ?? stages.indexOf(mission.stage);
  const state = mission.state === 'active' ? `${mission.stage} (step ${index + 1} of ${stages.length})` : mission.state;
  return `Mission ${mission.id} · ${state} — ${mission.title}\nPlan: ${planText(mission, (at) => (at === index && mission.state === 'active' ? ' (current)' : ''))}`;
}

/** Said wherever a session has more than one mission open, since no call can then be matched to a mission by guessing. */
export const NAME_THE_MISSION = 'With more than one open, name the mission each call is for: id with mission, mission with delegate, review, polish, debate and route.';

/** A resumed session is shown this much of its missions at most; the rest is read with `mission`. */
const RESUME_BYTES = 6000;

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
  private pinned: (id: string) => boolean;

  /** `pinned`: an ended mission that must be kept whatever its age, as one with a pull request still watched is. */
  constructor(home: string, onChange: (mission: Mission) => void, pinned: (id: string) => boolean = () => false) {
    this.home = home;
    this.onChange = onChange;
    this.pinned = pinned;
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

  start(input: { title: string; project: string; root: string; owner?: string; stage?: string; stages?: unknown; preset?: unknown; tasks?: unknown }): Mission {
    const title = titleOf(input.title);
    const preset = presetOf(input.preset);
    const steps = planOf(input.stages);
    const tasks = input.tasks === undefined ? undefined : mergeTasks(undefined, input.tasks);
    // Two calls that open the same command at once (a retry, a batch) share one card. Only a session that names
    // itself can be told apart from another one using the same title.
    const project = canonicalPath(input.project);
    const open = input.owner && this.list().find((mission) => mission.state === 'active' && mission.owner === input.owner && mission.project === project && mission.title === title);
    if (open) return open;
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
      project,
      root: canonicalPath(input.root),
      ...(input.owner ? { owner: input.owner } : {}),
      stage: first.stage,
      ...(preset ? { preset } : {}),
      ...(tasks?.length ? { tasks } : {}),
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

  update(id: string, input: { stage?: string; stages?: unknown; title?: string; preset?: unknown; tasks?: unknown }): Mission {
    const mission = this.get(id);
    if (mission.state !== 'active') throw new Error(`Mission ${id} is already ${mission.state}.`);
    const title = input.title === undefined ? mission.title : titleOf(input.title);
    const preset = presetOf(input.preset);
    const tasks = input.tasks === undefined ? undefined : mergeTasks(mission.tasks, input.tasks);
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
    if (tasks?.length) mission.tasks = tasks;
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
    // The one that ended last: with several open at once, a short one opened later may have ended first.
    const latest = mine.toSorted((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
    if (latest?.state !== 'done' || !latest.doneByLead || now - (latest.endedAt ?? 0) >= STALE_MS) return '';
    return `Crew: your mission "${latest.title}" is done. Only if this message clearly asks for new work (changing files, or starting a job), call \`mission\` with a title and stages before you start it, even work you will do yourself: "${followUpTitle(latest.title)}" for more of the same command, or a title of its own for a new one. A question, an explanation, or a reply opens none, even about that mission.`;
  }

  /**
   * What a lead session is shown when it starts, resumes or is compacted: the missions it has open with their
   * plans, tasks and pull requests, so the work goes on from the record rather than from what the context kept.
   */
  resumeText(owner: string, jobs: TaskJob[], pulls: PullWatch[], now = Date.now()): string {
    const mine = this.list().filter((mission) => mission.owner === owner);
    const open = mine.filter((mission) => mission.state === 'active').reverse();
    // A finished mission's pull request is still this session's to hear about.
    const later = pulls.filter((pull) => !pull.ended && mine.some((mission) => mission.id === pull.mission && mission.state === 'done'));
    if (!open.length && !later.length) return '';
    const parts = open.map((mission) => [missionHead(mission), missionDetail(mission, jobs, pulls, now)].filter(Boolean).join('\n'));
    if (open.length) parts.unshift(`Crew: this session has ${open.length === 1 ? 'a mission' : `${open.length} missions`} open, as recorded. Carry on from this rather than from memory, and report with mission as before.${open.length > 1 ? ` ${NAME_THE_MISSION}` : ''}`);
    if (later.length) parts.push(`Crew still watches ${later.map((pull) => `${pull.repo}#${pull.number} (${pull.id}, mission ${pull.mission}, done)`).join(', ')}: news of a failed check, a review or a conflict comes here.`);
    const text = parts.join('\n\n');
    return text.length > RESUME_BYTES ? `${clip(text, RESUME_BYTES)}\n… (cut; call mission with an id for the rest)` : text;
  }

  touch(id: string): void {
    const mission = this.missions.get(id);
    if (!mission || mission.state !== 'active') return;
    mission.updatedAt = Date.now();
    this.changed();
  }

  /** `isHeld`: the mission has a pull request still being watched, which, like an open task, is something it waits for. */
  sweep(now: number, isBusy: (id: string) => boolean, isHeld: (id: string) => boolean = () => false): Mission[] {
    const abandoned: Mission[] = [];
    for (const mission of this.missions.values()) {
      if (mission.state !== 'active' || now - mission.updatedAt < STALE_MS || isBusy(mission.id)) continue;
      const held = openTasks(mission).length > 0 || isHeld(mission.id);
      if (held && now - mission.updatedAt < STALE_HELD_MS) continue;
      abandoned.push(this.finish(mission.id, { abandoned: true, outcome: `No update for ${(held ? STALE_HELD_MS : STALE_MS) / 3_600_000} hours.` }));
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
      return index < KEEP_MISSIONS || seen < KEEP_PER_PROJECT || this.pinned(mission.id);
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
