import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, screen, session, shell, Tray } from 'electron';
import type { IpcMainInvokeEvent, MessageBoxOptions, Rectangle } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boardCredential, boardUrl, SESSION_COOKIE } from '../plugin/bridge/auth.ts';
import { api, ensureDaemon, forgetDaemon, health, verifiedDaemon } from '../plugin/bridge/client.ts';
import { baseUrl, HOME, loadConfig, PLUGIN_ROOT } from '../plugin/bridge/config.ts';
import type { BoardState } from '../plugin/board/src/types.ts';
import { pickLanguage, setLanguage, t } from '../plugin/board/src/i18n.ts';
import type { Language } from '../plugin/board/src/i18n.ts';
import { SETTING_CHANGE, taskbarDark } from './taskbar.ts';
import { installScript, supervisorEnv, UPDATE_FAILED, Updater } from './updater.ts';
import { isBoardNavigation, isSessionAppLink, linkTarget, windowBounds } from './window-state.ts';

// The Electron shell for Windows (and other non-macOS systems); macOS uses the native app in native/.
// It hosts the same React board the browser shows. Notifications stay with the daemon, whose Windows toasts
// need no installed shortcut or app identity, so this app never claims the desktop notification lease.

/**
 * A first install has no Crew home yet: the daemon this app starts creates it, and an update finds it in place. Read
 * first, since under CREW_HOME the user data folder below sits in the home and the instance lock may create it.
 */
const firstInstall = !fs.existsSync(HOME);
// Test and alternate daemon profiles must not claim the user's normal desktop instance.
if (process.env.CREW_HOME) app.setPath('userData', path.join(HOME, 'desktop'));
// The Start menu shortcut's identity (electron-builder's appId), so a launch of Crew.exe itself, as the installer
// does (desktop/installer.nsh), groups on the taskbar with the shortcut and its pin.
if (process.platform === 'win32') app.setAppUserModelId('dev.crew.desktop');
const locked = app.requestSingleInstanceLock();
/** Marks the welcome guide as owed on a first install. The mark stays until the board says the guide closed. */
const welcomeFile = path.join(app.getPath('userData'), 'welcome-pending');
if (locked && firstInstall) {
  fs.mkdirSync(path.dirname(welcomeFile), { recursive: true });
  fs.writeFileSync(welcomeFile, '');
}
let window: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let stopping = false;
let timer: ReturnType<typeof setTimeout> | undefined;
let pollAbort: AbortController | null = null;
/** The daemon address the board was last moved to. */
let movedTo = '';
let pending = 0;
const stateFile = path.join(app.getPath('userData'), 'window.json');
const asset = (name: string) => path.join(import.meta.dirname, name);
/**
 * Given an .ico path, Electron loads the image Windows asks for at each size. Given a PNG, it passes the whole bitmap
 * as the window icon and leaves Windows to scale 256px down to each size.
 */
const APP_ICON = asset('icon.ico');
/** The overlay drawn for the primary display's scale, which Windows would otherwise stretch from 16px. */
function badgeIcon() {
  const want = 16 * screen.getPrimaryDisplay().scaleFactor;
  const size = [16, 20, 24, 28, 32, 40].reduce((best, size) => (Math.abs(size - want) < Math.abs(best - want) ? size : best));
  return nativeImage.createFromPath(asset(`badge-${size}.png`));
}
/** The tray sits on the taskbar, which follows the Windows mode rather than the app mode the window follows. */
const trayIcon = (dark: boolean) => nativeImage.createFromPath(asset(dark ? 'tray-white.png' : 'tray-black.png'));
/** The Windows mode the tray was last drawn for; the app mode stands in where the Windows mode cannot be read. */
let trayDark = false;
const readTrayDark = async () => (await taskbarDark()) ?? nativeTheme.shouldUseDarkColors;
let trayTimer: ReturnType<typeof setTimeout> | undefined;
/**
 * Redraws the tray once a mode change has settled: Windows announces one in a burst of messages, and the first can
 * arrive before the registry holds the new mode.
 */
