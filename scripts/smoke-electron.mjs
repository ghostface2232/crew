import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

// Runs the Electron shell against its own daemon in a fresh home on a free port; it never starts workers.
const require = createRequire(import.meta.url);
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-desktop-test-'));
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ notify: false }));
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise((resolve) => probe.close(resolve));
// A local releases feed offering a newer version, so the updater runs without GitHub.
const installer = Buffer.from('not a real installer');
const feed = http.createServer((req, res) => {
  const origin = `http://127.0.0.1:${feed.address().port}`;
  if (req.url === '/latest') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
      tag_name: 'v9.9.9', draft: false, prerelease: false, html_url: 'https://github.com/ghostface2232/crew/releases/tag/v9.9.9',
      assets: [{
        name: 'Crew-Setup-9.9.9.exe', browser_download_url: `${origin}/Crew-Setup-9.9.9.exe`, size: installer.length,
        digest: `sha256:${createHash('sha256').update(installer).digest('hex')}`,
      }],
    }));
  } else if (req.url === '/Crew-Setup-9.9.9.exe') res.writeHead(200, { 'content-length': installer.length }).end(installer);
  else res.writeHead(404).end();
});
feed.listen(0, '127.0.0.1');
await once(feed, 'listening');
const env = { ...process.env, CREW_HOME: home, CREW_PORT: String(port), CREW_UPDATE_FEED: `http://127.0.0.1:${feed.address().port}/latest` };
delete env.ELECTRON_RUN_AS_NODE;
delete env.CREW_ATTACH_ONLY;
const base = `http://127.0.0.1:${port}`;
const getHealth = async () => (await fetch(`${base}/api/health`)).json();
const auth = () => ({ authorization: `Bearer ${fs.readFileSync(path.join(home, 'token'), 'utf8').trim()}` });
const appPath = process.env.CREW_APP_PATH;
const launch = () =>
  electron.launch({ ...(appPath ? { executablePath: appPath, args: [] } : { args: ['desktop/build'] }), env, timeout: 30_000 });
