# 07. React board and Electron desktop

Windows uses the [Electron shell](12-windows-electron.md), and macOS uses the [native macOS app](08-native-macos.md). The React web board remains supported on all platforms.

Originally implemented in Crew 0.2.0 (2026-11-12) for the L5 UI foundation and L2 role-based dispatch. AgentGauge usage routing (`plugin/bridge/usage.ts`), New Job intents (`Command`, `Question`, `Information`), and per-round undo (`plugin/board/src/JobDrawer.tsx`) have since shipped; Claude remains the pipeline lead, while Cursor, alternate leads, and automatic merges remain separate work.

## Architecture

```text
Claude plugin / CLI ──┐
                     ├── independent Crew daemon ── worker adapters / worktrees
Electron main ────────┘             │
  window, tray, signing, updater    │ HTTP + SSE
  update preload IPC only           ▼
                     React board in Electron (Windows) or web browser
```

React owns the entire board (`plugin/board/src`), replacing the original imperative `board.js` renderer with no shared DOM ownership. On macOS, the desktop shell is SwiftUI (`native/Sources/Crew`); on Windows, `desktop/main.ts` hosts the daemon-served React board.

| File | Responsibility |
| --- | --- |
| `plugin/board/src/store.ts` | One SSE subscription, immutable snapshots, reconnect replacement, bounded event history (400 events) |
| `plugin/board/src/api.ts` | Launch-ticket sign-in, HTTP requests, SSE reader, shared drafts, and action locks keyed by job/request identity |
| `plugin/board/src/model.ts` | Project grouping, state priority, mission stop/progress math, usage/heatmap helpers, and duration labels |
| `plugin/board/src/ui.tsx` | Native `<dialog>` lifecycle, the board's own select, menus, and confirm sheet (`ask`), stable composers, Fluent status icons, agent marks, and clock updates |
| `Missions.tsx`, `NeedsYou.tsx`, `Overview.tsx`, `Palette.tsx`, `Shell.tsx`, `Scores.tsx` | Mission tracks, needs-you cards, workspace/activity/history views, command palette, sidebar navigation, and model scores |
| `JobDrawer.tsx`, `Settings.tsx`, `Dispatch.tsx` | Job/session details (verification, evidence, rounds, debate), scoped settings/presets/about, and direct dispatch |
| `desktop/main.ts`, `desktop/preload.cts` | Windows Electron shell: single instance, tray, restored bounds, Mica backdrop, request signing, daemon startup, and updater IPC |
| `plugin/bridge/assets.ts` | Built-asset allowlist, MIME types, and renderer CSP |

Bridge types are imported type-only; Node modules never enter the renderer. Shared CSS tokens (`plugin/board/board.css`) preserve the workspace surfaces, typography, and state colors, while `Dispatch.tsx`, `Settings.tsx`, and `Scores.tsx` use CSS Modules. All text is set in the bundled Pretendard font (`plugin/board/pretendard.woff2`), with no monospace face. Selects, checkboxes, switches, tooltips, and confirmation prompts are drawn by the board rather than by the platform, so they look consistent on Windows. Fluent System Icons (`@fluentui/react-icons`) are filled SVGs in `currentColor`, sized by CSS; selected sidebar items swap to the Filled style with `bundleIcon`; agent marks (`AgentMark`) render the SVGs in `plugin/board/src/icons/` as CSS mask templates.

## Behaviors

