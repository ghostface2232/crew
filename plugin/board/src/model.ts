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
export function missionProgress(mission: Mission, jobs: BoardJob[]) {
  if (mission.state === 'done') return 1;
  const unfinished = jobs.filter((job) => job.mission === mission.id && job.endedAt == null);
  const share = unfinished.length
    ? unfinished.reduce((sum, job) => sum + (job.state === 'running' || job.state === 'waiting' ? 0.5 : 0), 0) /
      unfinished.length
    : 0.5;
  return Math.max(0, Math.min(1, (MISSION_STAGES.indexOf(mission.stage) + share) / MISSION_STAGES.length));
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
