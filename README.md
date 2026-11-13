# Crew

A Claude Code plugin that divides roles across Claude, Codex, and Antigravity so they collaborate as a three-agent crew. Claude acts as the lead and self-reviewer, Codex handles supporting implementation and cross-review, and Antigravity polishes UX copy, comments, and documentation. A native SwiftUI macOS app and a React web board show what all three agents are doing in real time.

## Getting started

Requirements: Node.js 22.18+, git, and authenticated `claude`, `codex`, and `agy` CLIs.

```bash
npm ci
npm run build:board
node plugin/bridge/cli.ts install
```

```bash
crew doctor
```

`install` registers this folder as a Claude Code marketplace, installs the `crew` plugin, and links the `crew` command into `~/.local/bin`. Open a new Claude Code session (including Desktop) after installing for it to take effect.

## Usage

Inside a Claude Code session:

| Input | What happens |
| --- | --- |
| `/crew:run <task>` | Runs planning, parallel implementation, self-review, cross-review, fixes, wording polish, and final verification in order |
| `/crew:board` | Opens the status board (inside the browser pane in Claude Desktop) |
| Natural prompts like "Have Codex build this part" or "Get a Codex review on this" | The lead calls `delegate`, `review`, or `polish` directly |

From a terminal:

```bash
crew status
```

```bash
crew board
```

The status board runs at http://127.0.0.1:47615. Open it with `crew board` or from the app, which sign it in; the daemon answers only requests that carry the secret in `~/.crew/token` ([docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md) section 12). Each command run with `/crew:run` appears as a single unit with its jobs grouped under it, and a line at the top lists anything waiting on you. Click a job to read its report, changed files, and activity, or to send it a follow-up. Settings on the board edits roles, the preset, and shared instructions.

If [AgentGauge](https://github.com/ghostface2232/AgentGauge) is installed, each agent's card shows its remaining usage, and `/crew:run` routes work accordingly: when an agent runs low, the lead takes over or defers the work and says so. A job's turns appear as rounds that can be undone or kept one by one, and Send work also accepts a read-only question or a piece of information to pin ([docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md)).

When a worker asks for approval or has a question, an input dialog pops up in the Claude app. You can also answer on the status board: approve or deny, or type an answer to a question. Codex's built-in automatic reviewer answers its approval requests first, so you are asked only about what it refuses twice ([docs/04-implementation.md](docs/04-implementation.md) section 5.1).

## Desktop app

```bash
npm run desktop
```

Build a local macOS 26+ app bundle with `npm run package:desktop`; it is written to `release/Crew.app`. Building requires Xcode 26+ and a standalone Node.js distribution. The app bundles Node for the existing TypeScript daemon. Closing the window hides it to the tray; quitting the app leaves jobs running. The app restores its window and opens approval notifications at the relevant job. The web board stays available.

The board can send implementation, read-only review, and wording jobs directly through the configured roles. Full missions still begin in the Claude lead session. See [the native macOS implementation and verification notes](docs/08-native-macos.md) for development, tests, resource measurements and distribution limits.

## How it works

- Each implementation or polish job runs in its own isolated git worktree (under `~/.crew/worktrees/`) on a `crew-<job id>` branch. Nothing touches your working branch until the lead inspects the diff and merges it.
- Gitignored files that workers need to run tests (such as `node_modules` or `.env`) are copied into the worktree when listed in `.worktreeinclude` at the repository root. It uses `.gitignore` syntax and shares the same file as Claude Code's native worktrees.
- Codex runs via `codex app-server` and Antigravity runs via `agy acp`. Crew executes only the official binaries and never reads authentication files or tokens.
- When a background job finishes or needs a decision, the lead session wakes up automatically.
- Agents share the machine without colliding: each starts an isolated instance of any service it runs, only one reviewer of a change launches the app, and a worker that does gets network access and its own snapshot of the change, and performance-measuring jobs run alone ([docs/04-implementation.md](docs/04-implementation.md) section 5.4).
- Instructions for every agent go in `~/.crew/instructions.md` (all projects) and `.crew/instructions.md` at the repository root (that project). Workers get them with each job and Claude sessions at start; no service's own instruction files are touched.
- Configuration lives in `~/.crew/config.json` (stall timeout, notifications, Codex approval policy, whether Antigravity is enabled, and which agent holds each role).

Using Antigravity carries a Terms of Service risk; read [docs/04-implementation.md](docs/04-implementation.md) section 6 before enabling it.

## Directory layout

| Path | Contents |
| --- | --- |
| `plugin/bridge/` | Daemon, MCP server, agent adapters, CLI (TypeScript, no build step) |
| `plugin/board/` | React + TypeScript board, shared CSS tokens and Vite output |
| `native/`, `desktop/`, `scripts/` | SwiftUI/AppKit app, app artwork, build/packaging and desktop verification |
| `plugin/roles/` | Role instructions (engineer, reviewer, editor) injected into whichever agent holds the role, on every job |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | `/crew:run`, `/crew:board`, self-reviewer subagent, hooks |
| `test/` | Unit tests (`npm test`) and Playwright regressions (`npm run test:e2e`) |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/01-requirements.md](docs/01-requirements.md) | Goal, current requirements (R1–R14), defaults and priorities, acceptance criteria |
| [docs/02-implementation-plan.md](docs/02-implementation-plan.md) | Architecture decisions, connection methods, roles and workflow, status display, rejected alternatives, risks, build phases |
| [docs/03-agentgauge-integration.md](docs/03-agentgauge-integration.md) | Current state of AgentGauge, integration gaps, phased integration plan, MCP tool spec, routing policy |
| [docs/04-implementation.md](docs/04-implementation.md) | Implemented architecture, changes from the plan and why, desktop app visibility findings, verification log |
| [docs/05-related-work.md](docs/05-related-work.md) | Survey of related projects, adoption candidates vs. current code, UX gaps |
| [docs/06-roadmap.md](docs/06-roadmap.md) | Near-term rework, long-term expansion, control UI concept, open items |
| [docs/07-desktop-and-react.md](docs/07-desktop-and-react.md) | React migration and historical Electron implementation |
| [docs/08-native-macos.md](docs/08-native-macos.md) | Native macOS app, Liquid Glass, Swift 6, packaging and verification |
| [docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md) | AgentGauge usage and routing, presets, rounds, intents, and the API they share |

## Current status

The bridge (Phase 1) and status board (Phase 2) are implemented, roles can be reassigned in `~/.crew/config.json`, and shared instructions reach every agent ([docs/04-implementation.md](docs/04-implementation.md) sections 2.1 and 2.2). AgentGauge usage and routing are implemented by reading its files (phase G1, [docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md)); the phases that need changes in AgentGauge itself are not. What comes next is in [docs/06-roadmap.md](docs/06-roadmap.md).

## Updating the documentation

- Attach a verification date to facts about external tools. Because protocols and policies across all three services have shifted every few months, re-verify the sources at the end of document 02 before building.
- Document 01 always states the current goals and is rewritten when they change; its history is in git.
- In the other documents, when reversing a recorded decision, do not delete it—append the reason and date to that document's revision log.
