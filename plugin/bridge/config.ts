import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PLUGIN_ROOT = path.resolve(import.meta.dirname, '..');

export const VERSION: string = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8'),
).version;

/**
 * Version and code fingerprint of the bridge as it is on disk now, which is
 * what a newly spawned daemon would run. A local-path install runs from the
 * source folder, so code can change without the version changing.
 * Roles and board files are read from disk on use and need no fingerprint.
 */
export function installed(): { version: string; build: string } {
  const version: string = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const dir = path.join(PLUGIN_ROOT, 'bridge');
  const hash = createHash('sha256');
  const files = (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.(ts|js)$/.test(f)).sort();
  for (const file of files) hash.update(file).update('\0').update(fs.readFileSync(path.join(dir, file))).update('\0');
  return { version, build: hash.digest('hex').slice(0, 12) };
}

export const HOME = process.env.CREW_HOME ?? path.join(os.homedir(), '.crew');
export const PORT = Number(process.env.CREW_PORT ?? 47615);
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export type WorkerAgent = 'codex' | 'antigravity';
/** A role is the kind of job a worker is given; the lead's tools are named after them. */
export type Role = 'delegate' | 'review' | 'polish';

export interface Worker {
  name: string;
  idPrefix: string;
  /** CLI prefix that reopens a session by id. */
  resume: string;
  /** As a reviewer it may run read-only commands, so it can read the diff with git itself. */
  reviewerRunsGit: boolean;
}

export const WORKERS: Record<WorkerAgent, Worker> = {
  codex: { name: 'Codex', idPrefix: 'cx', resume: 'codex resume', reviewerRunsGit: true },
  antigravity: { name: 'Antigravity', idPrefix: 'ag', resume: 'agy --conversation', reviewerRunsGit: false },
};

export interface RoleAssignment {
  agent: WorkerAgent;
  /** Override the agent's own model and effort settings for this role. */
  model?: string;
  effort?: string;
}

export interface Config {
  /** Seconds of silence from a running worker before it is flagged as possibly stalled. */
  stallSeconds: number;
  /** macOS notifications for waiting, error, limit, and stall events. */
  notify: boolean;
  /** Also notify when a job finishes normally. */
  notifyOnDone: boolean;
  codex: {
    bin: string;
    /** Approval policy for delegated implementation work. Static reviews always run with "never". */
    approvalPolicy: 'never' | 'on-request' | 'untrusted';
    /**
     * Who answers Codex's approval requests. "auto_review" (default) is Codex's own automatic reviewer,
     * so the user is asked only about what it refuses twice; "user" brings every request to the lead session.
     */
    approvalsReviewer: 'user' | 'auto_review' | 'guardian_subagent';
    model?: string;
    effort?: string;
  };
  antigravity: {
    bin: string;
    enabled: boolean;
    /** Value for the ACP "model" config option, e.g. "gemini-3.8-flash". */
    model?: string;
  };
  /** Which worker takes each role. Read when a job starts, so edits apply to the next job. */
  roles: Record<Role, RoleAssignment>;
}

const defaults: Config = {
  stallSeconds: 300,
  notify: true,
  notifyOnDone: false,
  codex: { bin: 'codex', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' },
  antigravity: { bin: 'agy', enabled: true },
  roles: { delegate: { agent: 'codex' }, review: { agent: 'codex' }, polish: { agent: 'antigravity' } },
};

export const DEFAULT_ROLES = defaults.roles;

type UserConfig = Partial<Omit<Config, 'roles'>> & { roles?: Partial<Record<Role, Partial<RoleAssignment>>> };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Fills a user's partial config with defaults. A role table that is not exactly what it should be
 * throws: quietly keeping a default would run a job on an agent the user did not choose.
 */
export function resolveConfig(user: UserConfig): Config {
  const roles = { ...defaults.roles };
  const given: unknown = user.roles ?? {};
  if (!isObject(given)) throw new Error('roles must be an object such as {"polish": {"agent": "codex"}}.');
  for (const [role, entry] of Object.entries(given)) {
    if (!Object.hasOwn(roles, role)) throw new Error(`roles.${role} is not a role; use one of: ${Object.keys(roles).join(', ')}.`);
    if (!isObject(entry)) throw new Error(`roles.${role} must be an object such as {"agent": "codex"}.`);
    for (const [key, value] of Object.entries(entry)) {
      if (!['agent', 'model', 'effort'].includes(key)) throw new Error(`roles.${role}.${key} is not a setting; use agent, model, or effort.`);
      if (typeof value !== 'string') throw new Error(`roles.${role}.${key} must be a string.`);
    }
    const merged = { ...roles[role as Role], ...entry } as RoleAssignment;
    if (!Object.hasOwn(WORKERS, merged.agent)) {
      throw new Error(`roles.${role}.agent is "${merged.agent}"; use one of: ${Object.keys(WORKERS).join(', ')}.`);
    }
    roles[role as Role] = merged;
  }
  return {
    ...defaults,
    ...user,
    codex: { ...defaults.codex, ...user.codex },
    antigravity: { ...defaults.antigravity, ...user.antigravity },
    roles,
  };
}

export function loadConfig(): Config {
  let user: UserConfig = {};
  try {
    user = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Invalid ${HOME}/config.json: ${(err as Error).message}`);
  }
  try {
    return resolveConfig(user);
  } catch (err) {
    throw new Error(`Invalid ${HOME}/config.json: ${(err as Error).message}`);
  }
}

/**
 * GUI-launched processes (Claude Desktop) get a minimal PATH, so the agent
 * CLIs installed under the user's home would not resolve without these.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const home = os.homedir();
  const extra = [path.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.dirname(process.execPath)];
  const current = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const merged = [...current, ...extra.filter((p) => !current.includes(p))];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: merged.join(path.delimiter) };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}
