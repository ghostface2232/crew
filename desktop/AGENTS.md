# desktop

The Windows app: an Electron shell around the React board, with a tray icon, the window frame, and self-update. It shares the daemon, jobs, and settings with the browser board and the macOS app. How it works is in [docs/windows-app.md](../docs/windows-app.md).

## Rules

- The renderer stays sandboxed (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`). The preload script (`preload.cts`) exposes only the updater, and the main process answers it only when called from the main window's board page.
- The main process signs the board's requests to the daemon (`signBoard` in `main.ts`); the page holds no secret.
- Board features belong in `plugin/board/`. What this folder adds to the page is limited to the frame: drag regions and room for the window buttons.
- Notifications stay with the daemon's toasts (`plugin/bridge/toast.ts`), because an unsigned Electron build has no registered app identity.
- Changes here need a check on Windows: `npm run test:desktop` there runs `scripts/smoke-electron.mjs` against an isolated daemon.

## Where things are

| File | What it does |
| --- | --- |
| `main.ts` | Window, tray, single instance, daemon start, request signing, frame stylesheet, and navigation limits |
| `preload.cts` | The updater bridge the board sees as `window.crewDesktop` |
| `updater.ts` | Checking, downloading, verifying, and installing releases |
| `window-state.ts` | Restoring window bounds |
| `taskbar.ts` | Reading the Windows mode, which sets the taskbar's theme, for the tray icon |
| `installer.nsh` | Launching the app after the NSIS installer finishes |
