# Windows desktop app (Electron)

Implemented 2026-11-16. macOS keeps the [native SwiftUI app](macos-app.md). Windows gets an Electron shell around the current React web board. Both connect to the same independent TypeScript daemon, so jobs, settings, and the browser board are shared. The [earlier Electron shell](board.md) was the starting point, updated for the daemon's token sign-in and the board's present layout.

## Architecture

```text
Electron main (desktop/main.ts) ── ensureDaemon ── independent daemon ── agent CLIs / worktrees
  window, tray, single instance          │
                                         │ HTTP + SSE, signed by the main process
  sandboxed renderer ─── React board (plugin/board) served by the daemon
```

- The main process imports the bridge's own `client.ts`, so startup reuses `ensureDaemon`, including version negotiation and active-job protection. The daemon starts using the app's Electron executable in Node mode (`ELECTRON_RUN_AS_NODE`), so no separate Node install is needed.
- The main process signs the board window's requests to the daemon: it makes a board credential from `~/.crew/token` and adds it as a header (`signBoard` in `desktop/main.ts`), so the page holds nothing and neither a cookie nor an address carries the secret. The tray's Open in browser command opens the board with a one-time ticket in the launch fragment ([daemon-api.md](daemon-api.md)).
- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Its preload script (`desktop/preload.cts`) exposes only the updater, as `window.crewDesktop`, and the main process answers it only from the main window's board page. Navigation outside the board and webviews are denied. The only granted permission is clipboard write access for the board's origin, used by its copy buttons.
- Links in reports open in the default browser. Evidence images are the daemon's to serve, so they open in a separate sandboxed app window that cannot navigate, by an address that carries the file's seal. All other new-window requests are denied.

## Window

- No system title bar. `titleBarStyle: 'hidden'` with `titleBarOverlay` draws the Windows minimize, maximize, and close buttons over the board's 60px top bar using the board's canvas and label colors, following the system light or dark theme.
- On Windows 11 22H2 (build 22621) and later, the window uses the Mica backdrop: the frame (sidebar and top bar) is transparent, as is the area behind the window buttons, while the stage, cards, panels, and dialogs keep their own surfaces. Mica was chosen over Acrylic after comparing both; it tints with the desktop instead of showing the windows behind. Windows shows a solid color while the window is inactive. Older systems keep the board's canvas color. The taskbar and window icons are the app mark with the sidebar's rounded corners.
- The main process injects a small stylesheet so the top bar and sidebar brand drag the window while their controls remain clickable. The top bar keeps its right padding clear of the window buttons via `env(titlebar-area-*)`, and the detail panel and dialogs start below the window buttons even at narrow widths. The board itself scrolls its pages in an inset stage wrapped by the sidebar and top bar, both in the browser and in the app, so the injected stylesheet adds nothing to the layout beyond the drag regions and window-button clearance. The search palette opens below the window buttons when it would reach them (through the Window Controls Overlay API, in `Palette.tsx`).
- Closing the window hides it to the tray. Quitting leaves the daemon and its jobs running; reopening attaches to the same daemon. A second launch shows the first window.
- Window bounds and maximized state are restored on launch. On scaled displays, Electron rounds bounds on the way in and out, so an unmoved window saves the exact bounds it was restored from rather than growing a few pixels on every launch.
- The tray icon is the macOS menu bar mark (`assets/crew_menubar.svg`) as a flat glyph: white on a dark taskbar, black on a light one. It follows the Windows mode, which sets the taskbar's theme, not the app mode the window follows, and changes when that mode does.
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

`npm run desktop`, `build:desktop`, `package:desktop`, and `test:desktop` go through `scripts/desktop.mjs`, which picks the native app on macOS and Electron elsewhere. `scripts/build-electron.mjs` outputs to `desktop/build` and scales icons from `assets/crew-iOS-Default-1024@2x.png` using Playwright's Chromium (`npx playwright install chromium`). On Windows it also copies `node.exe` and its `LICENSE` into `runtime/` for the bundled Claude Code plugin (the Node.js MSI ships no `LICENSE`, so set `CREW_NODE_LICENSE` or build with the zip distribution). `scripts/package-electron.mjs` writes the per-user NSIS installer `release/Crew-Setup-<version>.exe` and unpacked `release/win-unpacked/Crew.exe`, installing to `%LOCALAPPDATA%\Programs\Crew` with a Start menu shortcut and uninstaller. `desktop/installer.nsh` launches `Crew.exe` directly after install rather than via the Start menu `.lnk` (which Explorer may not have indexed yet).

This produces a local, unsigned installer without launch-at-login support; Windows SmartScreen warns on first run. Packaging never publishes a release. Worker CLIs and git remain required.

## Updates

An installed copy updates itself from GitHub Releases (`desktop/updater.ts`). A copy run from `release/win-unpacked` or `desktop/build` has no `Uninstall Crew.exe` beside it and reports in Settings that it cannot update itself.

