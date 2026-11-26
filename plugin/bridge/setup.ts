import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isNewer } from './client.ts';
import { CODEX_HOOKS, CODEX_PLUGIN, codexHooks, crewHooks, hookTrust, installCodexHooks, launcherPath, listedCrewHooks, writeCodexPlugin, writeLauncher, writtenByCrew } from './codex-plugin.ts';
import type { HookTrust, ListedHook } from './codex-plugin.ts';
import { execTimed, RpcPeer } from './rpc.ts';
import { agentCommand, agentEnv, HOME, installed, LEDGER_ASIDE, loadConfig, PLUGIN_ROOT, VERSION } from './config.ts';

/**
 * Registering this plugin with Claude Code and checking what Crew needs. A desktop app carries a built copy of the
 * plugin (scripts/bundle-plugin.mjs) and its daemon registers it on first launch and after each update; a source
 * checkout registers itself with `crew install`.
 */

/** The folder holding the marketplace manifest and the plugin. */
const MARKETPLACE = path.resolve(PLUGIN_ROOT, '..');
/** A built copy of the plugin, as an app carries, rather than a source checkout. */
export const PACKAGED = fs.existsSync(path.join(PLUGIN_ROOT, '.claude-plugin', 'build'));
const RECORD = path.join(HOME, 'setup.json');
/**
 * On Windows the installer replaces the install folder's files and is meant to stop the processes running from it
 * (in testing it stopped none), which would stop, or leave running on missing files, the MCP server of every open
 * Claude Code session and any daemon one started. So an app's copy registers a copy
 * of its plugin and runtime in the Crew home instead, one per build: open sessions keep running theirs through an
 * update, and the updated app registers the next.
 */
const COPIED = PACKAGED && process.platform === 'win32';
const COPIES = path.join(HOME, 'plugins');
const samePath = (a: string, b: string) => path.relative(a, b) === '';
/** The marketplace Claude Code runs this build's plugin from. */
const registeredRoot = () => (COPIED ? path.join(COPIES, `${VERSION}-${installed().build}`) : MARKETPLACE);

export function run(bin: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string; missing?: true }> {
  const env = agentEnv();
  const command = agentCommand(bin, args, env);
  return new Promise((resolve) => {
    execTimed(command.bin, command.args ?? [], { env, shell: command.shell, timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || err?.message || '').trim(), ...((err as NodeJS.ErrnoException | null)?.code === 'ENOENT' ? { missing: true } : {}) });
    });
  });
}

async function claudeList<T>(args: string[], key: keyof T): Promise<{ rows: T[] | null; out: string; missing?: true }> {
  const res = await run('claude', [...args, '--json'], 60_000);
  if (!res.ok) return { ...res, rows: null };
  try {
    const rows: unknown = JSON.parse(res.out);
    if (Array.isArray(rows) && rows.every((row) => row && typeof row[key] === 'string' && row[key].trim())) {
      return { rows, out: res.out };
    }
  } catch { /* Report malformed output as a failed query. */ }
  return { rows: null, out: 'Claude Code returned an invalid inventory.' };
}

type Marketplace = { name: string; path?: string };
type InstalledPlugin = { id: string; version?: string; readFromFolder?: string };

