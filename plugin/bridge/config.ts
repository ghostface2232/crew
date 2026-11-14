import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TIERS } from './tiers.ts';
import type { Tier } from './tiers.ts';

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
  // The packaged app runs compiled JavaScript, so it carries the fingerprint of the source it was built from;
  // the app and a plugin install of the same source then agree on whose daemon is current.
  const stamp = path.join(PLUGIN_ROOT, '.claude-plugin', 'build');
  if (fs.existsSync(stamp)) return { version, build: fs.readFileSync(stamp, 'utf8').trim() };
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
  /** Its sandbox can leave one directory writable while everything else is read-only. */
  readOnlyScratch: boolean;
}

export const WORKERS: Record<WorkerAgent, Worker> = {
  codex: { name: 'Codex', idPrefix: 'cx', resume: 'codex resume', reviewerRunsGit: true, readOnlyScratch: true },
  antigravity: { name: 'Antigravity', idPrefix: 'ag', resume: 'agy --conversation', reviewerRunsGit: false, readOnlyScratch: false },
};

/** Antigravity's commands are refused in every job but an engineer's (`decide` in adapters/antigravity.ts). */
export function runsCommands(agent: WorkerAgent, spec: { kind: Role; ask?: boolean }): boolean {
  return (spec.kind === 'delegate' && !spec.ask) || WORKERS[agent].reviewerRunsGit;
}

export interface RoleAssignment {
  agent: WorkerAgent;
  /** Override the agent's own model and effort settings for this role. */
  model?: string;
  effort?: string;
}

/** A debate longer than this has stopped converging; the lead should decide or start over. */
export const MAX_DEBATE_ROUNDS = 6;

export type PresetName = 'economy' | 'balanced' | 'best';

/** Model and effort a preset gives each agent, and the model the lead should give its subagents. */
export interface Preset {
  codex?: { model?: string; effort?: string };
  antigravity?: { model?: string };
  /** Passed by the lead as the model of the subagents it starts; "inherit" leaves them on the lead's model. */
  subagentModel?: string;
  /** The largest model the lead may give its subagents when a task needs more than subagentModel. */
  subagentMax?: string;
  /** The highest tier a worker job may run at; a higher tier is lowered to it. */
  maxTier?: Tier;
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
    /** Plugins enabled for every writable Codex delegate or app review; the in-app browser by default, for web research and docs. */
    plugins: string[];
    /** Additional plugins for `runs_app` jobs, including real-screen computer use by default. */
    appPlugins: string[];
  };
  antigravity: {
    bin: string;
    enabled: boolean;
    /** Value for the ACP "model" config option, e.g. "gemini-3.8-flash". */
    model?: string;
  };
  /** Which worker takes each role. Read when a job starts, so edits apply to the next job. */
  roles: Record<Role, RoleAssignment>;
  /** The preset in effect; none by default, so an unconfigured install runs each agent's own settings. */
  preset: PresetName | null;
  /** What each preset sets. The built-in ones set effort only; a user's entry replaces fields of the same name. */
  presets: Record<PresetName, Preset>;
}

/**
 * The built-in presets name no models: which ones an account can use differs, so a model belongs in the
 * user's config. They differ in Codex's effort and in the model the lead gives its subagents.
 */
export const PRESETS: Record<PresetName, Preset> = {
  economy: { codex: { effort: 'low' }, subagentModel: 'haiku', subagentMax: 'sonnet', maxTier: 'standard' },
  balanced: { codex: { effort: 'medium' }, subagentModel: 'sonnet' },
  best: { codex: { effort: 'high' }, subagentModel: 'inherit' },
};
const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];

const defaults: Config = {
  stallSeconds: 300,
  notify: true,
  notifyOnDone: false,
  codex: { bin: 'codex', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', plugins: ['browser'], appPlugins: ['computer-use', 'unified-computer-use'] },
  antigravity: { bin: 'agy', enabled: true },
  roles: { delegate: { agent: 'codex' }, review: { agent: 'codex' }, polish: { agent: 'antigravity' } },
  preset: null,
  presets: PRESETS,
};

export const DEFAULT_ROLES = defaults.roles;

type UserConfig = Partial<Omit<Config, 'roles' | 'presets' | 'codex'>> & { codex?: Partial<Config['codex']>; roles?: Partial<Record<Role, Partial<RoleAssignment>>>; presets?: Partial<Record<PresetName, Preset>> };

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
  for (const key of ['plugins', 'appPlugins'] as const) {
    const names: unknown = user.codex?.[key] === undefined ? defaults.codex[key] : user.codex[key];
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error(`codex.${key} must be a list of plugin names such as ["computer-use"].`);
  }
  return {
    ...defaults,
    ...user,
    codex: { ...defaults.codex, ...user.codex },
    antigravity: { ...defaults.antigravity, ...user.antigravity },
    roles,
    ...resolvePresets(user),
  };
}

