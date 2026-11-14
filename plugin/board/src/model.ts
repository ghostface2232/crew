import type { BoardJob, BoardState, ClaudeSession, Mission } from './types.ts';

export const NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
export const ROLE_NAMES = { delegate: 'Implementation', review: 'Read-only review', polish: 'Wording polish' };
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
export const projectOf = (item: { root?: string; project?: string; cwd?: string }) =>
  item.root ?? item.project ?? item.cwd ?? '';
export const knownProjects = (state: BoardState) =>
  [...new Set([...state.jobs, ...state.claude, ...state.missions].map(projectOf).filter(Boolean))].sort();
/** The folder name, or the whole path when another project shares the name. */
export function projectNames(dirs: string[]) {
  const last = (dir: string) => dir.split('/').filter(Boolean).pop() ?? dir;
  return new Map(dirs.map((dir) => [dir, dirs.filter((other) => last(other) === last(dir)).length > 1 ? dir : last(dir)]));
}
/** The app's elapsed label: under a minute reads <1m. */
export function elapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return '<1m';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}
/** Ended, but its worktree still awaits a merge or discard, or the lead has not read its result. */
export function unsettled(job: BoardJob): boolean {
  return Boolean(job.worktree) || job.seq > job.delivered;
}
export function jobLabel(job: BoardJob) {
  if (job.state === 'waiting') return job.waiting?.type === 'approval' ? 'Needs approval' : 'Has a question';
  if (job.stalled) return 'May be stuck';
  if (job.state === 'failed') return job.error?.limit ? 'Usage limit reached' : 'Failed';
  return { running: 'Working', done: 'Done', cancelled: 'Cancelled' }[job.state];
}
