import fs from 'node:fs';
import path from 'node:path';

/**
 * The plugin a built copy of Crew registers with Codex. Codex copies only a plugin's own folder into its cache, drops
 * symbolic links, and does not substitute `${PLUGIN_ROOT}` in MCP arguments (docs/mcp-compatibility.md#5-codex-as-a-lead-host),
 * so the app's Node beside the plugin is out of reach from there. Registration therefore writes a small marketplace
 * whose MCP server and hooks name the app's runtime and compiled bridge by absolute path.
 *
 * Codex trusts a plugin's hooks against a hash of the whole plugin folder, so any update would have the user trust
 * them again. Crew's hooks therefore go in the user's own Codex hooks file, which Codex trusts against each hook's
 * definition alone (Codex 0.172 `hooks/list`, Windows, 2026-11-25), and the plugin points Codex at an empty hooks
 * file. The commands name a launcher whose path stays the same across updates, and only the launcher, outside
 * Codex's files, names the build.
 */

export type HookEntry = { type?: string; command?: string; [key: string]: unknown };
export type HooksFile = { hooks: Record<string, Array<{ hooks: HookEntry[]; [key: string]: unknown }>>; [key: string]: unknown };
type McpFile = { mcpServers: Record<string, { command: string; args?: string[]; cwd?: string; [key: string]: unknown }> };

/** The plugin's id in Codex: plugin `crew` from marketplace `crew`. */
export const CODEX_PLUGIN = 'crew@crew';
/** Crew's hooks for Codex, relative to the plugin folder: the template for the user's Codex hooks file, not the plugin's. */
export const CODEX_HOOKS = 'hooks/codex.json';

const SOURCE_HOOK = /^node "\$\{PLUGIN_ROOT\}\/bridge\/([\w-]+)\.ts"((?: [\w-]+)*)$/;
const SOURCE_SERVER = /^\.\/bridge\/([\w-]+)\.ts$/;

/**
 * Writes the Codex marketplace for the built copy at `root` (its marketplace folder), run on `runtime`, under `dest`,
 * and returns its folder. The plugin's own Codex files are the templates: the MCP server's `node <bridge>.ts` becomes
 * the compiled script on the app's runtime, and the empty hooks file goes in as it is.
 */
export function writeCodexPlugin(root: string, runtime: string, dest: string): string {
  const plugin = path.join(root, 'plugin');
  const bridge = path.join(plugin, 'bridge');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  // Codex reads this folder only while `codex plugin add` copies it, so it is rebuilt whole, but only if Crew wrote it.
  const marketplace = path.join(dest, 'marketplace');
  if (fs.existsSync(marketplace) && !writtenByCrew(marketplace)) throw new Error(`${marketplace} was not written by Crew, so it is left as it is.`);

  fs.rmSync(marketplace, { recursive: true, force: true });
  fs.mkdirSync(marketplace, { recursive: true });
  fs.writeFileSync(path.join(marketplace, MARKER), 'Written by Crew for Codex from a built copy; rewritten at each registration.\n');
  fs.cpSync(path.join(root, '.claude-plugin', 'marketplace.json'), path.join(marketplace, '.claude-plugin', 'marketplace.json'));
  const out = path.join(marketplace, 'plugin');
  // The skills send Codex to ../../agents for their subagents' instructions.
  for (const folder of ['.codex-plugin', 'skills', 'agents']) fs.cpSync(path.join(plugin, folder), path.join(out, folder), { recursive: true });
  const mcp = codexMcp(JSON.parse(fs.readFileSync(path.join(plugin, pointer(manifest.mcpServers)), 'utf8')), runtime, bridge);
  writeJson(path.join(out, pointer(manifest.mcpServers)), mcp);
  fs.cpSync(path.join(plugin, pointer(manifest.hooks)), path.join(out, pointer(manifest.hooks)));
  return marketplace;
}

/** Marks a marketplace folder Crew wrote, the only kind registration replaces or removes. */
const MARKER = '.crew-codex-marketplace';
export const writtenByCrew = (marketplace: string) => fs.existsSync(path.join(marketplace, MARKER));

/** MCP servers started as `<runtime> <compiled script>`, in the session's folder rather than Codex's cache. */
export function codexMcp(source: McpFile, runtime: string, bridge: string): McpFile {
  const servers = Object.entries(source.mcpServers).map(([name, server]) => {
    const [script, ...rest] = server.args ?? [];
    const match = server.command === 'node' ? SOURCE_SERVER.exec(script ?? '') : null;
    if (!match) throw new Error(`Cannot rewrite the Codex MCP server "${name}" for a built copy: ${server.command} ${(server.args ?? []).join(' ')}`);
    const { cwd: _cwd, ...kept } = server;
    return [name, { ...kept, command: runtime, args: [path.join(bridge, `${match[1]}.js`), ...rest] }];
  });
  return { ...source, mcpServers: Object.fromEntries(servers) };
}

