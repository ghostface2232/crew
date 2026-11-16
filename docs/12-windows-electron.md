# 12. Windows desktop app (Electron)

Implemented 2026-11-16. macOS keeps the [native SwiftUI app](08-native-macos.md). Windows, and any other system that is not macOS, gets an Electron shell around the current React web board. Both talk to the same independent TypeScript daemon, so jobs, settings and the browser board are shared. The [earlier Electron shell](07-desktop-and-react.md) was the starting point, updated for the daemon's token sign-in and the board's present layout.

## Architecture

```text
Electron main (desktop/main.ts) ── ensureDaemon ── independent daemon ── agent CLIs / worktrees
  window, tray, single instance          │
                                         │ HTTP + SSE, signed in by cookie
  sandboxed renderer ─── React board (plugin/board) served by the daemon
```

- The main process imports the bridge's own `client.ts`, so startup reuses `ensureDaemon`, including version negotiation and active-job protection. The daemon is started with the app's Electron executable in Node mode (`ELECTRON_RUN_AS_NODE`), so a separate Node install is not needed to run it.
- Before loading the board, the main process sets the daemon's `crew_session` cookie from `~/.crew/token`. The secret never appears in a URL or in history. The tray's Open in browser command uses the usual `#token=` launch fragment.
- The renderer runs with `nodeIntegration: false`, `contextIsolation: true` and `sandbox: true`, and has no preload. Navigation outside the board and webviews are denied. The only permission granted is clipboard writing for the board's origin, which its copy buttons use.
- Links in reports open in the user's browser. Evidence images need the board's sign-in, so they open in a separate sandboxed app window that cannot navigate. Every other new window is refused.

## Window

- No system title bar. `titleBarStyle: 'hidden'` with `titleBarOverlay` draws Windows' minimize, maximize and close buttons over the board's 60px top bar, in the board's canvas and label colors, and follows the system light or dark theme.
- The main process injects a small stylesheet: the top bar and the sidebar's brand drag the window, and the controls in them stay clickable. The top bar keeps its right padding clear of the window buttons through `env(titlebar-area-*)`. The detail panel and dialogs start below the window buttons, including at narrow widths. The browser board is unchanged.
- Closing the window hides it to the tray. Quitting leaves the daemon and its jobs running; reopening attaches to the same daemon. A second launch shows the first window.
- Bounds and maximized state are restored. On scaled displays, Electron rounds bounds on the way in and out, so an unmoved window is saved with the bounds it was restored from; otherwise it would grow a few pixels on every launch.
- The tray tooltip and the taskbar overlay show how many jobs and Claude sessions are waiting.
- Quitting with unsaved settings asks first, through the board's `beforeunload` guard.

## Notifications

The daemon keeps notifications on Windows. Its PowerShell toasts need no Start menu shortcut or registered app identity, which an unpackaged or unsigned Electron build lacks. The app therefore sends no desktop heartbeat and denies the board's own browser notifications; the board recognizes the app and hides its Turn on notifications command. Approval buttons in notifications are not offered on Windows; open the app or board to answer.

## Build and run

```bash
npm ci
npm run desktop
npm run package:desktop
```

`npm run desktop`, `build:desktop`, `package:desktop` and `test:desktop` go through `scripts/desktop.mjs`, which picks the native app on macOS and Electron elsewhere. The Electron build writes `desktop/build` and renders the icons from `plugin/board/src/icons/CrewAppIcon.svg` with Playwright's Chromium (`npx playwright install chromium`). The packaged app is `release/Crew-win32-x64/Crew.exe`.

This is a local, unsigned build with no installer, code signing, automatic updates or login launch. Worker CLIs and git must still be installed and signed in.

## Verification

```bash
npm test
npm run typecheck
npm run test:desktop
```

The smoke test (`scripts/smoke-electron.mjs`) runs the app against its own daemon in a temporary home on a free port and starts no workers. It checks cookie sign-in without a URL secret, renderer isolation, hide on close, single instance, a cancelled quit that keeps unsaved settings, blocked external navigation, that no control lies under the window buttons at full or narrow width with Settings open, clipboard writes, evidence windows and browser links, the tray's waiting count, bounds restored without drift, and daemon survival across quit and reopen. Set `CREW_APP_PATH` to `release/Crew-win32-x64/Crew.exe` to check the packaged app.

On Windows the daemon inherits the app's stdio handles, so Playwright's `close()` would wait for the daemon too; the smoke test quits the app and waits for its own process to exit.

Verified on Windows 11 x64 at 150% scaling, unpackaged and packaged. The packaged app occupies about 360 MB on disk, and an idle board measured about 520 MiB as the sum of Electron process working sets under Playwright; working sets count shared pages more than once.