/** The Node a built plugin runs on: the app's own, beside the plugin's folder. */
function bundledRuntime(root: string): string | null {
  for (const file of [path.join(root, '..', 'runtime', 'node'), path.join(root, 'runtime', 'node.exe')]) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export type Registration = { ok: boolean; detail: string };

/** Copies a built marketplace's plugin and runtime to `dest`, whole or not at all. An existing `dest` is complete. */
export function copyPlugin(from: string, dest: string): void {
  if (fs.existsSync(dest)) return;
  const partial = `${dest}.partial-${process.pid}`;
  fs.rmSync(partial, { recursive: true, force: true });
  for (const name of ['.claude-plugin', 'plugin', 'runtime']) {
    if (fs.existsSync(path.join(from, name))) fs.cpSync(path.join(from, name), path.join(partial, name), { recursive: true });
  }
  try {
    fs.renameSync(partial, dest);
  } catch (err) {
    fs.rmSync(partial, { recursive: true, force: true });
    // Another process finished the same copy first.
    if (!fs.existsSync(dest)) throw err;
  }
}

/**
 * Removes the plugin copies in `dir` other than `keep`, except those still running. Windows refuses to delete a
 * running executable, so a copy whose `node.exe` cannot be deleted is left whole to the session using it and tried
 * again later.
 */
export function prunePlugins(dir = COPIES, keep = [registeredRoot(), MARKETPLACE]): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const copy = path.join(dir, name);
    if (keep.some((root) => samePath(root, copy))) continue;
    const pid = Number(/\.partial-(\d+)$/.exec(name)?.[1]);
    if (pid && alive(pid)) continue;
    try {
      fs.rmSync(path.join(copy, 'runtime', 'node.exe'), { force: true });
      fs.rmSync(copy, { recursive: true, force: true });
    } catch {
      /* In use. */
    }
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/**
 * The version of a newer copy of the app that holds the registration, if one does. After an update, a session still
 * open runs its MCP server from the copy before, and a daemon it starts would register that copy again and remove the
 * new one. So the older copy leaves the registration alone, as its daemon leaves a newer daemon (`shouldReplace` in
 * client.ts). A record of this copy's own folder, or of a folder since removed, is of nothing newer.
 */
function newerRegistration(): string | null {
  try {
    const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
    return isNewer(record.version, VERSION) && !samePath(record.root, registeredRoot()) && fs.existsSync(record.root) ? record.version : null;
  } catch {
    return null;
  }
}

/**
 * Registers this copy with Claude Code and, where it is installed, with Codex, then points the `crew` command here.
 * An app leaves a plugin registered from a source checkout alone: that is a developer's install.
 */
export async function register(asked = false): Promise<Registration> {
  // Only on its own account: a user who installs an older version and asks for it to be registered gets it.
  const newer = PACKAGED && !asked ? newerRegistration() : null;
  if (newer) return { ok: true, detail: `A newer Crew (${newer}) is registered; this copy (${VERSION}) leaves it as it is. To use this copy instead, run the setup checklist's repair from it, or its \`crew install\`.` };
  const root = registeredRoot();
  if (COPIED) copyPlugin(MARKETPLACE, root);
  const claude = await registerClaude(root);
  const codex = await registerCodex(root);
  const hosts = [claude, codex].filter((host) => host !== null);
  if (!hosts.length) return { ok: false, detail: 'Neither Claude Code nor Codex was found. Install one of them, then try again.' };
  // The command follows Claude Code's registration, or Codex's for a user without Claude Code.
  const owner = claude ?? codex!;
  if (owner.ok && owner.current) linkCommand(root);
  // Recorded once the command's host runs this copy, so an older copy finds a newer one registered (newerRegistration)
  // even while another host fails. Complete, and older copies pruned, only once every host runs it: a host left on an
  // older copy still needs it, and the next start tries again.
  const complete = hosts.every((host) => host.ok && host.current);
  if (PACKAGED && ((owner.ok && owner.current) || registered())) {
    fs.writeFileSync(RECORD, `${JSON.stringify({ root, version: VERSION, build: installed().build, complete }, null, 2)}\n`);
  }
  if (complete && COPIED) prunePlugins();
  const detail = [claude?.detail ?? 'Claude Code was not found.', codex && `Codex: ${codex.detail}`].filter(Boolean).join(' ');
  return { ok: hosts.every((host) => host.ok), detail };
}

/** How registering with one host went; `current` when that host now runs this copy rather than one left alone. */
type HostRegistration = Registration & { current: boolean };

/** Registers this copy's marketplace with Claude Code and installs or updates the plugin from it; null without Claude Code. */
async function registerClaude(root: string): Promise<HostRegistration | null> {
  const marketplaces = await claudeList<Marketplace>(['plugin', 'marketplace', 'list'], 'name');
  if (marketplaces.missing) return null;
  if (!marketplaces.rows) return { ok: false, current: false, detail: `Could not list Claude Code marketplaces: ${lastLine(marketplaces.out)}` };
  const current = marketplaces.rows.find((entry) => entry.name === 'crew');
  if (PACKAGED && current?.path && !samePath(current.path, root) && fromSource(current.path)) {
    return { ok: true, current: false, detail: `Registered from a source checkout (${current.path}); the app leaves it as it is.` };
  }
  if (!current?.path || !samePath(current.path, root)) {
    // Adding a marketplace under a name already taken points that name at the new folder.
    const added = await run('claude', ['plugin', 'marketplace', 'add', root], 60_000);
    if (!added.ok) return { ok: false, current: false, detail: `Could not register the marketplace: ${lastLine(added.out)}` };
  }
  const plugins = await claudeList<InstalledPlugin>(['plugin', 'list'], 'id');
  if (!plugins.rows) return { ok: false, current: false, detail: `Could not list Claude Code plugins: ${lastLine(plugins.out)}` };
  const plugin = plugins.rows.find((entry) => entry.id === 'crew@crew');
  // A copy of another build with the same version has Claude Code read the plugin from the new folder too.
  const moved = plugin && (typeof plugin.readFromFolder !== 'string' || !plugin.readFromFolder || !samePath(plugin.readFromFolder, path.join(root, 'plugin')));
  const step = !plugin ? ['install', 'crew@crew'] : plugin.version !== VERSION || (COPIED && moved) ? ['update', 'crew@crew'] : null;
  if (step) {
    const res = await run('claude', ['plugin', ...step], 60_000);
    if (!res.ok) return { ok: false, current: false, detail: `Could not ${step[0]} the plugin: ${lastLine(res.out)}` };
  }
  return { ok: true, current: true, detail: step ? 'Installed. Open a new Claude Code session, or run /reload-plugins, to load it.' : 'Up to date.' };
}

/** The user-wide folder a built copy writes its Codex marketplace and hook launcher in, whatever the Crew home. */
const CODEX_DIR = path.join(os.homedir(), '.crew', 'codex');

/**
 * Registers the plugin with Codex too, so a Codex session can lead; null without Codex. Codex copies the plugin into
 * its own cache, so this runs again after the plugin changes. A source checkout registers its own marketplace. A
 * built copy registers one written for Codex (codex-plugin.ts), since the app's Node beside the plugin folder is out of
 * reach from Codex's copy, and replaces only a registration Crew wrote: any other is a developer's or the user's own.
 */
async function registerCodex(root: string): Promise<HostRegistration | null> {
  const bin = loadConfig().codex.bin;
  const version = await run(bin, ['--version']);
  if (version.missing) return null;
  if (!version.ok) return { ok: false, current: false, detail: `Could not check the Codex version: ${lastLine(version.out)}` };
  const list = await run(bin, ['plugin', 'marketplace', 'list'], 60_000);
  if (!list.ok) return { ok: false, current: false, detail: `Could not list Codex marketplaces: ${lastLine(list.out)}` };
  const current = codexMarketplaces(list.out).get('crew');
  const marketplace = PACKAGED ? path.join(CODEX_DIR, 'marketplace') : MARKETPLACE;
  const other = current !== undefined && !sameFolder(current, marketplace);
  // A source checkout's hooks run on the Node in PATH, as its own MCP server does.
  let runtime = 'node';
  if (PACKAGED) {
    if (other && !writtenByCrew(current)) return { ok: true, current: false, detail: `Registered from ${current}; the app leaves it as it is.` };
    const bundled = bundledRuntime(root);
    if (!bundled) return { ok: false, current: false, detail: 'This copy of Crew has no Node runtime for Codex to run it on.' };
    runtime = bundled;
    try {
      writeCodexPlugin(root, runtime, CODEX_DIR);
    } catch (err) {
      return { ok: false, current: false, detail: `Could not write the plugin for Codex: ${(err as Error).message}` };
    }
  }
  // Codex refuses to add a marketplace under a name another folder holds.
  if (other) await run(bin, ['plugin', 'marketplace', 'remove', 'crew'], 60_000);
  const added = await run(bin, ['plugin', 'marketplace', 'add', marketplace], 60_000);
  if (!added.ok) return { ok: false, current: false, detail: `Could not register the marketplace with Codex: ${lastLine(added.out)}` };
  const plugin = await run(bin, ['plugin', 'add', CODEX_PLUGIN], 60_000);
  if (!plugin.ok) return { ok: false, current: false, detail: `Could not install the plugin in Codex: ${lastLine(plugin.out)}` };
  // A source checkout's hooks run Codex's copy of it, as its MCP server does, not the checkout as it changes.
  const copy = /^Installed plugin root:\s*(.+?)\s*$/m.exec(plugin.out)?.[1]?.replace(/^\\\\\?\\/, '');
  if (!PACKAGED && !copy) return { ok: false, current: false, detail: `Could not tell where Codex installed the plugin: ${lastLine(plugin.out)}` };
  try {
    const bridge = PACKAGED ? path.join(root, 'plugin', 'bridge') : path.join(copy!, 'bridge');
    const launcher = writeLauncher(path.join(CODEX_DIR, 'bin'), runtime, bridge, PACKAGED ? '.js' : '.ts');
    installCodexHooks(codexHooksFile(), codexHooks(readJson(path.join(root, 'plugin', CODEX_HOOKS)), launcher), launcher);
  } catch (err) {
    return { ok: false, current: false, detail: `Could not add Crew's hooks to ${codexHooksFile()}: ${(err as Error).message}` };
  }
  return { ok: true, current: true, detail: `Installed in Codex. If Crew's hooks are not trusted yet, ${CODEX_TRUST}` };
}

const CODEX_TRUST = 'select Trust Hooks in the setup checklist, or trust them in Codex under Settings → Hooks (`/hooks` in the CLI). Then start a new Codex chat or CLI session.';

/** The user's own Codex hooks file, where Crew's hooks go (codex-plugin.ts). */
const codexHooksFile = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'hooks.json');
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Codex's marketplaces by name, from `codex plugin marketplace list`: a header row, then name and root folder. */
function codexMarketplaces(output: string): Map<string, string> {
  const rows = output.split('\n').slice(1);
  return new Map(rows.map((row) => /^(\S+)\s+(.+?)\s*$/.exec(row)).filter((m) => m !== null).map((m) => [m[1], m[2]]));
}

