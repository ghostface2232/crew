# 12. Windows desktop app (Electron)

Implemented 2026-11-16. macOS keeps the [native SwiftUI app](08-native-macos.md). Windows (and any other non-macOS system) gets an Electron shell around the current React web board. Both connect to the same independent TypeScript daemon, so jobs, settings, and the browser board are shared. The [earlier Electron shell](07-desktop-and-react.md) was the starting point, updated for the daemon's token sign-in and the board's present layout.

## Architecture

```text
Electron main (desktop/main.ts) ── ensureDaemon ── independent daemon ── agent CLIs / worktrees
  window, tray, single instance          │
                                         │ HTTP + SSE, signed by the main process
  sandboxed renderer ─── React board (plugin/board) served by the daemon
```

- The main process imports the bridge's own `client.ts`, so startup reuses `ensureDaemon`, including version negotiation and active-job protection. The daemon starts using the app's Electron executable in Node mode (`ELECTRON_RUN_AS_NODE`), so no separate Node install is needed.
- The main process signs the board window's requests to the daemon: it makes a board credential from `~/.crew/token` and adds it as a header (`signBoard` in `desktop/main.ts`), so the page holds nothing and neither a cookie nor an address carries the secret. The tray's Open in browser command opens the board with a one-time ticket in the launch fragment (09 section 12).
- The renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Its preload script (`desktop/preload.cts`) exposes only the updater, as `window.crewDesktop`, and the main process answers it only from the main window's board page. Navigation outside the board and webviews are denied. The only granted permission is clipboard write access for the board's origin, used by its copy buttons.
- Links in reports open in the default browser. Evidence images are the daemon's to serve, so they open in a separate sandboxed app window that cannot navigate, by an address that carries the file's seal. All other new-window requests are denied.

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

`npm run desktop`, `build:desktop`, `package:desktop`, and `test:desktop` go through `scripts/desktop.mjs`, which picks the native app on macOS and Electron elsewhere. The Electron build outputs to `desktop/build` and renders the icons from `plugin/board/src/icons/CrewAppIcon.svg` using Playwright's Chromium (`npx playwright install chromium`). On Windows it also copies the current `node.exe` and its LICENSE into `runtime/` for the bundled Claude Code plugin; the Node.js MSI installs no LICENSE, so set `CREW_NODE_LICENSE` to one, or build with the zip distribution. Packaging writes the per-user installer `release/Crew-Setup-<version>.exe` and unpacked executable `release/win-unpacked/Crew.exe`. The installer installs to `%LOCALAPPDATA%\Programs\Crew` and creates a Start menu shortcut and uninstaller.

This produces a local, unsigned installer without launch-at-login support; Windows SmartScreen warns on its first run. Packaging never publishes a release. Worker CLIs and git must still be installed and authenticated.

## Updates

An installed copy updates itself from GitHub Releases (`desktop/updater.ts`). A copy run from `release/win-unpacked` or `desktop/build` has no `Uninstall Crew.exe` beside it and says in Settings that it cannot update itself.

