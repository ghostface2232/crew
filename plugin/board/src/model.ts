import type { AgentSettings, Holder, Role, RoleAssignment, RoleInfo, RoleSettings, WorkerAgent } from '../../bridge/config.ts';
import type { BoardJob, BoardPull, BoardState, ClaudeSession, Mission } from './types.ts';
import { t, translated } from './i18n.ts';

export const NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
/** Every holder, in the order a role lists them, as config.ts HOLDERS does. */
export const HOLDERS: Holder[] = ['codex', 'antigravity', 'claude'];
export const holdersOf = (assignment?: Pick<RoleAssignment, 'agents'>): Holder[] => assignment?.agents ?? [];
export const sortHolders = (agents: Holder[]) => HOLDERS.filter((holder) => agents.includes(holder));
/** A role's worker holders in the order it prefers them when no holder is named, as config.ts preferenceOf has it. */
export const preferredWorkers = (info: Pick<RoleInfo, 'kind'> | undefined, agents: Holder[]): WorkerAgent[] =>
  (info?.kind === 'polish' ? ['antigravity', 'codex'] as const : ['codex', 'antigravity'] as const).filter((agent) => agents.includes(agent));
/** An agent's settings without blank fields, or nothing when none is left: a blank field is one never set. */
export function agentSettings(settings?: AgentSettings): AgentSettings | undefined {
  const kept = Object.fromEntries(Object.entries(settings ?? {}).filter(([, value]) => value !== undefined && value !== ''));
  return Object.keys(kept).length ? kept : undefined;
}
/** The roles a daemon that predates the role registry knows; it sends no roleInfo. */
const LEGACY_ROLES = translated((): RoleInfo[] => [
  { role: 'delegate', kind: 'delegate', label: t('Implementation'), summary: t('Builds separable pieces of a change.') },
  { role: 'review', kind: 'review', label: t('Read-only review'), summary: t('Reviews a change by reading it and running checks.') },
  { role: 'polish', kind: 'polish', label: t('Wording polish'), summary: t('Improves UI strings, comments, and docs.') },
]);
export const rolesOf = (state: Pick<BoardState, 'roleInfo'>): RoleInfo[] => (state.roleInfo?.length ? state.roleInfo : LEGACY_ROLES());
/** Names for the roles an older daemon's jobs can have without listing them as roles to assign. */
const LEGACY_LABELS = translated((): Record<string, string> => ({ debate: t('Debate'), verify: t('Review that runs the app') }));
/** The daemon names roles in English; known names read in the viewer's language. */
export const roleLabel = (state: Pick<BoardState, 'roleInfo'>, role: string) => {
  const label = rolesOf(state).find((info) => info.role === role)?.label;
  return label ? t(label) : LEGACY_LABELS()[role] ?? role;
};
/** A job's role; jobs saved before roles were recorded get theirs from what they were, as the daemon does. */
export const jobRole = (job: Pick<BoardJob, 'role' | 'kind' | 'debate' | 'runsApp'>): Role =>
  job.role ?? (job.debate ? 'debate' : job.kind === 'review' && job.runsApp ? 'verify' : job.kind);
/**
 * What each role resolves to under a draft of the settings, so the form shows what an inherited role will
 * get before it is saved. The daemon applies the same rule (resolveRoles in config.ts).
 */
