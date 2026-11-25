import type { Job, CrewEvent } from '../../bridge/jobs.ts';
import type { ClaudeSession } from '../../bridge/claude.ts';
import type { Mission } from '../../bridge/missions.ts';
import type { Config, Preset, PresetName, ProjectSettings, RoleInfo, RoleSettings, Worker, WorkerAgent } from '../../bridge/config.ts';
import type { ModelChoice } from '../../bridge/tiers.ts';
import type { Usage } from '../../bridge/usage.ts';
import type { ModelScore } from '../../bridge/notes.ts';
import type { PullWatch } from '../../bridge/pulls.ts';

/** `outcomeContradiction` is what the daemon observed against a declared "done"; an older daemon sends none. */
export type BoardJob = Omit<Job, 'prompt' | 'instructions' | 'evidence'> & Partial<Pick<Job, 'prompt' | 'instructions'>> & {
  outcomeContradiction?: string;
  /** Each file with the seal its address needs; see evidenceSeal in the bridge. */
  evidence?: (NonNullable<Job['evidence']>[number] & { sig?: string })[];
};
export type { CrewEvent, ClaudeSession, Mission, WorkerAgent, Usage, Preset, PresetName, ModelScore, ProjectSettings };
export type Roles = Config['roles'];
/** An older daemon sends no models; the settings then take a typed model and effort. */
export type Agents = Record<WorkerAgent, Worker & { enabled: boolean; models?: ModelChoice[] }>;
export type BoardPull = Omit<PullWatch, 'news' | 'newsSeq' | 'reviews'>;
export interface BoardState {
  now: number;
  jobs: BoardJob[];
  missions: Mission[];
  pulls?: BoardPull[];
  claude: ClaudeSession[];
  agents: Agents;
  roles: Roles;
  /** The roles as the user wrote them, and what each role is; absent from a daemon that predates the role registry. */
  roleSettings?: RoleSettings;
  roleInfo?: RoleInfo[];
  /** A window's `minutes` is null when Codex does not say how long it is. */
  limits: { codex?: { windows?: { usedPercent: number; minutes: number | null }[] } | null };
  events: CrewEvent[];
  /** Absent from a daemon that predates AgentGauge support. */
  usage?: Usage;
  /** The preset in effect, or null when none is set. */
  preset?: PresetName | null;
  presets?: Record<PresetName, Preset>;
  /** Whether the lead and the workers rate each other's work; absent from a daemon that predates peer ratings. */
  peerRatings?: boolean;
  /** The interface language, or null to follow the browser; absent from a daemon that predates the setting. */
  language?: Config['language'];
  /** Each model's score from its review notes; absent from a daemon that predates model notes. */
  modelScores?: ModelScore[];
  /** Each project's switches by its canonical path; absent from a daemon that predates them. */
  projects?: Record<string, ProjectSettings>;
}
/** GET /api/issues: open issues of a project's repository that are the user's to start, mine first. */
export interface IssueList {
  project: string;
  repo: string | null;
  issues: { number: number; title: string; url: string; assignees: string[]; labels: string[]; updatedAt: string }[];
  checkedAt: number | null;
  error?: string;
}
export type Connection = 'connecting' | 'live' | 'lost' | 'unauthorized';
export interface Snapshot extends BoardState {
  connection: Connection;
  revision: number;
  clockSkew: number;
}

/** Where the desktop app's updater stands, as its window sees it. */
export interface AppUpdate {
  /** The running app's version. */
  current: string;
  /**
   * `unsupported` outside an installed copy. `idle` is up to date or not yet checked; `available` waits for the user to
   * be away before downloading; `ready` holds a verified installer that runs when the user chooses.
   */
  state: 'unsupported' | 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing';
  /** The release on offer, from `available` on. */
  latest?: string;
  /** Its release page. */
  page?: string;
  /** Download progress from 0 to 1. */
  progress?: number;
  /** When the last check finished, in epoch milliseconds. */
  checkedAt?: number;
  /** Why the last check, download or install failed. */
  error?: string;
  /** Why the install Crew restarted for did not go through, until the user has seen it in Settings. */
  installError?: string;
  /**
   * While installing: the running jobs the install waits for, 0 while it waits on a daemon that has not answered.
   * The install can be called off while this is set; it is absent once the daemon is being stopped.
   */
  waiting?: number;
}
/** What the desktop app's preload script gives the board; absent in a browser. */
export interface DesktopBridge {
  update: {
    state(): Promise<AppUpdate>;
    /** Checks now and, when a release is on offer, downloads it at once. */
    check(): Promise<void>;
    install(): Promise<void>;
    /** Stops an install that is still waiting for jobs. */
    cancel(): Promise<void>;
    /** Clears `installError` once Settings has shown it. Absent in an app older than this board. */
    seen?(): Promise<void>;
    subscribe(listener: (update: AppUpdate) => void): () => void;
  };
  /** The first-run guide, owed only on a first install. Absent in an app older than this board. */
  welcome?: {
    pending(): Promise<boolean>;
    done(): Promise<void>;
  };
}

/** What Crew needs and whether each is in place (`GET /api/setup`). The plugins, `crew` command and Codex hooks can be installed here, and Crew's Codex hooks trusted. */
export interface SetupState {
  items: { id: string; label: string; ok: boolean; detail: string; summary?: string; repairable?: boolean; trustable?: boolean }[];
  /** A desktop app's built copy, which registers its own plugin. */
  packaged: boolean;
  registering: boolean;
  registration?: { ok: boolean; detail: string };
}
