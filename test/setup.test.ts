import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-setup-'));
process.env.CREW_HOME = home;
const { copyPlugin, prunePlugins } = await import('../plugin/bridge/setup.ts');
after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 }));

/** A built marketplace as the app carries it, beside the app's own files. */
function marketplace(name: string): string {
  const root = path.join(home, name);
  for (const file of ['.claude-plugin/marketplace.json', 'plugin/bridge/mcp.js', 'runtime/node.exe', 'desktop/main.js', 'package.json']) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), file);
  }
  return root;
}

test('copyPlugin copies the plugin and runtime, not the app', () => {
  const dest = path.join(home, 'plugins', '1.0.0-abc');
  copyPlugin(marketplace('app'), dest);
  assert.deepEqual(fs.readdirSync(dest).sort(), ['.claude-plugin', 'plugin', 'runtime']);
  assert.equal(fs.readFileSync(path.join(dest, 'runtime/node.exe'), 'utf8'), 'runtime/node.exe');
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['1.0.0-abc']);
});

test('copyPlugin leaves a complete copy as it is', () => {
  const dest = path.join(home, 'plugins', '1.0.1-def');
  fs.mkdirSync(path.join(dest, 'plugin'), { recursive: true });
  copyPlugin(marketplace('app2'), dest);
  assert.deepEqual(fs.readdirSync(dest), ['plugin']);
});

test('prunePlugins keeps the registered copy and copies still running, whole', async (t) => {
  const dir = path.join(home, 'prune');
  const copy = (name: string) => {
    for (const file of ['runtime/node.exe', 'runtime/LICENSE', 'plugin/bridge/mcp.js']) {
      fs.mkdirSync(path.dirname(path.join(dir, name, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, name, file), '');
    }
    return path.join(dir, name);
  };
  const current = copy('2.0.0-new');
  copy('1.0.0-old');
  const running = copy('1.5.0-open');
  copy(`1.6.0-new.partial-${process.pid}`);
  copy('1.6.0-new.partial-999999999');
  const node = path.join(running, 'runtime', 'node.exe');
  if (process.platform === 'win32') {
    // Windows refuses to delete a running executable, which is how a copy still in use is told apart.
    fs.copyFileSync(process.execPath, node);
    const child = spawn(node, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    t.after(async () => {
      child.kill();
      await once(child, 'exit');
    });
    await once(child, 'spawn');
  } else {
    // Elsewhere a running executable can be deleted; a read-only folder refuses the same way.
    fs.chmodSync(path.dirname(node), 0o555);
    t.after(() => fs.chmodSync(path.dirname(node), 0o755));
  }
  const files = (root: string) => (fs.readdirSync(root, { recursive: true }) as string[]).sort();
  const before = files(running);
  prunePlugins(dir, [current]);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['1.5.0-open', `1.6.0-new.partial-${process.pid}`, '2.0.0-new']);
  assert.deepEqual(files(running), before);
});
