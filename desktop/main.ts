import { app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, screen, session, shell, Tray } from 'electron';
import type { Rectangle } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToken, SESSION_COOKIE } from '../plugin/bridge/auth.ts';
import { api, ensureDaemon } from '../plugin/bridge/client.ts';
import { BASE_URL, HOME } from '../plugin/bridge/config.ts';
import type { BoardState } from '../plugin/board/src/types.ts';
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
const stateFile = path.join(app.getPath('userData'), 'window.json');
const asset = (name: string) => path.join(import.meta.dirname, name);
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
:root dialog.sheet { max-height: calc(100vh - ${2 * (TOP_BAR_HEIGHT + 4)}px); }`;
/** Windows 11 22H2 (build 22621) and later draw a backdrop material behind a transparent window; older systems keep the canvas. */
const BACKDROP = process.platform === 'win32' && Number(os.release().split('.')[2]) >= 22621 ? 'mica' : null;
/** The main window's colors: clear over the backdrop where there is one, the board's otherwise. */
const frame = () => (BACKDROP ? { ...theme(), color: '#00000000' } : theme());
/** Lets the backdrop show through the page; cards, panels and dialogs keep their own surfaces. */
const BACKDROP_CSS = `:root body, :root .topbar { background: transparent; }`;

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
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
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
    else quitting = false;
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
function trayMenu(pending = 0) {
  tray?.setToolTip(pending ? `Crew · ${pending} need your input` : 'Crew');
  tray?.setContextMenu(
    Menu.buildFromTemplate([
      { label: pending ? `Open Crew (${pending} waiting)` : 'Open Crew', click: () => show() },
      { label: 'Open in browser', click: () => void openInBrowser() },
      { label: 'Reload board', click: () => void loadBoard().catch(console.error) },
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
}
