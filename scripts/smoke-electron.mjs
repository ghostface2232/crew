import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
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
const env = { ...process.env, CREW_HOME: home, CREW_PORT: String(port) };
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
  // The board signs in with the cookie the shell sets, so the stream connects without a launch fragment.
  await expect(page.getByText('Live', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(page.url()).toBe(`${base}/`);
  daemonPid = (await getHealth()).pid;
  expect(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }))).toEqual({
    require: 'undefined',
    process: 'undefined',
  });
  const prefs = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 50, y: 60, width: 1100, height: 760 }));
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-smoke.png' });

  // Only the page below the top bar scrolls, its bar at the window's edge; keys scroll it after a sidebar click too.
  expect(await page.evaluate(() => {
    const root = document.documentElement;
    const box = document.querySelector('main.page').getBoundingClientRect();
    return { rootScrolls: root.scrollHeight > root.clientHeight, top: box.top, right: box.right === innerWidth };
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
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Close settings' }).click();

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
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ width: 700, height: 760 }));
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
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setBounds({ x: 50, y: 60, width: 1100, height: 760 }));

  // External navigation is refused.
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await page.waitForTimeout(500);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL())).toBe(`${base}/`);

  // Copy buttons can write the clipboard; evidence opens in a signed-in window; web links go to the browser.
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
  const hook = (hook_event_name, extra = {}) =>
    fetch(`${base}/api/hooks/claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session_id: 'tray-test', cwd: home, hook_event_name, ...extra }),
    });
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
    await application.firstWindow();
    const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
    await quit(application);
    application = null;
    return bounds;
  };
  const bounds = await relaunchBounds();
  expect(bounds).toMatchObject({ x: 50, y: 60 });
  expect(Math.abs(bounds.width - 1100)).toBeLessThanOrEqual(8);
  expect(Math.abs(bounds.height - 760)).toBeLessThanOrEqual(8);
  expect(await relaunchBounds()).toEqual(bounds);
  expect((await getHealth()).pid).toBe(daemonPid);
  const result = {
    result: 'passed',
    platform: process.platform,
    checks: [
      'cookie sign-in without a URL secret',
      'renderer isolation',
      'page-only scrolling, keyboard scrolling after a sidebar click',
      'close hides to tray',
      'single instance',
      'cancelled quit preserves unsaved settings',
      'external navigation blocked',
      'no control under the window buttons, wide or narrow, with Settings or search open',
      'clipboard writes, evidence windows and browser links',
      'tray count follows waiting sessions',
      'window bounds restored without drift',
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
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
