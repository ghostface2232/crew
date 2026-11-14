# 07. React board and Electron desktop

Historical implementation: the Electron shell was replaced on 2026-11-13 by the [native macOS app](08-native-macos.md). The React web board remains supported. Commands and desktop paths below describe the previous implementation.

Implemented 2026-11-12, Crew 0.2.0. This delivers the UI foundation in roadmap L5 and the desktop shell plus role-based direct dispatch from L2. Claude remains the pipeline lead. AgentGauge, Cursor, alternate leads, automatic merges, intent classification, and per-round undo are separate work.

## Architecture

```text
Claude plugin / CLI ──┐
                     ├── independent Crew daemon ── worker adapters / worktrees
Electron main ────────┘             │
  window, tray, notifications       │ HTTP + SSE
  no renderer IPC                  ▼
                     React board in Chromium or a web browser
```

The original 1,413-line `board.js` mixed SSE state, HTML strings, DOM reconciliation, request locks, settings drafts, and event handlers. React now owns the entire board. There is no shared DOM ownership and no legacy renderer.

| File | Responsibility |
| --- | --- |
| `plugin/board/src/store.ts` | One SSE subscription, immutable snapshots, reconnect replacement, bounded event history |
| `plugin/board/src/api.ts` | HTTP requests and shared action locks keyed by job/request identity |
| `plugin/board/src/model.ts` | Project grouping, state priority, progress and duration labels |
| `plugin/board/src/ui.tsx` | Native dialog lifecycle, stable composers, status icons, clock updates |
| `Missions.tsx`, `NeedsYou.tsx`, `Overview.tsx` | Mission tracks, lead disclosures, agent activity, decisions and activity feed |
| `JobDrawer.tsx`, `Settings.tsx`, `Dispatch.tsx` | Details, follow-ups, scoped settings and direct job creation |
| `desktop/main.ts` | Single instance, tray, restored bounds, independent daemon startup and notifications |
| `plugin/bridge/assets.ts` | Built-asset allowlist, MIME types and renderer CSP |

Types are imported from the existing bridge as type-only imports. Node modules never enter the renderer. Shared CSS tokens preserve the existing surfaces, typography and state colors; new dispatch styles use a CSS Module. Lucide SVGs use `currentColor` and a fixed physical stroke width, including status marks and controls. The app icon reuses the existing Crew mark.

## Behaviors

- Mission stages, recent completed missions, unfinished jobs, lead session disclosures, limits, reports, changes, out-of-scope files, refusal notes, resume commands and job activity remain available.
- Needs-you cards sit in normal document flow above the work list. Every request remains reachable, including requests outside the current project filter. Project selection uses a native select instead of a separately implemented mobile modal.
- Approval buttons and text answers share one lock across the board and drawer. An accepted request stays locked while SSE catches up. A failed request keeps its draft and can retry. A new question gets a new draft.
- Korean IME composition does not send on Enter. Stable React keys preserve inputs and disclosures across SSE updates. Detail requests are aborted when a drawer closes or changes jobs.
- Settings track the loaded scope and generation. Late responses cannot fill another editor. Saving normalizes only the submitted draft and preserves edits made during the request. Failed loads disable saving and expose a retry.
- Direct dispatch uses the existing role table, rather than silently overriding agent assignments. Implementation and wording jobs use isolated worktrees. Reviews are read-only by default. Wording work requires explicit allowed paths. Direct jobs appear under Other jobs; there is no invented lead or review pipeline.
- Closing the desktop window hides it to the tray. Quitting the app leaves the daemon and its jobs running. Reopening attaches to the same daemon. Existing idle-daemon replacement and active-job protection remain in force.
- Notifications open the relevant job. Approval notification actions recheck the pending request ID before answering. A short heartbeat lease suppresses duplicate daemon input notifications while the desktop app is available; other daemon notifications remain unchanged. OS notification permission and platform support still govern delivery.
- Timers stop updating hidden renderers. Decorative ambient and connection pulses were removed to avoid continuous idle painting. Working-state indicators still respect reduced motion.

## Dependencies and decisions

Versions below are pinned by `package-lock.json` and were checked on 2026-11-12.

| Dependency | Expected benefit |
| --- | --- |
| React / React DOM 19.3 | Stable component identity and declarative updates replace manual HTML patching and input restoration |
| Vite 8.3 | TypeScript/JSX development and production bundling, hashed assets and unused-code elimination |
| Lucide React 1.72 | One outline SVG vocabulary, explicit sizing and stroke width, only imported icons in the build |
| Electron 45.3 | Requested native app shell with tray, window lifecycle and notification APIs |
| Electron Packager 20.3 | Reproducible platform app bundle without writing a custom packager |
| Playwright 1.65 | Real browser regressions, visual baselines and automation of the actual Electron executable |

No state manager, router, UI component framework, motion runtime or Storybook was added. React state and `useSyncExternalStore` cover the current state model; native dialogs/selects cover focus and keyboard behavior. Playwright fixtures exercise the real screens and component states. A dedicated component catalog can be reconsidered when isolated component consumption warrants it.

`@electron/asar` transitively selected vulnerable glob/minimatch versions. Scoped overrides use glob 14.0.2+ and minimatch 11.0.1+; packaging was tested with these versions. The audit reported zero vulnerabilities. Remove the overrides when the upstream dependency ranges include the fixes. Packager is a development dependency and is not shipped in the app.

Primary references consulted:

