import { randomBytes } from 'node:crypto';
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

  // Built beside the old folder and swapped in, since Codex fails to list any marketplace while one registered root
  // is incomplete, and a folder left half deleted (Windows refuses to remove files another process holds open) would
  // also have lost the marker that lets the next registration replace it.
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(dest)) {
    // Recent ones may belong to a registration another Crew process is running now.
    const leftover = path.join(dest, name);
    if (LEFTOVER.test(name) && Date.now() - (fs.statSync(leftover, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > LEFTOVER_AGE_MS) removeLeftover(leftover);
  }
  const temp = `${marketplace}.${randomBytes(6).toString('hex')}`;
  try {
    fs.mkdirSync(temp);
    fs.writeFileSync(path.join(temp, MARKER), 'Written by Crew for Codex from a built copy; rewritten at each registration.\n');
    fs.cpSync(path.join(root, '.claude-plugin', 'marketplace.json'), path.join(temp, '.claude-plugin', 'marketplace.json'));
    const out = path.join(temp, 'plugin');
    // The skills send Codex to ../../agents for their subagents' instructions.
    for (const folder of ['.codex-plugin', 'skills', 'agents']) fs.cpSync(path.join(plugin, folder), path.join(out, folder), { recursive: true });
    const mcp = codexMcp(JSON.parse(fs.readFileSync(path.join(plugin, pointer(manifest.mcpServers)), 'utf8')), runtime, bridge);
    writeJson(path.join(out, pointer(manifest.mcpServers)), mcp);
    fs.cpSync(path.join(plugin, pointer(manifest.hooks)), path.join(out, pointer(manifest.hooks)));
    const old = `${temp}.old`;
    const replacing = fs.existsSync(marketplace);
    if (replacing) renameRetrying(marketplace, old);
    try {
      renameRetrying(temp, marketplace);
    } catch (err) {
      try {
        if (replacing) renameRetrying(old, marketplace);
      } catch (restore) {
        throw new Error(`${(err as Error).message}; putting the old folder back failed too: ${(restore as Error).message}`);
      }
      throw err;
    }
    // A copy that cannot be removed yet is cleared at the next registration.
    if (replacing) removeLeftover(old);
  } finally {
    removeLeftover(temp);
  }
  return marketplace;
}

/** A marketplace being built, or one swapped out, that an earlier registration could not remove. */
const LEFTOVER = /^marketplace\.[0-9a-f]{12}(\.old)?$/;
const LEFTOVER_AGE_MS = 10 * 60_000;

/** Renames a folder, waiting out Windows refusing it for a moment while a scanner holds new files open. */
function renameRetrying(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      return fs.renameSync(from, to);
    } catch (err) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100 * (attempt + 1));
    }
  }
}
const removeLeftover = (folder: string) => {
  try {
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    // Still held open; it does no harm where it is.
  }
};

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
    const command = `${commandPrefix(launcher, platform)}${match[1]}${match[2]}${platform === 'win32' ? '; exit $LASTEXITCODE' : ''}`;
    return { ...entry, command };
  };
  const events = Object.entries(source.hooks).map(([event, groups]) => [event, groups.map((group) => ({ ...group, hooks: group.hooks.map(rewrite) }))]);
  return { ...source, hooks: Object.fromEntries(events) };
}

/**
 * Puts Crew's `hooks` (from `codexHooks`, running `launcher`) in the user's Codex hooks file at `file`, keeping
 * everything else in it, and returns whether the file changed. Crew's handlers are those whose command starts the way
 * `codexHooks` writes one, `<launcher> <script>`; each is taken out wherever it is, so none is left twice. Crew's
 * groups go where the first group holding one stood, so the key Codex trusts each hook by, its event, group and
 * index, stays the same, and new ones go after the user's own. A user's handler inside Crew's group stays, in a group
 * of its own, unless Crew's handlers are already as `hooks` has them: then the file is left as it is, so registering
 * again moves no one's hook. A file that is not a hooks file is left as it is.
 */
