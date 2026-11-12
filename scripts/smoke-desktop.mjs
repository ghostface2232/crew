import { _electron as electron, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';

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
const base = `http://127.0.0.1:${port}`;
const getHealth = async () => (await fetch(`${base}/api/health`)).json();
let application;
let daemonPid;
const appPath = process.env.CREW_APP_PATH;
const launch = () =>
  electron.launch({
    ...(appPath ? { executablePath: appPath, args: [] } : { args: ['desktop/build'] }),
    env,
    timeout: 30_000,
  });
try {
  application = await launch();
  const page = await application.firstWindow();
  await expect(page.getByText('Live', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'All quiet' })).toBeVisible();
  const health = await getHealth();
  daemonPid = health.pid;
  expect(await page.evaluate(() => ({ require: typeof window.require, process: typeof window.process }))).toEqual({
    require: 'undefined',
    process: 'undefined',
  });
  const prefs = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  expect(prefs).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ x: 50, y: 60, width: 1100, height: 760 }),
  );
  fs.mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/desktop-smoke.png' });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  expect((await getHealth()).pid).toBe(daemonPid);
  const second = spawn(appPath ?? require('electron'), appPath ? [] : ['desktop/build'], { env, stdio: 'ignore' });
  const [exitCode] = await once(second, 'exit');
  expect(exitCode).toBe(0);
  await expect
    .poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()))
    .toBe(true);
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const instructions = page.getByRole('textbox', { name: 'Shared instructions' });
  await expect(instructions).toBeEnabled();
  await instructions.fill('Keep this unsaved draft');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  await application.evaluate(({ app, dialog }) => {
    dialog.showMessageBoxSync = () => 1;
    app.quit();
  });
  await expect(instructions).toHaveValue('Keep this unsaved draft');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Close settings' }).click();
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  expect(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
  await page.evaluate(() => {
    location.href = 'https://example.com/';
  });
  await expect
    .poll(() => application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL()))
    .toBe(base + '/');
  expect(
    await application.evaluate(async ({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.executeJavaScript(
        "document.querySelector('.connection').textContent",
      ),
    ),
  ).toBe('Live');
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const metrics = await application.evaluate(({ app }) => app.getAppMetrics());
  const report = {
    platform: process.platform,
    arch: process.arch,
    electron: prefs,
    daemonPid,
    metrics: metrics.map(({ type, memory, cpu }) => ({ type, memory, cpu })),
    idleWorkingSetMiB: metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize / 1024, 0),
  };
  // Exercise the real daemon and desktop poller without displaying OS notifications.
  await application.evaluate(({ BrowserWindow, Notification }, base) => {
    const originalFetch = globalThis.fetch;
    const originalShow = Notification.prototype.show;
    const originalClose = Notification.prototype.close;
    const originalSupported = Notification.isSupported;
    const capture = { shown: [], closed: 0, polls: 0 };
    globalThis.crewNotificationTest = capture;
    capture.restore = () => {
      globalThis.fetch = originalFetch;
      Notification.prototype.show = originalShow;
      Notification.prototype.close = originalClose;
      Notification.isSupported = originalSupported;
      delete globalThis.crewNotificationTest;
    };
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { capture.shown.push(this.body); };
    Notification.prototype.close = function () { capture.closed++; this.emit('close'); };
    globalThis.fetch = async (...args) => {
      const response = await originalFetch(...args);
      if (args[0] !== `${base}/api/state`) return response;
      const state = await response.json();
      state.notifications.enabled = true;
      capture.polls++;
      return new Response(JSON.stringify(state), { status: response.status });
    };
    BrowserWindow.getAllWindows()[0].hide();
  }, base);
  try {
    const hook = async (hook_event_name, extra = {}) => {
      const response = await fetch(`${base}/api/hooks/claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session_id: 'notification-test', cwd: home, hook_event_name, ...extra }),
      });
      expect(response.ok).toBe(true);
    };
    const count = () => application.evaluate(() => globalThis.crewNotificationTest.shown.length);
    const prompt = { notification_type: 'permission_prompt', message: 'Allow this command?' };
    await hook('Notification', prompt);
    await expect.poll(count, { timeout: 10_000 }).toBe(1);
    await hook('Notification', prompt);
    const polls = await application.evaluate(() => globalThis.crewNotificationTest.polls);
    await expect.poll(
      () => application.evaluate(() => globalThis.crewNotificationTest.polls),
      { timeout: 10_000 },
    ).toBeGreaterThan(polls + 1);
    expect(await count()).toBe(1);
    await hook('PreToolUse', { tool_name: 'Bash' });
    await hook('Notification', prompt);
    await expect.poll(count, { timeout: 10_000 }).toBe(2);
    await hook('SessionEnd');
    await expect.poll(
      () => application.evaluate(() => globalThis.crewNotificationTest.closed),
      { timeout: 10_000 },
    ).toBe(2);
  } finally {
    await application.evaluate(() => globalThis.crewNotificationTest.restore());
  }
  await application.close();
  application = null;
  expect((await getHealth()).pid).toBe(daemonPid);
  application = await launch();
  await application.firstWindow();
  const bounds = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getNormalBounds());
  expect(bounds).toMatchObject({ x: 50, y: 60, width: 1100, height: 760 });
  await application.close();
  application = null;
  expect((await getHealth()).pid).toBe(daemonPid);
  fs.writeFileSync('test-results/desktop-metrics.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        result: 'passed',
        checks: [
          'renderer isolation',
          'external navigation blocked',
          'close hides to tray',
          'single instance',
          'cancelled quit preserves unsaved settings and tray behavior',
          'window bounds restored',
          'daemon survives quit and reopen',
          'repeated Claude requests notify once per waiting episode',
        ],
        idleWorkingSetMiB: report.idleWorkingSetMiB,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  if (application) await application.close().catch(() => {});
  await fetch(`${base}/api/shutdown`, { method: 'POST' }).catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 500));
  fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
