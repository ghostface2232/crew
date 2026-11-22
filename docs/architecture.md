# Architecture

Crew runs a long-lived daemon that owns worker processes, job state, the event log, and the status board. Claude Code leads from Desktop or the CLI, while the daemon drives Codex through `codex app-server` and Antigravity through `agy acp`.

**Key files:** `plugin/bridge/mcp.ts`, `daemon.ts`, `config.ts`, and the command hooks `report.ts`, `context.ts`, and `wake.ts`. See [jobs.md](jobs.md) for worker jobs, [delivery.md](delivery.md) for lead wakeups, and [daemon-api.md](daemon-api.md) for the HTTP contract.

## Processes and daemon lifecycle

```
Claude Code (Desktop or CLI) ── Lead
  │ stdio MCP                    │ Command hooks (authenticated HTTP)
  ▼                              ▼
plugin/bridge/mcp.ts ──HTTP──▶ Crew Daemon (127.0.0.1:47615)
                                 ├─ codex app-server   (Codex)
                                 ├─ agy acp            (Antigravity)
                                 ├─ Event log ~/.crew/events.jsonl
                                 └─ Status board (SSE) http://127.0.0.1:47615
```

- One long-lived daemon owns worker processes, job state, event log, and status board. The MCP server (`plugin/bridge/mcp.ts`) is a thin client, so jobs survive Claude session restarts or compaction and multiple sessions share one board.
- The daemon starts automatically on the first MCP or CLI call and replaces itself when idle if `plugin/bridge/` file hashes differ on disk (so source edits apply without bumping versions). Replacement sends `POST /api/shutdown` with `ifIdle: true`. The daemon returns `409` while any mutating POST is in flight or a job is active (running, waiting, starting, syncing, changing rounds, or being discarded). A daemon from another folder is replaced only by a newer version.
- On shutdown the daemon attempts both state saves and removes its PID file even if an earlier step fails. It logs each failed step and exits with a nonzero status if any step failed.
- `crew daemon stop` and `restart` stop the daemon unconditionally. If the shutdown request goes unanswered, they send `SIGTERM` to the PID in `~/.crew/daemon.json`—only after verifying it matches `/api/health`'s listener, retrying briefly if the PID file is missing—and remove the PID file after a forced stop only if it still names that PID (on Windows, `SIGTERM` terminates immediately). Replacement never spawns a new daemon while the old listener is still up, and `restart` verifies `~/.crew/token` is accepted before reporting "running".
- The daemon binds its port before reading or writing any state, so a competing daemon that loses the port race exits without creating a token, loading jobs, or clearing active scratch directories and review snapshots. If the system reserves a port with nothing listening (such as WSL mirrored networking's 4096-port blocks), the daemon steps down through `PORTS` in `config.ts`. Clients, hooks (`bridge/report.ts`), and desktop apps read the bound port from `~/.crew/daemon.json`.
- Everything ships in one Claude Code plugin (`plugin/`) containing the MCP server, hooks, 4 skills, 1 subagent (`self-reviewer`), and 9 role files.

## Bridge and state

- TypeScript runs directly via Node.js 22.18+ type stripping. The bridge has zero runtime dependencies and no build step.
- The bridge implements MCP directly without the official SDK because it only needs lifecycle, tools, progress, elicitation, and cancellation.
- The event log is JSONL (`~/.crew/events.jsonl`). Jobs, delivery state, and PR watches live in `~/.crew/jobs.json`. Missions live in `~/.crew/missions.json`.
- Codex thread start and resume time out after 3 minutes (`THREAD_TIMEOUT_MS`) because Windows sandbox ACL setup can exceed a minute under load. Other RPC calls time out after 30 seconds (`RPC_TIMEOUT_MS`). Stall probes report opening threads as working.
- The suspected stall timeout is set by [`stallSeconds`](delivery.md#stalls) in `~/.crew/config.json`.
- `/crew:run` sets the review limit to 1 round by default and 2 at most. The bridge does not enforce it.
- Codex uses `on-request` for implementation and `runs_app` reviews and `never` for static reviews and questions. See [approvals.md](approvals.md) for user and automatic reviewer routing.

## Changes from the plan

| Area | [Implementation plan](../research/implementation-plan.md) | Implementation | Reason |
| --- | --- | --- | --- |
| Antigravity connection | `agy acp` or `agy -p` | `agy acp` only | Official FAQ says wrapping `agy -p` in third-party agents is unsupported on consumer plans, whereas ACP docs allow any ACP client (see [Antigravity policy risk](#antigravity-policy-risk)) |
| Phase 0 | Run with `codex-plugin-cc` and skills first | Skipped | `app-server` worked immediately on this machine |
| Role files | `CLAUDE.md`, `AGENTS.md`, Antigravity custom agent | `plugin/roles/*.md`, skills, and MCP server instructions inside the plugin | The plugin keeps role files out of repositories and injects the role per job via `developerInstructions` (Codex) and ACP system-prompt append or prompt prefix (Antigravity) |
| Antigravity role enforcement | `--agent` and `--mode` | Bridge evaluates ACP permission requests | In default mode every edit asks permission, letting the bridge enforce [per-role read/edit/command rules](sandbox.md#role-permissions) without touching user config |
| Event transport | WebSocket | SSE | One-way streaming suffices, browsers reconnect automatically, and actions use plain `POST` requests |
| Claude status source | `claude agents --json` polling plus Notification hook | Command hooks (`report.ts`, `context.ts`, `wake.ts`) | Push-based, covers Desktop sessions, discovers the daemon port from `~/.crew/daemon.json`, and authenticates with `~/.crew/token` (HTTP hooks cannot read files) |
| Waking the lead | Unspecified | `asyncRewake` command hook | Wakes an idle lead session when a job ends or needs input. Channels were skipped as a research preview behind a feature flag |

## Desktop session visibility

These findings cover requirement R6.

| Service | What was verified |
| --- | --- |
| Claude | Claude sessions are visible when the lead runs in Claude Desktop, where the plugin works in local sessions |
| Codex | Bridge threads land in the ChatGPT app's store titled `Crew · <title>`. Because the ChatGPT app spawns its own private stdio `app-server`, Crew cannot attach live. The app controls when the list refreshes. Resume from the CLI with `codex resume <id>` |
| Antigravity | ACP sessions save to the CLI store (`~/.gemini/antigravity-cli/`) under `default-cli-project`, not the desktop app store (`~/.gemini/antigravity/`), so they do not appear in the Antigravity app. Resume from the CLI with `agy --conversation <id>`. The sidecar-only `agentapi` endpoint provides no way to read responses, so it is not used |

Resume commands appear in job results and in the board's job details panel.

### Antigravity policy risk

The [official FAQ](https://antigravity.google/docs/faq/) gives these policy terms.

- "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
- "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service" / "Such actions can result in suspension or termination of your account."

The bridge runs only the official `agy` binary via ACP (which Google documents for third-party clients) and never touches credentials, though whether driving Antigravity from Claude Code via ACP falls under the wording above depends on Google's interpretation. To disable Antigravity, set `{"antigravity": {"enabled": false}}` in `~/.crew/config.json`.

## Standalone status board app

Both desktop apps are thin clients over the daemon's `/api/state`, `/api/stream` (SSE), and `POST` endpoints, while the [React web board](board.md) remains for browsers and Claude Desktop's browser pane.

- **macOS (`native/Sources/Crew/`)** uses SwiftUI/AppKit. Crew chose it over Tauri for menu bar integration, actionable approval notifications, and OS-native presentation. See [macos-app.md](macos-app.md).
- **Windows (`desktop/`)** uses Electron to wrap the React web board with a system tray icon and daemon-signed requests. See [windows-app.md](windows-app.md).

## Not verified

- Visual appearance of the native approval dialog inside Claude Desktop (protocol round-trip verified only).
- When threads appear in the ChatGPT app UI.

## Tests

Baseline external-tool checks (2026-11-11): Claude Code 2.1.321, Codex CLI 0.167.0, Antigravity CLI 1.5.5, and Node.js 24.22.1. Later Windows checks used Codex CLI 0.166.0 and Git for Windows 2.53.

Verified against live accounts and on macOS/Windows hosts across 2026-11-11 to 2026-11-20.

- The core pipeline checks covered `delegate`, `review` (`adversarial` and `standard`), `polish`, out-of-workspace edit refusal, `.worktreeinclude` copy/link, project isolation, `cancel`/`discard`, and a full 7-stage `/crew:run` in headless Claude Code.
- Approval and wake checks covered `untrusted` approval round-trips, MCP elicitation approve/deny/dismiss/error/board-first/sequential prompts, live `asyncRewake` wakeups in Claude Desktop (7 s background review wakeup, `ask_lead`/`answer` round-trips), and `Host`/`Origin`/token request guards.
- Checks on a Windows 11 host (2026-11-14, 2026-11-16) covered the full unit test suite (macOS-only tests skipped), `check` under Git for Windows' `sh` in `codex sandbox` + PowerShell 5.1 kill-on-close job object, shared junctions, held empty worktree folder auto-retry, Windows toasts, and Remote Control wakeups.
- Claude Desktop loaded the plugin tools, skills, and `self-reviewer` subagent in local sessions.

Related unit tests include `test/adapters.test.ts`, `test/adapter-contracts.test.ts`, `test/client.test.ts`, and `test/desktop.test.ts`.

## History

- 2026-11-16: Windows bridge parity verified on Windows 11 with Codex CLI 0.166.0 and Git for Windows 2.53, including `crew.cmd`/Git Bash shims. See [usage-and-presets.md](usage-and-presets.md) for Windows Gauge usage files, [jobs.md](jobs.md#history) for canonical project paths, [delivery.md](delivery.md#history) for Windows toasts, and [sandbox.md](sandbox.md#history) for the Windows check and browser behavior.
- 2026-11-12–13: Added desktop apps, superseding the earlier web-only design (see the [board history](board.md#history) for the React/TypeScript/Vite migration). Daemon replacement switched to hashing `bridge/` files, and the daemon began binding its port before writing state.
