# plugin/board

The status board: a React 19 and TypeScript app built by Vite into `dist/` (not committed) and served by the daemon. It runs in a browser, in Claude Desktop's browser pane, and inside the Windows app, which wraps it in Electron. What it shows and how it behaves is in [docs/board.md](../../docs/board.md).

## Rules

- The board and the macOS app (`native/Sources/Crew/`) show the same state and offer the same actions, and their code names each other's views ("as in the app"). A change to what one shows or offers usually needs the same change in the other.
- `src/types.ts` mirrors the daemon's JSON. Fields an older daemon does not send are optional, so a newer board keeps working against it.
- Draw controls with the board's own components in `src/ui.tsx` (`Select`, the `ask` confirm sheet, menus, tooltips) rather than the platform's, so they look the same on Windows. Text uses the bundled Pretendard font, with no monospace face; icons are Fluent.
- A looping animation runs only while its cause lasts (a request in flight, a reply awaited), because a browser draws every frame of one; a running state otherwise rests as it does under Reduce Motion.
- The page holds no secret: the daemon signs it in with a scoped credential kept in memory ([docs/daemon-api.md](../../docs/daemon-api.md)). Do not put credentials in cookies, web storage, or addresses.

## Where things are

| Area | Files |
| --- | --- |
| Connection to the daemon and the state store | `src/store.ts`, `src/api.ts`, `src/types.ts` |
| Derived values: project grouping, priorities, mission progress, PR statuses, durations | `src/model.ts`, `src/dates.ts` |
| Pages and navigation | `src/App.tsx`, `src/Shell.tsx`, `src/Overview.tsx`, `src/NeedsYou.tsx`, `src/Palette.tsx` |
| Missions, job details, New Job, settings, and model scores | `src/Missions.tsx`, `src/JobDrawer.tsx`, `src/Dispatch.tsx`, `src/Settings.tsx`, `src/Scores.tsx` |
| Shared components | `src/ui.tsx` |
| Styles and tokens | `board.css`, `src/*.module.css` |
| Windows app hooks and notifications | `src/desktop.ts`, `src/notify.ts` |

## Build and test

- `npm run dev:board` serves the board on port 5173 and proxies `/api` to the daemon on `CREW_PORT` (default 47615).
- `npm run build:board` writes `dist/`; the daemon and both apps serve that build.
- `test/board.test.ts` covers the model and store; `npm run test:e2e` runs Playwright against a fixture daemon (`test/e2e/server.ts`) in two projects, a production build and a development build with React's StrictMode checks. The layout snapshots in `test/e2e/board.spec.ts-snapshots/` are taken on macOS; regenerate them there with Playwright's Chromium, and only when a layout change is intended.
