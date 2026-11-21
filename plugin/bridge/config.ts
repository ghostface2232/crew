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
/**
 * Ports the daemon tries, in order; CREW_PORT pins one. Windows can reserve a port with nothing listening on it:
 * WSL's mirrored networking reserves a block of 4096 at each start, wherever it finds room. So each fallback lies
 * further from the others than such a block.
 */
export const PORTS = process.env.CREW_PORT ? [Number(process.env.CREW_PORT)] : [47615, 42615, 37615, 32615, 27615];

/** The port the daemon took, as it recorded it in the Crew home; the first it tries until it has recorded one. */
export function daemonPort(): number {
  try {
    const { port } = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
    if (PORTS.includes(port)) return port;
  } catch {
    /* No daemon has recorded a port. */
  }
  return PORTS[0];
}

export const baseUrl = () => `http://127.0.0.1:${daemonPort()}`;

export type WorkerAgent = 'codex' | 'antigravity';
/** How a job runs: its sandbox, workspace, and base prompt. Each role runs as one of these. */
export type JobKind = 'delegate' | 'review' | 'polish';

/**
 * Who leads. Only Claude Code can today: the plugin's hooks wake it and record the user's words.
 * docs/06-roadmap.md describes what another lead would need.
 */
export const LEAD = 'claude' as const;
/** Who may hold a role: a worker, or the lead itself, which does the work in its own session or a subagent. */
export type Holder = WorkerAgent | typeof LEAD;
export const isHolder = (value: unknown): value is Holder => value === LEAD || Object.hasOwn(WORKERS, value as string);
/**
 * Every holder, in the order a role lists them: a job the lead names no holder for goes to the first worker
 * among them. Workers come before the lead, so naming Claude too never keeps work from a worker.
 */
export const HOLDERS: Holder[] = ['codex', 'antigravity', LEAD];

/**
 * A role is a kind of work the user assigns to an agent. Parents come before their children: a role the user
 * has not assigned takes its parent's whole assignment, so a config written for the first three roles keeps
 * working as it did.
 */
export const ROLES = ['delegate', 'refactor', 'release', 'debate', 'review', 'verify', 'fix', 'polish'] as const;
export type Role = (typeof ROLES)[number];

export interface RoleInfo {
  role: Role;
  kind: JobKind;
  parent?: Role;
  /** Workers that cannot do the role's work, so they never take it: running the app needs a reviewer that runs commands. */
  unable?: WorkerAgent[];
  label: string;
  summary: string;
}

/** Ordered as the settings show them. */
export const ROLE_INFO: RoleInfo[] = [
  { role: 'delegate', kind: 'delegate', label: 'Implementation', summary: 'Builds separable pieces of a change.' },
  { role: 'refactor', kind: 'delegate', parent: 'delegate', label: 'Refactoring', summary: 'Restructures code without changing what it does.' },
  { role: 'release', kind: 'delegate', parent: 'delegate', label: 'Release preparation', summary: 'Prepares a release: version, changelog, build, and the steps to publish. It does not publish or deploy.' },
  { role: 'debate', kind: 'delegate', parent: 'delegate', label: 'Debate', summary: 'Tests the lead\'s position on a hard decision, read-only.' },
  { role: 'review', kind: 'review', label: 'Cross-review', summary: 'Reviews a change by reading it and running checks.' },
  { role: 'verify', kind: 'review', parent: 'review', label: 'Review that runs the app', summary: 'Reviews a change by starting the app in a snapshot of it.', unable: ['antigravity'] },
  { role: 'fix', kind: 'delegate', label: 'Fix', summary: 'Fixes the review findings the lead accepted, in the lead\'s own code or a merged result.' },
  { role: 'polish', kind: 'polish', label: 'Wording', summary: 'Improves UI strings, comments, and docs.' },
];
export const roleInfo = (role: Role): RoleInfo => ROLE_INFO.find((info) => info.role === role)!;

/** Where the user assigns a role's holders, for a refusal to name: the lead cannot change roles itself. */
export const assignHint = (role: Role): string =>
  `To use another agent, ask the user to add it under Settings, Roles, ${roleInfo(role).label} (on the board or in the app), or to \`roles.${role}.agents\` in ~/.crew/config.json.`;
