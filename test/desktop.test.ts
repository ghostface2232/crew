import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { taskbarDarkIn } from '../desktop/taskbar.ts';
import { windowBounds, isBoardNavigation, isClaudeSessionLink, linkTarget } from '../desktop/window-state.ts';
import { boardAsset, BOARD_CSP } from '../plugin/bridge/assets.ts';

test('restores visible bounds but recenters a removed monitor or malformed values', () => {
  const displays = [{ x: 0, y: 0, width: 1440, height: 900 }];
  assert.deepEqual(windowBounds({ x: 20, y: 40, width: 900, height: 600, maximized: true }, displays), {
    x: 20,
    y: 40,
    width: 900,
    height: 600,
    maximized: true,
  });
  assert.equal(windowBounds({ x: 2000, y: 0, width: 900, height: 600 }, displays).x, undefined);
  assert.equal(windowBounds({ width: NaN, height: -5 }, displays).width, 1380);
  assert.equal(windowBounds({ height: -5 }, displays).height, 480);
});

test('the tray reads the Windows mode from what reg query prints, and nothing from a missing value', () => {
  const printed = (value: string) =>
    `\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize\r\n    SystemUsesLightTheme    REG_DWORD    ${value}\r\n\r\n`;
  assert.equal(taskbarDarkIn(printed('0x0')), true);
  assert.equal(taskbarDarkIn(printed('0x1')), false);
  // The app mode's value is not the taskbar's.
  assert.equal(taskbarDarkIn(printed('0x0').replace('SystemUsesLightTheme', 'AppsUseLightTheme')), undefined);
  assert.equal(taskbarDarkIn('ERROR: The system was unable to find the specified registry key or value.'), undefined);
});

test('desktop navigation is confined to the board, never API routes or remote pages', () => {
  const base = 'http://127.0.0.1:47615';
  assert.equal(isBoardNavigation(`${base}/#cx-1`, base), true);
  for (const url of [
    `${base}/api/state`,
    'https://example.com',
    'javascript:alert(1)',
    'http://127.0.0.1:47616/',
    'http://user@127.0.0.1:47615/',
  ])
    assert.equal(isBoardNavigation(url, base), false);
});

test('new windows open only evidence in the app and send web links to the browser', () => {
  const base = 'http://127.0.0.1:47615';
  assert.equal(linkTarget(`${base}/api/jobs/cx-1/evidence/shot.png?v=2`, base), 'evidence');
  assert.equal(linkTarget('https://example.com/docs', base), 'external');
  assert.equal(linkTarget('mailto:a@example.com', base), 'external');
  for (const url of [`${base}/api/state`, `${base}/`, 'file:///C:/x', 'javascript:alert(1)', 'http://user@example.com/', 'nonsense'])
    assert.equal(linkTarget(url, base), null);
});

test('hands only a Claude session link to the system, not other claude:// addresses', () => {
  assert.equal(isClaudeSessionLink('claude://code/continue?session=local_e97eb8b4-b9ff-4551-b625-3c06c77253c7'), true);
  for (const url of [
    'claude://code/continue?session=last',
    'claude://code/new?q=rm%20-rf',
    'claude://code/continue?session=local_1&q=x',
    'claude://u:p@code/continue?session=local_1',
    'claude://code/continue?session=local_1#x',
    'claude://claude.ai/new',
    'https://code/continue?session=local_1',
    'nonsense',
  ]) assert.equal(isClaudeSessionLink(url), false, url);
});

test('serves only built assets with explicit types and a renderer security policy', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-assets-'));
  try {
    fs.mkdirSync(path.join(root, 'board/dist/assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'board/dist/index.html'), '<html></html>');
    fs.writeFileSync(path.join(root, 'board/dist/assets/index-ab12.js'), '');
    fs.writeFileSync(path.join(root, 'board/dist/assets/CrewAppIcon-ab12.png'), '');
    assert.equal(boardAsset(root, '/')?.immutable, false);
    assert.equal(boardAsset(root, '/assets/index-ab12.js')?.type, 'text/javascript; charset=utf-8');
    assert.equal(boardAsset(root, '/assets/CrewAppIcon-ab12.png')?.type, 'image/png');
    for (const url of [
      '/src/main.tsx',
      '/assets/../../bridge/config.ts',
      '/assets/%2e%2e/config.js',
      '/assets/missing.js',
      '/assets/index.map',
    ])
      assert.equal(boardAsset(root, url), null);
    assert.match(BOARD_CSP, /script-src 'self'/);
    assert.match(BOARD_CSP, /object-src 'none'/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the bundled plugin runs as ES modules under a home folder whose package.json says CommonJS', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-bundle-'));
  try {
    // The bundle reads the checkout it runs in; this one has the source's plugin and a stand-in for the built board.
    const checkout = path.join(dir, 'checkout');
    const plugin = fileURLToPath(new URL('../plugin', import.meta.url));
    fs.cpSync(plugin, path.join(checkout, 'plugin'), { recursive: true, filter: (source) => source !== path.join(plugin, 'board') });
    fs.cpSync(fileURLToPath(new URL('../.claude-plugin', import.meta.url)), path.join(checkout, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'plugin/board/dist'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'package.json'), '{"type":"module"}\n');
    // What `npm init -y` leaves in a home folder, above the copy the Windows app registers.
    const home = path.join(dir, 'home');
    const copy = path.join(home, '.crew/plugins/1.0.0-abc');
    fs.mkdirSync(copy, { recursive: true });
    fs.writeFileSync(path.join(home, 'package.json'), '{"type":"commonjs"}\n');
    const bundle = new URL('../scripts/bundle-plugin.mjs', import.meta.url).href;
    execFileSync(process.execPath, ['--input-type=module', '-e', `const { bundlePlugin } = await import(${JSON.stringify(bundle)}); await bundlePlugin(${JSON.stringify(copy)}, '../runtime/node.exe');`], { cwd: checkout, stdio: 'pipe' });
    const script = path.join(copy, 'plugin/bridge/mcp.js');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, "import fs from 'node:fs';\nprocess.stdout.write(typeof fs.readFileSync);\n");
    assert.equal(execFileSync(process.execPath, [script], { encoding: 'utf8', stdio: 'pipe' }), 'function');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
