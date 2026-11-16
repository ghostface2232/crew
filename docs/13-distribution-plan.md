# 13. Distribution plan

Recorded 2026-11-16. Steps 1 to 4 of the order of work are implemented; signing (step 5) is not. This records the agreed direction for releasing Crew to other users.

## Goal

A user downloads one app from GitHub Releases, runs it, and Crew is ready: the Claude Code plugin is installed, the `crew` command works, and the app shows what is still missing. Nobody needs to clone the repository, install Node, or run `crew install`.

## Channel

GitHub Releases is the single channel. Pushing a version tag runs GitHub Actions on Windows and macOS runners, which build the apps and attach them to the release. The plugin already installs from this repository, so users look in one place.

| Platform | Artifact | Signing | Updates |
| --- | --- | --- | --- |
| Windows | `Crew-Setup-x.y.z.exe`, an NSIS installer built by electron-builder: per-user, no administrator rights, Start menu shortcut, uninstaller | Unsigned at first. SmartScreen warns on first run; the release notes explain "More info → Run anyway". A code signing certificate (for example Azure Trusted Signing, if available in the publisher's country) removes the warning later | The app's own updater, from the GitHub Releases API: it downloads while the user is away and installs when they choose ([12-windows-electron.md](12-windows-electron.md#updates)) |
| macOS | The native app, ad-hoc signed: a dmg to install from, and a zip that the app's updater downloads | Without an Apple Developer Program membership the app cannot be notarized, so Gatekeeper blocks the first launch. The notes explain System Settings → Privacy & Security → Open Anyway. Building from source (`npm run package:desktop`, Xcode 26) avoids the block | Manual download until the app is signed and notarized |

The Start menu shortcut also gives the Windows app the identity its own notifications need. Today notifications stay with the daemon's PowerShell toasts for that reason ([12-windows-electron.md](12-windows-electron.md)).

Joining the Apple Developer Program is the step that makes macOS "download and run". Developer ID signing and notarization then go into the same workflow.

## The app installs the plugin

Today `crew install` does three things: `claude plugin marketplace add <folder>`, `claude plugin install crew@crew`, and a `crew` shim in `~/.local/bin`. The app takes this over, with two changes.

1. **The app carries a built plugin and registers its own copy.** Registering the GitHub repository instead would miss the built board (`plugin/board/dist` is not committed). It would also let the plugin and the app run different code. With the bundled copy, the app's daemon and the plugin's daemon are the same build, and the existing version negotiation keeps a single daemon. The folder sits at a stable install path: `%LOCALAPPDATA%\Programs\Crew` on Windows, `/Applications/Crew.app` on macOS.
2. **The plugin runs on the app's runtime, not the user's Node.** The plugin's MCP server and hooks call `node …/bridge/*.ts`, which needs Node 22.18 or later on the PATH. The bundled plugin instead points at a runtime inside the app. The macOS app already ships standalone Node. On Windows, either ship `node.exe` or add a small launcher that runs `Crew.exe` in Node mode. The `crew` shim uses the same runtime.

On first launch, and on the first launch after an update (when the bundled version changes), the app registers or updates the marketplace and the plugin. It runs `claude plugin marketplace update` and `claude plugin update crew@crew` when they are already installed, and rewrites the `crew` shim.

## First-run checklist

The app shows a setup checklist built from the same checks as `crew doctor`. Once every item passes, the app opens straight to the board.

| Item | What the app does |
| --- | --- |
| Crew plugin and `crew` command | Installs or repairs automatically, with a Repair button |
| Claude Code (`claude` on the PATH) | Detects it; if missing, links to the installer. It does not install it |
| Codex CLI and login | Shows status; installing and signing in are left to the user |
| Antigravity CLI and login | Shows status; installing and signing in are left to the user |

Signing in to the user's accounts is never automated.

The user's path is: download the installer, run the app, sign in to whatever the checklist shows as missing, open a new Claude Code session, and use `/crew:run`.

## Release housekeeping

- To release, set both version fields below, commit to `main`, then push the tag: `git tag v<version> && git push origin v<version>`.

- Keep `package.json` and `plugin/.claude-plugin/plugin.json` at the release tag's version, since daemons compare versions to decide which replaces which.
- Release notes cover changes, installation, and the SmartScreen and Gatekeeper steps.
- README: the plugin comes with the app; installing from source stays documented for development.

## Order of work

1. Bundle the built plugin and a runtime in both apps; point the bundled plugin's MCP server, hooks and `crew` shim at that runtime. Done: `scripts/bundle-plugin.mjs` lays the plugin out as a marketplace inside each app and rewrites its `node …/bridge/*.ts` commands to the compiled scripts on the app's Node (`Contents/Resources/runtime/node` on macOS; on Windows a `runtime/node.exe` beside the plugin, since a hook cannot set `ELECTRON_RUN_AS_NODE` to run `Crew.exe` as Node). Claude Code loads a local marketplace's plugin in place, so an app update replaces the plugin's files with the app's.
2. First-launch install and update of the marketplace and plugin, with the checklist screen. Done: `plugin/bridge/setup.ts`. A packaged daemon registers its marketplace, installs or updates `crew@crew`, and writes the `crew` command whenever its build differs from the one recorded in `~/.crew/setup.json`. A marketplace named `crew` that points at a source checkout is left alone. `GET /api/setup` returns the checklist (`crew doctor` prints the same checks) and `POST /api/setup/repair` registers again; the overview in both apps shows it until every item passes.
3. Windows installer and auto-update with electron-builder. Done: an NSIS installer and the app's own updater.
4. GitHub Actions release workflow for both platforms, and release notes. Done: `.github/workflows/release.yml` runs on a pushed `v<version>` tag, checks the tag against both version fields, builds the macOS (arm64) app on a self-hosted Mac runner with Xcode 27 (hosted runners have only Xcode 26, which cannot compile the app's Icon Composer icon) and the Windows app on a hosted runner, and publishes them with `.github/release-notes.md` above GitHub's generated change list.
5. Signing: a Windows certificate, and an Apple Developer Program membership for macOS, when the audience calls for them.

Review the design (step 1 especially: the runtime launcher and how Claude Code caches installed plugins) before building it.