export const isRole = (value: unknown): value is Role => ROLES.includes(value as Role);

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
export function runsCommands(agent: WorkerAgent, spec: { kind: JobKind; ask?: boolean }): boolean {
  return (spec.kind === 'delegate' && !spec.ask) || WORKERS[agent].reviewerRunsGit;
}

/** A worker's model and effort for one role, over the agent's own settings. */
export interface AgentSettings {
  model?: string;
  effort?: string;
}

export interface RoleAssignment {
  /** Who may take the role's work, in HOLDERS order; the lead picks one for each job. */
  agents: Holder[];
  codex?: AgentSettings;
  antigravity?: AgentSettings;
}

/** The workers among a role's holders. */
export const workersOf = (assignment: Pick<RoleAssignment, 'agents'>): WorkerAgent[] => assignment.agents.filter((agent): agent is WorkerAgent => agent !== LEAD);

/** Workers in the order a role prefers them when the lead names none: wording goes to Antigravity first, other work to Codex. */
export const preferenceOf = (role: Role): WorkerAgent[] => (roleInfo(role).kind === 'polish' ? ['antigravity', 'codex'] : ['codex', 'antigravity']);
export const disabledAgents = (config: Pick<Config, 'antigravity'>): WorkerAgent[] => (config.antigravity.enabled ? [] : ['antigravity']);

/** The role's worker holders that can take its work now, in its order of preference: the first takes a job the lead names no holder for. */
export const workersFor = (role: Role, assignment: Pick<RoleAssignment, 'agents'>, disabled: WorkerAgent[] = []): WorkerAgent[] =>
  preferenceOf(role).filter((agent) => assignment.agents.includes(agent) && !roleInfo(role).unable?.includes(agent) && !disabled.includes(agent));

/**
 * Who takes a job the lead names no holder for: the first worker that can, else Claude when it holds the role, else the
 * first worker anyway, so the job is refused with the reason it cannot run.
 */
export const defaultHolder = (role: Role, assignment: Pick<RoleAssignment, 'agents'>, disabled: WorkerAgent[] = []): Holder =>
  workersFor(role, assignment, disabled)[0] ?? (assignment.agents.includes(LEAD) ? LEAD : workersOf(assignment)[0]);

export type RoleSettings = Partial<Record<Role, Partial<RoleAssignment>>>;

/** A debate longer than this has stopped converging; the lead should decide or start over. */
export const MAX_DEBATE_ROUNDS = 6;

export type PresetName = 'economy' | 'balanced' | 'best';