export function resolveDraft(info: RoleInfo[], draft: RoleSettings, saved: BoardState['roles']): Partial<Record<Role, RoleAssignment>> {
  const resolved: Partial<Record<Role, RoleAssignment>> = {};
  for (const { role, parent } of info) {
    const own = draft[role] ?? {};
    const base = own.agents?.length ? { agents: sortHolders(own.agents) } : parent ? resolved[parent] : saved[role] && { agents: saved[role].agents };
    if (!base) continue;
    const merged: RoleAssignment = { agents: base.agents };
    for (const agent of base.agents.filter((holder): holder is WorkerAgent => holder !== 'claude')) {
      const settings = agentSettings({ ...base[agent], ...agentSettings(own[agent]) });
      if (settings) merged[agent] = settings;
    }
    resolved[role] = merged;
  }
  return resolved;
}
export const STOPS = translated(() => [t('Plan'), t('Build'), t('Review'), t('Fix'), t('Polish'), t('Final')]);
export const STOP_OF_STAGE = {
  plan: 0,
  implement: 1,
  'self-review': 2,
  'cross-review': 2,
  fix: 3,
  polish: 4,
  final: 5,
};
export const STOP_OF_KIND = { delegate: 1, review: 2, polish: 4 };
export function missionStops(mission?: Mission) {
  const rounds = new Map<number, number>();
  return mission?.stages
    ? mission.stages.map((stage, index) => {
      const stop = STOP_OF_STAGE[stage];
      // A stop the lead named goes by that name and takes no number: the numbers tell apart stops that share one.
      const label = mission.labels?.[index];
      if (label) return { name: label, stop };
      const round = (rounds.get(stop) ?? 0) + 1;
      rounds.set(stop, round);
      return { name: `${STOPS()[stop]}${round > 1 ? ` ${round}` : ''}`, stop };
    })
    : STOPS().map((name, stop) => ({ name, stop }));
}
export function missionStep(mission?: Mission) {
  if (!mission) return -1;
  return mission.stages ? mission.stageIndex ?? Math.max(0, mission.stages.indexOf(mission.stage)) : STOP_OF_STAGE[mission.stage];
}
export function missionStopPosition(mission: Mission | undefined, index: number) {
  const at = missionStep(mission);
  return mission?.state === 'done' || index < at ? 'past' : index === at && mission?.state === 'active' ? 'now' : 'todo';
}
export function missionJobStep(mission: Mission | undefined, job: Pick<BoardJob, 'kind' | 'missionStep'>, stops = missionStops(mission)) {
  const recorded = job.missionStep;
  if (mission?.stages && recorded !== undefined && Number.isInteger(recorded) && recorded >= 0 && recorded < stops.length)
    return recorded;
  const at = missionStep(mission);
  const stop = STOP_OF_KIND[job.kind];
  // Jobs without a recorded occurrence use current matching stop, first match, then current.
  if (stops[at]?.stop === stop) return at;
  const match = stops.findIndex((step) => step.stop === stop);
  return match < 0 ? Math.max(0, at) : match;
}
export function leadMission(session: Pick<ClaudeSession, 'id' | 'mission'>, missions: Mission[]) {
  let newest: Mission | undefined;
  for (const mission of missions) {
    if (mission.state !== 'active' || mission.owner !== session.id) continue;
    if (mission.id === session.mission) return mission;
    if (!newest || mission.createdAt > newest.createdAt) newest = mission;
  }
  return newest;
}
/** A lead working alone touches neither the mission nor any job, so its own session must be quiet too. */
export function missionLooksFinished(mission: Mission, jobs: BoardJob[], now: number, lead?: ClaudeSession) {
  return mission.state === 'active' && now - mission.updatedAt >= 20 * 60_000
    && (!lead || lead.state === 'idle' || lead.state === 'error')
    && !mission.tasks?.some((task) => task.state === 'todo' || task.state === 'doing')
    && !jobs.some((job) => job.mission === mission.id && (job.state === 'running' || job.state === 'waiting'));
}
/** A pull request's status as a card shows it: a word and the state color it takes (as a chip's data-state). */
export interface PullStatus { word: string; tone: 'failed' | 'waiting' | 'running' | 'done' | 'merged' | ''; needsLead?: true }
/**
 * Most urgent first: what the lead must fix before what it must weigh, and a conflict first of all, since resolving it
 * moves the head and reruns the checks. Waiting and good news follow.
 */
