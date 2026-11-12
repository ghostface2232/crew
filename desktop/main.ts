import { app, BrowserWindow, dialog, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDaemon, api } from '../plugin/bridge/client.ts';
import { BASE_URL, HOME } from '../plugin/bridge/config.ts';
import type { BoardState } from '../plugin/board/src/types.ts';
import { isBoardNavigation, windowBounds } from './window-state.ts';

// Test and alternate daemon profiles must not claim the user's normal desktop instance.
if (process.env.CREW_HOME) app.setPath('userData', path.join(HOME, 'desktop'));
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pollAbort: AbortController | null = null;
const noticed = new Set<string>();
const notifications = new Map<string, Notification>();
const stateFile = path.join(app.getPath('userData'), 'window.json');

function saveWindow() {
  if (!window || window.isDestroyed()) return;
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...window.getNormalBounds(), maximized: window.isMaximized() }));
  } catch (error) {
    console.error('Could not save window state:', error);
  }
}
function show(job?: string) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  if (job) void window.loadURL(`${BASE_URL}/#${encodeURIComponent(job)}`).catch(console.error);
}
function createWindow() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* The first launch has no saved bounds. */
  }
  const bounds = windowBounds(
    saved ?? {},
    screen.getAllDisplays().map((display) => display.workArea),
  );
  window = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Crew',
    backgroundColor: '#f3f3f1',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  if (bounds.maximized) window.maximize();
  window.once('ready-to-show', () => show());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (!isBoardNavigation(url, BASE_URL)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isBoardNavigation(url, BASE_URL)) event.preventDefault();
  });
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question', message: 'Discard unsaved settings?',
      detail: 'Edits have not been saved, or a save is still in progress.',
      buttons: ['Discard changes', 'Keep editing'], defaultId: 1, cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
    else quitting = false;
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.on('close', (event) => {
    saveWindow();
    if (!quitting) {
      event.preventDefault();
      window?.hide();
    }
  });
  window.on('closed', () => {
    window = null;
  });
  void window.loadURL(BASE_URL).catch(console.error);
}
function trayMenu(pending = 0) {
  tray?.setToolTip(pending ? `Crew · ${pending} need your input` : 'Crew');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: pending ? `Open Crew (${pending} waiting)` : 'Open Crew', click: () => show() },
      {
        label: 'Open in browser',
        click: () => {
          void shell.openExternal(BASE_URL);
        },
      },
      { type: 'separator' },
      { label: 'Quit Crew — jobs keep running', click: () => app.quit() },
    ]),
  );
  if (process.platform === 'darwin') app.dock?.setBadge(pending ? String(pending) : '');
}
function notify(key: string, title: string, body: string, job?: string, requestId?: string) {
  if (noticed.has(key)) return;
  noticed.add(key);
  if (!Notification.isSupported() || window?.isFocused()) return;
  const notification = new Notification({
    title,
    body,
    ...(requestId
      ? {
          actions: [
            { type: 'button' as const, text: 'Approve' },
            { type: 'button' as const, text: 'Deny' },
          ],
        }
      : {}),
  });
  notifications.set(key, notification);
  notification.on('click', () => show(job));
  notification.on('close', () => notifications.delete(key));
  notification.on('action', (_event, index) => {
    if (!job || !requestId || index > 1) return;
    void (async () => {
      try {
        const current = await api('GET', `/api/jobs/${job}`);
        if (current.state !== 'waiting' || current.waiting?.id !== requestId) {
          show(job);
          return;
        }
        await api('POST', `/api/jobs/${job}/reply`, {
          request_id: requestId,
          decision: index === 0 ? 'approve' : 'deny',
        });
      } catch {
        show(job);
      }
    })();
  });
  notification.show();
}
async function poll() {
  pollAbort = new AbortController();
  try {
    const signal = AbortSignal.any([pollAbort.signal, AbortSignal.timeout(4000)]);
    const response = await fetch(`${BASE_URL}/api/state`, { signal });
    if (!response.ok) throw new Error(`Daemon returned ${response.status}`);
    const state = (await response.json()) as BoardState & { notifications?: { enabled: boolean; onDone: boolean } };
    if (stopping) return;
    // Lease suppresses duplicate osascript alerts only while this app can receive them.
    if (Notification.isSupported())
      await fetch(`${BASE_URL}/api/desktop/heartbeat`, { method: 'POST', signal }).catch(() => {});
    const waiting = state.jobs.filter((job) => job.state === 'waiting');
    const sessions = state.claude.filter((session) => session.state === 'waiting');
    trayMenu(waiting.length + sessions.length);
    if (state.notifications?.enabled !== false) {
      for (const job of waiting)
        if (job.waiting)
          notify(
            `${job.id}:${job.waiting.id}`,
            `${job.agent} needs your input`,
            job.waiting.reason,
            job.id,
            job.waiting.type === 'approval' ? job.waiting.id : undefined,
          );
      for (const session of sessions)
        notify(
          `session:${session.id}:${session.waitingId ?? session.waitingFor}`,
          'Claude needs your input',
          session.waitingFor ?? session.title,
        );
    }
    const live = new Set([
      ...waiting.map((job) => `${job.id}:${job.waiting?.id}`),
      ...sessions.map((session) => `session:${session.id}:${session.waitingId ?? session.waitingFor}`),
    ]);
    for (const [key, notification] of notifications)
      if (!live.has(key)) {
        notification.close();
        notifications.delete(key);
      }
    for (const key of noticed) if (!live.has(key)) noticed.delete(key);
  } catch {
    tray?.setToolTip('Crew · reconnecting to daemon');
  } finally {
    if (!stopping) timer = setTimeout(() => void poll(), 3000);
  }
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => show());
  app.on('activate', () => show());
  app.on('before-quit', () => {
    quitting = true;
    saveWindow();
  });
  app.on('will-quit', () => {
    stopping = true;
    clearTimeout(timer);
    pollAbort?.abort();
  });
  app.on('window-all-closed', () => {
    /* The tray stays available; the daemon is independent. */
  });
  void startDesktop().catch((error) => {
    console.error(error);
    app.quit();
  });
}

async function startDesktop() {
  await app.whenReady();
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  let ready = false;
  while (!ready) {
    try {
      await ensureDaemon();
      ready = true;
    } catch (error) {
      const answer = await dialog.showMessageBox({
        type: 'error',
        title: 'Crew could not start',
        message: (error as Error).message,
        buttons: ['Retry', 'Quit'],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response === 1) {
        app.quit();
        break;
      }
    }
  }
  if (ready) {
    const icon = nativeImage.createFromPath(path.join(import.meta.dirname, 'trayTemplate.png'));
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.on('click', () => show());
    trayMenu();
    createWindow();
    void poll();
  }
}
