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
function bundledRuntime(): string | null {
  for (const file of [path.join(MARKETPLACE, '..', 'runtime', 'node'), path.join(MARKETPLACE, 'runtime', 'node.exe')]) {
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export type Registration = { ok: boolean; detail: string };

/**
 * Registers this copy's marketplace and installs or updates the plugin from it, then points the `crew` command here.
 * An app leaves a plugin registered from a source checkout alone: that is a developer's install.
 */
export async function register(): Promise<Registration> {
  const marketplaces = await claudeJSON<Marketplace[]>(['plugin', 'marketplace', 'list']);
  if (!marketplaces) return { ok: false, detail: 'Claude Code was not found. Install it, then try again.' };
  const current = marketplaces.find((entry) => entry.name === 'crew');
  const fromSource = (folder: string) => fs.existsSync(folder) && !fs.existsSync(path.join(folder, 'plugin', '.claude-plugin', 'build'));
  if (PACKAGED && current?.path && path.resolve(current.path) !== MARKETPLACE && fromSource(current.path)) {
    return { ok: true, detail: `Registered from a source checkout (${current.path}); the app leaves it as it is.` };
  }
  if (!current?.path || path.resolve(current.path) !== MARKETPLACE) {
    // Adding a marketplace under a name already taken points that name at the new folder.
    const added = await run('claude', ['plugin', 'marketplace', 'add', MARKETPLACE], 60_000);
    if (!added.ok) return { ok: false, detail: `Could not register the marketplace: ${lastLine(added.out)}` };
  }
  const plugins = await claudeJSON<InstalledPlugin[]>(['plugin', 'list']);
  const plugin = plugins?.find((entry) => entry.id === 'crew@crew');
  const step = !plugin ? ['install', 'crew@crew'] : plugin.version !== VERSION ? ['update', 'crew@crew'] : null;
  if (step) {
    const res = await run('claude', ['plugin', ...step], 60_000);
    if (!res.ok) return { ok: false, detail: `Could not ${step[0]} the plugin: ${lastLine(res.out)}` };
  }
  linkCommand();
  if (PACKAGED) fs.writeFileSync(RECORD, `${JSON.stringify({ root: MARKETPLACE, build: installed().build }, null, 2)}\n`);
  return { ok: true, detail: step ? 'Installed. Open a new Claude Code session, or run /reload-plugins, to load it.' : 'Up to date.' };
}

/** Whether this built copy has been registered since it was installed or last updated. */
export function registered(): boolean {
  try {
    const record = JSON.parse(fs.readFileSync(RECORD, 'utf8'));
    return record.root === MARKETPLACE && record.build === installed().build;
  } catch {
    return false;
  }
}

const lastLine = (text: string) => text.split('\n').filter(Boolean).pop() ?? text;
export const COMMAND = path.join(os.homedir(), '.local', 'bin', 'crew');

/** Puts `crew` in ~/.local/bin, running this copy's CLI on its Node: the app's for a built copy, PATH's for source. */
function linkCommand(): void {
  const cli = path.join(PLUGIN_ROOT, 'bridge', `cli${path.extname(import.meta.filename)}`);
  const runtime = bundledRuntime();
  fs.mkdirSync(path.dirname(COMMAND), { recursive: true });
  for (const file of [COMMAND, `${COMMAND}.cmd`, `${COMMAND}.mjs`]) fs.rmSync(file, { force: true });
  if (process.platform === 'win32') {
    // A symlink needs Developer Mode or an elevated shell. cmd.exe reads a .cmd file in the console code page, so the
    // script's path, which may not be ASCII, is left to a UTF-8 module beside the shims; the runtime's path is written
    // through %LOCALAPPDATA% where it can be.
    const local = process.env.LOCALAPPDATA;
    const node = runtime ?? 'node';
    const cmdNode = runtime && local && node.toLowerCase().startsWith(local.toLowerCase()) ? `%LOCALAPPDATA%${node.slice(local.length)}` : node;
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
  const here = plugin?.readFromFolder && path.resolve(plugin.readFromFolder) === PLUGIN_ROOT;
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