- **Check.** One minute after launch, then every six hours, the app reads `https://api.github.com/repos/ghostface2232/crew/releases/latest` (skipping drafts and prereleases). A release qualifies when its tag is a newer dotted version and it has `Crew-Setup-<version>.exe` with GitHub's `sha256:` digest.
- **Download while away.** A found release downloads only after the user has been away from Crew for two minutes (window unfocused or system idle); **Check for Updates** in Settings downloads at once. The installer streams to a `.partial` file under `%APPDATA%\Crew\updates`, is verified against the digest, and is renamed and recorded in `staged.json`. (The digest proves integrity over the same TLS connection as the release link, not publisher identity.) Failed downloads wait for the next check.
- **Ready across launches.** On launch, a staged installer newer than the app that still matches its digest is offered again without re-downloading; stale or invalid files are removed.
- **Install on request.** When ready, an **Update** button appears above Settings in the sidebar, and **Restart to Update** appears in Settings → About Crew. The Windows tray says `Restart to update to <version>`, and the macOS menu bar says `Restart to Update to <version>`. Nothing installs until the user triggers it.
- **Daemon shutdown and hand-over.** Because the daemon started by this app runs as `Crew.exe` inside the install folder, it must exit before the installer runs. The app checks `daemon.json` and the daemon PID, and asks it to stop only while idle (`/api/shutdown` with `ifIdle: true`); it is never force-killed. While jobs run, the install waits (cancellable in Settings or the tray until shutdown is requested). If daemon health stays unanswered for two minutes, or the PID does not exit within two minutes of accepting shutdown, the install aborts with the update still staged. Daemons started from other installs are left alone.
- **Silent install and recovery.** Once the daemon stops, the app closes its windows; if the unsaved-settings prompt keeps Crew open, the app restarts its daemon and keeps the update ready. Otherwise it spawns a detached PowerShell supervisor via `cmd /c start` outside the install folder (a directly detached PowerShell has no console and exits, while an attached one dies with the app), then exits via `app.exit(0)` because Electron ignores another `app.quit()` after hand-over. The supervisor runs `Crew-Setup-<version>.exe /S --force-run`. If the supervisor fails to start, the app relaunches with the update still staged. If the installer fails, the supervisor reopens `Crew.exe` or launches the installer interactively. Steps are logged to `%APPDATA%\Crew\update.log`. Jobs, missions, and settings live in `~/.crew` and `%APPDATA%\Crew`, untouched by the installer.
- Before each installer launch, including an interactive retry, the supervisor checks the file against the SHA-256 digest Crew retained when it staged or restored the download. It holds the file open against writes and replacement through launch. A failed check stops the install, shows an update error, and reopens Crew if available.

`CREW_UPDATE_FEED` enables updates even for an unpackaged or uninstalled build and overrides the releases endpoint. This lets `scripts/smoke-electron.mjs` exercise the updater with a local server. Plain HTTP is accepted only on loopback.

**Claude Code sessions through an update.** Claude Code runs a local marketplace plugin in place. If registered directly from `%LOCALAPPDATA%\Programs\Crew`, open sessions' MCP servers, hooks, `crew` command, and spawned daemons would run `runtime\node.exe` inside a folder replaced by the installer. In electron-builder's NSIS templates, `installSection.nsh` launches the app after a silent install with `--force-run`. `include/allowOnlyOneInstallerInstance.nsh` stops processes under `$INSTDIR` and falls back to `taskkill /IM Crew.exe` for the current user when PowerShell is unavailable. In three Windows 11 silent installs the check left `node.exe` running, although the same query found those processes in both 32-bit and 64-bit PowerShell. The cause is unknown.

To avoid breaking active sessions, the Windows app copies its plugin and `runtime\node.exe` to `~/.crew/plugins/<version>-<build>` (`plugin/bridge/setup.ts`) and registers that copy instead. Open sessions keep their files and MCP server through an update. A daemon started by an MCP call during hand-over runs from the copy, so it neither blocks the installer nor gets stopped by it. The updated app's daemon registers its own copy for new sessions and updates the `crew` command. An older daemon from another folder is replaced once idle whenever the installed version is newer, even with an identical build, because a release may change only the version and the older daemon would otherwise prevent the new install from registering (`shouldReplace` in `plugin/bridge/client.ts`). Each daemon start and registration prunes unused copies, leaving any copy whose `node.exe` Windows still locks in use. Startup also checks `registrationMoved()` (`plugin/bridge/daemon.ts`) and re-registers if another Claude Code process rewrote the marketplace path back to the install folder. (The first update into this layout still leaves sessions from the prior install on the install folder.)

## Verification

```bash
npm test
npm run typecheck
npm run test:desktop
```

The smoke test (`scripts/smoke-electron.mjs`) runs the app against an isolated daemon in a temporary home directory on a free port, without starting any workers. It verifies:

- sign-in by the main process with no cookie and no secret in the address, across a reload, and renderer isolation
- hiding to the tray on close, single-instance focus, and daemon survival across quit and reopen
- cancelling quit to preserve unsaved settings
- blocked external navigation, browser-opened report links, and separate evidence windows
- unobstructed UI controls at full and narrow widths (including with Settings open)
- clipboard write permission, tray waiting counts, and drift-free window bounds restoration
- the updater against a local feed: Check for Updates downloads and verifies the release, the update button appears above Settings and again after a relaunch, and an evidence window cannot reach the updater

Set `CREW_APP_PATH` to `release/win-unpacked/Crew.exe` to test the packaged app.

On Windows, the daemon inherits the app's stdio handles, so Playwright's `close()` would hang waiting for the daemon; instead, the smoke test quits the app and waits for its own process to exit.

Verified on Windows 11 x64 at 150% display scaling, both unpackaged and packaged. The packaged app uses about 360 MB on disk, and the smoke runs measured 520 to 710 MiB across all Electron process working sets under Playwright, after the checks above (note that working sets count shared pages more than once).