- **Check.** A minute after launch, then every six hours, the app reads `https://api.github.com/repos/ghostface2232/crew/releases/latest`. That endpoint skips drafts and prereleases. A release counts when its tag is a newer dotted version and it has an asset named `Crew-Setup-<version>.exe` with GitHub's `sha256:` digest.
- **Download while away.** A release on offer downloads only once the user has been away from Crew for two minutes: the window out of focus, or the system idle. **Check for Updates** in Settings downloads at once. The installer streams to a `.partial` file under `%APPDATA%\Crew\updates`, is checked against the digest, and is then renamed and recorded in `staged.json`. The digest proves the file is intact, not who published it: it comes over the same TLS connection as the link.
- **Ready across launches.** At launch, a staged installer that is newer than the app and still matches its digest is offered again without downloading. Anything else in the folder is removed.
- **Install on request.** When an installer is ready, **Restart to Update** appears above Settings in the sidebar, in Settings → About Crew, and in the tray menu. Nothing installs until the user picks it.
- **No lost work.** The installer replaces the install folder's files and is meant to stop the processes running from it (see below), and the daemon this app started runs as that folder's `Crew.exe`, so it has to stop first. The app only ever asks it to stop while idle (`/api/shutdown` with `ifIdle`). The daemon refuses while a job runs or a change is being saved, and otherwise saves jobs and missions before it exits; it is never killed. While jobs run, the install waits for them and says so in the sidebar and Settings; it can be cancelled in Settings or from the tray until the daemon is asked to stop. Whether the daemon is still running is read from the `daemon.json` it keeps in the Crew home and its process, since a health request can time out on a busy daemon; an unanswered one is waited for, never taken as gone, and after two minutes the install is called off with the update still ready. Once the daemon has stopped, the app closes its windows. If the unsaved-settings prompt keeps the app open, the app restarts its daemon and the update stays ready. It then starts `Crew-Setup-<version>.exe /S --force-run`, which installs silently into the same per-user folder and starts the new version. A daemon started by another install is left alone. Jobs, missions and settings live in the Crew home (`~/.crew`) and `%APPDATA%\Crew`, which the installer does not touch. A small PowerShell supervisor outside the install folder waits for the installer process and, on failure, reopens Crew or starts the installer interactively if Crew.exe is gone. It is started through a detached `cmd /c start`: a detached PowerShell has no console and exits without running its script, and one that is not detached is killed with the app. Once it has started, the app exits outright rather than quitting again, which Electron ignores after the hand-over. Each step is logged to `%APPDATA%\Crew\update.log`; if it cannot start at all, the app reopens with the update still staged. A download that failed waits for the next check instead of starting again.

`CREW_UPDATE_FEED` points any build at another releases endpoint, and enables updates for it; the smoke test uses it with a local server. Plain HTTP is accepted only from a loopback address.

**Claude Code sessions through an update.** Claude Code runs a local marketplace's plugin in place, so a plugin registered from the install folder would run its MCP server, hooks, `crew` command and any daemon an MCP server starts as `runtime\node.exe` under that folder. The installer replaces that folder's files underneath them. electron-builder's template is meant to stop those processes first, but in testing on Windows 11 none of them was stopped: they kept running on files that had been replaced or removed. Either way every open session's Crew MCP server would be stopped or left running on files that are no longer there, and a daemon an MCP call started after the app's daemon stopped could be killed mid-work or block the install. The app therefore registers a copy of its plugin and runtime in the Crew home instead, `~/.crew/plugins/<version>-<build>` (`plugin/bridge/setup.ts`). The installer does not touch it, so open sessions keep their MCP server, and a daemon started from it during the hand-over neither blocks the install nor is stopped by it. The updated app's daemon registers its own copy and points the `crew` command at it; new sessions load it. An older daemon from another folder is replaced once it is idle whenever the installed version is newer, even if its build is the same, since a release may change only the version (`shouldReplace` in `plugin/bridge/client.ts`). Each daemon start, and each registration, removes copies that are no longer registered, except one whose `node.exe` Windows refuses to delete because a session still runs it; that copy is left whole. Each daemon start also checks that Claude Code still reads the plugin from the registered copy and registers again if it does not: once, right after a registration, the marketplace was found pointing back at the install folder, likely written back by a Claude Code process that started meanwhile. The first update to this layout still leaves the sessions of the version before it on the install folder, whose files the installer replaces.

The installer's behavior comes from electron-builder's NSIS templates in `node_modules/app-builder-lib/templates/nsis`. `installSection.nsh` starts the app after a silent install when `--force-run` is given. `include/allowOnlyOneInstallerInstance.nsh` stops processes whose path is under `$INSTDIR`, falling back to `taskkill /IM Crew.exe` for the current user when PowerShell is unavailable. In testing it left `node.exe` processes under the folder running through three silent installs, although its PowerShell query, run by hand from 32- and 64-bit PowerShell, finds them; the cause is not known.

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
- the updater against a local feed: Check for Updates downloads and verifies the release, Restart to Update appears above Settings and again after a relaunch, and an evidence window cannot reach the updater

Set `CREW_APP_PATH` to `release/win-unpacked/Crew.exe` to test the packaged app.

On Windows, the daemon inherits the app's stdio handles, so Playwright's `close()` would hang waiting for the daemon; instead, the smoke test quits the app and waits for its own process to exit.

Verified on Windows 11 x64 at 150% display scaling, both unpackaged and packaged. The packaged app uses about 360 MB on disk, and the smoke runs measured 520 to 710 MiB across all Electron process working sets under Playwright, after the checks above (note that working sets count shared pages more than once).
