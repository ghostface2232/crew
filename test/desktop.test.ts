import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { taskbarDarkIn } from '../desktop/taskbar.ts';
import { windowBounds, isBoardNavigation, isSessionAppLink, linkTarget } from '../desktop/window-state.ts';
import { boardAsset, BOARD_CSP } from '../plugin/bridge/assets.ts';

test('desktop IPC follows the verified main frame even after the fallback daemon stops', async () => {
  const source = fs.readFileSync(new URL('../desktop/main.ts', import.meta.url), 'utf8');
  const handlers = new Map<string, (event: unknown) => unknown>();
  const base = 'http://127.0.0.1:2';
  const url = base + '/';
  let currentBase = base;
  let daemonUp = true;
  let probes = 0;
  type SendHeaders = (details: { url: string; webContentsId: number; resourceType: string; requestHeaders: object }, respond: (response: { cancel?: boolean }) => void) => Promise<void>;
  let sendHeaders!: SendHeaders;
  const webContents = Object.assign(new EventEmitter(), {
    id: 1,
    session: { webRequest: { onBeforeSendHeaders: (handler: SendHeaders) => { sendHeaders = handler; }, onErrorOccurred() {} } },
  });
  const calls: string[] = [];
  const record = (name: string) => () => calls.push(name);
  const signing = source.slice(source.indexOf('function signBoard('), source.indexOf('\nasync function loadBoard('));
  const start = source.lastIndexOf('\n', source.indexOf('function fromBoard('));
  const ipc = source.slice(start, source.indexOf('\nasync function ask(', start));
  vm.runInNewContext(stripTypeScriptTypes(signing + ipc) + '; signBoard(window); watchUpdates()', {
    URL, window: { webContents }, boardOrigins: new WeakMap(),
    baseUrl: () => currentBase, verifiedDaemon: async () => { probes++; return daemonUp ? { token: null } : null; },
    ipcMain: { handle: (name: string, handler: (event: unknown) => unknown) => handlers.set(name, handler) },
    updater: { status: { state: 'installing', waiting: 1 }, load: () => new Promise(() => {}), failed: record('cancel'), seen: record('seen') },
    installUpdate: record('install'), updateFailed: false, console,
    welcomeFile: 'welcome', fs: { existsSync: () => true, rmSync: record('welcome') },
    loginItemSupported: true, opensAtLogin: () => true,
  });
  const invoke = async (name: string, sender: object = webContents, frameURL = url) => handlers.get(name)!({ sender, senderFrame: { url: frameURL } });
  const startNavigation = (target: string) => webContents.emit('did-start-navigation', { url: target, isMainFrame: true, isSameDocument: false });
  const verifyRequest = (resourceType: string) => new Promise<{ cancel?: boolean }>((resolve, reject) => {
    void sendHeaders({ url, webContentsId: webContents.id, resourceType, requestHeaders: {} }, resolve).catch(reject);
  });
  const commitNavigation = (target: string) => webContents.emit('did-navigate', {}, target);
  startNavigation(url);
  await verifyRequest('xhr');
  commitNavigation(url);
  await assert.rejects(invoke('update:install'), /only the Crew board/);
  startNavigation(url);
  assert.equal((await verifyRequest('mainFrame')).cancel, undefined);
  await assert.rejects(invoke('update:install'), /only the Crew board/);
  commitNavigation(url);
  daemonUp = false;
  currentBase = 'http://127.0.0.1:1';
  await invoke('update:cancel');
  await invoke('update:install');
  await invoke('update:seen');
  assert.equal(await invoke('welcome:pending'), true);
  await invoke('welcome:done');
  assert.equal(await invoke('login:state'), true);
  assert.deepEqual(calls, ['cancel', 'install', 'seen', 'welcome']);
  assert.equal(probes, 2);
  await assert.rejects(invoke('update:install', {}), /only the Crew board/);
  await assert.rejects(invoke('update:install', webContents, currentBase + '/'), /only the Crew board/);

  startNavigation(currentBase + '/');
  await assert.rejects(invoke('update:install'), /only the Crew board/);
  currentBase = base;
  daemonUp = true;
  startNavigation(url);
  await verifyRequest('mainFrame');
  commitNavigation(url);
  assert.equal(await invoke('welcome:pending'), true);
  webContents.emit('did-fail-load', {}, -2, 'Failed', url, false);
  assert.equal(await invoke('welcome:pending'), true);
  webContents.emit('did-fail-load', {}, -2, 'Failed', url, true);
  await assert.rejects(invoke('update:install'), /only the Crew board/);
  daemonUp = false;
  startNavigation(url);
  assert.equal((await verifyRequest('mainFrame')).cancel, true);
});

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
  assert.equal(isSessionAppLink('claude://code/continue?session=local_e97eb8b4-b9ff-4551-b625-3c06c77253c7'), true);
  for (const url of [
    'claude://code/continue?session=last',
    'claude://code/new?q=rm%20-rf',
    'claude://code/continue?session=local_1&q=x',
    'claude://u:p@code/continue?session=local_1',
    'claude://code/continue?session=local_1#x',
    'claude://claude.ai/new',
    'https://code/continue?session=local_1',
    'nonsense',
  ]) assert.equal(isSessionAppLink(url), false, url);
});

test('hands only a Codex thread UUID link to the system', () => {
  const id = 'e97eb8b4-b9ff-4551-b625-3c06c77253c7';
  const thread = `codex://threads/${id}`;
  assert.equal(isSessionAppLink(thread), true);
  assert.equal(isSessionAppLink(`codex://threads/${id.toUpperCase()}`), true);
  for (const url of [
    'codex://threads/lead-1',
    `codex://thread/${id}`,
    `codex://threads:443/${id}`,
    `codex://user:password@threads/${id}`,
    `codex://@threads/${id}`,
    `codex://threads/other/../${id}`,
    `${thread}/`,
    `${thread}?`,
    `${thread}?x=1`,
    `${thread}#`,
    `${thread}#x`,
  ]) assert.equal(isSessionAppLink(url), false, url);
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
    // The bundle reads the checkout it runs in; this one has the source's plugin and stand-ins for the board files it carries.
    const checkout = path.join(dir, 'checkout');
    const plugin = fileURLToPath(new URL('../plugin', import.meta.url));
    fs.cpSync(plugin, path.join(checkout, 'plugin'), { recursive: true, filter: (source) => source !== path.join(plugin, 'board') });
    fs.cpSync(fileURLToPath(new URL('../.claude-plugin', import.meta.url)), path.join(checkout, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'plugin/board/dist'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'plugin/board/src/icons'), { recursive: true });
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
