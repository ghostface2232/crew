import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Lays out the Claude Code plugin an app carries, so the app can register it as a local marketplace
 * (plugin/bridge/setup.ts). `root` becomes the marketplace and already holds the compiled bridge in
 * `root/plugin/bridge`. `runtime` is the app's Node, relative to the plugin folder: the plugin's MCP server and
 * hooks run the compiled bridge on it instead of the user's Node.
 */
export async function bundlePlugin(root, runtime) {
  const plugin = path.join(root, 'plugin');
  // The Codex manifest and files go in as they are: they are the templates the app's registration rewrites with
  // absolute paths, since Codex copies only the plugin folder and so cannot reach the runtime beside it
  // (plugin/bridge/codex-plugin.ts).
  for (const folder of ['roles', 'skills', 'agents', '.claude-plugin', '.codex-plugin', 'codex.mcp.json', 'hooks/codex.json', 'board/dist']) {
    fs.cpSync(`plugin/${folder}`, path.join(plugin, folder), { recursive: true });
  }
  // The compiled bridge is ES modules in `.js` files. Node otherwise goes by the nearest package.json above the
  // plugin, wherever it is copied: one in the user's home folder saying "commonjs" would stop every command.
  fs.writeFileSync(path.join(plugin, 'package.json'), '{"type":"module"}\n');
  // Commands that ran `node <bridge>.ts` run the compiled script on the bundled runtime. Claude Code substitutes
  // CLAUDE_PLUGIN_ROOT in both the command and its arguments, and runs the argument form without a shell.
  const command = `\${CLAUDE_PLUGIN_ROOT}/${runtime}`;
  const rewrite = (value) => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      const out = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rewrite(item)]));
      if (out.command === 'node') out.command = command;
      return out;
    }
    return typeof value === 'string' && value.startsWith('${CLAUDE_PLUGIN_ROOT}/bridge/') ? value.replace(/\.ts$/, '.js') : value;
  };
  for (const file of ['.mcp.json', 'hooks/hooks.json']) {
    fs.mkdirSync(path.dirname(path.join(plugin, file)), { recursive: true });
    fs.writeFileSync(path.join(plugin, file), `${JSON.stringify(rewrite(JSON.parse(fs.readFileSync(`plugin/${file}`, 'utf8'))), null, 2)}\n`);
  }
  fs.cpSync('.claude-plugin', path.join(root, '.claude-plugin'), { recursive: true });
  // The compiled bridge carries the source's fingerprint, so the app and a plugin install agree on whose daemon is current.
  const { installed } = await import(pathToFileURL(path.resolve('plugin/bridge/config.ts')).href);
  fs.writeFileSync(path.join(plugin, '.claude-plugin/build'), `${installed().build}\n`);
}
