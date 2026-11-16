# 12. Windows desktop app (Electron)

Implemented 2026-11-16. macOS keeps the [native SwiftUI app](08-native-macos.md). Windows (and any other non-macOS system) gets an Electron shell around the current React web board. Both connect to the same independent TypeScript daemon, so jobs, settings, and the browser board are shared. The [earlier Electron shell](07-desktop-and-react.md) was the starting point, updated for the daemon's token sign-in and the board's present layout.

## Architecture

```text
Electron main (desktop/main.ts) ── ensureDaemon ── independent daemon ── agent CLIs / worktrees
  window, tray, single instance          │
                                         │ HTTP + SSE, signed in by cookie
  sandboxed renderer ─── React board (plugin/board) served by the daemon
```

- The main process imports the bridge's own `client.ts`, so startup reuses `ensureDaemon`, including version negotiation and active-job protection. The daemon starts using the app's Electron executable in Node mode (`ELECTRON_RUN_AS_NODE`), so no separate Node install is needed.
- Before loading the board, the main process sets the daemon's `crew_session` cookie from `~/.crew/token`. The secret never appears in a URL or browser history. The tray's Open in browser command uses the usual `#token=` launch fragment.
- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, with no preload script. Navigation outside the board and webviews are denied. The only granted permission is clipboard write access for the board's origin, used by its copy buttons.
- Links in reports open in the default browser. Evidence images require the board's sign-in, so they open in a separate sandboxed app window that cannot navigate. All other new-window requests are denied.

## Window

- No system title bar. `titleBarStyle: 'hidden'` with `titleBarOverlay` draws the Windows minimize, maximize, and close buttons over the board's 60px top bar using the board's canvas and label colors, following the system light or dark theme.
- On Windows 11 22H2 (build 22621) and later the window uses the Mica backdrop: the page and top bar are transparent, as is the area behind the window buttons, while cards, panels and dialogs keep their own surfaces. Mica was chosen over Acrylic after comparing both; it tints with the desktop instead of showing the windows behind. Windows shows a solid color while the window is inactive. Older systems keep the board's canvas color. The taskbar and window icons are the app mark with the sidebar's rounded corners.
- The main process injects a small stylesheet so the top bar and sidebar brand drag the window while their controls remain clickable. The top bar keeps its right padding clear of the window buttons via `env(titlebar-area-*)`, and the detail panel and dialogs start below the window buttons even at narrow widths. Only the page below the top bar scrolls, so nothing passes under the bar, and its scrollbar starts below the window buttons; the page centers its content with padding so that scrollbar sits at the window edge. The search palette opens below the window buttons when it would reach them (through the Window Controls Overlay API, in `Palette.tsx`). The browser board's layout is unchanged.
- Closing the window hides it to the tray. Quitting leaves the daemon and its jobs running; reopening attaches to the same daemon. A second launch shows the first window.
- Window bounds and maximized state are restored on launch. On scaled displays, Electron rounds bounds on the way in and out, so an unmoved window saves the exact bounds it was restored from rather than growing a few pixels on every launch.
- The tray tooltip and the taskbar overlay show how many jobs and Claude sessions are waiting.
- Quitting with unsaved settings prompts for confirmation via the board's `beforeunload` guard.

## Notifications

The daemon continues to handle notifications on Windows. Its PowerShell toasts require no Start menu shortcut or registered app identity, which an unpackaged or unsigned Electron build lacks. Consequently, the app sends no desktop heartbeat and denies the board's browser notifications; the board detects the app and hides its Turn on notifications command. Approval buttons are not available in Windows notifications—open the app or board to respond.

## Build and run

```bash
npm ci
npm run desktop
npm run package:desktop
```

`npm run desktop`, `build:desktop`, `package:desktop`, and `test:desktop` go through `scripts/desktop.mjs`, which picks the native app on macOS and Electron elsewhere. The Electron build outputs to `desktop/build` and renders the icons from `plugin/board/src/icons/CrewAppIcon.svg` using Playwright's Chromium (`npx playwright install chromium`). Packaging writes the per-user installer `release/Crew-Setup-<version>.exe` and unpacked executable `release/win-unpacked/Crew.exe`. The installer installs to `%LOCALAPPDATA%\Programs\Crew` and creates a Start menu shortcut and uninstaller.

This produces a local, unsigned installer without automatic updates or launch-at-login support. Packaging never publishes releases or generates `latest.yml`. Worker CLIs and git must still be installed and authenticated.

For a silent update that restarts the app, run `Crew-Setup-<version>.exe /S --force-run --updated`. `/S` suppresses the installer UI; `--force-run` starts the app even in silent mode; `--updated` marks the update and is passed to the restarted app. The existing per-user install location is reused (unless `/D=` overrides it).

These behaviors come from electron-builder's installed NSIS templates: `node_modules/app-builder-lib/templates/nsis/installSection.nsh` (silent launch condition), `common.nsh` (`StartApp` and `UNINSTALL_FILENAME`), and `multiUser.nsh` (`setInstallModePerUser`). The installed uninstaller is `Uninstall Crew.exe`, alongside `Crew.exe`; with `asar: false`, application files are under `%LOCALAPPDATA%\Programs\Crew\resources\app`.

Before replacing files, `include/allowOnlyOneInstallerInstance.nsh` checks and stops running processes. Its PowerShell filter is `$$_.Path -and $$_.Path.StartsWith('$INSTDIR', 'CurrentCultureIgnoreCase')`, followed by `Stop-Process -Id $$_.ProcessId $0` (retried with `-Force`). This includes the background daemon running from that directory. If PowerShell is unavailable, the per-user fallback uses `taskkill /IM Crew.exe` filtered to the current user, excluding the parent PID; that fallback is not restricted to the install directory. The updater must account for daemon termination.

The planned updater reads `https://api.github.com/repos/ghostface2232/crew/releases/latest`, selects `Crew-Setup-<version>.exe`, and verifies GitHub's SHA-256 digest before execution. It does not use electron-updater metadata.

## Verification

```bash
npm test
npm run typecheck
npm run test:desktop
```

The smoke test (`scripts/smoke-electron.mjs`) runs the app against an isolated daemon in a temporary home directory on a free port, without starting any workers. It verifies:

- cookie sign-in without a URL secret, and renderer isolation
- hiding to the tray on close, single-instance focus, and daemon survival across quit and reopen
- cancelling quit to preserve unsaved settings
- blocked external navigation, browser-opened report links, and separate evidence windows
- unobstructed UI controls at full and narrow widths (including with Settings open)
- clipboard write permission, tray waiting counts, and drift-free window bounds restoration

Set `CREW_APP_PATH` to `release/win-unpacked/Crew.exe` to test the packaged app.

On Windows, the daemon inherits the app's stdio handles, so Playwright's `close()` would hang waiting for the daemon; instead, the smoke test quits the app and waits for its own process to exit.

Verified on Windows 11 x64 at 150% display scaling, both unpackaged and packaged. The packaged app uses about 360 MB on disk, and the smoke runs measured 520 to 710 MiB across all Electron process working sets under Playwright, after the checks above (note that working sets count shared pages more than once).
