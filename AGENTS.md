# Crew

Crew is a Claude Code plugin that splits one user's coding work across several agents on the same machine. A Claude Code session leads: it plans, does the core of the change, reviews, and decides what is merged. By default Codex implements separable pieces and cross-reviews, and Antigravity polishes wording; which agent takes which kind of work is the user's setting (roles). A status board and desktop apps for macOS and Windows show every agent live and let the user answer approvals and questions in place.

This file is the map for agents working on this repository. A directory with its own `AGENTS.md` has rules or an overview of its own; read it before editing there.

## How the app fits together

```text
Claude Code session (lead)
  │ stdio MCP (plugin/bridge/mcp.ts)      │ command hooks (report.ts, context.ts, wake.ts)
  ▼                                       ▼
Crew daemon (plugin/bridge/daemon.ts, http://127.0.0.1:47615)
  ├─ codex app-server ── Codex jobs, each writable job in its own git worktree
  ├─ agy acp ─────────── Antigravity jobs
  ├─ state in ~/.crew (config.json, jobs.json, missions.json, events.jsonl, token)
  └─ HTTP + SSE ──┬─ React board (plugin/board), in a browser or Claude Desktop's browser pane
                  ├─ macOS app (native/, SwiftUI and AppKit)
                  └─ Windows app (desktop/, Electron around the board)
```

- The daemon is one long-lived process per user. It owns the worker processes, job and mission state, and the board, so jobs survive the lead session restarting and several sessions share one board. The MCP server, hooks, CLI, and apps are clients; the first one to need the daemon starts it.
- Each implementation or polish job runs on branch `crew-<job id>` in a worktree under `~/.crew/worktrees/`. Nothing reaches the user's branch until the lead reads the diff and merges it.
- Workers never see the lead's conversation. Each job gets the lead's brief, a role file from `plugin/roles/`, the machine-sharing rules, and the shared instructions in `~/.crew/instructions.md` and `.crew/instructions.md`.
- A desktop app carries a built copy of the plugin and its own Node runtime, and registers the plugin with Claude Code on first launch.

## Repository layout

| Path | What it is | Read first |
| --- | --- | --- |
| `plugin/bridge/` | Daemon, lead and worker MCP servers, agent adapters, hooks, and the `crew` CLI, in TypeScript run directly by Node | [plugin/bridge/AGENTS.md](plugin/bridge/AGENTS.md) |
| `plugin/board/` | React status board, built with Vite and served by the daemon | `plugin/board/AGENTS.md` |
| `plugin/roles/` | Role instructions each job receives (engineer, reviewer, editor, debater, question, machine rules, and additions for refactor, release, and fix) | |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | The `/crew:run`, `/crew:debate`, `/crew:review`, and `/crew:board` skills; the `self-reviewer` subagent; hook registrations | |
| `native/` | macOS app (Swift 6) | `native/AGENTS.md` |
| `desktop/` | Windows app (Electron) | `desktop/AGENTS.md` |
| `scripts/` | Board, desktop, and plugin-bundle builds, packaging, and desktop smoke tests | |
| `test/` | Unit tests (`node --test`) and Playwright board regressions (`test/e2e/`) | |
| `docs/` | How each part works and why, one topic per file | `docs/AGENTS.md` |
| `research/` | Earlier plans and surveys, kept for their reasoning; not a description of current behavior | |
| `.crew/instructions.md` | Notes Crew gives every job in this repository, such as sandbox workarounds | |
| `.github/` | CI and the release workflow | |

## Commands

```bash
npm ci
npm run typecheck                    # bridge and tests, board, desktop app
npm test                             # unit tests
npm run test:e2e                     # board build and Playwright regressions
npm run test:native                  # macOS app tests (macOS only)
npm run test:desktop                 # this platform's desktop app smoke test
npm run desktop                      # build and open this platform's desktop app
node plugin/bridge/cli.ts install    # register this checkout as the Crew plugin
```

## Rules for the whole repository

- macOS and Windows are the supported platforms; Linux is not a target. Platform-specific behavior needs both paths, and Windows-only checks run on a Windows machine.
- Comments and docs are in English. Write what the code cannot say: intent, constraints, and non-obvious decisions.
- The bridge has no runtime dependencies and no build step. The only runtime dependencies are the board's (React and Fluent icons), bundled by Vite.
- When behavior changes, update the doc that owns the topic (below) in the same change.
- Do not add a `CLAUDE.md` here: Claude Code ignores `AGENTS.md` files while one exists.

## Where each topic is documented

| To understand | Read |
| --- | --- |
| Goals, requirements, and acceptance criteria | [docs/requirements.md](docs/requirements.md) |
| Processes, state in `~/.crew`, how Codex and Antigravity are driven, and Antigravity's terms-of-service risk | [docs/architecture.md](docs/architecture.md) |
| Lead tools, jobs, worktrees, rounds, follow-ups, and `crew gc` | [docs/jobs.md](docs/jobs.md) |
| How news reaches the lead: receipts, hooks, and wake-ups | [docs/delivery.md](docs/delivery.md) |
| Approval requests and worker questions | [docs/approvals.md](docs/approvals.md) |
| Sandboxes, `check`, `runs_app`, and sharing the machine | [docs/sandbox.md](docs/sandbox.md) |
| Missions, tasks, and watched pull requests | [docs/missions.md](docs/missions.md) |
| Roles, shared instructions, model notes, scores, and peer ratings | [docs/roles.md](docs/roles.md) |
| Usage, routing, presets, and tiers | [docs/usage-and-presets.md](docs/usage-and-presets.md) |
| The daemon's HTTP API, events, and sign-in | [docs/daemon-api.md](docs/daemon-api.md) |
| The React board | [docs/board.md](docs/board.md) |
| The macOS app and its design tokens | [docs/macos-app.md](docs/macos-app.md), [docs/design-tokens.md](docs/design-tokens.md) |
| The Windows app | [docs/windows-app.md](docs/windows-app.md) |
| Releases, how the app installs the plugin, and the first-run checklist | [docs/distribution.md](docs/distribution.md) |
| What each MCP host supports | [docs/mcp-compatibility.md](docs/mcp-compatibility.md) |
| Planned work and open questions | [docs/roadmap.md](docs/roadmap.md) |