function refreshTray() {
  clearTimeout(trayTimer);
  trayTimer = setTimeout(async () => {
    const dark = await readTrayDark();
    if (dark === trayDark) return;
    trayDark = dark;
    tray?.setImage(trayIcon(dark));
  }, 300);
}
/** The window looks out of reach once it has been out of focus, or the system idle, this long; only then does an update download. */
const AWAY_MS = 120_000;
const CHECK_EVERY_MS = 6 * 3_600_000;
/** An installed copy has the installer's uninstaller beside it; an unpacked or development build cannot update itself. */
const installed = process.platform === 'win32' && fs.existsSync(path.join(path.dirname(process.execPath), 'Uninstall Crew.exe'));
/** What Windows starts at sign-in: this executable with this argument, which keeps the window closed. */
const LOGIN_ITEM = { args: ['--hidden'] };
const openedAtLogin = process.argv.includes(LOGIN_ITEM.args[0]);
/**
 * Only the installed copy opens at sign-in, since another build's executable is Electron's own or a folder that moves.
 * A test or alternate profile (CREW_HOME) must not change what the user's sign-in starts.
 */
const loginItemSupported = installed && !process.env.CREW_HOME;
/**
 * Read from Windows each time rather than stored, since the user can also turn it off in Task Manager's Startup apps:
 * the Run entry must be this one, and Windows must not have it switched off.
 */