- [Vite guide](https://vite.dev/guide/)
- [Lucide React](https://lucide.dev/guide/react/)
- [Electron security checklist](https://github.com/electron/electron/blob/main/docs/tutorial/security.md)
- [Electron sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox)
- [Electron application distribution](https://github.com/electron/electron/blob/main/docs/tutorial/application-distribution.md)
- [Playwright Electron API](https://playwright.dev/docs/api/class-electron)

## Run and build

```bash
npm ci
npm run build:board
node plugin/bridge/cli.ts board
```

For renderer development, start the daemon with `node plugin/bridge/cli.ts daemon start`, then run `npm run dev:board`. Vite listens on `127.0.0.1:5173` and proxies the existing local daemon. `CREW_PORT` selects an alternate daemon port.

```bash
npm run desktop
npm run package:desktop
```

The macOS arm64 output is `release/Crew-darwin-arm64/Crew.app`. The app contains compiled bridge JavaScript, renderer assets, roles, plugin metadata and third-party notices. It starts its detached daemon with the bundled Electron executable in Node mode; a separately installed Node is not needed for that daemon. Authenticated worker CLIs and git remain required. The web board remains available at `http://127.0.0.1:47615`.

Source installs now need `npm run build:board` after frontend changes. Missing assets produce an explicit 503 message instead of a broken page. Do not restart a daemon that has active jobs during an upgrade. Let those jobs finish, then start the current daemon and reload the board.

## Security and distribution

The renderer has `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. There is no preload API. External navigation, popups, webviews and browser permission requests are denied. CSP permits only local scripts and connections; inline styles are allowed for computed progress values. The daemon retains its loopback Host/Origin checks. The Vite proxy removes only its own allowed development origins; foreign origins reach the daemon unchanged and are refused.

This is a local development app bundle, not a signed, notarized public release. Signing identities, notarization credentials, an update feed and distribution policy are not configured. Updating means building/replacing the local app. Automatic updates and login launch are intentionally absent. Windows/Linux packaging and OS notification button presentation have not been verified.

## Verification

The original 79 tests and typecheck passed before migration. The final unit suite has 81 passing tests and the browser suite has 14 passing tests, including 1440px/390px visual comparisons and a 320px dialog check. The old DOM-specific board harness was replaced by tests of the extracted model, store and action state plus actual browser regressions; bridge adapter and worktree tests remain in place.

```bash
npm test
npm run typecheck
npm run build:desktop
npx playwright install chromium webkit
npm run test:e2e
node scripts/smoke-desktop.mjs
```

To check a packaged macOS app:

```bash
CREW_APP_PATH="$PWD/release/Crew-darwin-arm64/Crew.app/Contents/MacOS/Crew" node scripts/smoke-desktop.mjs
```

Browser checks run in Chromium, WebKit, and a development build that keeps React's StrictMode checks. Each project gets its own fixture server on a free port, so worktrees can run the suite side by side; fixtures do not start workers. The screenshot baselines are Chromium's on macOS; other systems skip that comparison and run the remaining layout checks. Inspect baseline changes before running `npm run test:e2e -- --update-snapshots`. Desktop smoke tests use a fresh temporary home and an unused port, never the user's real jobs.

Verified on macOS arm64: renderer isolation, denied external navigation, window close/hide, second-instance focus, restored bounds, cancellation of a quit with unsaved settings, and an unchanged daemon PID after app quit/reopen. Browser checks cover request locking/retry, settings races, scoped dispatch, cancellation/follow-up, escaped report text, live updates, narrow layouts and reduced motion. The desktop smoke test also exercises repeated Claude input requests through the real daemon and poller, with OS notification display mocked. Native notification presentation and buttons were not clicked in Notification Center; those remain a manual acceptance check.

A packaged empty-board smoke run reported approximately 524 MiB as the sum of Electron process working sets, and the local app occupied about 255 MiB on disk. Working sets can count shared pages more than once, exclude the independent daemon/workers, and were measured under Playwright instrumentation; they are not a physical-memory budget or a comparison with a native shell. The renderer bundle is approximately 262 kB JavaScript (82 kB gzip), plus shared CSS and the bundled 73 kB font. Resource cost is a real tradeoff of choosing Electron; no claim of native-app memory efficiency is made.

## UI review

Scope: the board, requests, details, settings and dispatch flow. Native notification presentation is excluded.

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| Medium | `plugin/board/board.css`, `src/ui.tsx`, `src/Missions.tsx` | Mixed mask glyphs, CSS chevrons and SVG controls | Lucide marks, controls and completed-stage checks share physical stroke widths | Keeps small icons legible and consistent |
| High | `src/Settings.tsx`, `src/api.ts` | Migration could drop shared locks and late-response protection | Request identities and scoped save generations preserve those guarantees | Prevents duplicate decisions and overwritten drafts |
| Medium | `plugin/board/board.css` | Retired dock stacking rules hid subsequent React request cards | Removed renderer-specific stacking and kept all requests in flow | Every waiting job remains reachable |

Verification uses browser interactions, screenshots and source inspection of hover, pending, disabled, error, focus and reduced-motion states. These findings were corrected. Verdict: Approve for the inspected scope; native notification appearance remains unverified.

## Review fixes (2026-11-13)

A selected project now keeps the filter selector visible even when it is the only known project, so the user can clear the persisted filter and dispatch to another directory. The browser regression covers selection, reload, clearing, and dispatch.

Claude waiting episodes carry a unique ID. Duplicate hooks within an unchanged wait retain that ID; a new wait gets a new ID even when its message repeats or the desktop misses the intervening work. The desktop uses that ID for notification deduplication and removes inactive records on each poll. Older daemons fall back to message-based keys until they can be restarted safely.

## Revision: native macOS replacement (2026-11-13)

The user requested SwiftUI and AppKit while retaining the TypeScript daemon. The native app replaces Electron, uses system Liquid Glass and SF Symbols, bundles standalone Node, and keeps the browser board. See [08-native-macos.md](08-native-macos.md) for current build and verification instructions.