/** Model and effort a preset gives each agent, and the model the lead should give its subagents. */
export interface Preset {
  codex?: { model?: string; effort?: string };
  antigravity?: { model?: string; effort?: string };
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
  /** Which worker takes each role, with inheritance resolved. Read when a job starts, so edits apply to the next job. */
  roles: Record<Role, RoleAssignment>;
  /** The roles as the user wrote them: a role without `agent` inherits from its parent. Settings edit this, not `roles`. */
  roleSettings: RoleSettings;
  /**
   * Whether the lead and the workers rate each other's work as they see it, as one input to the model scores. Off, no
   * worker is asked to rate and the scores come from the review evidence alone; ratings already given are kept.
   */
  peerRatings: boolean;
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
export const PRESET_NAMES = Object.keys(PRESETS) as PresetName[];
export const isPresetName = (value: unknown): value is PresetName => PRESET_NAMES.includes(value as PresetName);

/**
 * Holders of the roles that have no parent, when the user names none. Fixing stays with the lead, as it was before it
 * became a role: triage needs the conversation, and the fix often does too.
 */
const BASE_HOLDERS: Partial<Record<Role, Holder>> = { delegate: 'codex', review: 'codex', fix: LEAD, polish: 'antigravity' };
const sortHolders = (agents: Holder[]) => HOLDERS.filter((holder) => agents.includes(holder));

const defaults: Config = {
  stallSeconds: 300,
  notify: true,
  notifyOnDone: false,
  codex: { bin: 'codex', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', plugins: ['browser'], appPlugins: ['computer-use', 'unified-computer-use'] },
  antigravity: { bin: 'agy', enabled: true },
  roles: resolveRoles({}),
  roleSettings: {},
  peerRatings: true,
  preset: null,
  presets: PRESETS,
};

export const DEFAULT_ROLES = defaults.roles;

/** A role as written before agents: a default agent, the others in also, and one model and effort for the default. */
interface LegacyRole { agent?: Holder; also?: Holder[]; model?: string; effort?: string }

type UserConfig = Partial<Omit<Config, 'roles' | 'roleSettings' | 'presets' | 'codex'>> & { codex?: Partial<Config['codex']>; roles?: Partial<Record<Role, Partial<RoleAssignment> | LegacyRole>>; presets?: Partial<Record<PresetName, Preset>> };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Each role's assignment from what the user wrote. A role that names its agents starts fresh; one that does not
 * takes its parent's, with its own settings for each agent laid over the parent's. Settings for an agent that
 * does not hold the role are left out.
 */
function resolveRoles(settings: RoleSettings): Record<Role, RoleAssignment> {
  const roles = {} as Record<Role, RoleAssignment>;
  for (const role of ROLES) {
    const own = settings[role] ?? {};
    const parent = roleInfo(role).parent;
    const base: RoleAssignment = own.agents ? { agents: own.agents } : parent ? roles[parent] : { agents: [BASE_HOLDERS[role]!] };
    const resolved: RoleAssignment = { agents: base.agents };
    for (const agent of workersOf(base)) {
      const merged = { ...base[agent], ...own[agent] };
      if (Object.keys(merged).length) resolved[agent] = merged;
    }
    roles[role] = resolved;
  }
  return roles;
}

/**
 * One role's entry as the user wrote it, in the current form. The form before agents named a default agent with
 * the others in also, and one model and effort for the default; they become that agent's settings.
 */
function roleEntry(role: Role, entry: Record<string, unknown>, inherited: RoleAssignment): Partial<RoleAssignment> {
  const holders = HOLDERS.join(', ');
  const legacy = ['agent', 'also', 'model', 'effort'].filter((key) => key in entry);
  const current = ['agents', 'codex', 'antigravity'].filter((key) => key in entry);
  for (const key of Object.keys(entry)) {
    if (!legacy.includes(key) && !current.includes(key)) throw new Error(`roles.${role}.${key} is not a setting; use agents, codex, or antigravity.`);
  }
  if (legacy.length && current.length) throw new Error(`roles.${role} mixes ${legacy.join(', ')} with ${current.join(', ')}; write the agents list and each agent's settings instead.`);
  const result: Partial<RoleAssignment> = {};
  if (legacy.length) {
    const { agent, also, model, effort } = entry;
    if (agent !== undefined && !isHolder(agent)) throw new Error(`roles.${role}.agent is "${String(agent)}"; use one of: ${holders}.`);
    if (also !== undefined && (!Array.isArray(also) || also.some((holder) => !isHolder(holder)))) throw new Error(`roles.${role}.also must be a list of: ${holders}.`);
    for (const [key, value] of [['model', model], ['effort', effort]] as const) {
      if (value !== undefined && typeof value !== 'string') throw new Error(`roles.${role}.${key} must be a string.`);
    }
    const parent = roleInfo(role).parent;
    // A model names one agent's model. Following the parent, the agent can change under it and receive a model it does not have.
    if (parent && model !== undefined && agent === undefined) {
      throw new Error(`roles.${role}.model needs roles.${role}.agent: a model belongs to one agent, and a role that follows ${parent} can change agents. Set the agent too, or leave the model to ${parent}.`);
    }
    if (agent !== undefined) result.agents = sortHolders([agent as Holder, ...((also as Holder[] | undefined) ?? [])]);
    else if (also !== undefined) {
      // Further holders on top of those the role had unwritten, whose settings it kept too.
      Object.assign(result, structuredClone(inherited), { agents: sortHolders([...inherited.agents, ...(also as Holder[])]) });
    }
    // The settings were the default's: the agent named, else the role's own default, else (only effort may follow a parent) Codex's.
    const owner = (agent ?? BASE_HOLDERS[role] ?? 'codex') as Holder;
    if (owner !== LEAD && (model !== undefined || effort !== undefined)) {
      const settings: AgentSettings = { ...(model !== undefined ? { model: model as string } : {}), ...(effort !== undefined && owner === 'codex' ? { effort: effort as string } : {}) };
      if (Object.keys(settings).length) result[owner] = { ...result[owner], ...settings };
    }
    return result;
  }
  if (entry.agents !== undefined) {
    const agents = entry.agents;
    if (!Array.isArray(agents) || !agents.length || agents.some((holder) => !isHolder(holder))) throw new Error(`roles.${role}.agents must be a non-empty list of: ${holders}.`);
    if (new Set(agents).size !== agents.length) throw new Error(`roles.${role}.agents names a holder twice.`);
    result.agents = sortHolders(agents as Holder[]);
  }
  for (const agent of Object.keys(WORKERS) as WorkerAgent[]) {
    const settings = entry[agent];
    if (settings === undefined) continue;
    const allowed = ['model', 'effort'];
    if (!isObject(settings)) throw new Error(`roles.${role}.${agent} must be an object such as {"model": "..."}.`);
    for (const [key, value] of Object.entries(settings)) {
      if (!allowed.includes(key)) throw new Error(`roles.${role}.${agent}.${key} is not a setting; use ${allowed.join(' or ')}.`);
      if (typeof value !== 'string') throw new Error(`roles.${role}.${agent}.${key} must be a string.`);
    }
    result[agent] = settings as AgentSettings;
  }
  return result;
}

/**
 * Fills a user's partial config with defaults. A role table that is not exactly what it should be
 * throws: quietly keeping a default would run a job on an agent the user did not choose.
 */
export function resolveConfig(user: UserConfig): Config {
  const given: unknown = user.roles ?? {};
  if (!isObject(given)) throw new Error('roles must be an object such as {"polish": {"agents": ["codex"]}}.');
  const roleSettings: RoleSettings = {};
  for (const role of Object.keys(given)) if (!isRole(role)) throw new Error(`roles.${role} is not a role; use one of: ${ROLES.join(', ')}.`);
  // Parents first, so an old entry that added holders to its parent's can be read against the parent.
  for (const role of ROLES) {
    const entry = given[role];
    if (entry === undefined) continue;
    if (!isObject(entry)) throw new Error(`roles.${role} must be an object such as {"agents": ["codex"]}.`);
    // What the role would get unwritten: its parent's holders, or its own default.
    roleSettings[role] = roleEntry(role, entry, resolveRoles({ ...roleSettings, [role]: undefined })[role]);
  }
  const roles = resolveRoles(roleSettings);
  for (const key of ['plugins', 'appPlugins'] as const) {
    const names: unknown = user.codex?.[key] === undefined ? defaults.codex[key] : user.codex[key];
    if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) throw new Error(`codex.${key} must be a list of plugin names such as ["computer-use"].`);
  }
  // Any other value would read as on, and "false" in quotes is the likely one.
  if (user.peerRatings !== undefined && typeof user.peerRatings !== 'boolean') throw new Error('peerRatings must be true or false.');
  return {
    ...defaults,
    ...user,
    codex: { ...defaults.codex, ...user.codex },
    antigravity: { ...defaults.antigravity, ...user.antigravity },
    roles,
    roleSettings,
    ...resolvePresets(user),
  };
}

/** Like the role table, a preset that is not exactly valid throws: a job must not run on settings the user did not choose. */
function resolvePresets(user: UserConfig): Pick<Config, 'preset' | 'presets'> {
  const preset: unknown = user.preset ?? null;
  if (preset !== null && !isPresetName(preset)) throw new Error(`preset is "${String(preset)}"; use one of: ${PRESET_NAMES.join(', ')}, or leave it out.`);
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
        const allowed = ['model', 'effort'];
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
 * and the preset over the agent's own. `preset` is the job's: its mission's when the mission sets one.
 */
export function effectiveRole(config: Config, role: Role, preset: PresetName | null = config.preset, agent?: WorkerAgent): { agent: WorkerAgent; model?: string; effort?: string } {
  const assignment = config.roles[role];
  const holder = agent ?? workersFor(role, assignment, disabledAgents(config))[0];
  if (!holder) throw new Error(`${role} is held by Claude, the lead, which does the work itself; no worker takes it.`);
  const own: AgentSettings = assignment[holder] ?? {};
  const chosen = preset ? config.presets[preset][holder] : undefined;
  const effort = own.effort ?? (chosen as { effort?: string } | undefined)?.effort;
  const model = own.model ?? chosen?.model;
  return { agent: holder, ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
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

/**
 * What a child started with `process.execPath` needs to run a script. Under the desktop app that path is the
 * Electron executable, which opens the app instead unless it is told to act as Node.
 */
export function nodeEnv(versions: NodeJS.ProcessVersions = process.versions): Record<string, string> {
  return versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};
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