/** Hook commands that run `<launcher> <script> <args>`, quoted for the shell Codex runs hooks in on `platform`. */
export function codexHooks(source: HooksFile, launcher: string, platform: NodeJS.Platform = process.platform): HooksFile {
  const rewrite = (entry: HookEntry): HookEntry => {
    const match = SOURCE_HOOK.exec(entry.command ?? '');
    if (entry.type !== 'command' || !match) throw new Error(`Cannot rewrite the Codex hook: ${entry.command}`);
    // Codex runs hooks under pwsh.exe on Windows, which runs a quoted path only after `&` and otherwise ends with its
    // own status rather than the script's, and under the account's login shell elsewhere.
    const command = platform === 'win32'
      ? `& ${quoteFor(platform)(launcher)} ${match[1]}${match[2]}; exit $LASTEXITCODE`
      : `${quoteFor(platform)(launcher)} ${match[1]}${match[2]}`;
    return { ...entry, command };
  };
  const events = Object.entries(source.hooks).map(([event, groups]) => [event, groups.map((group) => ({ ...group, hooks: group.hooks.map(rewrite) }))]);
  return { ...source, hooks: Object.fromEntries(events) };
}

/**
 * Puts Crew's `hooks` (from `codexHooks`, running `launcher`) in the user's Codex hooks file at `file`, keeping
 * everything else in it, and returns whether the file changed. Crew's groups are those whose every hook runs the
 * launcher. They are replaced where they stand, so the key Codex trusts each hook by, its event, group and index,
 * stays the same, and new ones go after the user's own. A file that is not a hooks file is left as it is.
 */