export function pullStatuses(pull: BoardPull): PullStatus[] {
  if (pull.state === 'merged') return [{ word: t('Merged'), tone: 'merged' }];
  if (pull.state === 'closed') return [{ word: t('Closed'), tone: '' }];
  const statuses: (PullStatus | false)[] = [
    pull.conflict && { word: t('Conflict'), tone: 'failed', needsLead: true },
    pull.checks === 'failing' && { word: t('Checks failing'), tone: 'failed', needsLead: true },
    pull.review === 'changes_requested' && { word: t('Changes requested'), tone: 'waiting', needsLead: true },
    pull.checks === 'pending' && { word: t('Checks running'), tone: 'running' },
    pull.review === 'approved' && { word: t('Approved'), tone: 'done' },
    pull.checks === 'passing' && { word: t('Checks passed'), tone: 'done' },
  ];
  return statuses.filter((status): status is PullStatus => Boolean(status));
}
export const pullIsStale = (pull: BoardPull, now: number) =>
  pull.state === 'open' && (pull.ended != null || pull.error != null || now - pull.checkedAt > 15 * 60_000);
type EvidenceItem = NonNullable<BoardJob['evidence']>[number];
/** At most this many captures at once: three in a row, or four in a grid of two by two. */
export const MAX_COMPARED = 4;
/** The view a capture shows and which side of a change, from a name such as `hero-before.png` or `after_hero.png`. */
export function evidenceSide(file: string): { view: string; side: 'before' | 'after' } | null {
  const match = /^(?:(before|after)[-_. ]+(.+)|(.+)[-_. ]+(before|after))$/i.exec(file.replace(/\.[^.]+$/, ''));
  // The separators around the view are not part of it, as in the app: `hero--after` pairs with `hero-before`.
  const view = (match?.[2] ?? match?.[3] ?? '').replace(/^[-_. ]+|[-_. ]+$/g, '').toLowerCase();
  if (!match || !view) return null;
  return { view, side: (match[1] ?? match[4]).toLowerCase() as 'before' | 'after' };
}
/** Left to right: what the lead attached, then the worker's by turn, with a before ahead of its after. */
export function orderEvidence<T extends Pick<EvidenceItem, 'file' | 'turn' | 'from'>>(items: T[]): T[] {
  const rank = (item: T) => (evidenceSide(item.file)?.side === 'after' ? 1 : 0);
  return items.toSorted((a, b) => Number(a.from !== 'lead') - Number(b.from !== 'lead') || a.turn - b.turn || rank(a) - rank(b) || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}
/** Which turn a capture is from, against how many the job has had: one from an earlier turn may not show the final state. */
export function evidenceTurn(item: Pick<EvidenceItem, 'turn' | 'from'>, turns: number) {
  if (item.from === 'lead') return t('Attached by the lead');
  return turns > 1 ? t('Turn {turn} of {turns}', { turn: item.turn, turns }) : t('Turn {turn}', { turn: item.turn });
}
export function usageWindowName(kind: string) {
  return (
    ({ fiveHour: t('5-hour'), weekly: t('Weekly'), billingCycle: t('Billing cycle') } as Record<string, string>)[kind] ??
    kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
  );
}
export function relativeDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return t('{n}m', { n: minutes });
  if (minutes < 1440) return t('{n}h', { n: Math.round(minutes / 60) });
  return t('{n}d', { n: Math.round(minutes / 1440) });
}
export const projectOf = (item: { root?: string; project?: string; cwd?: string }) =>
  item.root ?? item.project ?? item.cwd ?? '';
export const knownProjects = (state: Pick<BoardState, 'jobs' | 'claude' | 'missions'>) =>
  [...new Set([...state.jobs, ...state.claude, ...state.missions].map(projectOf).filter(Boolean))].sort();
/**
 * The folder name; when another project shares it, as many parent folders as tell them apart.
 * Paths may be POSIX or Windows, since the daemon reports them as its own platform writes them. Names that differ
 * only in case read as the same name, so they are told apart too.
 */
