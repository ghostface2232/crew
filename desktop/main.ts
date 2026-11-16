import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent, MessageBoxOptions, Rectangle } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToken, SESSION_COOKIE } from '../plugin/bridge/auth.ts';
import { api, ensureDaemon, health } from '../plugin/bridge/client.ts';
import { BASE_URL, HOME, PLUGIN_ROOT } from '../plugin/bridge/config.ts';
import type { BoardState } from '../plugin/board/src/types.ts';
import { Updater } from './updater.ts';
import { isBoardNavigation, linkTarget, windowBounds } from './window-state.ts';

// The Electron shell for Windows (and other non-macOS systems); macOS uses the native app in native/.
// It hosts the same React board the browser shows. Notifications stay with the daemon, whose Windows toasts
// need no installed shortcut or app identity, so this app never claims the desktop notification lease.

// Test and alternate daemon profiles must not claim the user's normal desktop instance.
if (process.env.CREW_HOME) app.setPath('userData', path.join(HOME, 'desktop'));
const locked = app.requestSingleInstanceLock();
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pollAbort: AbortController | null = null;
let pending = 0;
const stateFile = path.join(app.getPath('userData'), 'window.json');
const asset = (name: string) => path.join(import.meta.dirname, name);
/** The window looks out of reach once it has been out of focus, or the system idle, this long; only then does an update download. */
const AWAY_MS = 120_000;
const CHECK_EVERY_MS = 6 * 3_600_000;
/**
 * An installed copy has the installer's uninstaller beside it; an unpacked or development build cannot update itself.
 * CREW_UPDATE_FEED points any build at another releases endpoint, for testing against a local server.
 */