- Mission stages, recent completed missions, unfinished jobs, lead session disclosures, limits, reports, changes, out-of-scope files, refusal notes, resume commands, and job activity remain available.
- Needs-you cards sit in normal document flow above the work list, keeping every request reachable across project filters. Project selection uses the sidebar `NavList` (`All projects` and per-project hover previews), collapsing into a slide-over drawer at `<= 760px`.
- Approval buttons and text answers share one lock across the board and drawer (`answer:<job>:<requestId>`). An accepted request stays locked while SSE catches up; a failed request keeps its draft for retry; a new question gets a new draft.
- `Composer` uses a `<textarea>` where Return adds a newline and only the send button submits, so IME composition cannot accidentally send. Stable React keys preserve inputs and disclosures across SSE updates. Detail requests abort when a drawer closes or changes jobs.
- Settings track loaded scope and generation so late responses cannot overwrite another editor. Saving normalizes only the submitted draft and preserves edits made during the request. Failed loads disable saving and expose a retry.
- Direct dispatch (`Dispatch.tsx`) supports `Command` (uses the role table, offers a worker picker when multiple workers hold a role, runs implementation/polish in isolated worktrees, `review` read-only on uncommitted changes, and `verify` in a snapshot), `Question` (read-only), and `Information` (appends to project/shared instructions or an active mission note). Direct jobs appear under Other jobs.
- Closing the desktop window hides it to the tray; quitting leaves the daemon and jobs running, and reopening attaches to the same daemon with existing active-job protection.
- On Windows, the Electron shell leaves OS toast notifications to the daemon and denies browser notifications (`notify.ts`); see [08-native-macos.md](08-native-macos.md) for macOS native notifications. In a standalone browser, `Notifier` shows Web Notifications for waiting requests and completions when permitted and opted in while the tab is unfocused.
- `ClockProvider` holds a clock store that skips updates while `document.hidden` is true. Components read it through `useClock(select)`, so one renders again only when the text it shows changes, and finished work does not subscribe. The store tells its subscribers of stream events once per animation frame (a timer in a hidden tab); connection changes are told at once.
- Nothing on the board animates without end: a browser draws every frame of a looping animation, and the turning chip symbol, the current step's halo, the working project's dot and the live connection's ripple together held a third of a core while a mission ran. They rest as they do under Reduce Motion. `@media (prefers-reduced-motion: reduce)` disables transitions and animations except the active `.spinner`, which shows only while a request is in flight.

## Dependencies and decisions

Versions below match `package.json` (pinned in `package-lock.json`).

| Dependency | Expected benefit |
| --- | --- |
| React / React DOM 19.3 | Stable component identity and declarative updates replace manual HTML patching and input restoration |
| Vite 8.3 | TypeScript/JSX development and production bundling, hashed assets, and unused-code elimination |
| Fluent UI React Icons 2 | Windows' own icon vocabulary in Regular and Filled styles, only imported icons in the build; its Griffel runtime injects a few inline styles, which the board's CSP allows |
| Electron 45.3 | Desktop shell for Windows with tray, window lifecycle, and Mica support |
| Electron Builder 26.18 | Per-user NSIS Windows installer and unpacked bundle (`asar: false`), replacing the earlier `electron-packager` setup |
| Playwright 1.65 | Real browser regressions, visual baselines, and automation of the Electron executable |

No state manager, router, UI component framework, motion runtime, or Storybook was added. React state and `useSyncExternalStore` cover the state model; native `<dialog>` covers focus, and the board's own `Select` in `ui.tsx` handles keyboard behavior. Playwright exercises the real screens and component states. The move to the native macOS app removed the earlier `@electron/asar` dependency overrides (`73bde30`).

Primary references consulted:

- [Vite guide](https://vite.dev/guide/)
- [Fluent UI System Icons](https://github.com/microsoft/fluentui-system-icons)
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

For renderer development, start the daemon with `node plugin/bridge/cli.ts daemon start`, then run `npm run dev:board`. Vite listens on `127.0.0.1:5173` and proxies `/api`, `/fonts`, and `/icons` to the local daemon (`CREW_PORT` selects an alternate port, default `47615`).

```bash
npm run desktop
npm run package:desktop
```

These commands run `scripts/desktop.mjs`, which builds and opens the native SwiftUI app on macOS (`08-native-macos.md`) and Electron on non-macOS systems (`12-windows-electron.md`); `release/Crew-darwin-arm64/Crew.app` was the retired macOS Electron output. The web board remains available at `http://127.0.0.1:47615`.

Source installs need `npm run build:board` after frontend changes; missing assets return HTTP 503 (`plugin/bridge/daemon.ts`). Never restart a daemon with active jobs during an upgrade—let running jobs finish, then start the current daemon and reload the board.

## Security and distribution

The Electron renderer runs with `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Its preload script (`desktop/preload.cts`) exposes only `window.crewDesktop.update`, which `desktop/main.ts` answers solely from the main window's board origin, and only `clipboard-sanitized-write` is permitted for that origin. External navigation, webviews, and unapproved popups are denied; report links open in the default browser, and evidence files open in a separate sandboxed window. `BOARD_CSP` (`plugin/bridge/assets.ts`) restricts scripts, connections, fonts, and media to `'self'` (plus `data:` for images and `'unsafe-inline'` for styles). The daemon retains loopback Host/Origin checks; Vite removes only its own development origins.

Packaging, signing, and self-updating are covered in [08-native-macos.md](08-native-macos.md) (macOS) and [12-windows-electron.md](12-windows-electron.md) (Windows).

## Verification

```bash
npm test
npm run typecheck
npm run build:desktop
npx playwright install chromium
npm run test:e2e
npm run test:desktop
```

`npm run test:desktop` runs `scripts/smoke-desktop.mjs` on macOS or `scripts/smoke-electron.mjs` on Windows (`CREW_APP_PATH` points either script at a packaged binary).

Browser checks (`playwright.config.ts`) run in Chromium (`chromium`) and a `development` build that keeps React's StrictMode checks; Firefox and WebKit are omitted because neither launches on macOS 27. Each project gets its own fixture server (`test/e2e/server.ts`) on a free port without starting workers. Screenshot baselines are Chromium's on macOS. Screenshot comparisons are skipped on other platforms. Inspect changes before running `npm run test:e2e -- --update-snapshots`. Desktop smoke tests use a fresh temporary home and free port, never the user's real jobs.

At the initial 2026-11-12 React/Electron migration baseline, 81 unit tests, typecheck, 14 browser tests, and a macOS arm64 Electron smoke run passed (reporting ~524 MiB sum of Electron working sets under Playwright, ~255 MiB app bundle, and ~262 kB / 82 kB gzip JS renderer bundle). The working-set sum counts shared pages twice, excludes the daemon and workers, and cannot serve as a physical-memory budget. See [08-native-macos.md](08-native-macos.md) and [12-windows-electron.md](12-windows-electron.md) for current platform verification.

## UI review

Scope: the board, requests, details, settings, and dispatch flow (excluding OS notification appearance).

| Severity | Location | Before | After | Why |
| --- | --- | --- | --- | --- |
| Medium | `plugin/board/board.css`, `src/ui.tsx`, `src/Missions.tsx` | Mixed mask glyphs, CSS chevrons, and SVG controls | Lucide icons use a `strokeWidth` of 1.75 in SVG units | Keeps small icons legible and consistent |
| High | `src/Settings.tsx`, `src/api.ts` | Migration could drop shared locks and late-response protection | Request identities and scoped save generations preserve those guarantees | Prevents duplicate decisions and overwritten drafts |
| Medium | `plugin/board/board.css` | Retired dock stacking rules hid subsequent React request cards | Removed renderer-specific stacking and kept all requests in flow | Every waiting job remains reachable |

## Review fixes (2026-11-13)

- Keeping `All projects` visible in the project sidebar ensures users can always clear a persisted project filter and dispatch to another directory.
- Claude waiting episodes carry a unique `waitingId` across duplicate hooks for the same wait, while a new wait gets a new ID even if its message repeats, enabling accurate notification deduplication. For daemons without `waitingId`, notifications fall back to the message key.

## Revision: native macOS replacement (2026-11-13)

The native SwiftUI and AppKit app replaced Electron on macOS, using system Liquid Glass, SF Symbols, and bundled standalone Node while keeping the TypeScript daemon and React web board. See [08-native-macos.md](08-native-macos.md).