export function installCodexHooks(file: string, hooks: HooksFile, launcher: string, platform: NodeJS.Platform = process.platform): boolean {
  let current: { hooks?: unknown; [key: string]: unknown } = { hooks: {} };
  // A link whose target is missing counts as no file: writing through it creates the target.
  const exists = fs.existsSync(file);
  if (exists) {
    current = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!current || typeof current !== 'object' || Array.isArray(current)) throw new Error(`${file} is not a Codex hooks file.`);
  }
  const existing = current.hooks ?? {};
  if (typeof existing !== 'object' || Array.isArray(existing)) throw new Error(`${file} is not a Codex hooks file.`);
  const events = { ...existing } as Record<string, unknown>;
  const prefix = commandPrefix(launcher, platform);
  const ours = (hook: unknown) => typeof (hook as HookEntry | null)?.command === 'string' && (hook as HookEntry).command!.startsWith(prefix);
  const names = [...new Set([...Object.keys(events), ...Object.keys(hooks.hooks)])];
  for (const event of names) {
    const groups = events[event] ?? [];
    if (!Array.isArray(groups) || groups.some((group) => !Array.isArray(group?.hooks))) throw new Error(`${file} has hooks for ${event} that are not a list.`);
  }
  const installed = (event: string) => JSON.stringify((events[event] as { hooks: unknown[] }[] | undefined ?? []).flatMap((group) => group.hooks.filter(ours)));
  const wanted = (event: string) => JSON.stringify((hooks.hooks[event] ?? []).flatMap((group) => group.hooks));
  if (names.every((event) => installed(event) === wanted(event))) return false;
  for (const event of names) {
    const groups = (events[event] ?? []) as { hooks: unknown[] }[];
    const at = groups.findIndex((group) => group.hooks.some(ours));
    // A group of Crew's alone goes; one the user added a handler to keeps the user's handlers.
    const kept = groups.flatMap((group) => {
      if (!group.hooks.some(ours)) return [group];
      const theirs = group.hooks.filter((hook: unknown) => !ours(hook));
      return theirs.length ? [{ ...group, hooks: theirs }] : [];
    });
    // The groups before the first with a Crew handler are all kept as they are.
    const before = at === -1 ? kept.length : at;
    const next = [...kept.slice(0, before), ...(hooks.hooks[event] ?? []), ...kept.slice(before)];
    if (next.length) events[event] = next;
    else delete events[event];
  }
  const updated = { ...current, hooks: events };
  if (JSON.stringify(updated) === JSON.stringify(current)) return false;
  if (!exists) fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written in place rather than replaced, so the file keeps what the user gave it: a symbolic link, its permissions,
  // and on Windows its access control list, which a replacement would take from the folder instead.
  fs.writeFileSync(file, `${JSON.stringify(updated, null, 2)}\n`);
  return true;
}

/** How `codexHooks` starts each command it writes, on `platform`: the quoted launcher and a space. */
const commandPrefix = (launcher: string, platform: NodeJS.Platform) => `${platform === 'win32' ? '& ' : ''}${quoteFor(platform)(launcher)} `;

/** A Crew hook as it is written in the user's Codex hooks file. */
export type CrewHook = { event: string; command: string };

/** Every hook in `hooks` (from `codexHooks`), by event and command. */
export const crewHooks = (hooks: HooksFile): CrewHook[] =>
  Object.entries(hooks.hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.map((hook) => ({ event, command: hook.command ?? '' }))));

/** A hook as app-server `hooks/list` reports it, with the fields Crew reads. */
export type ListedHook = { key: string; eventName: string; command: string; sourcePath: string; currentHash: string; trustStatus: string; enabled?: boolean };

/**
 * Crew's hooks among those app-server `hooks/list` reports, matched by event, command and the hooks file at `file`
 * rather than by key, whose spelling of the file's path is Codex's own. Undefined where Codex lists no such hook, or
 * more than one: which of them Crew wrote is unknown, so neither is trusted, and registering again leaves one.
 */