const opensAtLogin = () => {
  const settings = app.getLoginItemSettings(LOGIN_ITEM);
  return settings.openAtLogin && settings.executableWillLaunchAtLogin;
};
/** CREW_UPDATE_FEED points any build at another releases endpoint, for testing against a local server. */
const updater = new Updater({
  dir: path.join(app.getPath('userData'), 'updates'),
  current: app.getVersion(),
  feed: process.env.CREW_UPDATE_FEED,
  supported: installed || (process.platform === 'win32' && Boolean(process.env.CREW_UPDATE_FEED)),
  onChange: (status) => {
    if (window && !window.isDestroyed()) window.webContents.send('update:changed', status);
    trayMenu();
  },
});
/** Why the install this launch follows did not go through. Taken out first, so the daemon this app starts does not inherit it. */
const updateFailed = process.env[UPDATE_FAILED];
delete process.env[UPDATE_FAILED];
let checkTimer: ReturnType<typeof setTimeout> | undefined;
let watchTimer: ReturnType<typeof setTimeout> | undefined;
/** Set once the user chooses to install; the installer starts after the windows have closed. */
let installRequested = false;
let handedOver = false;
/** The install's hand-over steps, kept beside the app's data for diagnosing an update that did not go through. */
const updateLog = (step: string) => {
  try { fs.appendFileSync(path.join(app.getPath('userData'), 'update.log'), `${new Date().toISOString()} ${step}\n`); } catch {}
};
/** The board's top bar height (`.topbar` in board.css), so the window buttons line up with it. */
const TOP_BAR_HEIGHT = 60;
/** The board's --canvas and --label colors (board.css), behind and on the window buttons. */
const theme = () =>
  nativeTheme.shouldUseDarkColors ? { color: '#1f1f22', symbolColor: '#e1e1e2' } : { color: '#f1f2f4', symbolColor: '#28282a' };
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
  padding-inline-end: max(var(--window-inset), calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 12px));
}
@media (max-width: 760px) { :root dialog.detail-panel { top: ${TOP_BAR_HEIGHT + 4}px; } }
:root dialog.sheet { max-height: calc(100vh - ${2 * (TOP_BAR_HEIGHT + 4)}px); }`;
/** Windows 11 22H2 (build 22621) and later draw a backdrop material behind a transparent window; older systems keep the canvas. */
const BACKDROP = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 ? 'mica' : null;
/** The main window's colors: clear over the backdrop where there is one, the board's otherwise. */
const frame = () => (BACKDROP ? { ...theme(), color: '#00000000' } : theme());
/**
 * Lets the backdrop show through the frame (the sidebar and top bar); the stage, cards, panels and dialogs keep their
 * own surfaces. While a sheet is open the frame takes its canvas again, so the sheet's backdrop blurs it as it does in
 * a browser.
 */
const BACKDROP_CSS = `
:root body { background: transparent; }
:root:has(dialog.sheet:modal) body { background: var(--canvas); }
@media (prefers-reduced-motion: no-preference) { :root body { transition: background-color 300ms ease-out; } }`;

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
/** What the board's requests are signed with: a board credential, made again when the secret changes or it nears its end. */
let signed: { token: string; credential: string; expires: number } | null = null;
/**
 * Signs the board's requests from here, so its page holds nothing and neither a cookie nor an address carries the
 * secret. Only the board window's requests to the daemon are signed; a window opened for evidence loads an address
 * that carries that file's seal.
 */
function signBoard(board: BrowserWindow) {
  // Read once: the session outlives the window, whose contents cannot be asked for their id once it is destroyed.
  const { id } = board.webContents;
  const { webRequest } = board.webContents.session;
  webRequest.onBeforeSendHeaders(async (details, respond) => {
    const origin = URL.parse(details.url)?.origin;
    if (details.webContentsId !== id || origin !== baseUrl()) {
      respond({ requestHeaders: details.requestHeaders });
      return;
    }
    const daemon = await verifiedDaemon(origin);
    if (!daemon) {
      respond({ cancel: true });
      return;
    }
    const { token } = daemon;
    if (token && (signed?.token !== token || signed.expires - Date.now() < 3_600_000)) signed = { token, ...boardCredential(token) };
    respond({ requestHeaders: token ? { ...details.requestHeaders, Authorization: `Bearer ${signed!.credential}` } : details.requestHeaders });
  });
  webRequest.onErrorOccurred((details) => {
    const origin = URL.parse(details.url)?.origin;
    if (details.webContentsId === id && origin === baseUrl()) forgetDaemon(origin);
  });
}
async function loadBoard() {
  if (!window || window.isDestroyed()) return;
  // An earlier version signed in with a cookie holding the secret itself.
  await window.webContents.session.cookies.remove(baseUrl(), SESSION_COOKIE);
  await window.loadURL(baseUrl());
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
    icon: APP_ICON,
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
  signBoard(window);
  // A theme update is tied to the app mode, so for the Windows mode the tray also takes the system's own message,
  // which reaches the window while it is hidden too.
  if (process.platform === 'win32') window.hookWindowMessage(SETTING_CHANGE, refreshTray);
  // Opened at sign-in, the app waits in the tray until the user opens it.
  window.once('ready-to-show', () => {
    if (!openedAtLogin) show();
  });
  window.webContents.on('dom-ready', () => {
    void window?.webContents.insertCSS(BACKDROP ? FRAME_CSS + BACKDROP_CSS : FRAME_CSS).catch(console.error);
  });
  // Report links open in the user's browser. Evidence is the daemon's to serve, so it opens in a window of its
  // own, by an address that carries the file's seal.
  window.webContents.setWindowOpenHandler(({ url }) => {
    const target = linkTarget(url, baseUrl());
    if (target === 'external') void shell.openExternal(url);
    if (target !== 'evidence') return { action: 'deny' };
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        backgroundColor: theme().color,
        icon: APP_ICON,
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
    if (isBoardNavigation(url, baseUrl())) return;
    event.preventDefault();
    if (isSessionAppLink(url)) void shell.openExternal(url);
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!isBoardNavigation(url, baseUrl())) event.preventDefault();
  });
  // The board's settings editor guards unsaved edits with beforeunload; Electron leaves the prompt to us.
  window.webContents.on('will-prevent-unload', (event) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question', message: t('Discard unsaved settings?'),
      detail: t('Edits have not been saved, or a save is still in progress.'),
      buttons: [t('Discard changes'), t('Keep editing')], defaultId: 1, cancelId: 1,
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
  tray?.setToolTip(pending ? t('Crew · {count} need your input', { count: pending }) : 'Crew');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: pending ? t('Open Crew ({count} waiting)', { count: pending }) : t('Open Crew'), click: () => show() },
      { label: t('Open in browser'), click: () => void openInBrowser() },
      { label: t('Reload board'), click: () => void loadBoard().catch(console.error) },
      ...(updater.status.state === 'ready' ? [{ label: t('Update to {version}', { version: updater.status.latest ?? '' }), click: () => void installUpdate() }] : []),
      ...(updater.status.state === 'installing' && updater.status.waiting !== undefined
        ? [{ label: t('Cancel the waiting update'), click: () => updater.failed() }]
        : []),
      { type: 'separator' },
      { label: t('Quit Crew — jobs keep running'), click: () => app.quit() },
    ]),
  );
  window?.setOverlayIcon(pending ? badgeIcon() : null, pending ? `${pending} waiting` : '');
}
/** The browser signs in with a ticket in the launch fragment, as /crew:board opens it. Without one it shows how to sign in. */
async function openInBrowser() {
  const ticket = await api<{ ticket: string }>('POST', '/api/session/ticket').then((issued) => issued.ticket, () => null);
  await shell.openExternal(boardUrl(baseUrl(), ticket));
}
/**
 * The tray and dialogs read the language setting, or the system's where none is set: the same choice the board makes,
 * since the board's Chromium takes its languages from this locale. Undefined (an older daemon) also follows the system.
 */
const applyLanguage = (choice: Language | null | undefined) => setLanguage(choice ?? pickLanguage([app.getLocale()]));
/** Keeps the tray's waiting count and language current; the board itself follows the daemon's live stream. */
async function poll() {
  pollAbort = new AbortController();
  try {
    const signal = AbortSignal.any([pollAbort.signal, AbortSignal.timeout(4000)]);
    const state = await api<BoardState>('GET', '/api/state', undefined, signal);
    if (stopping) return;
    applyLanguage(state.language);
    // A daemon that restarted on another port leaves the board reconnecting to the old one. Moved once per port:
    // a board that refuses to unload (unsaved settings) is not asked again every poll.
    const shown = window && !window.isDestroyed() ? window.webContents.getURL() : '';
    if (URL.canParse(shown) && new URL(shown).origin !== baseUrl() && movedTo !== baseUrl()) {
      movedTo = baseUrl();
      void loadBoard().catch(console.error);
    }
    trayMenu(
      state.jobs.filter((job) => job.state === 'waiting').length +
        state.claude.filter((claude) => claude.state === 'waiting').length,
    );
  } catch {
    tray?.setToolTip(t('Crew · reconnecting to daemon'));
  } finally {
    if (!stopping) timer = setTimeout(() => void poll(), 3000);
  }
}
if (!locked) app.quit();
else {
  app.on('second-instance', () => show());
  app.on('activate', () => show());
  app.on('before-quit', () => {
    if (installRequested) updateLog('before-quit');
    quitting = true;
    saveWindow();
  });
  app.on('will-quit', (event) => {
    if (installRequested) updateLog(`will-quit${handedOver ? ' (after hand-over)' : ''}`);
    stopping = true;
    clearTimeout(timer);
    pollAbort?.abort();
    clearTimeout(checkTimer);
    clearTimeout(watchTimer);
    if (installRequested && !handedOver) {
      event.preventDefault();
      handedOver = true;
      updateLog('windows closed; handing over');
      // The windows are closed and before-quit has run, so the app exits outright rather than going through quit again.
      void handOver().finally(() => {
        updateLog('exiting');
        app.exit(0);
      });
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
  // Read from the file until the daemon answers, so a dialog about starting it is in the chosen language too.
  try {
    applyLanguage(loadConfig().language);
  } catch {
    applyLanguage(null);
  }
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }, { role: 'viewMenu' }, { role: 'windowMenu' }]));
  // The board's copy buttons are the only permission it needs; notifications come from the daemon.
  const allowed = (permission: string, origin: string) => permission === 'clipboard-sanitized-write' && origin === baseUrl();
  session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
    callback(allowed(permission, URL.canParse(details.requestingUrl) ? new URL(details.requestingUrl).origin : '')));
  session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => allowed(permission, origin));
  nativeTheme.on('updated', () => {
    refreshTray();
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
        title: t('Crew could not start'),
        message: (error as Error).message,
        buttons: [t('Retry'), t('Quit')],
        defaultId: 0,
        cancelId: 1,
      });
      if (answer.response === 1) {
        app.quit();
        return;
      }
    }
  }
  trayDark = await readTrayDark();
  tray = new Tray(trayIcon(trayDark));
  tray.on('click', () => show());
  createWindow();
  trayMenu();
  void poll();
  watchUpdates();
}

/** Only the main window's board page may reach the updater. */
async function fromBoard(event: IpcMainInvokeEvent) {
  const origin = URL.parse(event.senderFrame?.url ?? '')?.origin;
  if (event.sender !== window?.webContents || !origin || !await verifiedDaemon(origin)
      || event.sender !== window?.webContents || URL.parse(event.senderFrame?.url ?? '')?.origin !== origin) {
    throw new Error('The updater answers only the Crew board.');
  }
}
function watchUpdates() {
  ipcMain.handle('update:state', async (event) => {
    await fromBoard(event);
    return updater.status;
  });
  // Asked for by the user, so a release on offer downloads at once.
  ipcMain.handle('update:check', async (event) => {
    await fromBoard(event);
    await updater.check();
    await updater.download();
  });
  ipcMain.handle('update:install', async (event) => {
    await fromBoard(event);
    await installUpdate();
  });
  ipcMain.handle('update:cancel', async (event) => {
    await fromBoard(event);
    // Only an install still waiting can be called off; past that, the daemon is already stopping.
    if (updater.status.state === 'installing' && updater.status.waiting !== undefined) updater.failed();
  });
  ipcMain.handle('update:seen', async (event) => {
    await fromBoard(event);
    updater.seen();
  });
  ipcMain.handle('welcome:pending', async (event) => {
    await fromBoard(event);
    return fs.existsSync(welcomeFile);
  });
  ipcMain.handle('welcome:done', async (event) => {
    await fromBoard(event);
    fs.rmSync(welcomeFile, { force: true });
  });
  ipcMain.handle('login:state', async (event) => {
    await fromBoard(event);
    return loginItemSupported ? opensAtLogin() : null;
  });
  // Turning it on also switches it back on where the user turned it off in Task Manager (`enabled` defaults to true).
  ipcMain.handle('login:set', async (event, open: unknown) => {
    await fromBoard(event);
    if (!loginItemSupported || typeof open !== 'boolean') throw new Error('Only the installed app opens at sign-in.');
    app.setLoginItemSettings({ openAtLogin: open, ...LOGIN_ITEM });
    return opensAtLogin();
  });
  if (updateFailed) updater.installFailed(updateFailed);
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
      message: daemon.active === 1 ? t('1 job is still running.') : t('{count} jobs are still running.', { count: daemon.active }),
      detail: t('Crew will install the update as soon as they finish. Nothing is stopped, and jobs, missions and settings are kept.'),
      buttons: [t('Update When Finished'), t('Cancel')], defaultId: 0, cancelId: 1,
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
        await api('POST', '/api/shutdown', { ifIdle: true, expectedPid: daemon.pid });
        accepted = true;
        // It saves jobs and missions, then exits; the process going is what counts, not a quiet health check.
        for (let waited = 0; alive(daemon.pid); waited += 200) {
          if (waited >= 120_000) throw new Error(t('The Crew daemon (process {pid}) did not stop.', { pid: daemon.pid }));
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
        const message = t('Could not stop the Crew daemon for the update: {error}', { error: (error as Error).message });
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
      updater.failed(t('The Crew daemon is not answering, so the update was not installed. Try again later.'));
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
  updateLog(`daemon stopped; quitting to install ${updater.status.latest}`);
  app.quit();
}
/**
 * Starts the installer silently once the windows have closed. It installs into the same folder and starts the new
 * version. A small PowerShell supervisor, outside the install folder, waits for it and reopens Crew if it fails.
 */
async function handOver() {
  const installer = updater.installer;
  const sha256 = updater.installerSHA256;
  updateLog(`installer ${installer ?? 'missing'}`);
  try {
    if (!installer || !sha256) throw new Error(t('Crew could not verify the update. Download it again from Settings.'));
    // Paths travel in the environment, never in the script text.
    const supervise = `try { ${installScript} } catch {
      $reason = $_.Exception.Message
      Wait-Process -Id $env:CREW_PARENT_PID -ErrorAction SilentlyContinue
      # Crew shows why in its own window. A window of this hidden script cannot take the foreground and opens behind
      # others, so the alert is only for a Crew that is gone.
      if (Test-Path -LiteralPath $env:CREW_APP) {
        $env:${UPDATE_FAILED} = $reason
        Start-Process -FilePath $env:CREW_APP
      } else {
        Add-Type -AssemblyName System.Windows.Forms
        [void][System.Windows.Forms.MessageBox]::Show($reason, 'Crew could not update', 'OK', 'Error')
      }
    }`;
    // The supervisor must outlive the app, so it is detached: a child that is not is killed with the app (libuv's job).
    // But a detached PowerShell has no console and exits without running its script, so a detached cmd starts it in a
    // console of its own, which -WindowStyle Hidden then hides. The script is encoded so cmd does not parse it.
    const encoded = Buffer.from(supervise, 'utf16le').toString('base64');
    const powershell = ['powershell.exe', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded];
    const child = spawn('cmd.exe', ['/d', '/c', 'start', '""', '/min', ...powershell], {
      detached: true, stdio: 'ignore', windowsHide: true,
      // Not the install folder, which the installer replaces.
      cwd: os.tmpdir(),
      env: { ...supervisorEnv(process.env), CREW_INSTALLER: installer, CREW_INSTALLER_SHA256: sha256, CREW_APP: process.execPath, CREW_PARENT_PID: String(process.pid) },
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
    updateLog(`supervisor started (process ${child.pid})`);
  } catch (error) {
    updateLog(`supervisor failed: ${(error as Error).message}`);
    // The staged installer stays, so the reopened app offers it again; the reopened app starts its daemon again.
    updater.failed((error as Error).message);
    dialog.showErrorBox(t('Crew could not update'), t('{error}\n\nCrew will reopen; try the update again from Settings.', { error: (error as Error).message }));
    app.relaunch();
  }
}
