# Distribution plan

Recorded 2026-11-16. Steps 1 to 4 of the order of work have shipped; recognized-publisher signing (step 5) has not. This records the direction and current state for releasing Crew to users.

## Goal

A user downloads one app from GitHub Releases, runs it, and Crew is ready: the Claude Code plugin is installed, the `crew` command works, and the app shows what is still missing. Nobody needs to clone the repository, install Node, or run `crew install`.

## Channel

GitHub Releases is the single channel. Pushing a `v<version>` tag triggers `.github/workflows/release.yml`, which builds the Windows and macOS apps and attaches them to the release.

| Platform | Artifact | Signing | Updates |
| --- | --- | --- | --- |
| Windows | `Crew-Setup-<version>.exe`, a per-user NSIS installer built by `electron-builder` (no admin rights, Start menu shortcut, uninstaller) | Unsigned. SmartScreen warns on first run; `.github/release-notes.md` explains "More info → Run anyway". A code signing certificate (for example Azure Trusted Signing) is planned | Self-updates from GitHub Releases: downloads while away, verifies SHA-256, and installs on **Update Now** ([windows-app.md](windows-app.md#updates)) |
| macOS | `Crew-macOS-arm64-<version>.dmg` (to install from) and `Crew-macOS-arm64-<version>.zip` (for the updater) | Signed with a self-signed certificate (`MACOS_SIGNING_P12`) to preserve granted folder access across updates. The 0.4.0 → 0.5.0 update kept folder access without asking again. Releases lack an Apple Developer ID and notarization. Gatekeeper blocks first launch; release notes explain System Settings → Privacy & Security → Open Anyway. Building from source (`npm run package:desktop`, Xcode 27+) avoids the block | Self-updates from GitHub Releases: downloads `.zip` while away, verifies SHA-256, and swaps the bundle on **Update Now** ([macos-app.md](macos-app.md#updates)) |

The Start menu shortcut gives the Windows app an AppUserModelID (`dev.crew.desktop`), while notifications stay with the daemon's PowerShell toasts ([windows-app.md](windows-app.md#notifications)). Joining the Apple Developer Program and acquiring a Windows signing certificate remain the steps to remove first-run OS warnings.

## The app installs the plugin

`crew install` registers the marketplace, installs `crew@crew`, and writes a `crew` shim in `~/.local/bin`. Packaged apps automate this via `plugin/bridge/setup.ts`:

1. **Each app carries a built plugin.** Registering the GitHub repository would miss the built board (`plugin/board/dist` is not committed) and let plugin and app code drift. On macOS, the packaged daemon registers the copy inside `Crew.app` (`/Applications/Crew.app/Contents/Resources/bridge`). On Windows, `setup.ts` copies the plugin and `runtime/node.exe` to `~/.crew/plugins/<version>-<build>` and registers that copy so installer updates do not replace files beneath running Claude Code sessions.
2. **The plugin runs on the app's runtime.** macOS bundles standalone Node (`Contents/Resources/runtime/node`, `scripts/build-desktop.mjs`); Windows bundles `runtime/node.exe` (`scripts/build-electron.mjs`) because a hook command cannot set `ELECTRON_RUN_AS_NODE`. `linkCommand` in `setup.ts` points `~/.local/bin/crew` (and `.cmd`/`.mjs` shims on Windows) at that runtime.

With `CREW_HOME` unset, a packaged daemon checks `~/.crew/setup.json` (`registered()`). Whenever its `root`, `version`, or `build` differs, it runs `claude plugin marketplace add <root>`, runs `claude plugin install crew@crew` or `claude plugin update crew@crew` if needed, and rewrites the `crew` shim (leaving a source-checkout `crew` marketplace alone). A copy older than the one on record skips all of this at startup while the newer copy's folder still exists: after an update, an already-open session can start a daemon from the previous copy, which must not register itself over the new one or prune it. Asked for by the user, through the setup checklist's repair or `crew install`, the older copy is registered: that is a downgrade on purpose. On Windows, startup also prunes unused copies and checks `registrationMoved()` to re-register if Claude Code rewrote the marketplace path. With an explicit `CREW_HOME`, startup skips registration, pruning, and that check. Use `crew install` or the setup checklist’s repair action to register explicitly. The marketplace and the command in `~/.local/bin` belong to the user across all Crew homes.

## First-run checklist

Both apps show a **Set up Crew** card at the top of the unfiltered Overview page (`SetupView.swift`, `Overview.tsx`), backed by `GET /api/setup` and `POST /api/setup/repair` (matching `crew doctor`). It hides automatically once every item passes. Both apps poll every minute while open and each check starts five CLIs, so the daemon keeps the answer (`SetupCache` in `setup.ts`): for one minute while an item is missing or a check fails, and for ten minutes once every item passes; it always runs a new check on **Check Again**, after a repair, or after a registration. If the setup breaks while the card is hidden, the card therefore reappears within about ten minutes.

| Item | What the app does |
| --- | --- |
| Crew plugin and `crew` command | Registers and writes shims automatically; exposes an **Install** repair button when missing |
| Claude Code (`claude` on `PATH`) | Checks `claude --version`; if missing, tells the user to install from `claude.com/code` |
| Codex CLI and sign-in | Checks `codex --version` and `codex login status`; installing and signing in are left to the user |
| Antigravity CLI | Checks `agy --version` when `antigravity.enabled` is true; installing and running `agy` to sign in are left to the user |
| Job ledger | Shown only while a `jobs.json.unreadable-*` file is in the Crew home ([architecture.md](architecture.md#bridge-and-state)): names the file the daemon set aside; repairing or deleting it is left to the user |

Signing in to user accounts is never automated.

## Release housekeeping

- Set `package.json` and `plugin/.claude-plugin/plugin.json` to the release version (daemons compare versions to decide which replaces which), commit to `main`, and push a stable semver tag: `git tag v<version> && git push origin v<version>`.
- `.github/workflows/release.yml` publishes only when all checks pass: tag matching both version files; `.github/workflows/ci.yml` (`npm run typecheck` on `windows-latest` and `npm test` on both `macos-latest` and `windows-latest`); `npm run test:native` on the self-hosted ARM64 Mac runner (Xcode 27); and `node scripts/desktop.mjs smoke` on the packaged Windows app (`release/win-unpacked/Crew.exe`). Run `Release` via `workflow_dispatch` on any branch to rehearse without publishing.
- `.github/release-notes.md` documents download links, install paths, and Gatekeeper/SmartScreen steps above GitHub's generated changelog.
- README documents both the packaged app install and source checkout development.

## Order of work

1. **Bundle plugin and runtime.** *Shipped:* `scripts/bundle-plugin.mjs` lays out the marketplace in each app and rewrites `node …/bridge/*.ts` commands to compiled `.js` on the bundled Node (`Contents/Resources/runtime/node` on macOS; `runtime/node.exe` on Windows, registered via per-build copies in `~/.crew/plugins` in `plugin/bridge/setup.ts`). It also writes `plugin/package.json` with `"type": "module"`: the compiled bridge is ES modules in `.js` files, and Node would otherwise go by the nearest `package.json` above wherever the plugin was copied, so one in the user's home folder saying `commonjs` would stop every command.
2. **First-launch registration and checklist.** *Shipped:* `plugin/bridge/setup.ts`, `~/.crew/setup.json`, `GET /api/setup`, `POST /api/setup/repair`, `crew doctor`, and the Overview checklist card in both apps.
3. **Installers and auto-update.** *Shipped:* `electron-builder` NSIS installer + `desktop/updater.ts` on Windows; `.dmg`/`.zip` packaging + `native/Sources/Crew/Updater.swift` on macOS.
4. **GitHub Actions release workflow.** *Shipped:* `.github/workflows/release.yml` calls `.github/workflows/ci.yml`, builds macOS (self-hosted ARM64 Mac with Xcode 27 for `assets/crew.icon`) and Windows (hosted runner with smoke test), and publishes with `.github/release-notes.md`. Pull requests also run `.github/workflows/ci.yml`; pushes to `main` are not re-checked.
5. **Signing.** *Remaining:* Windows code signing certificate and Apple Developer Program membership (Developer ID + notarization) when public distribution calls for them.
