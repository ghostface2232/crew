import type { Job, CrewEvent } from '../../bridge/jobs.ts';
import type { ClaudeSession } from '../../bridge/claude.ts';
import type { Mission } from '../../bridge/missions.ts';
import type { Config, Preset, PresetName, RoleInfo, RoleSettings, Worker, WorkerAgent } from '../../bridge/config.ts';
import type { ModelChoice } from '../../bridge/tiers.ts';
import type { Usage } from '../../bridge/usage.ts';
import type { ModelScore } from '../../bridge/notes.ts';

export type BoardJob = Omit<Job, 'prompt' | 'instructions'> & Partial<Pick<Job, 'prompt' | 'instructions'>>;
export type { CrewEvent, ClaudeSession, Mission, WorkerAgent, Usage, Preset, PresetName, ModelScore };
export type Roles = Config['roles'];
/** An older daemon sends no models; the settings then take a typed model and effort. */
export type Agents = Record<WorkerAgent, Worker & { enabled: boolean; models?: ModelChoice[] }>;
export interface BoardState {
  now: number;
  jobs: BoardJob[];
  missions: Mission[];
  claude: ClaudeSession[];
  agents: Agents;
  roles: Roles;
  /** The roles as the user wrote them, and what each role is; absent from a daemon that predates the role registry. */
  roleSettings?: RoleSettings;
  roleInfo?: RoleInfo[];
  limits: { codex?: { windows?: { usedPercent: number; minutes: number }[] } | null };
  events: CrewEvent[];
  /** Absent from a daemon that predates AgentGauge support. */
  usage?: Usage;
  /** The preset in effect, or null when none is set. */
  preset?: PresetName | null;
  presets?: Record<PresetName, Preset>;
  /** Each model's score from its review notes; absent from a daemon that predates model notes. */
  modelScores?: ModelScore[];
}
export type Connection = 'connecting' | 'live' | 'lost' | 'unauthorized';
export interface Snapshot extends BoardState {
  connection: Connection;
  revision: number;
  clockSkew: number;
}