/** Two folders compared as the file system resolves them, since Codex records a marketplace by its real path. */
function sameFolder(a: string, b: string): boolean {
  const real = (folder: string) => {
    try {
      return fs.realpathSync.native(folder);
    } catch {
      return path.resolve(folder);
    }
  };
  return samePath(real(a), real(b));
}

/** A marketplace folder holding a source checkout rather than a built copy: a developer's install. */
const fromSource = (folder: string) => fs.existsSync(folder) && !fs.existsSync(path.join(folder, 'plugin', '.claude-plugin', 'build'));

/**
 * Whether Claude Code no longer reads the plugin from the copy this app registered, although the record says it does.
 * This was seen right after a registration, likely another Claude Code process starting meanwhile and writing back the
 * marketplace it had loaded.
 */
export async function registrationMoved(): Promise<boolean | null> {
  if (!COPIED) return false;
  const { rows, missing } = await claudeList<InstalledPlugin>(['plugin', 'list'], 'id');
  if (missing) return false;
  if (!rows) return null;
  const plugin = rows.find((entry) => entry.id === 'crew@crew');
  // A plugin the user removed stays removed.
  if (!plugin) return false;
  if (typeof plugin.readFromFolder !== 'string' || !path.isAbsolute(plugin.readFromFolder)) return null;
  return !samePath(plugin.readFromFolder, path.join(registeredRoot(), 'plugin')) && !fromSource(path.resolve(plugin.readFromFolder, '..'));
}

