# Native macOS app

Implemented 2026-11-13. The macOS desktop UI is SwiftUI and AppKit, with Swift 6 language mode and a macOS 26 minimum deployment target (`native/Package.swift`). The TypeScript daemon, agent adapters, CLI, worktrees, configuration, and React web board remain the execution and browser layers.

## Architecture

```text
SwiftUI + AppKit app ── HTTP / SSE ── independent TypeScript daemon
                                         ├── agent CLIs / worktrees
Claude plugin / crew CLI ─────────────────┘
React web board ──────────────────────────┘
```

The app bundles a standalone Node runtime (`Contents/Resources/runtime/node`) and compiled bridge JavaScript (`Contents/Resources/bridge`). Startup invokes `crew daemon start`, retaining active-job protection and version negotiation (`DaemonLauncher` in `Transport.swift`). No worker authentication is copied or read by the native app. Closing the window hides it; quitting the UI leaves the daemon and jobs running, and reopening attaches to the same daemon. A process lock (`InstanceLock`) scoped to `CREW_HOME` prevents duplicate native instances, and a distributed notification reopens the first window.

## Interface

- The window toolbar combines workspace navigation (`Overview`, `Needs You`, `Activity`, `History`), search, and primary actions (`New Job`, options menu). Project selection lives in the `NavigationSplitView` sidebar (`ProjectSidebar`: `All projects` and known repositories). A floating detail panel opens beside the page, which keeps scrolling and working; clicking empty page space or clicking the open row again closes it.
- The workspace uses a solid neutral canvas (`WorkspaceStyle.canvas`), rounded 38-point headlines and 40-point summary values, agent cards, and mission stage tracks. Progress and active accents use the system accent color (`Palette.accent`), with no background gradient. System appearance remains automatic. Opening an inspector preserves list and search context; narrow layouts fall back to a compact agent list that keeps status labels.
- Needs You includes every project. A Claude session's tile shows its prompt's questions and choices or what an approval would act on, offers Open in Claude (opening the session's `claude://` link via `NSWorkspace`) for desktop sessions, and opens the session's details when clicked elsewhere, matching the web board ([board.md](board.md#needs-you-and-live-answers)). A Codex lead session (`host: "codex"`) is shown as Codex's there and everywhere a lead session appears, as on the board: its mark and name, and `codex resume <id>`. Each lead's agent card says Lead only while one of its sessions is open in scope, Claude's as Codex's. Needs You and the session details show Open in Codex for a Codex desktop thread when macOS finds a handler for the link, as the board decides it; otherwise they show "Answer in Codex." while the session is waiting. A Claude worker job resumes with `claude --resume <session>`. Approval and question responses share request-specific action locks (`answer:<job>:<requestId>`) with the inspector and notification actions.
- After a first install, a welcome sheet (`WelcomeView`) appears once the daemon first responds, showing the same four pages as the web board with illustrations built from the app's own views. The app flags it as pending only when the Crew home did not exist at launch (checked before the instance lock and the daemon create it), so updates never show it. It stores that flag as `welcomePending` in user defaults, and closing the sheet in any way clears it. **Help > Welcome to Crew** reopens it.
- Missions retain stage progress, lead disclosures, job membership, outcomes, token totals, presets, linked pull requests, and dismissal without cancelling jobs. History keeps completed work reachable.
- Job details include token and context window use, a running Codex turn's changes so far, reports, changed and out-of-scope files, verification receipts, evidence thumbnails with multi-pane comparison, per-round undo/keep, automatic-review refusals, notes, original prompts, follow-ups, cancellation, resume commands, and diff commands.
- New Job (`DispatchView`) supports `Command` (role assignments, worker picker when multiple workers hold a role, isolated worktrees for implementation/polish, read-only review of uncommitted changes, and snapshot runs for `verify`), `Question` (read-only), and `Information` (appends to shared/project instructions or an active mission note), plus a native folder picker (`NSOpenPanel`). Full missions still begin with `/crew:run` in Claude.
- Settings (`CrewSettingsView`) uses a sidebar with **About Crew**, **Roles** (`Build`, `Review`, `Edit`), **Shared** (`Presets`, `Model Scores`, `Instructions`, `Language`), and **Projects** (per-project instructions), with grouped forms, failed-load protection, save-generation checks, and unsaved-change confirmation on close and quit. Roles and the preset are stored as they are changed, with no save step, as [the board does](board.md#settings), down to bringing back a re-enabled agent's settings and resolving roles against the table as Settings opened; a change that cannot be stored is undone and says why under its role or preset. Only the instructions have a save, on the line under their editor. A model or effort typed by hand is a draft until Return or leaving its field puts it in the table to be stored, as the board's is, so a store already under way never sends half a name; until then it counts as an unsaved change that closing the window asks about. New Job also confirms before discarding a dirty draft with Cancel or Escape. The role pages store the whole role table at each change, so a table stored elsewhere (the board, `config.json`) replaces the window's copy unless a change made in it is unsaved or being stored (`SettingsModel.adopt`), as the board's form does ([board.md](board.md)).
- Native text editors preserve marked text and use Return for a newline; sending requires an explicit button, so IME confirmation cannot submit.
- Navigation, controls, and statuses use SF Symbols. Service marks and the menu bar icon come from SVGs in `assets/`, compiled into `Services.xcassets` as template vector assets for light and dark appearances. Cursor's SVG is packaged, though no Cursor adapter exists.
- Sizes, spacing, colors, type, motion, and controls come from the design tokens in [design-tokens.md](design-tokens.md).
- Liquid Glass is provided by system navigation/toolbars and glass buttons, with a custom glass attention banner. Reports and logs use readable content surfaces. System materials and controls inherit accessibility appearance settings. Views use `Motion.reduced` for shared transitions. `WorkflowStrip` in `JobDetailView.swift` applies its pulse directly and checks `reduceMotion` before animating.

Keyboard shortcuts: Command-N creates a job, Command-comma opens Settings, Command-1 through Command-4 select workspace sections, Command-S saves the active settings pane, Command-F focuses toolbar search, Control-Command-S toggles the sidebar, and Escape closes job details.

## Transport and state

`URLSessionDataDelegate` (`StreamConnection` in `Transport.swift`) feeds received data chunks directly into an incremental `SSEParser` on a serial delegate queue, handling split UTF-8, CRLF, multiple data lines, and comments without byte-by-byte async iteration. The stream uses `.bufferingOldest(512)` and reconnects for a fresh snapshot on overflow instead of dropping events. Reconnection replaces event history, including sequence numbers reset by a restarted daemon.

`CrewAPI` is `Sendable`, `CrewStore` is `@MainActor @Observable`, and `StreamConnection` guards cancellation and teardown with `NSLock`. HTTP job responses cannot replace a newer SSE update or a job version updated since the request started (`applyJob` in `CrewStore.swift`). Idle windows stop updating elapsed-time clocks (`windowVisible`), detail loads cancel when the selected job changes, and `SettingsModel` scopes loads and saves by generation while preserving edits typed during a save.

Native notifications revalidate the current request ID before acting (`handleNotification` in `CrewApp.swift`). A heartbeat suppresses duplicate daemon input notifications only when OS notification authorization is available. Completion notifications negotiate a short server-timestamped ownership lease (`CompletionTracker.swift`). Ordered SSE `desktopLease` events and historical ownership intervals prevent duplicate daemon/native notifications and handle delayed completions; legacy daemons retain notification ownership. Durations below a minute display `<1m`.

## Build and run

Requirements: macOS 26+, Xcode 27+ (Xcode 26 `actool` cannot compile the Xcode 27 Icon Composer document `assets/crew.icon`; see `.github/workflows/release.yml`), Swift 6, and a standalone Node.js 22.18+ distribution for packaging. The app builds for the host architecture. Development and verification have used Xcode 27.2 on macOS 27.2.1; runtime behavior on macOS 26 needs a separate machine or VM.

```bash
npm ci
npm run desktop
npm run package:desktop
```

`scripts/build-desktop.mjs` builds `native/build/Crew.app`; `scripts/package-desktop.mjs` copies it to `release/Crew.app` and produces `release/Crew-macOS-<arch>-<version>.dmg` (for users to install from) and `.zip` (for the updater), where `<arch>` is `arm64` or `x64`. Open `native/Package.swift` in Xcode to edit Swift sources; use `npm run package:desktop` to run with the bundled daemon and assets.

The build copies the current Node executable and its `LICENSE`, using `otool -L` to reject Node binaries linked against non-system libraries. `CREW_NODE_LICENSE` overrides the license path when the Node layout differs, and `CREW_BUILD_CONFIGURATION=debug` selects a debug build.

Local builds are ad-hoc signed and verified. Releases are signed with a self-signed certificate from `MACOS_SIGNING_P12` and `MACOS_SIGNING_P12_PASSWORD` to keep the app's designated requirement stable and preserve granted folder access across versions (`.github/workflows/release.yml` loads it into a temporary keychain as `CREW_SIGN_IDENTITY` and `CREW_SIGN_KEYCHAIN`). The 0.4.0 → 0.5.0 update kept folder access without asking again. Apple Developer ID signing, notarization, and login launch are not configured; this is a direct release, not an App Store build.

## Updates

The app updates itself from GitHub Releases (`native/Sources/Crew/Updater.swift`), matching the Windows updater ([windows-app.md](windows-app.md#updates)). It checks a minute after launch and then every six hours (`CrewApp.swift`). A release qualifies when its asset `Crew-macOS-<arch>-<version>.zip` includes GitHub's `sha256:` digest. Background downloads start only after the user has been away from Crew for two minutes (app inactive or Mac idle); **Check for Updates** downloads at once. Verified archives are stored in `~/Library/Application Support/Crew/Updates` (or `$CREW_HOME/desktop/updates` when `CREW_HOME` is set) and persist across relaunches.

Settings → About Crew is laid out like Software Update: the update's state and the installed version beside the app's icon, with **Check for Updates** on that row and the download's progress under the state. When an update is on offer or ready, **Download Now** or **Update Now** sits under the list, on one line with the note. When an update is ready, an **Update Now** button also appears above Settings in the sidebar and installs at once, and `Update to <version>` in the menu bar menu. Nothing installs until the user triggers it. Why an install did not happen stays under the list until an install starts again, apart from a failed check's or download's reason, which the next successful check clears; a check that fails leaves a release already on offer available to download.

- Because the daemon runs the bundled Node and bridge inside the bundle being replaced, it must stop first. The app checks `daemon.json` and the daemon PID, and sends `/api/shutdown` with `ifIdle: true` (never force-killing). Health can time out on a busy daemon, so `daemon.json` and the PID determine whether it is still running. The app aborts after 2 minutes if health stays unanswered, waits up to 30 seconds for the PID to exit after accepting shutdown, and waits while jobs run (cancellable in Settings until shutdown is requested). Unsaved settings are settled before stopping the daemon, and cancelling quit after hand-over stops the swap helper and restores the update. The store's reconnect loop pauses during hand-over so it does not respawn the daemon.
- The unpacked app must match the bundle identifier (`dev.crew.native`) and release version and pass strict, deep signature verification. An app signed with a certificate, as every release is, also requires the update to satisfy its own designated requirement, that is, to be signed with the same certificate (`codesign -R`). An ad hoc or unsigned build has no such requirement to pass on, so its updates get the integrity check alone.
- A detached helper waits up to 60 seconds for Crew to quit, then repeats the same signature check on the staged bundle beside the installed app. It makes a backup folder of its own beside the app (`Crew.app.previous.<random>`), so it never deletes anything it did not create and a folder left by an interrupted run cannot stop the next update. It keeps the original app there until the new app opens and restores it if the move or launch fails; if even the restore fails, the report names where the previous app is.
- The requirement names the release certificate, so a release signed with a different certificate (a move to an Apple Developer ID, for example) is refused by every installed copy. Changing the certificate needs a bridging release first, signed with the old one, whose updater accepts the new requirement; otherwise users must install the new version by hand. The updater reads only the latest release, so a copy that was not updated while the bridging release was the latest must also be updated by hand.
- The folder holding Crew must be writable (otherwise About Crew tells the user to move it, e.g. to Applications). Jobs, missions, and settings live in `~/.crew`, outside the bundle.

Without an Apple Developer ID, the first launch of a downloaded copy needs System Settings → Privacy & Security → Open Anyway ([distribution.md](distribution.md)). An update replaces the bundle in place; whether Gatekeeper prompts again after an in-place update has not been verified.

## Verification

```bash
npm test
npm run typecheck
npm run test:native
npm run test:e2e
npm run test:desktop
```

The native Swift suite (`native/Tests/CrewTests/`) covers SSE framing, split Unicode, large snapshots, bounded history, reconnect replacement, repeated waiting identities, request locking, retry, same-sequence HTTP races, inspector context, cross-project attention, settings load/save races, missions, role inheritance/dispatch, authentication, and the updater. `scripts/test-native.mjs` (`npm run test:native`) starts an ephemeral loopback SSE fixture (`CREW_STREAM_TEST_PORT`) to verify the real `URLSession` delegate path; direct `swift test` skips that case when `CREW_STREAM_TEST_PORT` is unset.

`scripts/smoke-desktop.mjs` (`npm run test:desktop`) uses an isolated temporary `CREW_HOME` and free port with notifications disabled (`CREW_TEST_MODE=1`) and checks bundled Node startup on a minimal `PATH`, token auth, completion notification leases, single-instance exit, daemon survival across UI termination/reopen, web board availability, and code signatures without starting worker jobs.

Manual UI checks use `test/e2e/server.ts` with `CREW_ATTACH_ONLY=1`, `CREW_TEST_MODE=1`, and a separate `CREW_HOME`. These switches neither widen permissions nor change agent behavior. OS Notification Center presentation requires a manual acceptance check with notifications authorized. Smoke-script RSS figures cover the native process only and are not directly comparable to Electron working-set totals.

### Review record (2026-11-13)

Nine reviewers (concurrency, accessibility, build/tests, design/layout, motion, usability, performance, logic, and final integration) reviewed the initial native implementation and verified fixes across settings readiness, mutation timeouts, foreground notifications, stale responses, stream decoding, unnecessary polling, inspector context, search, layout shifts, compact status labels, and dark-mode contrast. At that milestone, 79 TypeScript tests, 24 native tests, 14 browser tests, typecheck, release packaging, signature verification, and manual UI checks passed; the test suite has grown since. Runtime verification on macOS 26 and Notification Center button interaction remain manual checks.

## References

- [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
- [Scroll views](https://developer.apple.com/design/human-interface-guidelines/scroll-views)
- [Adopting Liquid Glass](https://developer.apple.com/documentation/TechnologyOverviews/adopting-liquid-glass)
- [Applying Liquid Glass to custom views](https://developer.apple.com/documentation/SwiftUI/Applying-Liquid-Glass-to-custom-views)
- [SwiftUI and AppKit integration](https://developer.apple.com/documentation/swiftui/appkit-integration)