/** Like the role table, a preset that is not exactly valid throws: a job must not run on settings the user did not choose. */
function resolvePresets(user: UserConfig): Pick<Config, 'preset' | 'presets'> {
  const preset: unknown = user.preset ?? null;
  if (preset !== null && !PRESET_NAMES.includes(preset as PresetName)) throw new Error(`preset is "${String(preset)}"; use one of: ${PRESET_NAMES.join(', ')}, or leave it out.`);
  const given: unknown = user.presets ?? {};
  if (!isObject(given)) throw new Error('presets must be an object such as {"best": {"codex": {"model": "..."}}}.');
  const presets = { ...PRESETS };
  for (const [name, entry] of Object.entries(given)) {
    if (!PRESET_NAMES.includes(name as PresetName)) throw new Error(`presets.${name} is not a preset; use one of: ${PRESET_NAMES.join(', ')}.`);
    if (!isObject(entry)) throw new Error(`presets.${name} must be an object.`);
    const merged: Preset = { ...PRESETS[name as PresetName] };
    for (const [key, value] of Object.entries(entry)) {
      if (key === 'subagentModel' || key === 'subagentMax') {
        if (typeof value !== 'string') throw new Error(`presets.${name}.${key} must be a string.`);
        merged[key] = value;
      } else if (key === 'maxTier') {
        if (!TIERS.includes(value as Tier)) throw new Error(`presets.${name}.maxTier must be one of: ${TIERS.join(', ')}.`);
        merged.maxTier = value as Tier;
      } else if (key === 'codex' || key === 'antigravity') {
        const allowed = key === 'codex' ? ['model', 'effort'] : ['model'];
        if (!isObject(value)) throw new Error(`presets.${name}.${key} must be an object.`);
        for (const [setting, text] of Object.entries(value)) {
          if (!allowed.includes(setting)) throw new Error(`presets.${name}.${key}.${setting} is not a setting; use ${allowed.join(' or ')}.`);
          if (typeof text !== 'string') throw new Error(`presets.${name}.${key}.${setting} must be a string.`);
        }
        merged[key] = { ...merged[key], ...(value as Record<string, string>) };
      } else throw new Error(`presets.${name}.${key} is not a setting; use codex, antigravity, subagentModel, subagentMax, or maxTier.`);
    }
    presets[name as PresetName] = merged;
  }
  return { preset: preset as PresetName | null, presets };
}

/**
 * The agent, model, and effort a job of this role runs with. A setting on the role wins over the preset,
 * and the preset over the agent's own.
 */
export function effectiveRole(config: Config, role: Role): RoleAssignment {
  const assignment = config.roles[role];
  const preset = config.preset ? config.presets[config.preset][assignment.agent] : undefined;
  const effort = assignment.effort ?? (preset as { effort?: string } | undefined)?.effort;
  const model = assignment.model ?? preset?.model;
  return { agent: assignment.agent, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
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
/**
 * One spelling for a project key. Git reports Windows paths as `C:/x` while Claude Code passes `C:\x`, and the
 * drive letter's case can differ; jobs, missions and sessions are grouped and filtered by comparing these strings.
 * Only keys go through this: paths handed back to git (a job's `repo`) keep git's spelling, which worktree paths hash.
 */
export function canonicalPath(file: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return path.posix.resolve(file);
  return path.win32.resolve(file).replace(/^[a-z]:/, (drive) => drive.toUpperCase());
}

export function agentEnv(platform: NodeJS.Platform = process.platform, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = os.homedir();
  const windows = platform === 'win32';
  const extra = [path.join(home, '.local', 'bin'), ...(windows ? [] : ['/opt/homebrew/bin', '/usr/local/bin']), path.dirname(process.execPath)];
  const appData = source[Object.keys(source).find((key) => key.toUpperCase() === 'APPDATA') ?? 'APPDATA'];
  if (windows && appData) extra.push(path.win32.join(appData, 'npm'));
  const pathKey = windows ? Object.keys(source).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH' : 'PATH';
  const delimiter = windows ? ';' : path.delimiter;
  const current = (source[pathKey] ?? '').split(delimiter).filter(Boolean);
  const merged = [...current, ...extra.filter((p) => !current.includes(p))];
  const env: NodeJS.ProcessEnv = { ...source };
  if (windows) for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = merged.join(delimiter);
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/** Windows npm shims need cmd.exe and one quoted string to avoid Node's shell-with-args deprecation. */
export function agentCommand(bin: string, args: string[] = [], env: NodeJS.ProcessEnv = agentEnv(), platform: NodeJS.Platform = process.platform): { bin: string; args: string[] | undefined; shell: boolean } {
  if (platform !== 'win32') return { bin, args, shell: false };
  if (!path.win32.extname(bin)) {
    const value = (name: string) => env[Object.keys(env).find((key) => key.toUpperCase() === name) ?? name];
    const extensions = (value('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
    const dirs = /[\\/]/.test(bin) || path.win32.isAbsolute(bin) ? [''] : (value('PATH') ?? '').split(';').filter(Boolean);
    search: for (const dir of dirs) {
      for (const ext of extensions) {
        const candidate = path.win32.join(dir.replace(/^"(.*)"$/, '$1'), bin + ext);
        if (fs.statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
          bin = candidate;
          break search;
        }
      }
    }
  }
  const shell = /\.(cmd|bat)$/i.test(bin);
  if (shell && [bin, ...args].some((value) => /["%\r\n]/.test(value))) throw new Error('Invalid agent binary path or argument.');
  return { bin: shell ? [bin, ...args].map((value) => `"${value}"`).join(' ') : bin, args: shell ? undefined : args, shell };
}
