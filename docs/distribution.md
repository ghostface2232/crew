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

`crew install` registers the marketplace, installs `crew@crew`, and writes a `crew` shim in `~/.local/bin`. From a source checkout with Codex installed, it also runs `codex plugin marketplace add <checkout>` and `codex plugin add crew@crew` (`registerCodex` in `setup.ts`), so a Codex session can lead. Codex copies the plugin into its own cache, so run `crew install` again after changing it. Hook review is part of the [first-run checklist](#first-run-checklist). A built app registers with Codex too, through a marketplace of its own (**Codex** below). Packaged apps automate this via `plugin/bridge/setup.ts`:

1. **Each app carries a built plugin.** Registering the GitHub repository would miss the built board (`plugin/board/dist` is not committed) and let plugin and app code drift. On macOS, the packaged daemon registers the copy inside `Crew.app` (`/Applications/Crew.app/Contents/Resources/bridge`). On Windows, `setup.ts` copies the plugin and `runtime/node.exe` to `~/.crew/plugins/<version>-<build>` and registers that copy so installer updates do not replace files beneath running Claude Code sessions.
2. **The plugin runs on the app's runtime.** macOS bundles standalone Node (`Contents/Resources/runtime/node`, `scripts/build-desktop.mjs`); Windows bundles `runtime/node.exe` (`scripts/build-electron.mjs`) because a hook command cannot set `ELECTRON_RUN_AS_NODE`. `linkCommand` in `setup.ts` points `~/.local/bin/crew` (and `.cmd`/`.mjs` shims on Windows) at that runtime.

With `CREW_HOME` unset, a packaged daemon checks `~/.crew/setup.json` (`registered()`). Whenever its `root`, `version`, or `build` differs, or it is not `complete`, it runs `claude plugin marketplace add <root>`, runs `claude plugin install crew@crew` or `claude plugin update crew@crew` if needed, and rewrites the `crew` shim (leaving a source-checkout `crew` marketplace alone). A copy older than the one on record skips all of this at startup while the newer copy's folder still exists: after an update, an already-open session can start a daemon from the previous copy, which must not register itself over the new one or prune it. Asked for by the user, through the setup checklist's repair or `crew install`, the older copy is registered: that is a downgrade on purpose. On Windows, startup also prunes unused copies and checks `registrationMoved()` to re-register if Claude Code rewrote the marketplace path. With an explicit `CREW_HOME`, startup skips registration, pruning, and that check. Use `crew install` or the setup checklist’s repair action to register explicitly. The marketplace and the command in `~/.local/bin` belong to the user across all Crew homes.

**Codex.** Where `codex` is installed, the same registration also installs `crew@crew` in Codex, so a Codex session can lead (`registerCodex()` in `setup.ts`). A source checkout registers its own folder. A built copy cannot: Codex copies only the plugin folder into its cache and drops symbolic links, and it does not substitute `${PLUGIN_ROOT}` in MCP arguments, so the app's runtime beside the plugin folder is out of reach ([mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)). So the registration writes a marketplace of its own under `~/.crew/codex/marketplace` (`codex-plugin.ts`) and registers that instead:
- **MCP server.** It starts as the app's runtime on the compiled `mcp.js`, both named by absolute path. It has no `cwd`, so it runs in the session's folder.
- **Hooks.** Each hook runs `~/.crew/codex/bin/hook <script> <args>`. The launcher is rewritten at each registration to run the current build's script on its runtime, in the same process, so the script's output and exit status reach Codex unchanged.
- **Why the launcher.** Codex records trust against each hook's definition, so the commands stay the same from one update to the next, and a change to the compiled bridge alone keeps the hooks trusted. Codex also records a hash of its copy of the plugin folder (skills, agents, manifest, MCP and hooks files), so an update that changes any of those marks every Crew hook modified, and the user trusts them again in `/hooks`. A registration that copies the same files keeps the trust (Codex 0.172 `hooks/list`, macOS, 2026-11-24).
- **Existing registrations.** The folder is user-wide, like the `crew` command, whatever the Crew home. A marker file identifies a folder Crew wrote. A built copy replaces or removes only folders with that marker, and only `crew` marketplaces in Codex whose folder has it. Codex refuses to add a second folder under a name, so such a marketplace is removed first. A source checkout's `crew install` replaces any registration.
- **The setup record.** `setup.json` is written once the `crew` command's host runs this copy, so an older copy finds the newer one registered, and marked `complete` only once every installed host runs it. Older copies are pruned on Windows only when it is complete. An incomplete record counts as unregistered, so a failed Codex install is tried again at the next start, and an older copy a host still points to is kept. Without Claude Code, a Codex registration alone counts, and the `crew` command follows it.

## First-run checklist

Both apps show a **Set up Crew** card at the top of the unfiltered Overview page (`SetupView.swift`, `Overview.tsx`), backed by `GET /api/setup` and `POST /api/setup/repair` (matching `crew doctor`). It hides automatically once every item passes. Both apps poll every minute while open and each check starts five CLIs, so the daemon keeps the answer (`SetupCache` in `setup.ts`): for one minute while an item is missing or a check fails, and for ten minutes once every item passes; it always runs a new check on **Check Again**, after a repair, or after a registration. If the setup breaks while the card is hidden, the card therefore reappears within about ten minutes.

Each item confirms what is ready or says what to do next in the app's language. Hover over the message for details such as the installed version, command path, or error. `crew doctor` also prints these details.

| Item | What the app does |
| --- | --- |
| Crew plugin and `crew` command | Registers and writes shims automatically; exposes an **Install** repair button when missing |
| Claude Code (`claude` on `PATH`) | Checks `claude --version`; if missing, tells the user to install from `claude.com/code` |
| Codex CLI and sign-in | Checks `codex --version` and `codex login status`; installing and signing in are left to the user |
| Crew plugin in Codex | With Codex installed, checks `codex plugin list --marketplace crew` (the whole list also reads remote marketplaces, which can take a minute) for `crew@crew` installed and enabled at this copy's version; **Install** registers it |
| Crew hooks in Codex | Checked as soon as the Codex plugin item passes, so users can enable hooks before running their first Crew job. It asks a short-lived `codex app-server` for `hooks/list` (`codexHooksItem` in `setup.ts`). It passes when every Crew hook is trusted and enabled. The instruction matches the hook state and asks the user to trust, re-trust, or enable hooks. If the request fails or exceeds 10 seconds, the item points to a fresh check or manual review. |
| Antigravity CLI | Checks `agy --version` when `antigravity.enabled` is true; installing and running `agy` to sign in are left to the user |
| Job ledger | Shown only while a `jobs.json.unreadable-*` file is in the Crew home ([architecture.md](architecture.md#bridge-and-state)). The item points to `crew doctor` for the backup path and recovery instructions. |

Signing in to user accounts is never automated.

In the Codex app, open **Settings → Hooks → Crew**, review the commands, and choose **Trust all** in the Crew panel. In the Codex CLI, open `/hooks` to review and trust the Crew hooks. Turn on any Crew hooks that are off, then start a new chat or CLI session. **Check Again** refreshes the checklist. Codex requires the user to review plugin hooks before running them. [Codex hooks guide](https://learn.chatgpt.com/docs/hooks)

The checklist reads `trustStatus` using each key in this copy's hook file. Codex 0.172 uses the same key format on macOS and Windows as of 2026-11-25, `crew@crew:hooks/codex.json:<event>:<group>:<index>`. Codex skips modified hooks even when their previous trust records are still in its config. The checklist uses Codex's live report to detect changes.

## Release housekeeping

- Set `package.json`, `plugin/.claude-plugin/plugin.json`, and `plugin/.codex-plugin/plugin.json` to the release version (daemons compare versions to decide which replaces which), commit to `main`, and push a stable semver tag: `git tag v<version> && git push origin v<version>`.
- `.github/workflows/release.yml` publishes only when all checks pass: tag matching both version files; `.github/workflows/ci.yml` (`npm run typecheck` on `windows-latest` and `npm test` on both `macos-latest` and `windows-latest`); `npm run test:native` on the self-hosted ARM64 Mac runner (Xcode 27); and `node scripts/desktop.mjs smoke` on the packaged Windows app (`release/win-unpacked/Crew.exe`). Run `Release` via `workflow_dispatch` on any branch to rehearse without publishing.
- `.github/release-notes.md` documents download links, install paths, and Gatekeeper/SmartScreen steps above GitHub's generated changelog.
- README documents both the packaged app install and source checkout development.

## Order of work

1. **Bundle plugin and runtime.** *Shipped:* `scripts/bundle-plugin.mjs` lays out the marketplace in each app and rewrites `node …/bridge/*.ts` commands to compiled `.js` on the bundled Node (`Contents/Resources/runtime/node` on macOS; `runtime/node.exe` on Windows, registered via per-build copies in `~/.crew/plugins` in `plugin/bridge/setup.ts`). It also writes `plugin/package.json` with `"type": "module"`: the compiled bridge is ES modules in `.js` files, and Node would otherwise go by the nearest `package.json` above wherever the plugin was copied, so one in the user's home folder saying `commonjs` would stop every command.
2. **First-launch registration and checklist.** *Shipped:* `plugin/bridge/setup.ts`, `~/.crew/setup.json`, `GET /api/setup`, `POST /api/setup/repair`, `crew doctor`, and the Overview checklist card in both apps.
3. **Installers and auto-update.** *Shipped:* `electron-builder` NSIS installer + `desktop/updater.ts` on Windows; `.dmg`/`.zip` packaging + `native/Sources/Crew/Updater.swift` on macOS.
4. **GitHub Actions release workflow.** *Shipped:* `.github/workflows/release.yml` calls `.github/workflows/ci.yml`, builds macOS (self-hosted ARM64 Mac with Xcode 27 for `assets/crew.icon`) and Windows (hosted runner with smoke test), and publishes with `.github/release-notes.md`. Pull requests also run `.github/workflows/ci.yml`, except a pull request that changes only docs (`docs/`, `research/`, `README.md`, `AGENTS.md`) or a push that adds only docs on top of a head whose CI passed; pushes to `main` are not re-checked.
5. **Signing.** *Remaining:* Windows code signing certificate and Apple Developer Program membership (Developer ID + notarization) when public distribution calls for them.

## History

- 2026-11-25. The hook check moved from after the first Codex-led Crew job to the first-run checklist. The `SessionEnd` and `Interrupt` hooks now use Codex's three-second maximum to avoid loading warnings. [Codex hooks guide](https://learn.chatgpt.com/docs/hooks)