const updater = new Updater({
  dir: path.join(app.getPath('userData'), 'updates'),
  current: app.getVersion(),
  feed: process.env.CREW_UPDATE_FEED,
  supported: process.platform === 'win32' &&
    (Boolean(process.env.CREW_UPDATE_FEED) || fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Crew.exe'))),
  onChange: (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('update:changed', status);
    trayMenu();
  },
});
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
/** Set once the user chooses to install; the installer starts after the windows have closed. */
let installRequested = false;
let handedOver = false;
/** The board's top bar height (`.topbar` in board.css), so the window buttons line up with it. */
const TOP_BAR_HEIGHT = 60;
/** The board's --canvas and --label colors (board.css), behind and on the window buttons. */
const theme = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#0b0b0c', symbolColor: '#e1e1e2' } : { color: '#f4f4f6', symbolColor: '#28282a' };
/**
 * Lets the top bar and the sidebar's brand move the window, and keeps the top bar's controls and the dialogs'
 * close buttons clear of the window buttons. Injected here rather than kept in board.css, since the browser board has a title bar of its own;
 * injected sheets come before the page's, hence the extra specificity.
 */
const FRAME_CSS = `
.topbar, .brand { -webkit-app-region: drag; }
.topbar :is(button, a, input, nav), .brand :is(button, a) { -webkit-app-region: no-drag; }
:root .topbar {
  min-height: ${TOP_BAR_HEIGHT}px;
  padding-inline-end: max(var(--page-margin), calc((100% - 1400px) / 2),
    calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px));
}
:root dialog.detail-panel { top: ${TOP_BAR_HEIGHT + 4}px; }
:root dialog.sheet { max-height: calc(100vh - ${2 * (TOP_BAR_HEIGHT + 4)}px); }
/* Only the page below the top bar scrolls, so nothing passes under the bar and its scrollbar starts below the window
   buttons. The page centers its content with padding rather than a maximum width, keeping that scrollbar at the edge. */
:root, :root body { height: 100%; overflow: hidden; }
:root .workspace { height: 100vh; }
:root .topbar { position: static; flex: none; }
:root .page { flex: 1; min-height: 0; overflow-y: auto; max-width: none; margin: 0; }
@media (min-width: 761px) { :root .page { padding-inline: max(var(--page-margin), calc((100% - 1400px) / 2)); } }
/* Sticky offsets in board.css count the top bar the page used to scroll under; the page now starts below it. */
:root .event-day-name { top: 0; }
:root .dash-side { top: 12px; }`;
/** Windows 11 22H2 (build 22621) and later draw a backdrop material behind a transparent window; older systems keep the canvas. */
const BACKDROP = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 ? 'mica' : null;
/** The main window's colors: clear over the backdrop where there is one, the board's otherwise. */
const frame = () => (BACKDROP ? { ...theme(), color: '#00000000' } : theme());
/** Lets the backdrop show through the page and top bar; cards, panels and dialogs keep their own surfaces. */
const BACKDROP_CSS = `
:root body { background: transparent; }
:root .topbar { background: transparent; -webkit-backdrop-filter: none; backdrop-filter: none; }`;

/**
 * The bounds this launch restored, and what the window reported for them. Scaled displays round them on the way
 * in and out, so writing back an unmoved window's reported bounds would grow it a few pixels on every launch.
 */
let restored: { bounds: Rectangle; settled: Rectangle } | null = null;
const sameRect = (a: Rectangle, b: Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

function saveWindow() {
  if (!window || window.isDestroyed()) return;
  try {
    const current = window.getNormalBounds();
    const bounds = restored && sameRect(current, restored.settled) ? restored.bounds : current;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, JSON.stringify({ ...bounds, maximized: window.isMaximized() }));
  } catch (error) {
    console.error('Could not save window state:', error);
  }
}
function show() {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
/** Signs the board in with the daemon's secret as its HttpOnly cookie, so the secret never enters a URL or history. */
async function loadBoard() {
  if (!window || window.isDestroyed()) return;
  const token = readToken(HOME);
  if (token) {
    await window.webContents.session.cookies.set({
      url: BASE_URL, name: SESSION_COOKIE, value: token, httpOnly: true, sameSite: 'strict',
      expirationDate: Date.now() / 1000 + 31_536_000,
    });
  }
  await window.loadURL(BASE_URL);
}
function createWindow() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    /* The first launch has no saved bounds. */
  }
  const bounds = windowBounds(saved ?? {}, screen.getAllDisplays().map((display) => display.workArea));
  window = new BrowserWindow({
    ...bounds,
    minWidth: 640,
    minHeight: 480,
    show: false,
    title: 'Crew',
    icon: asset('icon.png'),
    backgroundColor: frame().color,
    ...(BACKDROP ? { backgroundMaterial: BACKDROP } : {}),
    autoHideMenuBar: true,
    // No system title bar: the board's top bar takes its place, with the window buttons drawn over it.
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...frame(), height: TOP_BAR_HEIGHT },
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, preload: asset('preload.cjs') },
  });
  const settled = window.getNormalBounds();
  restored = { bounds: { ...settled, ...bounds }, settled };
  if (bounds.maximized) window.maximize();
  window.once('ready-to-show', () => show());
  window.webContents.on('dom-ready', () => {
    void window?.webContents.insertCSS(BACKDROP ? FRAME_CSS + BACKDROP_CSS : FRAME_CSS).catch(console.error);
  });
  // Report links open in the user's browser. Evidence needs the board's sign-in, so it opens in a window of its own.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = linkTarget(url, BASE_URL);
    if (target === 'external') void shell.openExternal(url);
    if (target !== 'evidence') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: theme().color,
        icon: asset('icon.png'),
        webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
      },
    };
  });
  window.webContents.on('did-create-window', (child) => {
    child.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    child.webContents.on('will-navigate', (event) => event.preventDefault());
    child.webContents.on('will-redirect', (event) => event.preventDefault());
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (!isBoardNavigation(url, BASE_URL)) event.preventDefault();
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isBoardNavigation(url, BASE_URL)) event.preventDefault();
  });
  // The board's settings editor guards unsaved edits with beforeunload; Electron leaves the prompt to us.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question', message: 'Discard unsaved settings?',
      detail: 'Edits have not been saved, or a save is still in progress.',
      buttons: ['Discard changes', 'Keep editing'], defaultId: 1, cancelId: 1,
    });
    if (choice === 0) event.preventDefault();
    else {
      quitting = false;
      // The daemon was already stopped for the install; the app keeps running, so it needs its daemon back.
      if (installRequested) {
        installRequested = false;
        updater.failed();
        void ensureDaemon().catch(console.error);
      }
    }
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
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
  void loadBoard().catch(console.error);
}
function trayMenu(waiting = pending) {
  pending = waiting;
  tray?.setToolTip(pending ? `Crew · ${pending} need your input` : 'Crew');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: pending ? `Open Crew (${pending} waiting)` : 'Open Crew', click: () => show() },
      { label: 'Open in browser', click: () => void openInBrowser() },
      { label: 'Reload board', click: () => void loadBoard().catch(console.error) },
      ...(updater.status.state === 'ready' ? [{ label: `Restart to update to ${updater.status.latest}`, click: () => void installUpdate() }] : []),
      ...(updater.status.state === 'installing' && updater.status.waiting !== undefined
        ? [{ label: 'Cancel the waiting update', click: () => updater.failed() }]
        : []),
      { type: 'separator' },
      { label: 'Quit Crew — jobs keep running', click: () => app.quit() },
    ]),
  );
  window?.setOverlayIcon(pending ? nativeImage.createFromPath(asset('badge.png')) : null, pending ? `${pending} waiting` : '');
}
/** The browser signs in through the launch fragment, as /crew:board opens it. */
async function openInBrowser() {
  const token = readToken(HOME);
  await shell.openExternal(token ? `${BASE_URL}/#token=${token}` : BASE_URL);
}
/** Keeps the tray's waiting count current; the board itself follows the daemon's live stream. */
async function poll() {
  pollAbort = new AbortController();
  try {
    const signal = AbortSignal.any([pollAbort.signal, AbortSignal.timeout(4000)]);
    const state = await api<BoardState>('GET', '/api/state', undefined, signal);
    if (stopping) return;
    trayMenu(
      state.jobs.filter((job) => job.state === 'waiting').length +
        state.claude.filter((claude) => claude.state === 'waiting').length,
    );
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
  app.on('will-quit', (event) => {
    stopping = true;
    clearTimeout(timer);
    pollAbort?.abort();
    clearTimeout(checkTimer);
    clearTimeout(watchTimer);
    if (installRequested && !handedOver) {
      event.preventDefault();
      handedOver = true;
      void handOver().finally(() => app.quit());
    }
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
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  // The board's copy buttons are the only permission it needs; notifications come from the daemon.
  const allowed = (permission: string, origin: string) => permission === 'clipboard-sanitized-write' && origin === BASE_URL;
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowed(permission, URL.canParse(details.requestingUrl) ? new URL(details.requestingUrl).origin : '')));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin));
  nativeTheme.on('updated', () => {
    if (!window || window.isDestroyed()) return;
    window.setBackgroundColor(frame().color);
    window.setTitleBarOverlay({ ...frame(), height: TOP_BAR_HEIGHT });
  });
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
        return;
      }
    }
  }
  tray = new Tray(nativeImage.createFromPath(asset('tray.png')));
  tray.on('click', () => show());
  createWindow();
  trayMenu();
  void poll();
  watchUpdates();
}