export function listedCrewHooks(listed: unknown, file: string, expected: CrewHook[]): (ListedHook | undefined)[] {
  const data = (listed as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error('hooks/list answered without a list of hooks');
  const all: ListedHook[] = data.flatMap((entry) => (Array.isArray(entry?.hooks) ? entry.hooks : []));
  const ours = realPath(file);
  const sameFile = (source: unknown) => typeof source === 'string' && path.relative(realPath(source), ours) === '';
  // Codex names events in camel case: `SessionStart` is `sessionStart`.
  const camel = (event: string) => event[0].toLowerCase() + event.slice(1);
  return expected.map(({ event, command }) => {
    const matches = all.filter((hook) => hook?.eventName === camel(event) && hook.command === command && sameFile(hook.sourcePath));
    return matches.length === 1 ? matches[0] : undefined;
  });
}

/** A file's path as the file system resolves it, without Windows' extended-length prefix, which Codex may report. */
function realPath(file: string): string {
  const plain = file.replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '');
  try {
    return fs.realpathSync.native(plain);
  } catch {
    return path.resolve(plain);
  }
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

/**
 * The launcher `writeLauncher` writes in `dir`, which the hook commands name. Not the `hook` an earlier Crew wrote
 * there for its plugin hooks, which an older copy registering again would write back without the launcher's checks.
 */
export const launcherPath = (dir: string, platform: NodeJS.Platform = process.platform) => path.join(dir, platform === 'win32' ? 'lead-hook.cmd' : 'lead-hook');

/** Set in the environment of the `codex app-server` that runs Crew's workers, whose hooks the launcher skips. */
export const WORKER_ENV = 'CREW_CODEX_WORKER';

/**
 * Whether Codex's `config.toml` text has Crew's plugin installed and on: a `plugins."crew@crew"` table or key (Codex
 * removes the table with the plugin), its `enabled` not false, and the `plugins` feature not turned off. It reads the
 * TOML Codex and people write, comments and quoted keys included, but not multi-line strings. The launcher runs its
 * source, so it names nothing outside itself.
 */
export function crewPluginOn(config: string): boolean {
  const unquote = (key: string) => key.replace(/^"(.*)"$|^'(.*)'$/s, '$1$2');
  const keys = (dotted: string) => (dotted.match(/"[^"]*"|'[^']*'|[^.\s]+/g) ?? []).map(unquote);
  const falsy = (value: string) => /^false\b/.test(value.trim());
  let table: string[] = [];
  let present = false;
  let enabled = true;
  let plugins = true;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.replace(/^((?:[^#"']|"[^"]*"|'[^']*')*)#.*$/, '$1').trim();
    if (!line) continue;
    const header = /^\[\[?\s*(.+?)\s*\]\]?$/.exec(line);
    if (header) {
      table = keys(header[1]);
      if (table[0] === 'plugins' && table[1] === 'crew@crew') present = true;
      continue;
    }
    const pair = /^((?:"[^"]*"|'[^']*'|[^="'])+?)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = [...table, ...keys(pair[1])];
    if (key[0] === 'plugins' && key[1] === 'crew@crew') {
      present = true;
      if (key.length === 3 && key[2] === 'enabled') enabled = !falsy(pair[2]);
      const inline = key.length === 2 ? /["']?enabled["']?\s*=\s*(\w+)/.exec(pair[2]) : null;
      if (inline) enabled = !falsy(inline[1]);
    }
    if (key.length === 2 && key[0] === 'features' && key[1] === 'plugins') plugins = !falsy(pair[2]);
  }
  return present && enabled && plugins;
}

/**
 * The launcher hooks run: `hook <script> [args]` runs `<bridge>/<script><ext>` on the runtime, `.js` for a built
 * copy and `.ts` for a source checkout, in the same process so its exit code and output are the hook's. It is
 * rewritten in place at each registration, one file at a time, since an open session may run it at any moment.
 *
 * The hooks sit in the user's Codex hooks file, outside the plugin, so the launcher does what being the plugin's did:
 * it runs them only while Crew's plugin is installed and on in that Codex home, never for a Crew worker (which runs
 * with Crew's plugin off), and does nothing once the runtime or the script is gone with Crew.
 */
export function writeLauncher(dir: string, runtime: string, bridge: string, ext: '.js' | '.ts', platform: NodeJS.Platform = process.platform): string {
  fs.mkdirSync(dir, { recursive: true });
  const module = path.join(dir, 'lead-hook.mjs');
  writeAtomic(module, [
    "import fs from 'node:fs';",
    "import os from 'node:os';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    `const bridge = ${JSON.stringify(bridge)};`,
    'const [name, ...rest] = process.argv.slice(2);',
    "if (!/^[\\w-]+$/.test(name ?? '')) {",
    "  console.error('Usage: hook <script> [args...]');",
    '  process.exit(1);',
    '}',
    `if (process.env.${WORKER_ENV}) process.exit(0);`,
    crewPluginOn.toString(),
    "let config = '';",
    "try { config = fs.readFileSync(path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml'), 'utf8'); } catch {}",
    `if (!${crewPluginOn.name}(config)) process.exit(0);`,
    `const file = path.join(bridge, \`\${name}${ext}\`);`,
    'if (!fs.existsSync(file)) process.exit(0);',
    '// A script that runs only as the entry point compares process.argv[1] with its own path, which Node resolves.',
    'const script = fs.realpathSync(file);',
    'process.argv = [process.argv[0], script, ...rest];',
    'await import(pathToFileURL(script).href);',
    '',
  ].join('\n'));
  const launcher = launcherPath(dir, platform);
  // A source checkout's runtime is the `node` in PATH, which only an absolute runtime can be checked for beforehand.
  const fixed = path.isAbsolute(runtime);
  if (platform === 'win32') {
    // cmd.exe reads a .cmd file in the console code page, so the module's path, which may not be ASCII, is left to
    // %~dp0, and the runtime's is written through %LOCALAPPDATA% or %USERPROFILE% where it can be. cmd.exe would
    // look for a bare `node` in the session's project folder before PATH, unless told not to.
    const node = cmdPath(runtime);
    const lines = ['@set NoDefaultCurrentDirectoryInExePath=1', ...(fixed ? [`@if not exist "${node}" exit /b 0`] : []), `@"${node}" "%~dp0lead-hook.mjs" %*`];
    writeAtomic(launcher, `${lines.join('\r\n')}\r\n`);
    return launcher;
  }
  const check = fixed ? `[ -x ${shellQuote(runtime)} ] || exit 0\n` : '';
  writeAtomic(launcher, `#!/bin/sh\n${check}exec ${shellQuote(runtime)} ${shellQuote(module)} "$@"\n`, 0o755);
  return launcher;
}

function cmdPath(file: string): string {
  const base = ['LOCALAPPDATA', 'USERPROFILE'].find((name) => process.env[name] && file.toLowerCase().startsWith(process.env[name]!.toLowerCase()));
  return base ? `%${base}%${file.slice(process.env[base]!.length)}` : file;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
// PowerShell also takes the curly single quotes for quotes.
const powershellQuote = (value: string) => `'${value.replace(/['‘-‛]/g, '$&$&')}'`;
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