// On Windows the daemon this app starts inherits the app's stdio pipes, so Playwright's close() would wait on the
// daemon. Quitting and waiting for the app's own exit tests what a user's quit does.
const quit = async (application) => {
  const exited = once(application.process(), 'exit');
  await application.evaluate(({ app }) => app.quit()).catch(() => {});
  await exited;
};
const visible = (application) => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
let application;
let daemonPid;
try {
  application = await launch();
  const page = await application.firstWindow();
  // The shell signs the board's requests itself, so the stream connects with nothing in the address, and the
  // page is left holding nothing: no cookie, and a reload stays signed in.
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toBe(`${base}/`);
  expect(await application.evaluate(({ session }) => session.defaultSession.cookies.get({}))).toEqual([]);
  await page.reload();
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  daemonPid = (await getHealth()).pid;
  expect(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }))).toEqual({
    require: 'undefined',
    process: 'undefined',
  });
  const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  // Sized to fit the screen's work area: a hosted runner's display is smaller than a desk's, and Windows shrinks a
  // window that would run past it, so a fixed size would not come back as set.
  const area = await application.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const placed = { x: area.x + 50, y: area.y + 60, width: Math.min(1100, area.width - 100), height: Math.min(760, area.height - 120) };
  console.log(`work area ${JSON.stringify(area)}, window ${JSON.stringify(placed)}`);
  await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), placed);
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-smoke.png' });

  // Only the stage below the top bar scrolls, inset from the window's edge by the frame; keys scroll it after a sidebar click too.
  expect(await page.evaluate(() => {
    const root = document.documentElement;
    const box = document.querySelector('main.page').getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(root).getPropertyValue('--window-inset'));
    return { rootScrolls: root.scrollHeight > root.clientHeight, top: box.top, right: box.right === innerWidth - inset };
  })).toEqual({ rootScrolls: false, top: 60, right: true });
  await page.getByRole('button', { name: 'Overview', exact: true }).first().click();
  await page.keyboard.press('PageDown');
  await expect.poll(() => page.evaluate(() => document.querySelector('main.page').scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => document.querySelector('main.page').scrollTop)).toBe(0);

  // Closing hides to the tray; a second launch exits and shows the first window.
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(await visible(application)).toBe(false);
  expect((await getHealth()).pid).toBe(daemonPid);
  const second = spawn(appPath ?? require('electron'), appPath ? [] : ['desktop/build'], { env, stdio: 'ignore' });
  const [exitCode] = await once(second, 'exit');
  expect(exitCode).toBe(0);
  await expect.poll(() => visible(application)).toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

  // A cancelled quit keeps unsaved settings.
  const toggle = page.getByRole('button', { name: 'Show sidebar' });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'Instructions', exact: true }).click();
  const instructions = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(instructions).toBeEnabled();
  await instructions.fill('Keep this unsaved draft');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await application.evaluate(({ app, dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    app.quit();
  });
  await expect(instructions).toHaveValue('Keep this unsaved draft');
  expect(await visible(application)).toBe(true);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('dialog', { name: 'Close without saving your changes?' }).getByRole('button', { name: 'Close', exact: true }).click();

  // No control lies under the window buttons, including at a narrow width with Settings open.
  const covered = () =>
    page.evaluate(() => {
      const bar = navigator.windowControlsOverlay.getTitlebarAreaRect();
      return [...document.querySelectorAll('button, a, input, select, textarea')]
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width && rect.height && rect.right > bar.right && rect.top < bar.height)
        .map(({ element }) => element.getAttribute('aria-label') || element.textContent.trim());
    });
  expect(await covered()).toEqual([]);
  await application.evaluate(({ BrowserWindow }, height) => BrowserWindow.getAllWindows()[0].setBounds({ width: 700, height }), placed.height);
  await page.waitForTimeout(300);
  expect(await covered()).toEqual([]);
  await page.getByRole('button', { name: 'Show sidebar' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Close settings' }).first()).toBeVisible();
  expect(await covered()).toEqual([]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+k');
  await expect(page.locator('.palette')).toBeVisible();
  await page.waitForTimeout(600); // Its opening motion starts at the search control.
  expect(await covered()).toEqual([]);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await application.evaluate(({ BrowserWindow }, bounds) => BrowserWindow.getAllWindows()[0].setBounds(bounds), placed);

  // About Crew checks the feed and downloads the release; the sidebar then offers it above Settings.
  const version = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('navigation', { name: 'Settings pages' }).getByRole('button', { name: 'About Crew', exact: true }).click();
  await expect(page.getByText(`Version ${version}`, { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Check for Updates' }).click();
  await expect(page.getByText('Version 9.9.9 is ready to install')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'What’s new in 9.9.9' })).toBeVisible();
  await page.getByRole('button', { name: 'Close settings' }).click();
  expect(await page.evaluate(() => [...document.querySelectorAll('.sidebar-foot button')].map((button) => button.id)))
    .toEqual(['install-update', 'open-settings']);
  expect(fs.readFileSync(path.join(home, 'desktop', 'updates', 'Crew-Setup-9.9.9.exe'))).toEqual(installer);
  // Only the main window reaches the updater: another window with the same preload, even on the board, is refused.
  expect(await application.evaluate(async ({ app, BrowserWindow }, board) => {
    const preload = `${app.getAppPath()}/desktop/preload.cjs`;
    const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } });
    try {
      await other.loadURL(board);
      return await other.webContents.executeJavaScript("window.crewDesktop ? window.crewDesktop.update.state().then(() => 'answered', () => 'refused') : 'no bridge'");
    } finally {
      other.destroy();
    }
  }, `${base}/`)).toBe('refused');

  // External navigation is refused.
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(`${base}/`);

  // Copy buttons can write the clipboard; evidence opens in a window of its own; web links go to the browser.
  expect(await page.evaluate(() => navigator.clipboard.writeText('crew').then(() => 'ok', (error) => String(error)))).toBe('ok');
  await application.evaluate(({ shell }) => {
    globalThis.crewOpened = [];
    shell.openExternal = async (url) => { globalThis.crewOpened.push(url); };
  });
  await page.evaluate(() => {
    window.open('https://example.com/report', '_blank', 'noreferrer');
    window.open('/api/state', '_blank', 'noreferrer');
  });
  await expect.poll(() => application.evaluate(() => globalThis.crewOpened)).toEqual(['https://example.com/report']);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await page.evaluate(() => window.open('/api/jobs/cx-none/evidence/shot.png', '_blank', 'noreferrer'));
  await expect.poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/evidence/')).forEach((w) => w.destroy()));
  expect(await page.evaluate(() => typeof Notification !== 'undefined' && Notification.permission)).toBe('denied');

  // The tray count follows waiting Claude sessions.
  const tooltip = () => application.evaluate(() => globalThis.crewTrayTooltip ?? null);
  await application.evaluate(({ Tray }) => {
    const original = Tray.prototype.setToolTip;
    Tray.prototype.setToolTip = function (text) {
      globalThis.crewTrayTooltip = text;
      return original.call(this, text);
    };
  });
  const hook = async (hook_event_name, extra = {}) => {
    const response = await fetch(`${base}/api/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...auth() },
      body: JSON.stringify({ session_id: 'tray-test', cwd: home, hook_event_name, ...extra }),
    });
    expect(response.status, hook_event_name).toBe(200);
  };
  await hook('Notification', { notification_type: 'permission_prompt', message: 'Allow this command?' });
  await expect.poll(tooltip, { timeout: 10_000 }).toBe('Crew · 1 need your input');
  await hook('SessionEnd');
  await expect.poll(tooltip, { timeout: 10_000 }).toBe('Crew');

  const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
  const idleWorkingSetMiB = Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0));
  await quit(application);
  application = null;
  expect((await getHealth()).pid).toBe(daemonPid);
  // Scaled displays round bounds by a pixel or a few, but an unmoved window must not drift from launch to launch.
  const relaunchBounds = async () => {
    application = await launch();
    // The staged update is still offered after a relaunch.
    await expect((await application.firstWindow()).locator('#install-update')).toBeVisible({ timeout: 20_000 });
    const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    await quit(application);
    application = null;
    return bounds;
  };
  const bounds = await relaunchBounds();
  expect(bounds).toMatchObject({ x: placed.x, y: placed.y });
  expect(Math.abs(bounds.width - placed.width)).toBeLessThanOrEqual(8);
  expect(Math.abs(bounds.height - placed.height)).toBeLessThanOrEqual(8);
  expect(await relaunchBounds()).toEqual(bounds);
  expect((await getHealth()).pid).toBe(daemonPid);
  const result = {
    result: 'passed',
    platform: process.platform,
    checks: [
      'sign-in by the shell, with no cookie and no secret in the address',
      'renderer isolation',
      'stage-only scrolling, keyboard scrolling after a sidebar click',
      'close hides to tray',
      'single instance',
      'cancelled quit preserves unsaved settings',
      'external navigation blocked',
      'no control under the window buttons, wide or narrow, with Settings or search open',
      'clipboard writes, evidence windows and browser links',
      'tray count follows waiting sessions',
      'window bounds restored without drift',
      'update checked, downloaded and verified, offered above Settings and after a relaunch, only to the board window',
      'daemon survives quit and reopen',
    ],
    idleWorkingSetMiB,
  };
  fs.writeFileSync('test-results/desktop-smoke.json', JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (application) {
    // After a failure the app may be held by an unsaved-settings prompt; the test owns this instance, so end it.
    const child = application.process();
    await Promise.race([quit(application), new Promise((resolve) => setTimeout(resolve, 10_000))]).catch(() => {});
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  await fetch(`${base}/api/shutdown`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json', ...auth() } }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 1000));
  feed.close();
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