/**
 * Whether this built copy has been registered since it was installed or last updated. The version counts as well as
 * the code: a release that changes only the version still has Claude Code update the plugin's.
 */
export function registered(): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
    // A record from before `complete` was kept was written only once every host ran its copy.
    return record.root === registeredRoot() && record.version === VERSION && record.build === installed().build && record.complete !== false;
  } catch {
    return false;
  }
}

const lastLine = (text: string) => text.split('\n').filter(Boolean).pop() ?? text;
export const COMMAND = path.join(os.homedir(), '.local', 'bin', 'crew');

/** Puts `crew` in ~/.local/bin, running the registered copy's CLI on its Node: the app's for a built copy, PATH's for source. */
function linkCommand(root: string): void {
  const cli = path.join(root, 'plugin', 'bridge', `cli${path.extname(import.meta.filename)}`);
  const runtime = bundledRuntime(root);
  fs.mkdirSync(path.dirname(COMMAND), { recursive: true });
  for (const file of [COMMAND, `${COMMAND}.cmd`, `${COMMAND}.mjs`]) fs.rmSync(file, { force: true });
  if (process.platform === 'win32') {
    // A symlink needs Developer Mode or an elevated shell. cmd.exe reads a .cmd file in the console code page, so the
    // script's path, which may not be ASCII, is left to a UTF-8 module beside the shims; the runtime's path is written
    // through %LOCALAPPDATA% or %USERPROFILE% where it can be.
    const node = runtime ?? 'node';
    const base = runtime ? ['LOCALAPPDATA', 'USERPROFILE'].find((name) => process.env[name] && node.toLowerCase().startsWith(process.env[name]!.toLowerCase())) : undefined;
    const cmdNode = base ? `%${base}%${node.slice(process.env[base]!.length)}` : node;
    fs.writeFileSync(`${COMMAND}.mjs`, `import ${JSON.stringify(pathToFileURL(cli).href)};\n`);
    fs.writeFileSync(`${COMMAND}.cmd`, `@"${cmdNode}" "%~dp0crew.mjs" %*\r\n`);
    // For Git Bash, which Claude Code's shell is on Windows.
    fs.writeFileSync(COMMAND, `#!/bin/sh\nexec "${node.replaceAll('\\', '/')}" "$(dirname "$0")/crew.mjs" "$@"\n`);
  } else if (runtime) {
    fs.writeFileSync(COMMAND, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(cli)} "$@"\n`, { mode: 0o755 });
  } else fs.symlinkSync(cli, COMMAND);
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export type SetupItem = {
  id: string;
  label: string;
  ok: boolean;
  detail: string;
  /** A short, translatable message for the checklist. The detail is available for troubleshooting. */
  summary?: string;
  repairable?: boolean;
  /** Crew's Codex hooks wait for the user's trust, which the checklist can record (`trustCodexHooks`). */
  trustable?: boolean;
};

/**
 * The checklist's answer, kept for a while: a check starts five CLIs, and the board and the app each ask every
 * minute for as long as they are open. A complete checklist is kept for ten minutes; one with something missing,
 * or a check that failed, for one, so a fix shows soon.
 */
export class SetupCache {
  static readonly COMPLETE_MS = 10 * 60_000;
  static readonly INCOMPLETE_MS = 60_000;
  private check: () => Promise<SetupItem[]>;
  private now: () => number;
  private kept: Promise<SetupItem[]> | null = null;
  private since = 0;
  private complete = false;

  constructor(check: () => Promise<SetupItem[]>, now: () => number = Date.now) {
    this.check = check;
    this.now = now;
  }

  /** `after` is waited for before a new check starts, so a check never reads a registration still being made. */
  get(refresh: boolean, after: Promise<unknown> = Promise.resolve()): Promise<SetupItem[]> {
    if (refresh || !this.kept || this.now() - this.since > (this.complete ? SetupCache.COMPLETE_MS : SetupCache.INCOMPLETE_MS)) {
      this.since = this.now();
      this.complete = false;
      const checking = after.then(() => this.check());
      this.kept = checking;
      // Only the check still kept says how long it is kept: an older one that ends later must not vouch for a newer answer.
      checking.then((items) => {
        if (this.kept === checking) this.complete = items.every((item) => item.ok);
      }, () => {});
    }
    return this.kept;
  }

  /** The next answer is checked anew. */
  reset(): void {
    this.kept = null;
  }
}

/**
 * A job ledger the daemon set aside is the only sign that the jobs, receipts and pull request watches it held are
 * gone from view; the checklist is where the board, the apps and `crew doctor` already look.
 */
export function ledgerItem(home = HOME): SetupItem | null {
  let aside: string[];
  try {
    aside = fs.readdirSync(home).filter((name) => name.startsWith(LEDGER_ASIDE)).sort();
  } catch {
    return null;
  }
  if (!aside.length) return null;
  const file = path.join(home, aside.at(-1)!);
  return {
    id: 'ledger',
    label: 'Job ledger',
    ok: false,
    detail: `Crew could not read its job ledger and set it aside as ${file}. The jobs, delivery receipts and pull request watches it held are not in the current ledger. To bring them back, quit Crew, repair the file and put it back as jobs.json; otherwise delete it.`,
    summary: 'Crew could not read the job ledger. Run `crew doctor` for the recovery steps.',
  };
}

/** Checks what a Codex session needs to lead so the user can set it up before starting their first Crew job. */
async function codexLeadItems(bin: string): Promise<{ registered: boolean; plugin: SetupItem; hooks?: SetupItem }> {
  // Only Crew's marketplace: the whole list includes remote marketplaces, which can take a minute and megabytes.
  const list = await run(bin, ['plugin', 'list', '--marketplace', 'crew'], 60_000);
  // Columns are padded with two or more spaces: id, status ("installed, enabled", "not installed"), version, source.
  const columns = list.ok ? list.out.split('\n').map((line) => line.trim().split(/\s{2,}/)).find((row) => row[0] === CODEX_PLUGIN) : undefined;
  const status = columns?.[1] ?? '';
  const installed = /^installed\b/.test(status) && /\benabled\b/.test(status);
  const version = columns && columns.length > 3 ? columns[2] : undefined;
  // Another version is a registration that did not finish; on Windows its copy of the runtime may be gone.
  const expected = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, '.codex-plugin', 'plugin.json'), 'utf8')).version;
  const ok = installed && version === expected;
  const detail = !installed ? 'Not installed.' : ok ? `Installed (${version})` : `Installed (${version ?? 'unknown version'}); this copy is ${expected}.`;
  const plugin: SetupItem = {
    id: 'codex-plugin', label: 'Crew plugin in Codex', ok, detail, repairable: true,
    summary: ok ? 'Installed' : 'Select Install to set up the Crew plugin in Codex.',
  };
  // Trust is read by this copy's hook keys, so a copy of another version is reinstalled before its hooks are asked about.
  return { registered: installed, plugin, hooks: ok ? await codexHooksItem(bin) : undefined };
}

/** The Crew hooks' trust as Codex reports it; never "trusted" unless Codex says every one is. */
export async function codexHooksItem(bin: string, timeout = HOOK_LIST_TIMEOUT_MS): Promise<SetupItem> {
  const item = { id: 'codex-hooks', label: 'Crew hooks in Codex' };
  let trust: HookTrust;
  try {
    trust = hookTrust(await withAppServer(bin, timeout, listCrewHooks));
  } catch (err) {
    return {
      ...item, ok: false,
      detail: `Could not ask Codex whether they are trusted (${(err as Error).message}). To check manually, open Settings → Hooks in Codex or use \`/hooks\` in the CLI.`,
      summary: 'Could not check hook trust. Select Check Again or open Settings → Hooks in Codex.',
    };
  }
  if (trust === 'trusted') return { ...item, ok: true, detail: 'Trusted.', summary: 'Complete' };
  if (trust === 'missing' && PACKAGED) {
    // The app leaves a source checkout's registration as it is, so its Install would not add the hooks.
    const list = await run(bin, ['plugin', 'marketplace', 'list'], 60_000);
    const current = list.ok ? codexMarketplaces(list.out).get('crew') : undefined;
    if (current && !sameFolder(current, path.join(CODEX_DIR, 'marketplace')) && !writtenByCrew(current)) return {
      ...item, ok: false, detail: `Codex runs Crew from ${current}, which the app leaves as it is. Run \`crew install\` from there to add its hooks to ${codexHooksFile()}.`,
      summary: 'Run `crew install` from the Crew checkout Codex runs.',
    };
  }
  if (trust === 'missing') return {
    ...item, ok: false, repairable: true, detail: `Crew's hooks are missing from ${codexHooksFile()}, or are there more than once.`,
    summary: 'Select Install to add Crew hooks to Codex.',
  };
  if (trust === 'disabled') return { ...item, ok: false, detail: 'In Codex, open Settings → Hooks and turn on the disabled Crew hooks.' };
  const detail = `Crew's hooks in ${codexHooksFile()} run ${crewLauncher()}. To let Codex run them, ${CODEX_TRUST}`;
  if (trust === 'modified') return { ...item, ok: false, trustable: true, detail, summary: 'Crew hooks were updated. Select Trust Hooks to trust them again.' };
  return { ...item, ok: false, trustable: true, detail, summary: 'Select Trust Hooks to let Codex run Crew hooks.' };
}

