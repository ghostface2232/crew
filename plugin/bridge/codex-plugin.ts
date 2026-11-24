import fs from 'node:fs';
import path from 'node:path';

/**
 * The plugin a built copy of Crew registers with Codex. Codex copies only a plugin's own folder into its cache, drops
 * symbolic links, and does not substitute `${PLUGIN_ROOT}` in MCP arguments (docs/mcp-compatibility.md#5-codex-as-a-lead-host),
 * so the app's Node beside the plugin is out of reach from there. Registration therefore writes a small marketplace
 * whose MCP server and hooks name the app's runtime and compiled bridge by absolute path.
 *
 * Codex asks the user to trust each hook again whenever its definition changes, so the hook commands name a launcher
 * whose path stays the same across updates, and only the launcher, outside the plugin folder, names the build.
 */

/** Where the marketplace and the hook launcher are written. */
export type CodexPluginPaths = { marketplace: string; launcher: string };

type HookEntry = { type?: string; command?: string; [key: string]: unknown };
type HooksFile = { hooks: Record<string, Array<{ hooks: HookEntry[]; [key: string]: unknown }>>; [key: string]: unknown };
type McpFile = { mcpServers: Record<string, { command: string; args?: string[]; cwd?: string; [key: string]: unknown }> };

/** The plugin's id in Codex: plugin `crew` from marketplace `crew`. */
export const CODEX_PLUGIN = 'crew@crew';

const SOURCE_HOOK = /^node "\$\{PLUGIN_ROOT\}\/bridge\/([\w-]+)\.ts"((?: [\w-]+)*)$/;
const SOURCE_SERVER = /^\.\/bridge\/([\w-]+)\.ts$/;

/**
 * Writes the Codex marketplace for the built copy at `root` (its marketplace folder), run on `runtime`, under `dest`.
 * The plugin's own Codex files are the templates: their `node <bridge>.ts` commands become the compiled scripts on
 * the app's runtime.
 */
export function writeCodexPlugin(root: string, runtime: string, dest: string, platform: NodeJS.Platform = process.platform): CodexPluginPaths {
  const plugin = path.join(root, 'plugin');
  const bridge = path.join(plugin, 'bridge');
  const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.codex-plugin', 'plugin.json'), 'utf8'));
  const launcher = writeLauncher(path.join(dest, 'bin'), runtime, bridge, platform);

  // Codex reads this folder only while `codex plugin add` copies it, so it is rebuilt whole.
  const marketplace = path.join(dest, 'marketplace');
  fs.rmSync(marketplace, { recursive: true, force: true });
  fs.cpSync(path.join(root, '.claude-plugin', 'marketplace.json'), path.join(marketplace, '.claude-plugin', 'marketplace.json'));
  const out = path.join(marketplace, 'plugin');
  fs.cpSync(path.join(plugin, '.codex-plugin'), path.join(out, '.codex-plugin'), { recursive: true });
  fs.cpSync(path.join(plugin, 'skills'), path.join(out, 'skills'), { recursive: true });
  const mcp = codexMcp(JSON.parse(fs.readFileSync(path.join(plugin, pointer(manifest.mcpServers)), 'utf8')), runtime, bridge);
  const hooks = codexHooks(JSON.parse(fs.readFileSync(path.join(plugin, pointer(manifest.hooks)), 'utf8')), launcher, platform);
  writeJson(path.join(out, pointer(manifest.mcpServers)), mcp);
  writeJson(path.join(out, pointer(manifest.hooks)), hooks);
  return { marketplace, launcher };
}

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
    if (entry.type !== 'command' || !match) throw new Error(`Cannot rewrite the Codex hook for a built copy: ${entry.command}`);
    // Codex runs hooks under pwsh.exe on Windows, which runs a quoted path only after `&`, and under the account's
    // login shell elsewhere.
    const command = platform === 'win32' ? `& ${powershellQuote(launcher)} ${match[1]}${match[2]}` : `${shellQuote(launcher)} ${match[1]}${match[2]}`;
    return { ...entry, command };
  };
  const events = Object.entries(source.hooks).map(([event, groups]) => [event, groups.map((group) => ({ ...group, hooks: group.hooks.map(rewrite) }))]);
  return { ...source, hooks: Object.fromEntries(events) };
}

/**
 * The keys Codex records a trusted hook under in its config.toml, `[hooks.state."<plugin>:<hooks file>:<event>:<group>:<index>"]`,
 * for every hook in `hooks`, the plugin's hooks file at `file` (relative to the plugin folder).
 */
export function hookKeys(hooks: HooksFile, file: string): string[] {
  const snake = (event: string) => event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  return Object.entries(hooks.hooks).flatMap(([event, groups]) =>
    groups.flatMap((group, g) => group.hooks.map((_, i) => `${CODEX_PLUGIN}:${file}:${snake(event)}:${g}:${i}`)),
  );
}

/**
 * The keys among `keys` that Codex's config does not record as trusted. Codex keeps a hash of each trusted hook, which
 * it compares itself; a trusted hook whose definition has changed since is reported by Codex, not here.
 */
export function untrustedHooks(config: string, keys: string[]): string[] {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return keys.filter((key) => !new RegExp(`^\\[hooks\\.state\\."${escape(key)}"\\]\\s*\\n\\s*trusted_hash\\s*=`, 'm').test(config));
}

/** The plugin folder's relative path for a manifest pointer such as `./hooks/codex.json`. */
export const pointer = (value: unknown): string => {
  if (typeof value !== 'string' || !value.startsWith('./')) throw new Error(`Expected a ./ path in .codex-plugin/plugin.json, got ${JSON.stringify(value)}`);
  return value.slice(2);
};

/**
 * The launcher hooks run: `hook <script> [args]` runs `<bridge>/<script>.js` on the runtime, in the same process so
 * its exit code and output are the hook's. It is rewritten in place at each registration, one file at a time, since
 * an open session may run it at any moment.
 */
function writeLauncher(dir: string, runtime: string, bridge: string, platform: NodeJS.Platform): string {
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
    '// A script that runs only as the entry point compares process.argv[1] with its own path, which Node resolves.',
    "const script = fs.realpathSync(path.join(bridge, `${name}.js`));",
    'process.argv = [process.argv[0], script, ...rest];',
    'await import(pathToFileURL(script).href);',
    '',
  ].join('\n'));
  if (platform === 'win32') {
    // cmd.exe reads a .cmd file in the console code page, so the module's path, which may not be ASCII, is left to
    // %~dp0, and the runtime's is written through %LOCALAPPDATA% or %USERPROFILE% where it can be.
    const launcher = path.join(dir, 'hook.cmd');
    writeAtomic(launcher, `@"${cmdPath(runtime)}" "%~dp0hook.mjs" %*\r\n`);
    return launcher;
  }
  const launcher = path.join(dir, 'hook');
  writeAtomic(launcher, `#!/bin/sh\nexec ${shellQuote(runtime)} ${shellQuote(module)} "$@"\n`, 0o755);
  return launcher;
}

function cmdPath(file: string): string {
  const base = ['LOCALAPPDATA', 'USERPROFILE'].find((name) => process.env[name] && file.toLowerCase().startsWith(process.env[name]!.toLowerCase()));
  return base ? `%${base}%${file.slice(process.env[base]!.length)}` : file;
}

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const powershellQuote = (value: string) => `'${value.replaceAll("'", "''")}'`;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAtomic(file: string, text: string, mode?: number): void {
  const partial = `${file}.partial-${process.pid}`;
  fs.writeFileSync(partial, text, mode === undefined ? undefined : { mode });
  fs.renameSync(partial, file);
}
