import type { Job, CrewEvent } from '../../bridge/jobs.ts';
import type { ClaudeSession } from '../../bridge/claude.ts';
import type { Mission } from '../../bridge/missions.ts';
import type { Config, Worker, WorkerAgent } from '../../bridge/config.ts';

export type BoardJob = Omit<Job, 'prompt' | 'instructions'> & Partial<Pick<Job, 'prompt' | 'instructions'>>;
export type { CrewEvent, ClaudeSession, Mission, WorkerAgent };
export type Roles = Config['roles'];
export type Agents = Record<WorkerAgent, Worker & { enabled: boolean }>;
export interface BoardState {
  now: number;
  jobs: BoardJob[];
  missions: Mission[];
  claude: ClaudeSession[];
  agents: Agents;
  roles: Roles;
  limits: { codex?: { windows?: { usedPercent: number; minutes: number }[] } | null };
  events: CrewEvent[];
}
export type Connection = 'connecting' | 'live' | 'lost';
export interface Snapshot extends BoardState {
  connection: Connection;
  revision: number;
  clockSkew: number;
}