/**
 * Records the user's trust in Crew's hooks with Codex, as they asked from the checklist: only hooks with the commands
 * Crew writes, at the definition Codex lists now (app-server `config/batchWrite`, which Codex's own hook review uses).
 */
export async function trustCodexHooks(bin = loadConfig().codex.bin, timeout = HOOK_LIST_TIMEOUT_MS): Promise<void> {
  await withAppServer(bin, timeout, async (request) => {
    const edits = (await listCrewHooks(request)).filter((hook) => hook !== undefined && hook.trustStatus !== 'trusted').map((hook) => ({
      keyPath: `hooks.state.${JSON.stringify(hook!.key)}.trusted_hash`, value: hook!.currentHash, mergeStrategy: 'replace',
    }));
    if (edits.length) await request('config/batchWrite', { edits, reloadUserConfig: true });
  });
}

const HOOK_LIST_TIMEOUT_MS = 10_000;

/** The launcher Crew's Codex hooks run, which registration writes. */
const crewLauncher = () => launcherPath(path.join(CODEX_DIR, 'bin'));

/**
 * Crew's hooks as Codex lists them now (`hooks/list`), with the commands this copy writes. Codex's config keeps a trust
 * record after the hook it trusted has changed, so the config alone cannot say.
 */
async function listCrewHooks(request: AppServerRequest): Promise<(ListedHook | undefined)[]> {
  const expected = crewHooks(codexHooks(readJson(path.join(PLUGIN_ROOT, CODEX_HOOKS)), crewLauncher()));
  // User hooks are listed for any folder; the home folder needs no project trust.
  return listedCrewHooks(await request('hooks/list', { cwds: [os.homedir()] }), codexHooksFile(), expected);
}