export function projectNames(dirs: string[]) {
  const parts = (dir: string) => dir.split(/[\\/]/).filter(Boolean);
  const tail = (dir: string, count: number, separator = '/') => parts(dir).slice(-count).join(separator);
  return new Map(
    dirs.map((dir) => {
      const total = parts(dir).length;
      for (let count = 1; count <= total; count++) {
        const key = tail(dir, count).toLowerCase();
        if (!dirs.some((other) => other !== dir && tail(other, count).toLowerCase() === key)) {
          return [dir, tail(dir, count, dir.includes('\\') ? '\\' : '/')];
        }
      }
      return [dir, dir];
    }),
  );
}
/** The app's elapsed label: under a minute reads <1m. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return t('<1m');
  if (seconds < 3600) return t('{n}m', { n: Math.floor(seconds / 60) });
  return t('{h}h {m}m', { h: Math.floor(seconds / 3600), m: Math.floor((seconds % 3600) / 60) });
}
/** Ended, but its worktree still awaits a merge or discard, or the lead has not read its result. */
export function unsettled(job: BoardJob): boolean {
  return Boolean(job.worktree) || job.seq > job.delivered;
}
export function jobLabel(job: BoardJob) {
  if (job.state === 'waiting') return job.waiting?.type === 'approval' ? t('Needs approval') : t('Has a question');
  if (job.stalled) return t('May be stuck');
  if (job.error?.limit) return t('Usage limit reached');
  return { running: t('Working'), done: t('Done'), failed: t('Failed'), cancelled: t('Cancelled') }[job.state];
}

const HOUR = 3_600_000;
/** Counts per hour over the last `hours`, oldest first; the last bucket ends now. */
export function hourly(now: number, hours: number, count: (start: number, end: number) => number) {
  return Array.from({ length: hours }, (_, index) => {
    const end = now - (hours - 1 - index) * HOUR;
    return count(end - HOUR, end);
  });
}
/** How many jobs were running at some point in each hour. */
export const runningPerHour = (jobs: BoardJob[], now: number, hours = 24) =>
  hourly(now, hours, (start, end) => jobs.filter((job) => job.createdAt < end && (job.endedAt ?? now) >= start).length);
/** How many jobs ended in a state in each hour. */
export const endedPerHour = (jobs: BoardJob[], state: BoardJob['state'], now: number, hours = 24) =>
  hourly(now, hours, (start, end) => jobs.filter((job) => job.state === state && job.endedAt != null && job.endedAt >= start && job.endedAt < end).length);
const startOfDay = (time: number) => new Date(time).setHours(0, 0, 0, 0);
/**
 * Items started on each day, in whole weeks from Monday so a heatmap's columns are weeks; days after today
 * are left out. Each day is its local midnight.
 */
export function dailyCounts(times: number[], now: number, weeks: number) {
  const today = startOfDay(now);
  const monday = new Date(today);
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - (weeks - 1) * 7);
  const counts = new Map<number, number>();
  for (const time of times) counts.set(startOfDay(time), (counts.get(startOfDay(time)) ?? 0) + 1);
  const days: { day: number; count: number }[] = [];
  // Each step lands on its own local midnight, even past a day whose midnight a clock change skipped.
  for (let index = 0; ; index++) {
    const day = startOfDay(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index).getTime());
    if (day > today) break;
    days.push({ day, count: counts.get(day) ?? 0 });
  }
  return days;
}

/** What a session's sub-agents add to its row, as the app says it: "2 sub-agents · review 12 running". */
export function agentSummary(session: Pick<ClaudeSession, 'agents' | 'workflows'>) {
  const agents = session.agents ?? [];
  const plain = agents.filter((agent) => !agent.workflow);
  const running = agents.length - plain.length;
  const active = (session.workflows ?? []).filter((run) => agents.some((agent) => agent.workflow === run.id));
  return [
    plain.length > 0 ? (plain.length === 1 ? t('1 sub-agent') : t('{count} sub-agents', { count: plain.length })) : '',
    active.length > 0
      ? t('{workflow} {running} running', { workflow: active.length === 1 ? active[0].name : t('{count} workflows', { count: active.length }), running })
      : '',
  ].filter(Boolean).join(' · ');
}