/** Only the main window's board page may reach the updater. */
function fromBoard(event: IpcMainInvokeEvent) {
  const url = event.senderFrame?.url;
  if (event.sender !== window?.webContents || !url || !URL.canParse(url) || new URL(url).origin !== BASE_URL) {
    throw new Error('The updater answers only the Crew board.');
  }
}
function watchUpdates() {
  ipcMain.handle('update:state', (event) => {
    fromBoard(event);
    return updater.status;
  });
  // Asked for by the user, so a release on offer downloads at once.
  ipcMain.handle('update:check', async (event) => {
    fromBoard(event);
    await updater.check();
    await updater.download();
  });
  ipcMain.handle('update:install', async (event) => {
    fromBoard(event);
    await installUpdate();
  });
  ipcMain.handle('update:cancel', (event) => {
    fromBoard(event);
    // Only an install still waiting can be called off; past that, the daemon is already stopping.
    if (updater.status.state === 'installing' && updater.status.waiting !== undefined) updater.failed();
  });
  void updater.load().catch(console.error).then(() => {
    const check = () => {
      void updater.check();
      checkTimer = setTimeout(check, CHECK_EVERY_MS);
    };
    checkTimer = setTimeout(check, 60_000);
    // A found release downloads only once the user has been away from Crew for a while. One that failed waits for
    // the next check, rather than downloading again every few seconds.
    let lastUsed = Date.now();
    const watch = () => {
      if (window?.isFocused() && powerMonitor.getSystemIdleTime() * 1000 < AWAY_MS) lastUsed = Date.now();
      if (Date.now() - lastUsed >= AWAY_MS && !updater.status.error) void updater.download();
      watchTimer = setTimeout(watch, 15_000);
    };
    watch();
  });
}
async function ask(options: MessageBoxOptions) {
  return (window && !window.isDestroyed() ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options)).response;
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};
const samePath = (a: string, b: string) =>
  process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
/**
 * The daemon running from this app's own files, found by the record it keeps in the Crew home and its process, since
 * a health request can time out on a busy daemon. `active` is null when its health did not answer.
 */
