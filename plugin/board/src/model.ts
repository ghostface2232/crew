import type { BoardJob, BoardState, ClaudeSession, Mission } from './types.ts';

export type Mark = 'waiting' | 'failed' | 'stalled' | 'working' | 'done' | 'idle';
export const NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export const ROLE_NAMES = { delegate: 'Engineer', review: 'Cross-review', polish: 'UX writing · docs' };
export const STOPS = ['Plan', 'Build', 'Review', 'Fix', 'Polish', 'Final'];
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
const MISSION_STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'];
export function missionStops(mission?: Mission) {
  const rounds = new Map<number, number>();
  return mission?.stages
    ? mission.stages.map((stage) => {
      const stop = STOP_OF_STAGE[stage];
      const round = (rounds.get(stop) ?? 0) + 1;
      rounds.set(stop, round);
      return { name: `${STOPS[stop]}${round > 1 ? ` ${round}` : ''}`, stop };
    })
    : STOPS.map((name, stop) => ({ name, stop }));
}
export function missionStep(mission?: Mission) {
  if (!mission) return -1;
  return mission.stages ? mission.stageIndex ?? Math.max(0, mission.stages.indexOf(mission.stage)) : STOP_OF_STAGE[mission.stage];
}
export function missionStopPosition(mission: Mission | undefined, index: number) {
  const at = missionStep(mission);
  return mission?.state === 'done' || index < at ? 'past' : index === at && mission?.state === 'active' ? 'now' : 'todo';
}
export function missionJobStep(mission: Mission | undefined, job: Pick<BoardJob, 'kind' | 'missionStep'>) {
  const stops = missionStops(mission);
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
/** A lead working alone touches neither the mission nor any job, so its own session must be quiet too. */
export function missionLooksFinished(mission: Mission, jobs: BoardJob[], now: number, lead?: ClaudeSession) {
  return mission.state === 'active' && now - mission.updatedAt >= 20 * 60_000
    && (!lead || lead.state === 'idle' || lead.state === 'error')
    && !jobs.some((job) => job.mission === mission.id && (job.state === 'running' || job.state === 'waiting'));
}
export function missionProgress(mission: Mission, jobs: BoardJob[]) {
  if (mission.state === 'done') return 1;
  const unfinished = jobs.filter((job) => job.mission === mission.id && job.endedAt == null);
  const share = unfinished.length
    ? unfinished.reduce((sum, job) => sum + (job.state === 'running' || job.state === 'waiting' ? 0.5 : 0), 0) /
      unfinished.length
    : 0.5;
  const stages = mission.stages ?? MISSION_STAGES;
  // Zero-based plan position plus at most half a step of running work; only done reaches 100%.
  // Missions without a plan retain the original seven-stage progress formula.
  const index = mission.stages ? missionStep(mission) : Math.max(0, stages.indexOf(mission.stage));
  return Math.max(0, (index + share) / stages.length);
}
export function usageWindowName(kind: string) {
  return (
    ({ fiveHour: '5-hour', weekly: 'Weekly', billingCycle: 'Billing cycle' } as Record<string, string>)[kind] ??
    kind.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[-_]/g, ' ')
  );
}
export function relativeDuration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}
export const STOP_NOTES = [
  'Claude is working out what needs to be done and splitting it into pieces.',
  'The agents are writing the code, each in its own copy of the project.',
  'The work is being checked for mistakes, first by Claude and then by a second agent.',
  'Claude is fixing what the review found.',
  'Wording, comments, and docs are being tidied up.',
  'Everything is being tested one last time before it comes back to you.',
];
export const URGENCY: Mark[] = ['waiting', 'failed', 'stalled', 'working'];
export const projectOf = (item: { root?: string; project?: string; cwd?: string }) =>
  item.root ?? item.project ?? item.cwd ?? '';
export const knownProjects = (state: BoardState) =>
  [...new Set([...state.jobs, ...state.claude, ...state.missions].map(projectOf).filter(Boolean))].sort();
export function shortPath(dir: string) {
  const parts = dir.split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}
export function projectNames(dirs: string[]) {
  const last = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;
  return new Map(
    dirs.map((dir) => [dir, dirs.filter((other) => last(other) === last(dir)).length > 1 ? shortPath(dir) : last(dir)]),
  );
}
/** Ended, but its worktree still awaits a merge or discard, or the lead has not read its result. */
export function unsettled(job: BoardJob): boolean {
  return Boolean(job.worktree) || job.seq > job.delivered;
}
export function jobMark(job: BoardJob): Mark {
  if (job.state === 'waiting') return 'waiting';
  if (job.stalled) return 'stalled';
  return ({ running: 'working', done: 'done', failed: 'failed', cancelled: 'idle' } as const)[job.state];
}
export function jobLabel(job: BoardJob) {
  if (job.state === 'waiting') return job.waiting?.type === 'approval' ? 'Needs approval' : 'Has a question';
  if (job.stalled) return 'May be stuck';
  if (job.state === 'failed') return job.error?.limit ? 'Usage limit reached' : 'Failed';
  return { running: 'Working', done: 'Done', cancelled: 'Cancelled' }[job.state];
}
export const sessionMark = (session: ClaudeSession): Mark =>
  session.state === 'waiting'
    ? 'waiting'
    : session.stalled
      ? 'stalled'
      : session.state === 'error'
        ? 'failed'
        : session.state;
export function together(marks: Mark[]): Mark | '' {
  return (
    URGENCY.find((mark) => marks.includes(mark)) ??
    (marks.length && marks.every((mark) => mark === 'done' || mark === 'idle') ? 'done' : '')
  );
}
export function brief(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
export const compact = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
export function timeLabel(job: BoardJob, now: number) {
  if (job.state === 'waiting') return `waiting ${brief(now - (job.waiting?.since ?? now))}`;
  if (job.stalled) return `quiet for ${brief(now - job.activeAt)}`;
  if (job.state === 'running') return `${brief(now - job.createdAt)} so far`;
  return `${job.state === 'failed' ? 'stopped after ' : job.state === 'cancelled' ? 'cancelled after ' : ''}${brief((job.endedAt ?? now) - job.createdAt)}`;
}
/** Unfinished jobs remain reachable after their mission falls outside the recent history. */
export function cardsForProject(missions: Mission[], jobs: BoardJob[]) {
  const open = missions.filter((m) => m.state === 'active').sort((a, b) => b.createdAt - a.createdAt);
  const ended = missions
    .filter((m) => m.state !== 'active')
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 2);
  const shown = new Set([...open, ...ended].map((m) => m.id));
  const known = new Set(missions.map((m) => m.id));
  const loose = jobs.filter((job) => !known.has(job.mission ?? '') || (!job.endedAt && !shown.has(job.mission ?? '')));
  const recent = loose
    .filter((job) => job.endedAt)
    .sort((a, b) => b.endedAt! - a.endedAt!)
    .slice(0, 4);
  return {
    open,
    ended,
    loose: [...loose.filter((job) => !job.endedAt), ...recent].sort((a, b) => a.createdAt - b.createdAt),
  };
}