export function installCodexHooks(file: string, hooks: HooksFile, launcher: string, platform: NodeJS.Platform = process.platform): boolean {
  let current: { hooks?: unknown; [key: string]: unknown } = { hooks: {} };
  if (fs.existsSync(file)) {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} is not a Codex hooks file.`);
  }
  const existing = current.hooks ?? {};
  if (typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`${file} is not a Codex hooks file.`);
  const events = { ...existing } as Record<string, unknown>;
  const marker = quoteFor(platform)(launcher);
  const ours = (group: unknown) => {
    const handlers = (group as { hooks?: unknown } | null)?.hooks;
    return Array.isArray(handlers) && handlers.length > 0 && handlers.every((hook) => typeof hook?.command === 'string' && hook.command.includes(marker));
  };
  for (const event of new Set([...Object.keys(events), ...Object.keys(hooks.hooks)])) {
    const groups = events[event] ?? [];
    if (!Array.isArray(groups)) throw new Error(`${file} has hooks for ${event} that are not a list.`);
    const at = groups.findIndex(ours);
    const kept = groups.filter((group) => !ours(group));
    const crew = hooks.hooks[event] ?? [];
    const next = at === -1 ? [...kept, ...crew] : [...kept.slice(0, at), ...crew, ...kept.slice(at)];
    if (next.length) events[event] = next;
    else delete events[event];
  }
  const updated = { ...current, hooks: events };
  if (JSON.stringify(updated) === JSON.stringify(current)) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeAtomic(file, `${JSON.stringify(updated, null, 2)}\n`);
  return true;
}

/** A Crew hook as it is written in the user's Codex hooks file. */
export type CrewHook = { event: string; command: string };

/** Every hook in `hooks` (from `codexHooks`), by event and command. */
export const crewHooks = (hooks: HooksFile): CrewHook[] =>
  Object.entries(hooks.hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => ({ event, command: hook.command ?? '' }))));

/** A hook as app-server `hooks/list` reports it, with the fields Crew reads. */
export type ListedHook = { key: string; eventName: string; command: string; sourcePath: string; currentHash: string; trustStatus: string; enabled?: boolean };

/**
 * Crew's hooks among those app-server `hooks/list` reports, matched by event, command and the hooks file at `file`
 * rather than by key, whose spelling of the file's path is Codex's own; undefined where Codex lists no such hook.
 */
export function listedCrewHooks(listed: unknown, file: string, expected: CrewHook[]): (ListedHook | undefined)[] {
  const data = (listed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('hooks/list answered without a list of hooks');
  const all: ListedHook[] = data.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
  const sameFile = (source: unknown) => typeof source === 'string' && path.relative(path.resolve(source.replace(/^\\\\\?\\/, '')), path.resolve(file)) === '';
  // Codex names events in camel case: `SessionStart` is `sessionStart`.
  const camel = (event: string) => event[0].toLowerCase() + event.slice(1);
  return expected.map(({ event, command }) => all.find((hook) => hook?.eventName === camel(event) && hook.command === command && sameFile(hook.sourcePath)));
}

/** Whether every Crew hook runs in Codex, or what the user still needs to do. */
export type HookTrust = 'trusted' | 'modified' | 'untrusted' | 'disabled' | 'missing';

/**
 * The Crew hooks' trust from `listedCrewHooks`. A hook Codex does not list is missing from the hooks file, which
 * registration puts back; one in a state Crew does not know counts as untrusted. Once all enabled hooks are trusted,
 * disabled hooks are reported so the checklist can tell the user to turn them on.
 */
export function hookTrust(found: (ListedHook | undefined)[]): HookTrust {
  if (found.some((hook) => hook === undefined)) return 'missing';
  const states = found.map((hook) => (hook!.enabled === false ? 'disabled' : hook!.trustStatus));
  if (states.some((state) => state !== 'trusted' && state !== 'modified' && state !== 'disabled')) return 'untrusted';
  if (states.includes('modified')) return 'modified';
  return states.includes('disabled') ? 'disabled' : 'trusted';
}

/** The plugin folder's relative path for a manifest pointer such as `./hooks/codex.json`. */
export const pointer = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('./')) throw new Error(`Expected a ./ path in .codex-plugin/plugin.json, got ${JSON.stringify(value)}`);
  return value.slice(2);
};

/** The launcher `writeLauncher` writes in `dir`, which the hook commands name. */
export const launcherPath = (dir: string, platform: NodeJS.Platform = process.platform) => path.join(dir, platform === 'win32' ? 'hook.cmd' : 'hook');

/**
 * The launcher hooks run: `hook <script> [args]` runs `<bridge>/<script><ext>` on the runtime, `.js` for a built
 * copy and `.ts` for a source checkout, in the same process so its exit code and output are the hook's. It is
 * rewritten in place at each registration, one file at a time, since an open session may run it at any moment.
 */
export function writeLauncher(dir: string, runtime: string, bridge: string, ext: '.js' | '.ts', platform: NodeJS.Platform = process.platform): string {
  fs.mkdirSync(dir, { recursive: true });
  const module = path.join(dir, 'hook.mjs');
  writeAtomic(module, [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `const bridge = ${JSON.stringify(bridge)};`,
    'const [name, ...rest] = process.argv.slice(2);',
    "if (!/^[\\w-]+$/.test(name ?? '')) {",
    "  console.error('Usage: hook <script> [args...]');",
    '  process.exit(1);',
    '}',
    `const file = path.join(bridge, \`\${name}${ext}\`);`,
    "// The hooks stay in the user's Codex hooks file after Crew is removed; they then do nothing.",
    'if (!fs.existsSync(file)) process.exit(0);',
    '// A script that runs only as the entry point compares process.argv[1] with its own path, which Node resolves.',
    'const script = fs.realpathSync(file);',
    'process.argv = [process.argv[0], script, ...rest];',
    'await import(pathToFileURL(script).href);',
    '',
  ].join('\n'));
  const launcher = launcherPath(dir, platform);
  if (platform === 'win32') {
    // cmd.exe reads a .cmd file in the console code page, so the module's path, which may not be ASCII, is left to
    // %~dp0, and the runtime's is written through %LOCALAPPDATA% or %USERPROFILE% where it can be.
    writeAtomic(launcher, `@"${cmdPath(runtime)}" "%~dp0hook.mjs" %*\r\n`);
    return launcher;
  }
  writeAtomic(launcher, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(module)} "$@"\n`, 0o755);
  return launcher;
}

function cmdPath(file: string): string {
  const base = ['LOCALAPPDATA', 'USERPROFILE'].find((name) => process.env[name] && file.toLowerCase().startsWith(process.env[name]!.toLowerCase()));
  return base ? `%${base}%${file.slice(process.env[base]!.length)}` : file;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const quoteFor = (platform: NodeJS.Platform) => (platform === 'win32' ? powershellQuote : shellQuote);

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomic(file: string, text: string, mode?: number): void {
  const partial = `${file}.partial-${process.pid}`;
  fs.writeFileSync(partial, text, mode === undefined ? undefined : { mode });
  try {
    fs.renameSync(partial, file);
  } catch (err) {
    // Windows can refuse to replace a file a hook is running.
    fs.rmSync(partial, { force: true });
    throw err;
  }
}