async function ownDaemon(): Promise<{ pid: number; active: number | null } | null> {
  let record: { pid?: unknown; root?: unknown };
  try {
    record = JSON.parse(fs.readFileSync(path.join(HOME, 'daemon.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!Number.isInteger(record.pid) || !alive(record.pid as number) || typeof record.root !== 'string' || !samePath(record.root, PLUGIN_ROOT)) return null;
  const running = await health();
  return { pid: record.pid as number, active: running && running.pid === record.pid ? running.active : null };
}
/** Starts the daemon again once a process that agreed to stop has gone, unless the app is quitting. */
async function restartWhenGone(pid: number) {
  while (alive(pid) && !stopping) await sleep(2000);
  if (!stopping) void ensureDaemon().catch(console.error);
}
/** Counts each install the user starts, so a cancelled one that is still sleeping does not carry on beside a new one. */
let installAttempt = 0;
/**
 * Installs the staged update without losing work. The daemon this app started runs as this install's Crew.exe, which
 * the installer replaces, so it has to stop first, but it is only ever asked to stop while idle: it refuses while a job
 * runs or a change is being saved, and otherwise saves jobs and missions before it exits. Until then the install waits,
 * and the user can call it off. A daemon from another install is left alone. Jobs, missions and settings live in the
 * Crew home and the app's data folder, which the installer does not touch.
 */
async function installUpdate() {
  if (updater.status.state !== 'ready') return;
  const attempt = ++installAttempt;
  let daemon = await ownDaemon();
  if (daemon?.active) {
    const response = await ask({
      type: 'info',
      message: `${daemon.active} job${daemon.active === 1 ? ' is' : 's are'} still running.`,
      detail: 'Crew will install the update as soon as they finish. Nothing is stopped, and jobs, missions and settings are kept.',
      buttons: ['Update When Finished', 'Cancel'], defaultId: 0, cancelId: 1,
    });
    if (response !== 0 || attempt !== installAttempt) return;
  }
  // A second click while the daemon was asked supersedes this one; only the latest attempt takes the install.
  if (attempt !== installAttempt || !updater.installing(daemon?.active ?? 0)) return;
  // Read afresh each time: the user can cancel while the install waits.
  const current = () => attempt === installAttempt && !stopping && updater.status.state === 'installing';
  // Once the daemon has stopped, anything that calls the install off must start it again.
  let stopped = false;
  const abandon = () => {
    if (stopped && !stopping) void ensureDaemon().catch(console.error);
  };
  let refusals = 0;
  let unanswered = 0;
  for (;;) {
    if (!current()) return abandon();
    daemon = await ownDaemon();
    // The user may have called it off while that was asked.
    if (!current()) return abandon();
    if (!daemon) break;
    if (daemon.active === 0) {
      // From here the install can no longer be called off.
      updater.stoppingDaemon();
      let accepted = false;
      try {
        await api('POST', '/api/shutdown', { ifIdle: true });
        accepted = true;
        // It saves jobs and missions, then exits; the process going is what counts, not a quiet health check.
        for (let waited = 0; alive(daemon.pid); waited += 200) {
          if (waited >= 120_000) throw new Error(`The Crew daemon (process ${daemon.pid}) did not stop.`);
          await sleep(200);
        }
        stopped = true;
        // Checked again before going on, in case another daemon from these files has started meanwhile.
        continue;
      } catch (error) {
        if (!alive(daemon.pid)) {
          stopped = true;
          continue;
        }
        const message = `Could not stop the Crew daemon for the update: ${(error as Error).message}`;
        if (accepted) {
          // It agreed to stop and will go; once it has, the app that stays gets it back.
          updater.failed(message);
          void restartWhenGone(daemon.pid);
          return;
        }
        // Refused because work started meanwhile; a daemon that keeps refusing while idle is reported instead.
        if (++refusals >= 3) {
          updater.failed(message);
          return;
        }
        updater.waitFor(0);
      }
    } else if (daemon.active !== null) refusals = 0;
    // A daemon whose health does not answer is waited for, never taken as gone, but not for ever.
    if (daemon.active === null && ++unanswered >= 24) {
      updater.failed('The Crew daemon is not answering, so the update was not installed. Try again later.');
      return abandon();
    }
    if (daemon.active !== null) {
      unanswered = 0;
      updater.waitFor(daemon.active);
    }
    await sleep(5000);
  }
  if (!current()) return abandon();
  installRequested = quitting = true;
  app.quit();
}
/**
 * Starts the installer silently once the windows have closed. It installs into the same folder and starts the new
 * version. A small PowerShell supervisor, outside the install folder, waits for it and reopens Crew if it fails.
 */
async function handOver() {
  const installer = updater.installer;
  if (!installer) return;
  try {
    // Paths travel in the environment, never in the script text.
    const supervise = "$p = Start-Process -FilePath $env:CREW_INSTALLER -ArgumentList '/S','--force-run' -PassThru; $p.WaitForExit(); " +
      'if ($p.ExitCode -ne 0 -and (Test-Path -LiteralPath $env:CREW_APP)) { Start-Process -FilePath $env:CREW_APP }';
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', supervise], {
      detached: true, stdio: 'ignore', windowsHide: true,
      // Not the install folder, which the installer replaces.
      cwd: os.tmpdir(),
      env: { ...process.env, CREW_INSTALLER: installer, CREW_APP: process.execPath },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } catch (error) {
    // The staged installer stays, so the reopened app offers it again; the reopened app starts its daemon again.
    updater.failed((error as Error).message);
    dialog.showErrorBox('Crew could not update', `${(error as Error).message}\n\nCrew will reopen; try the update again from Settings.`);
    app.relaunch();
  }
}
