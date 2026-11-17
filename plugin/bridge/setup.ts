import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agentCommand, agentEnv, HOME, installed, loadConfig, PLUGIN_ROOT, VERSION } from './config.ts';

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

export function run(bin: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string }> {
  const env = agentEnv();
  const command = agentCommand(bin, args, env);
  return new Promise((resolve) => {
    execFile(command.bin, command.args, { env, shell: command.shell, timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: (stdout || stderr || err?.message || '').trim() });
    });
  });
}

async function claudeJSON<T>(args: string[]): Promise<T | null> {
  const res = await run('claude', [...args, '--json'], 60_000);
  if (!res.ok) return null;
  try { return JSON.parse(res.out) as T; } catch { return null; }
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
 * Registers this copy's marketplace and installs or updates the plugin from it, then points the `crew` command here.
 * An app leaves a plugin registered from a source checkout alone: that is a developer's install.
 */
export async function register(): Promise<Registration> {
  const marketplaces = await claudeJSON<Marketplace[]>(['plugin', 'marketplace', 'list']);
  if (!marketplaces) return { ok: false, detail: 'Claude Code was not found. Install it, then try again.' };
  const current = marketplaces.find((entry) => entry.name === 'crew');
  const root = registeredRoot();
  if (PACKAGED && current?.path && !samePath(current.path, root) && fromSource(current.path)) {
    return { ok: true, detail: `Registered from a source checkout (${current.path}); the app leaves it as it is.` };
  }
  if (COPIED) copyPlugin(MARKETPLACE, root);
  if (!current?.path || !samePath(current.path, root)) {
    // Adding a marketplace under a name already taken points that name at the new folder.
    const added = await run('claude', ['plugin', 'marketplace', 'add', root], 60_000);
    if (!added.ok) return { ok: false, detail: `Could not register the marketplace: ${lastLine(added.out)}` };
  }
  const plugins = await claudeJSON<InstalledPlugin[]>(['plugin', 'list']);
  const plugin = plugins?.find((entry) => entry.id === 'crew@crew');
  // A copy of another build with the same version has Claude Code read the plugin from the new folder too.
  const moved = plugin?.readFromFolder !== undefined && !samePath(plugin.readFromFolder, path.join(root, 'plugin'));
  const step = !plugin ? ['install', 'crew@crew'] : plugin.version !== VERSION || (COPIED && moved) ? ['update', 'crew@crew'] : null;
  if (step) {
    const res = await run('claude', ['plugin', ...step], 60_000);
    if (!res.ok) return { ok: false, detail: `Could not ${step[0]} the plugin: ${lastLine(res.out)}` };
  }
  linkCommand(root);
  if (PACKAGED) fs.writeFileSync(RECORD, `${JSON.stringify({ root, version: VERSION, build: installed().build }, null, 2)}\n`);
  if (COPIED) prunePlugins();
  return { ok: true, detail: step ? 'Installed. Open a new Claude Code session, or run /reload-plugins, to load it.' : 'Up to date.' };
}

/** A marketplace folder holding a source checkout rather than a built copy: a developer's install. */
const fromSource = (folder: string) => fs.existsSync(folder) && !fs.existsSync(path.join(folder, 'plugin', '.claude-plugin', 'build'));

/**
 * Whether Claude Code no longer reads the plugin from the copy this app registered, although the record says it does.
 * This was seen right after a registration, likely another Claude Code process starting meanwhile and writing back the
 * marketplace it had loaded.
 */
export async function registrationMoved(): Promise<boolean> {
  if (!COPIED) return false;
  const plugin = (await claudeJSON<InstalledPlugin[]>(['plugin', 'list']))?.find((entry) => entry.id === 'crew@crew');
  // A plugin the user removed stays removed.
  if (!plugin?.readFromFolder) return false;
  return !samePath(plugin.readFromFolder, path.join(registeredRoot(), 'plugin')) && !fromSource(path.resolve(plugin.readFromFolder, '..'));
}

/**
 * Whether this built copy has been registered since it was installed or last updated. The version counts as well as
 * the code: a release that changes only the version still has Claude Code update the plugin's.
 */
export function registered(): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
    return record.root === registeredRoot() && record.version === VERSION && record.build === installed().build;
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

export type SetupItem = { id: string; label: string; ok: boolean; detail: string; repairable?: boolean };

/** What Crew needs, as the app's checklist and `crew doctor` show it. Signing in is always left to the user. */
export async function checks(): Promise<SetupItem[]> {
  const config = loadConfig();
  const [claude, plugins, codex, agy] = await Promise.all([
    run('claude', ['--version']),
    claudeJSON<InstalledPlugin[]>(['plugin', 'list']),
    run(config.codex.bin, ['--version']),
    run(config.antigravity.bin, ['--version']),
  ]);
  const items: SetupItem[] = [
    { id: 'claude', label: 'Claude Code', ok: claude.ok, detail: claude.ok ? claude.out : 'Not found. Install Claude Code from claude.com/code.' },
  ];
  const plugin = plugins?.find((entry) => entry.id === 'crew@crew');
  const here = plugin?.readFromFolder && samePath(plugin.readFromFolder, path.join(registeredRoot(), 'plugin'));
  items.push({
    id: 'plugin',
    label: 'Crew plugin',
    ok: Boolean(plugin),
    detail: !claude.ok ? 'Needs Claude Code.' : !plugin ? 'Not installed.' : here ? `Installed (${plugin.version})` : `Installed from ${plugin.readFromFolder ?? 'another copy'} (${plugin.version})`,
    repairable: claude.ok,
  });
  const command = fs.existsSync(COMMAND) || fs.existsSync(`${COMMAND}.cmd`);
  items.push({ id: 'command', label: '`crew` command', ok: command, detail: command ? COMMAND : 'Not installed.', repairable: true });
  const codexLogin = codex.ok ? await run(config.codex.bin, ['login', 'status']) : null;
  items.push({ id: 'codex', label: 'Codex CLI', ok: codex.ok, detail: codex.ok ? codex.out : 'Not found. Install Codex, then run `codex login`.' });
  if (codexLogin) items.push({ id: 'codex-login', label: 'Codex sign-in', ok: codexLogin.ok, detail: codexLogin.ok ? lastLine(codexLogin.out) : 'Run `codex login` in a terminal.' });
  if (config.antigravity.enabled) {
    items.push({ id: 'antigravity', label: 'Antigravity CLI', ok: agy.ok, detail: agy.ok ? agy.out : 'Not found. Install it, then run `agy` once to sign in.' });
  }
  return items;
}
