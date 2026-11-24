# Board

The React web board lets users inspect work and act on it directly, as does the native macOS app (requirement R10, roadmap item B1). The web board is supported on all platforms and also runs in the Windows Electron shell. Claude remains the pipeline lead; Cursor, alternate leads, and automatic merges remain separate work.

**Key files:** `plugin/board/src/store.ts`, `plugin/board/src/api.ts`, `plugin/board/src/model.ts`, `plugin/board/src/ui.tsx`, `plugin/board/board.css`, and `plugin/bridge/assets.ts`. See [daemon-api.md](daemon-api.md) for HTTP and SSE, [missions.md](missions.md#display) for mission display, [approvals.md](approvals.md) for approvals and questions, and [usage-and-presets.md](usage-and-presets.md) for usage routing and presets. The current desktop apps are documented in [windows-app.md](windows-app.md) and [macos-app.md](macos-app.md).

## Architecture

The Claude plugin, CLI, and Windows Electron main process connect to an independent Crew daemon that owns worker adapters and worktrees. The daemon serves the React board over HTTP and SSE to browsers and the Windows Electron window. React owns the entire board (`plugin/board/src`). The macOS desktop app uses SwiftUI (`native/Sources/Crew`).

| File | Responsibility |
| --- | --- |
| `plugin/board/src/store.ts` | One SSE subscription, immutable snapshots, reconnect replacement, and bounded history of 400 events |
| `plugin/board/src/api.ts` | Launch-ticket sign-in, HTTP requests, SSE reader, shared drafts, and action locks keyed by job and request identity |
| `plugin/board/src/model.ts` | Project grouping, state priority, usage and heatmap helpers, duration labels, and [mission stops](missions.md#display) |
| `plugin/board/src/ui.tsx` | Native `<dialog>` lifecycle, the board's select, menus, confirm sheet (`ask`), stable composers, Fluent status icons, agent marks, and clock updates |
| `Missions.tsx`, `NeedsYou.tsx`, `Overview.tsx`, `Palette.tsx`, `Shell.tsx`, `Scores.tsx` | Mission tracks, request cards, workspace/activity/history views, command palette, sidebar navigation, and model scores |
| `JobDrawer.tsx`, `Settings.tsx`, `Dispatch.tsx` | Job and session details (verification, evidence, rounds, debate), scoped settings/presets/about, and direct dispatch |
| `desktop/main.ts`, `desktop/preload.cts` | Windows hosting, single instance, tray, restored bounds, Mica backdrop, request signing, daemon startup, and updater IPC |
| `plugin/bridge/assets.ts` | Built-asset allowlist, MIME types, and renderer CSP |

Bridge types are imported type-only, keeping Node modules out of the renderer. Shared CSS tokens in `plugin/board/board.css` preserve the workspace surfaces, typography, and state colors. `Dispatch.tsx`, `Settings.tsx`, `Scores.tsx`, and `Onboarding.tsx` use CSS Modules. All text uses the bundled variable Pretendard font (`plugin/board/pretendard.woff2`) in three weights, 450, 550, and 600, with no monospace face. The board draws its own selects, checkboxes, switches, tooltips, and confirmation prompts for a consistent appearance on Windows.

## Navigation and workspace

- The sidebar lists `Overview`, `Needs You`, `Activity`, and `History`, with an alphabetical `Projects` list. The sidebar `NavList` keeps `All projects` visible so users can always clear a persisted filter and dispatch to a different directory. It also offers per-project hover previews. The board saves the selection in `localStorage` under `crew.selection`. Selecting a project scopes Overview to it. Jobs and sessions group under the repository's main working tree even when started from a worktree or subfolder.
- `⌘K` or `/` opens the search palette (`Ctrl+K`, and shown that way, on non-Apple platforms), `N` opens New Job, and `1`–`4` switch pages. `N` is also recognized by its physical key position when an input source such as Korean sends another character for it. A query in the palette matches work by its content, as the macOS app's search does (a job's title, phase, project, and agent; a mission's or Claude session's title), and actions, pages, and projects by their names only, so their descriptions and the group headings never turn up unrelated results. The board follows system light and dark mode (`color-scheme: light dark`) and scales down to `320px`. At `<= 760px` the sidebar becomes a slide-over drawer, with a bottom dock below `760px`.
- The workspace shows mission stages and recently completed missions as described in [missions.md](missions.md#display), along with unfinished jobs, lead session disclosures, and limits. Summary KPI counts include ended jobs only while unsettled, meaning they have an undiscarded worktree or unread result.
- Activity and History show their cards in two columns once the page is wider than 1040px, the width at which Overview's side column appears (`Columns` in `Overview.tsx`). As in the macOS app's masonry, cards alternate left and right in order and each column stacks on its own, so a mission that opens moves only the cards below it in its own column; a lone card keeps the full width. No CSS layout gives independent columns while keeping cards in order, so the split is made in React, and with two columns the DOM, and so Tab and screen readers, reads the left column and then the right. A card that changes column, as when a filter removes one before it, mounts again and appears in place rather than rising in again. History's table of completed jobs stays outside the columns at the page's width, which its six columns need.
- After a first install, the Windows app's board displays a four-page welcome sheet (`Onboarding.tsx`) covering what Crew is, `/crew:` commands, Needs You, and what Overview's setup card checks. Its illustrations use the board's own components (the app icon, agent marks, cards, chips, and buttons), so they follow the theme and match the UI they describe. Every page's text shares one grid cell so the sheet keeps the tallest page's height. The app flags the sheet as pending only when the Crew home (`~/.crew`, or `CREW_HOME`) did not exist before starting the daemon, so updates never show it; it stores that flag as `welcome-pending` in user data, the board checks it through the preload bridge (`crewDesktop.welcome`), and closing the sheet in any way clears it. **Welcome to Crew** in the command palette reopens the sheet (in a browser too), and the arrow keys page through it.
- Status uses Fluent icons and tinted chips (`Chip`). Fluent System Icons (`@fluentui/react-icons`) are filled SVGs in `currentColor` and sized by CSS. Selected sidebar items swap to the Filled style with `bundleIcon`. The `AgentPanel` beside the workspace shows agent names and marks. `AgentMark` renders SVGs in `plugin/board/src/icons/` as CSS mask templates.

## Needs You and live answers

- Lead sessions come from Claude Code's hooks and, marked `host: "codex"`, from Codex's, whose payloads carry the same fields (`report.ts codex`). A Codex session shows under Codex: its agent card adds Lead while one is open, and its rows, cards and panel name Codex. Codex's `PermissionRequest` hook marks it waiting with the call it asks about, and `Interrupt` ends its turn. For a Codex session with a UUID thread ID, Open in Codex opens the thread via `codex://threads/<threadId>`. With other IDs, its card and session panel say to answer in Codex.
- Waiting jobs and lead sessions appear as full request cards with inline controls on `Needs You`, with badges in the sidebar, header button, and Overview KPI. The cards sit in normal document flow above the work list, so every request stays reachable across project filters. A card names only the agent; its project shows on hover. The tab title shows `(<n>) Crew` whenever jobs or lead sessions wait on the user across all projects.
- A waiting Claude session is answered in Claude itself: hooks can report a prompt but not answer it, and a `PermissionRequest` hook that waited for the board would hold back the desktop app's own prompt. Its card shows what the prompt asks: an `AskUserQuestion` call's questions and choices, the end-of-turn box's question with its buttons, or the command, path, or input an approval is for. `PreToolUse` runs before the permission check, so the tracker keeps each caller's open calls (the main loop's or a sub-agent's, by `tool_use_id`) and attaches the call to the `permission_prompt` notification that follows when it is that caller's only open one; with several open at once the card shows the message alone (`ask` on the session, `claude.ts`). For a Claude desktop session, Open in Claude opens the session via `claude://code/continue?session=<local_id>`; `report.ts` supplies that ID from `CLAUDE_CODE_HOST_SESSION_ID` (`desktopId` on the session), which terminal sessions lack, so their cards keep *Answer in Claude.* Pressing anywhere else on the card opens the session's details, unless the press ended a text selection. The session panel shows the same content and the same button beside Resume Command.
- Waiting approvals offer Approve, Deny, and *Allow for This Job* when eligible. Questions accept written replies or Yes/No. Answers carry `request_id` so they cannot settle a later request. Approval buttons and text answers share one lock across the board and drawer (`answer:<job>:<requestId>`). An accepted request stays locked while SSE catches up. A failed request keeps its draft for retry, and a new question gets a new draft.
- Stable React keys preserve inputs and disclosures across SSE updates. Live updates preserve drafts, caret, focus, and action locks. `Composer` uses a `<textarea>` where Return adds a newline and only the send button submits, preventing accidental sends during IME composition. Inline `ActionStatus` messages and a connection banner report failures.
- In a standalone browser, `Notifier` shows Web Notifications for waiting requests and completions when permitted and opted in while the tab is unfocused. The Windows Electron shell denies browser notifications and leaves OS toasts to the daemon (`plugin/bridge/toast.ts`); `notify.ts` turns itself off there. See [macos-app.md](macos-app.md) for native macOS notifications.

## Job details and evidence

- Reports preserve asterisk bullets, extension globs such as `src/*.ts` and a bare `*.ts` (a dotted name closed by an asterisk, as in `*.env*`, is still emphasis), and unmatched emphasis markers as text. Paired markers such as `*italic*` and `**bold**` format their contents. A link uses the matching bracketed label immediately before its destination, so earlier bracketed references stay plain.
- Clicking a job row opens a non-modal side panel (`#<job id>`). It shows status and errors, inline approval or question controls while waiting, and facts about the agent, model, project, branch, tokens, context window use, and shared instructions. While a Codex turn runs, it also shows the changes made so far, fetched again whenever the job's `liveDiff` changes (the macOS app shows them too, cut at 8,000 characters). It also shows changed files with out-of-scope files marked and Diff Command at the end of that section, the bridge check receipt, evidence, rounds with undo and keep, automatic-review refusals, notes, the report or debate transcript, a follow-up composer, the original task, activity, and Resume Command and Cancel Job in the footer. Detail requests abort when the drawer closes or changes jobs.
- Pressing a capture opens it alone. A thumbnail strip adds or removes panes (up to four, arranged in a row of up to three or a 2×2 grid). Lead attachments come first, then worker captures by turn, with `<view>-before` ahead of `<view>-after`. Captions show `Turn X of Y` or `Attached by the lead`. The macOS app decodes images natively at pane size and opens recordings in the system player. macOS has no WebM decoder.

## Settings

- The dialog (`Settings.tsx`) edits Build/Review/Edit roles, Presets, Model Scores (including the peer-ratings toggle), shared instructions (global and per-project), Language ([localization.md](localization.md#how-the-language-is-chosen)), and About Crew. Role saves preserve other `config.json` keys and refuse unparseable files. Instruction writes allow only daemon-known projects and never follow symlinks.
- Roles and the default preset are stored as they are changed, with no save step (`useStored` in `Settings.tsx`), as System Settings stores a switch: each control is a complete change, and a save button was one more thing to forget. One request runs at a time and a change made meanwhile goes out when it returns, so the last change is the one stored. A change that cannot be stored is undone and says why, under its role's rows or under the preset. Closing Settings waits for a change still being stored, and stays open if it cannot be, so the reason is never lost with the dialog. A model or effort typed by hand is stored when its field is left or Return is pressed, not at every keystroke. An agent turned off loses its settings and gets them back if it is turned on again while Settings stays open, and a role without a parent that returns to the holders it had unwritten when Settings opened writes none again; the form resolves such a role against the roles as Settings opened, since the stored ones lag a change by one request. If the table is changed elsewhere (in the macOS app, another tab, or `config.json`), the updated table replaces the form's copy unless a change made here is still being stored, and Settings then treats it as the table it opened with: each change stores the whole table, so an older copy would otherwise undo the other change. A model or effort being typed and not yet stored is kept when its stored value changes that way. A table that arrives while a change made here is still being stored is not taken, so the next change here can undo it; closing that gap would need the daemon to store one role at a time.
- Instructions keep an explicit save, on the line under their editor with the status and Retry Loading: they are prose, and text half typed would otherwise reach the next job that starts. Closing with unsaved instructions prompts first.
- The dialog is laid out as the window is: a frame on `--canvas` around the page, an inset stage on `--stage` that is the one thing that scrolls. Beside the sidebar the stage takes the dialog's full height and has no title row: the sidebar's current item names the page. There is no close button there either; Escape or a press outside the dialog closes it, and it settles out over 220ms as its backdrop clears (`LeavingContext` in `ui.tsx`, as the detail panel leaves). On a phone the sidebar is a list of its own, and a page gets a title row with Back and Close above a stage inset on both sides; the list keeps a Close button too, since a phone leaves little outside the dialog to press. The sidebar's pages are plain glyphs, as the window's sidebar draws its own, with the accent on the current one.
- A role's agent checkboxes take a line of their own, running from its start, where their group is too narrow (440px) to hold them beside the label; wrapped against the trailing edge they read as scattered.
- The instructions editor tracks loaded scope and generation so late responses cannot overwrite another editor. Saving normalizes only the submitted draft and preserves edits made during the request. Failed loads disable saving and expose a retry.

## New Job

Direct dispatch (`Dispatch.tsx`) sends one of three intents. Direct jobs appear under Other jobs.

| Intent | Behavior | Request |
| --- | --- | --- |
| Command | Uses the role table and offers a worker picker when multiple workers hold a role. Implementation and polish run in isolated worktrees, `review` is read-only on uncommitted changes, and `verify` runs in a snapshot. | `POST /api/jobs` for the chosen role (except `debate`) |
| Question | Runs read-only. | `POST /api/jobs` with `kind: "delegate"` and `ask: true` |
| Information | Appends to project or shared instructions, or to an [active mission's notes](missions.md#notes-and-runbooks). | `POST /api/missions/:id` with `note` when a mission is chosen, otherwise `POST /api/instructions` with `append` |

## Update frequency and motion

- `ClockProvider` holds a clock store that ticks once a second and skips updates while `document.hidden` is true. Components read it through `useClock(select)` and re-render only when the text they show changes. Finished work does not subscribe.
- `BoardStore` in `store.ts` applies each stream event to its snapshot immediately. It notifies subscribers once per animation frame, or on a timer in a hidden tab. Connection changes notify subscribers immediately.
- Four status animations now rest as they do under Reduce Motion: the running mission chip's turning symbol, the current step's halo, the working project's dot, and the live connection's ripple. Together they used a third of a core while a mission ran because the browser draws every frame of a looping animation.
- Three looping animations remain, running only while their cause lasts: `.spinner` while a request is in flight, `.dots` while waiting for a debate reply, and the workflow strip's pulse while its session panel is open. `@media (prefers-reduced-motion: reduce)` disables transitions and animations except the active `.spinner`.

## Dependencies and decisions

Versions match `package.json` and are pinned in `package-lock.json`.

| Dependency | Expected benefit |
| --- | --- |
| React / React DOM 19.3 | Stable component identity and declarative updates replace manual HTML patching and input restoration |
| Vite 8.3 | TypeScript/JSX development and production bundling, hashed assets, and unused-code elimination |
| Fluent UI React Icons 2 | Windows' icon vocabulary in Regular and Filled styles, with only imported icons in the build. Its Griffel runtime injects a few inline styles, which the board's CSP allows. |
| Electron 45.3 | Windows desktop shell with tray, window lifecycle, and Mica support |
| Electron Builder 26.18 | Per-user NSIS Windows installer and unpacked bundle (`asar: false`), replacing the earlier `electron-packager` setup |
| Playwright 1.65 | Real browser regressions, visual baselines, and automation of the Electron executable |

React state and `useSyncExternalStore` cover the state model. Native `<dialog>` handles focus, the board's own `Select` in `ui.tsx` handles keyboard behavior, and Playwright exercises real screens and component states. The migration added no state manager, router, UI component framework, motion runtime, or Storybook.

Primary references consulted

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

For renderer development, start the daemon with `node plugin/bridge/cli.ts daemon start`, then run `npm run dev:board`. Vite listens on `127.0.0.1:5173` and proxies `/api`, `/fonts`, and `/icons` to the local daemon. `CREW_PORT` selects an alternate port, with `47615` as the default. The web board is available at `http://127.0.0.1:47615`.

Source installs need `npm run build:board` after frontend changes. Missing assets return HTTP 503 (`plugin/bridge/daemon.ts`). During an upgrade, let running jobs finish before restarting the daemon, then start the current daemon and reload the board.

```bash
npm run desktop
npm run package:desktop
```

These commands run `scripts/desktop.mjs`, which builds and opens the native SwiftUI app on macOS and Electron on non-macOS systems. Closing the Electron desktop window hides it to the tray. Quitting leaves the daemon and jobs running, and reopening attaches to the same daemon with existing active-job protection. See the platform docs for build and launch steps, packaging, signing, and self-updating: [macOS app](macos-app.md#build-and-run) and [Windows app](windows-app.md#build-and-run).

## Renderer security

The Electron renderer uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`. Its preload (`desktop/preload.cts`) exposes only `window.crewDesktop.update` and `window.crewDesktop.welcome`. `desktop/main.ts` answers it solely from the main window's board origin and permits only `clipboard-sanitized-write` for that origin. The shell denies external navigation, webviews, and unapproved popups. Report links open in the default browser, and evidence files open in a separate sandboxed window.

`BOARD_CSP` in `plugin/bridge/assets.ts` restricts scripts, connections, fonts, and media to `'self'`, with `data:` for images and `'unsafe-inline'` for styles. The daemon retains loopback Host/Origin checks, and Vite removes only its own development origins.

## Not verified

- Screen readers.
- IME composition.

## Tests

The board was checked in the browser pane and with Playwright regressions (`npm run test:e2e`). Automated handler tests covered instruction saves, concurrent edits, and request locks. Mission display is tested as described in [missions.md](missions.md#tests).

```bash
npm test
npm run typecheck
npm run build:desktop
npx playwright install chromium
npm run test:e2e
npm run test:desktop
```

The browser suite (`test/e2e/board.spec.ts`, `playwright.config.ts`) runs in Chromium (`chromium`) and a `development` build that keeps React's StrictMode checks. Firefox and WebKit are omitted because neither launches on macOS 27. Each project gets its own fixture server (`test/e2e/server.ts`) on a free port without starting workers. Screenshot baselines are Chromium's on macOS, and comparisons are skipped on other platforms. Inspect changes before running `npm run test:e2e -- --update-snapshots`.

`npm run test:desktop` runs `scripts/smoke-desktop.mjs` on macOS or `scripts/smoke-electron.mjs` on Windows. `CREW_APP_PATH` points either script at a packaged binary. Desktop smoke tests use a fresh temporary home and free port, separate from the user's real jobs. Current platform verification is documented in [macos-app.md](macos-app.md#verification) and [windows-app.md](windows-app.md#verification).

## History

- **2026-11-23.** Settings dropped the Save Roles and Save Preset buttons: roles and the preset are stored as they are changed, in the board and the macOS app alike. Until then every page was a draft with a save bar at the foot of the dialog, and a change left unsaved was lost or asked about on close. Instructions keep their save, moved from that bar to the line under the editor. The dialog also took the window's frame-and-stage layout and lost its title row, close button, and the colored tiles behind the sidebar's icons.
- **2026-11-13.** The native SwiftUI and AppKit app replaced Electron on macOS, using system Liquid Glass, SF Symbols, and bundled standalone Node while keeping the TypeScript daemon and React web board. The retired Electron output was `release/Crew-darwin-arm64/Crew.app`. The move removed the earlier `@electron/asar` dependency overrides (`73bde30`). See [macos-app.md](macos-app.md) and [windows-app.md](windows-app.md) for the current apps.
- **2026-11-13.** Review fixes kept `All projects` visible and gave Claude waiting episodes a unique `waitingId`. Duplicate hooks for the same wait share the ID. A new wait gets a new ID even if the message repeats, enabling accurate notification deduplication. For daemons without `waitingId`, notifications fall back to the message key.
- **2026-11-12–13.** Migrated the board to React/TypeScript/Vite and added board decision support ([architecture.md](architecture.md#history) records the desktop apps). React replaced the imperative `board.js` renderer and took sole ownership of its DOM.
- **2026-11-12.** The original Crew 0.2.0 implementation served the L5 UI foundation and L2 role-based dispatch. As it still does on Windows, the Electron main process owned the window, tray, signing, and updater, with preload IPC only for updates. AgentGauge usage routing (`plugin/bridge/usage.ts`), New Job intents (`Command`, `Question`, `Information`), and per-round undo (`plugin/board/src/JobDrawer.tsx`) shipped after that baseline.
- **2026-11-12.** The initial React/Electron baseline passed 81 unit tests, typecheck, 14 browser tests, and a macOS arm64 Electron smoke run. The baseline reported ~524 MiB sum of Electron working sets under Playwright, ~255 MiB app bundle, and ~262 kB / 82 kB gzip JS renderer bundle. The working-set sum counts shared pages twice and excludes the daemon and workers, so it cannot serve as a physical-memory budget.

The migration UI review covered the board, requests, details, settings, and dispatch flow, excluding OS notification appearance.

| Severity | Location | Finding and fix | Reason |
| --- | --- | --- | --- |
| Medium | `plugin/board/board.css`, `src/ui.tsx`, `src/Missions.tsx` | Mixed mask glyphs, CSS chevrons, and SVG controls changed to Lucide icons with a `strokeWidth` of 1.75 in SVG units. | Keeps small icons legible and consistent. |
| High | `src/Settings.tsx`, `src/api.ts` | The migration could drop shared locks and late-response protection. Request identities and scoped save generations preserved those guarantees. | Prevents duplicate decisions and overwritten drafts. |
| Medium | `plugin/board/board.css` | Retired dock stacking rules hid subsequent React request cards. Removing renderer-specific stacking kept all requests in flow. | Keeps every waiting job reachable. |
