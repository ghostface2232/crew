# Crew

A Claude Code plugin that splits work across Claude, Codex, and Antigravity. Claude acts as the lead and self-reviewer, Codex handles supporting implementation and cross-review, and Antigravity polishes UX copy, comments, and documentation. A native SwiftUI macOS app, a Windows Electron app, and a React web board show all three agents in real time.

## Getting started

Install and open the desktop app from [Releases](https://github.com/ghostface2232/crew/releases/latest) (macOS 26 or later on Apple silicon, or Windows 10 or later on x64).

You need Claude Code plus signed-in Codex and Antigravity CLIs (`codex login`; run `agy` once). Every job spends the usage of the plan its agent is signed in to.

On first launch, the app installs the Crew plugin for Claude Code and the `crew` command, both running on the app's own Node. Its overview lists anything else Crew needs. Open a new Claude Code session afterwards. The app updates the plugin with itself, leaving a plugin installed from a source checkout alone.

### From source

Requirements: Node.js 22.18+, git, and authenticated `claude`, `codex`, and `agy` CLIs.

```bash
npm ci
npm run build:board
node plugin/bridge/cli.ts install
```

```bash
crew doctor
```

`install` registers this folder as a Claude Code marketplace, installs the `crew` plugin, and links `crew` into `~/.local/bin` (on Windows, `crew.cmd` for cmd and PowerShell and a `crew` script for Git Bash). Open a new Claude Code session (including Desktop) afterwards.

## Usage

Inside a Claude Code session:

| Input | What happens |
| --- | --- |
| `/crew:run <task>` | Runs planning, parallel implementation, a review (your own or Codex's; both where security, concurrency, or data loss is involved), fixes, wording polish, and final verification in order |
| `/crew:debate <decision>` | Debates a hard or important decision with Codex over a few read-only rounds that end with a conclusion |
| `/crew:review [target]` | Runs a self-review and a Codex cross-review of a change in parallel, then fixes what holds up |
| `/crew:board` | Opens the status board (inside the browser pane in Claude Desktop) |
| Natural prompts like "Have Codex build this part" or "Get a Codex review on this" | The lead calls `delegate`, `review`, or `polish` directly |

From a terminal:

```bash
crew status
```

```bash
crew board
```

When something hangs, `crew doctor` checks prerequisites, `crew daemon logs` shows the daemon log, and `crew daemon restart` restarts it. `crew show <job>` reads one job and `crew cancel <job>` stops it.

`crew gc` previews orphan worktrees, Git metadata, and unused worker branches, showing whether each branch is merged into `HEAD`. Use `crew gc --apply` to remove orphan directories and prune metadata; add `--branches` to delete only branches merged into `HEAD`. Unmerged branches are kept with a `git branch -D <name>` command for manual removal. Active and owned worktrees are protected. Windows cleanup failures name leftovers in job status and notes.

The status board runs at http://127.0.0.1:47615, or on a fallback port in `~/.crew/daemon.json` when the system reserves that one. Open it with `crew board` or from the app to sign in; a browser tab stays signed in until it is closed or reloaded. The daemon answers only requests carrying the secret in `~/.crew/token` ([docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md) section 12).

Each `/crew:run` command appears as a single unit with its jobs grouped under it, and a top line lists anything waiting on you. Click a job to read its report, changed files, and activity, or to send a follow-up.

Board Settings edits roles, the preset, and shared instructions, and shows each model's score out of 10 from the lead's review notes. Roles cover implementation, refactoring, release preparation, debate, cross-review, review that runs the app, fixing review findings, and wording; unset roles follow their parent. A role can have several holders, including Claude, and the lead picks one per job.

A mission can use its own preset when you name one in the command ("economy" for a simple task, "best" for a deep one) or pick one from the mission's menu.

A command you give while another is still under way opens beside it, and both stay open until each finishes. A mission stores the tasks the lead split the work into, so a resumed or compacted session carries on from that record. When the lead links a pull request to a mission, Crew reads it with your GitHub CLI (`gh`) while the session is open and wakes the lead only for a newly failed check, review feedback, or a merge conflict. The lead decides the fix and hands it to an agent, while merging stays yours.

If [AgentGauge](https://github.com/ghostface2232/AgentGauge) is installed, each agent's card shows remaining usage and `/crew:run` routes work accordingly. When an agent runs low, the lead takes over or defers the work and says so.

Job turns appear as rounds that can be undone or kept one by one. Send work also accepts a read-only question or a piece of information to pin ([docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md)).

When a worker asks for approval or has a question, an input dialog pops up in the Claude app. You can also answer on the status board: approve or deny, or type an answer to a question. A computer-use request about one app can be allowed for the rest of its job so the worker stops asking on every call. Codex's built-in automatic reviewer answers approval requests first; you are asked only about what it refuses twice ([docs/04-implementation.md](docs/04-implementation.md) section 5.1).

## Desktop app

```bash
npm run desktop
```

On macOS, this builds the native SwiftUI app; on Windows, it builds an Electron app around the web board. `npm run package:desktop` writes `release/Crew.app` on macOS (requires Xcode 26+ and a standalone Node.js distribution) or the per-user installer `release/Crew-Setup-<version>.exe` and unpacked app `release/win-unpacked/Crew.exe` on Windows. Both apps run the existing TypeScript daemon without a separate Node install.

Closing the window hides it to the tray; quitting the app leaves jobs running. Both restore their window, and the macOS app opens approval notifications at the relevant job. The web board stays available.

The board can send jobs directly for any role except debate, using the configured roles; full missions still begin in the Claude lead session. See the [native macOS](docs/08-native-macos.md) and [Windows](docs/12-windows-electron.md) notes for development, tests, resource measurements, and distribution limits.

## How it works

- Each implementation or polish job runs in an isolated git worktree under `~/.crew/worktrees/` on branch `crew-<job id>`. Nothing touches your working branch until the lead inspects the diff and merges it.
- Gitignored files needed for tests (such as `node_modules` or `.env`) are copied into the worktree when listed in `.worktreeinclude` at the repository root. It uses `.gitignore` syntax and shares Claude Code's native worktree file.
- Codex runs via `codex app-server` and Antigravity runs via `agy acp`. Crew executes only the official binaries and never reads authentication files or tokens.
- When a background job finishes or needs a decision, the lead session wakes up automatically.
- Agents share the machine without colliding ([docs/04-implementation.md](docs/04-implementation.md) section 5.4):
  - Each starts an isolated instance of any service it runs.
  - Only one reviewer of a change launches the app.
  - A worker that runs the app gets network access and its own snapshot of the change.
  - Performance-measuring jobs run alone.
- Shared instructions go in `~/.crew/instructions.md` (all projects) and `.crew/instructions.md` at the repository root (that project). Workers get them with each job and Claude sessions at start; no service's own instruction files are touched.
- Configuration lives in `~/.crew/config.json` (stall timeout, notifications, Codex approval policy, whether Antigravity is enabled, which agent holds each role, and whether agents rate each other's work for the model scores).

Antigravity is enabled by default, and using it carries a Terms of Service risk: read [docs/04-implementation.md](docs/04-implementation.md) section 6, and set `antigravity.enabled` to `false` in `~/.crew/config.json` to turn it off.

## Directory layout

| Path | Contents |
| --- | --- |
| `plugin/bridge/` | Daemon, MCP server, agent adapters, CLI (TypeScript, no build step) |
| `plugin/board/` | React + TypeScript board, shared CSS tokens and Vite output |
| `native/`, `desktop/`, `scripts/` | SwiftUI/AppKit macOS app, Electron Windows app, build/packaging, and desktop verification |
| `plugin/roles/` | Role instructions (engineer, reviewer, editor, and additions for refactoring, release preparation, and fixing) injected into whichever agent holds the role, on every job |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | `/crew:run`, `/crew:debate`, `/crew:review`, `/crew:board`, self-reviewer subagent, hooks |
| `test/` | Unit tests (`npm test`) and Playwright regressions (`npm run test:e2e`) |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/01-requirements.md](docs/01-requirements.md) | Goal, current requirements (R1–R16), defaults and priorities, acceptance criteria |
| [docs/02-implementation-plan.md](docs/02-implementation-plan.md) | Architecture decisions, connection methods, roles and workflow, status display, rejected alternatives, risks, build phases |
| [docs/03-agentgauge-integration.md](docs/03-agentgauge-integration.md) | Current state of AgentGauge, integration gaps, phased integration plan, MCP tool spec, routing policy |
| [docs/04-implementation.md](docs/04-implementation.md) | Implemented architecture, changes from the plan and why, desktop app visibility findings, verification log |
| [docs/05-related-work.md](docs/05-related-work.md) | Survey of related projects, adoption candidates vs. current code, UX gaps |
| [docs/06-roadmap.md](docs/06-roadmap.md) | Near-term rework, long-term expansion, control UI concept, open items |
| [docs/07-desktop-and-react.md](docs/07-desktop-and-react.md) | React migration and historical Electron implementation |
| [docs/08-native-macos.md](docs/08-native-macos.md) | Native macOS app, Liquid Glass, Swift 6, packaging and verification |
| [docs/09-usage-presets-rounds.md](docs/09-usage-presets-rounds.md) | AgentGauge usage and routing, presets, rounds, intents, and the API they share |
| [docs/10-design-tokens.md](docs/10-design-tokens.md) | Design tokens of the macOS app: color, type, spacing, radius, motion |
| [docs/11-mcp-compatibility.md](docs/11-mcp-compatibility.md) | MCP protocol revisions and what each host supports |
| [docs/12-windows-electron.md](docs/12-windows-electron.md) | Windows Electron app, frameless window, notifications, packaging and verification |
| [docs/13-distribution-plan.md](docs/13-distribution-plan.md) | Release plan: GitHub Releases, Windows installer, the app installing the plugin, first-run checklist (release workflow and installer implemented) |

## Current status

Released as 0.3.x with desktop apps for macOS and Windows. Usage-based routing works when AgentGauge is installed. Planned work is in [docs/06-roadmap.md](docs/06-roadmap.md); the surveys behind it are in [research/](research/).

## Updating the documentation

- Attach a verification date to facts about external tools. Because protocols and policies across all three services have shifted every few months, re-verify the sources at the end of document 02 before building.
- Document 01 always states the current goals and is rewritten when they change; its history is in git.
- In the other documents, when reversing a recorded decision, do not delete it—append the reason and date to that document's revision log.