type AppServerRequest = (method: string, params: unknown) => Promise<unknown>;

/** Runs `use` against a short-lived `codex app-server`. Throws when Codex cannot be asked. */
async function withAppServer<T>(bin: string, timeout: number, use: (request: AppServerRequest) => Promise<T>): Promise<T> {
  const env = agentEnv();
  const command = agentCommand(bin, ['app-server'], env);
  const child = spawn(command.bin, command.args ?? [], { env, shell: command.shell, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const peer = new RpcPeer(child, { onNotification: () => {}, onRequest: async () => undefined, onExit: () => {} }, command.shell);
  try {
    await peer.request('initialize', { clientInfo: { name: 'crew', title: 'Crew', version: VERSION }, capabilities: null }, timeout);
    peer.notify('initialized');
    return await use((method, params) => peer.request(method, params, timeout));
  } finally {
    child.stdin.end();
    peer.close();
  }
}

async function claudeLoginItem(): Promise<SetupItem> {
  const item = { id: 'claude-login', label: 'Claude Code sign-in' };
  const status = await run('claude', ['auth', 'status', '--json']);
  let loggedIn: unknown;
  try {
    loggedIn = JSON.parse(status.out)?.loggedIn;
  } catch { /* Older CLIs may lack the status command. */ }
  if (status.ok && loggedIn === true) return { ...item, ok: true, detail: 'Signed in.', summary: 'Complete' };
  if (loggedIn === false) return { ...item, ok: false, detail: 'Run `claude auth login` in a terminal.', summary: 'Sign in to Claude Code.' };
  // Only a clear "signed out" fails: an item nothing can repair would keep the checklist up for a CLI that cannot say,
  // such as an older version or a sign-in this command does not report.
  const detail = /unknown (command|option)|unrecognized (command|option)/i.test(status.out)
    ? 'This Claude Code version has no supported sign-in status command.'
    : 'Could not check Claude Code sign-in.';
  return { ...item, ok: true, detail, summary: 'Not checked' };
}

/** What Crew needs, as the app's checklist and `crew doctor` show it. Signing in is always left to the user. */
export async function checks(): Promise<SetupItem[]> {
  const config = loadConfig();
  const [claude, plugins, codex, agy] = await Promise.all([
    run('claude', ['--version']),
    claudeList<InstalledPlugin>(['plugin', 'list'], 'id').then((result) => result.rows),
    run(config.codex.bin, ['--version']),
    run(config.antigravity.bin, ['--version']),
  ]);
  const [claudeLogin, codexLogin, codexLead] = await Promise.all([
    claude.ok ? claudeLoginItem() : null,
    codex.ok ? run(config.codex.bin, ['login', 'status']) : null,
    codex.ok ? codexLeadItems(config.codex.bin) : null,
  ]);
  const items: SetupItem[] = [
    {
      id: 'claude', label: 'Claude Code', ok: claude.ok,
      detail: claude.ok ? claude.out : 'Not found. Install Claude Code from claude.com/code.',
      summary: claude.ok ? 'Installed' : 'Install Claude Code from claude.com/code.',
    },
  ];
  if (claudeLogin) items.push(claudeLogin);
  const plugin = plugins?.find((entry) => entry.id === 'crew@crew');
  const here = plugin?.readFromFolder && samePath(plugin.readFromFolder, path.join(registeredRoot(), 'plugin'));
  // Claude Code's plugin. A user who leads only from Codex has Codex's plugin as its own item below, so the same plugin is
  // not asked for twice; with neither host there is nothing to install the plugin into.
  if (claude.ok || !codexLead) {
    items.push({
      id: 'plugin',
      label: 'Crew plugin',
      ok: Boolean(plugin),
      detail: !claude.ok ? 'Needs Claude Code or Codex.' : !plugin ? 'Not installed.' : here ? `Installed (${plugin.version})` : `Installed from ${plugin.readFromFolder ?? 'another copy'} (${plugin.version})`,
      summary: plugin ? 'Installed' : claude.ok ? 'Select Install to add the Crew plugin.' : 'Install Claude Code or Codex first.',
      repairable: claude.ok,
    });
  }
  const command = fs.existsSync(COMMAND) || fs.existsSync(`${COMMAND}.cmd`);
  items.push({
    id: 'command', label: '`crew` command', ok: command, detail: command ? COMMAND : 'Not installed.', repairable: true,
    summary: command ? 'Installed' : 'Select Install to add the `crew` command.',
  });
  items.push({
    id: 'codex', label: 'Codex CLI', ok: codex.ok,
    detail: codex.ok ? codex.out : 'Not found. Install Codex, then run `codex login`.',
    summary: codex.ok ? 'Installed' : 'Install the Codex CLI.',
  });
  if (codexLogin) items.push({
    id: 'codex-login', label: 'Codex sign-in', ok: codexLogin.ok,
    detail: codexLogin.ok ? lastLine(codexLogin.out) : 'Run `codex login` in a terminal.',
    summary: codexLogin.ok ? 'Complete' : 'Run `codex login` to sign in.',
  });
  if (codexLead) items.push(codexLead.plugin);
  if (codexLead?.hooks) items.push(codexLead.hooks);
  if (config.antigravity.enabled) {
    items.push({
      id: 'antigravity', label: 'Antigravity CLI', ok: agy.ok,
      detail: agy.ok ? agy.out : 'Not found. Install it, then run `agy` once to sign in.',
      summary: agy.ok ? 'Installed' : 'Install the Antigravity CLI, then run `agy` to sign in.',
    });
  }
  const ledger = ledgerItem();
  if (ledger) items.push(ledger);
  return items;
}
