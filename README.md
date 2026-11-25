<img width="256" alt="crew-icon" src="https://github.com/user-attachments/assets/c3725ff6-85d9-49e6-ba61-08fda7cbcc5a" />


# Crew

A plugin for Claude Code and Codex that runs several coding agents together: Claude, Codex, and Antigravity. The session you start in leads, whether it is Claude Code or Codex: it plans the work and hands pieces of it to the other agents in parallel, reviewing what comes back and deciding what is merged. You can change which agent takes each kind of work at any time. A native SwiftUI macOS app, a Windows Electron app, and a React web board show all three agents in real time.

<img width="1440" alt="crew-screenshot" src="https://github.com/user-attachments/assets/eec6a201-8395-4dc9-a77c-2e5872aa96d0" />

## Getting started

Install and open the desktop app from [Releases](https://github.com/ghostface2232/crew/releases/latest) (macOS 26 or later on Apple silicon, or Windows 10 or later on x64).

You need Claude Code or Codex to lead from, plus signed-in Codex and Antigravity CLIs for the workers (`codex login`; run `agy` once). Every job spends the usage of the plan its agent is signed in to.

Crew works best alongside [AgentGauge](https://github.com/ghostface2232/AgentGauge). Crew reads each agent's remaining usage and reset times from it, shows them on the agent cards, and routes work by them ([Usage](#usage)). Without it, work follows your role assignments.

On first launch, the app installs the Crew plugin for Claude Code and for Codex, whichever you have, and the `crew` command, all running on the app's own Node. Its Overview lists anything else Crew needs. Open a new Claude Code or Codex session afterwards; Codex also needs the steps in [Leading from Codex](#leading-from-codex). The app updates the plugin with itself and leaves a plugin installed from a source checkout alone.

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

`install` registers this folder as a Claude Code marketplace and installs the `crew` plugin. With Codex installed, it does the same for Codex. It also links `crew` into `~/.local/bin` (on Windows, `crew.cmd` for cmd and PowerShell, a `crew` script for Git Bash, and `crew.mjs`). Open a new Claude Code or Codex session afterwards. Codex keeps its own copy of the plugin, so run `install` again after changing it.

## Usage

Inside a Claude Code or Codex session (in Codex, skills start with `$`: `$crew:run`, `$crew:debate`, `$crew:review`, `$crew:board`):

| Input | What happens |
| --- | --- |
| `/crew:run <task>` | Runs planning, parallel implementation, a review (self or cross; both for security, concurrency, or data loss), fixes, wording polish, and final verification in order |
| `/crew:debate <decision>` | Debates a hard or important decision with the debate role holder over a few read-only rounds that end with a conclusion |
| `/crew:review [target]` | Runs a self-review and a cross-review of a change in parallel, then fixes what holds up |
| `/crew:board` | Opens the status board (inside the browser pane in Claude Desktop) |
| Natural prompts like "Have Codex build this part" or "Get a Codex review on this" | The lead calls `delegate`, `review`, or `polish` directly |

### Leading from Codex

A Codex session leads the same way, with a few differences:

- **Trust the hooks.** Crew adds its hooks to your Codex hooks file (`~/.codex/hooks.json`), and Codex runs them only after you trust them. Select **Trust Hooks** in the app's Overview, or open `/hooks` in a Codex session and press `t`, then start a new session. They stay trusted through Crew updates; only a change to a hook's own definition asks again. They run only while Crew's plugin is on in Codex. Without them the lead still works, but it misses the shared instructions and the news at the start and end of its turns, and the board does not show the session.
- **Allow the Crew tools.** The first Crew call that starts or changes work may ask for approval. Choose "Always allow" so later calls do not stop to ask.
- **Waking.** When a job finishes, Crew queues a short note in the lead's thread ("Crew has news for …"), and an idle Codex session runs it as its next turn. If the session's last turn was interrupted, Codex holds the note until you type again; the news is then shown on that prompt.
- **Whose roles the lead does itself.** A role held by the lead's own agent is the lead's own work, in its session, a subagent or a session it starts; every other holder runs as a worker. So under a Codex lead, a role held by Codex is the lead's, and a role held by Claude goes to a Claude Code worker, which edits only inside the job's folder. A writable job runs in Claude Code's automatic mode, which decides most commands itself and sends what it refuses back to the lead; a read-only job asks you before any command that is not read-only.
- **Updating Codex.** If `codex` hangs at "Updating the local background server…" on Windows, run `codex app-server daemon stop`, then `codex app-server daemon update`.

How this works is in [docs/delivery.md](docs/delivery.md#codex-leads).

### From a terminal

```bash
crew status
```

```bash
crew board
```

When something hangs, `crew doctor` checks prerequisites, `crew daemon logs` shows the daemon log, and `crew daemon restart` restarts it. `crew show <job>` reads one job, `crew cancel <job>` stops it, and `crew export <mission>` prints a mission as a Markdown runbook.

`crew gc` previews orphan worktrees, Git metadata, and unused worker branches with their merge status against `HEAD`. `crew gc --apply` removes orphan directories and prunes metadata; add `--branches` to delete branches merged into `HEAD`. Unmerged branches stay, with a `git branch -D <name>` command for manual removal. Active and owned worktrees are protected, and Windows cleanup failures name leftovers in job status and notes.

The status board runs at http://127.0.0.1:47615, or on a fallback port in `~/.crew/daemon.json` when the system reserves that one. Open it with `crew board` or from the app to sign in; a browser tab holds a scoped credential in memory (valid up to 7 days, cleared on close or reload). Direct clients send the secret in `~/.crew/token` ([docs/daemon-api.md](docs/daemon-api.md)).

Each `/crew:run` command appears as a mission with its jobs grouped under it, and the Needs You view lists every job and session waiting on you. Click a job to read its report, changed files, evidence, and activity, or to send a follow-up.

Board Settings edits roles, the global preset, and shared instructions, and shows each model's score out of 10 from the lead's review notes and peer ratings. Roles cover implementation, refactoring, release preparation, debate, cross-review, review that runs the app, fixing review findings, and wording; unset roles follow their parent. A role can have several holders, including Claude, and the lead picks one per job.

A mission can use its own preset when you name one in the command ("economy" for a simple task, "best" for a deep one) or pick one from the mission's menu.

A command given while another is under way opens beside it, and both stay open until each finishes. A mission stores the tasks the lead split the work into, so a resumed or compacted session carries on from that record. When the lead links a pull request to a mission, Crew polls it with your GitHub CLI (`gh`) while the session is open and wakes the lead only for a newly failed check, review feedback, a merge conflict, or checks passing after a reported failure. The lead decides the fix and hands it to an agent; merging stays yours.

If [AgentGauge](https://github.com/ghostface2232/AgentGauge) is installed, each agent's card shows remaining usage and `/crew:run` routes work accordingly. When an agent runs low, the lead takes over or defers the work and says so.

Job turns appear as rounds that can be undone or kept one by one. New Job also accepts a read-only question or a piece of information to pin ([docs/jobs.md](docs/jobs.md), [docs/board.md](docs/board.md)).

When a worker asks for approval or has a question, an input dialog pops up in the Claude app; you can also answer on the status board or in the desktop app. A computer-use request about one app or a simple Antigravity command can be allowed for the rest of its job so the worker stops asking on every call. Codex's built-in automatic reviewer answers approval requests first; you are asked only about what it refuses twice ([docs/approvals.md](docs/approvals.md)).

## Desktop app

```bash
npm run desktop
```

On macOS, this builds and opens the native SwiftUI app; on Windows, it builds and opens the Electron app around the web board. `npm run package:desktop` writes `release/Crew.app` (plus `.zip` and `.dmg` artifacts) on macOS (requires Xcode 27+ and a standalone Node.js distribution) or the per-user installer `release/Crew-Setup-<version>.exe` and unpacked app `release/win-unpacked/Crew.exe` on Windows. Both apps run the existing TypeScript daemon without a separate Node install.

Closing the window hides it to the tray; quitting the app leaves jobs running. Both restore their window, and the macOS app opens approval notifications at the relevant job. The web board stays available.

The board can start jobs directly for any role except debate, using the configured roles; full missions begin in a lead session. See the [native macOS](docs/macos-app.md) and [Windows](docs/windows-app.md) notes for development, tests, resource measurements, and distribution limits.

## How it works

- Each implementation or polish job runs in an isolated git worktree under `~/.crew/worktrees/` on branch `crew-<job id>`. Nothing touches your working branch until the lead inspects the diff and merges it.
- Gitignored files needed for tests (such as `node_modules` or `.env`) are copied into the worktree (or cloned/linked read-only for directories) when listed in `.worktreeinclude` at the repository root. It uses `.gitignore` syntax and shares Claude Code's native worktree file.
- Codex runs via `codex app-server` and Antigravity runs via `agy acp`. Crew executes only the official binaries and never reads authentication files or tokens.
- When a background job finishes, asks the lead a question, or needs a decision, the lead session wakes automatically.
- Agents share the machine without colliding ([docs/sandbox.md](docs/sandbox.md)):
  - Each starts an isolated instance of any service it runs.
  - Only one reviewer of a change launches the app.
  - A worker that runs the app gets network access and its own snapshot of the change.
  - Performance-measuring jobs run alone.
- Shared instructions live in `~/.crew/instructions.md` (all projects) and `.crew/instructions.md` at the repository root (that project). Workers receive them with each job and lead sessions receive them at start; no service's own instruction files are touched.
- Configuration lives in `~/.crew/config.json` (stall timeout, notifications, Codex approval policy and automatic reviewer, plugins, whether Antigravity is enabled, presets, role holders, and whether agents rate each other's work for model scores).

Antigravity is enabled by default and carries a Terms of Service risk: read [docs/architecture.md](docs/architecture.md#antigravity-policy-risk), and set `antigravity.enabled` to `false` in `~/.crew/config.json` to turn it off.

## Directory layout

| Path | Contents |
| --- | --- |
| `plugin/bridge/` | Daemon, MCP server, worker MCP server, agent adapters, CLI (TypeScript, no build step) |
| `plugin/board/` | React + TypeScript board, shared CSS tokens, and Vite output |
| `native/`, `desktop/`, `scripts/` | SwiftUI/AppKit macOS app, Electron Windows app, build/packaging, and desktop verification |
| `plugin/roles/` | Role instructions (engineer, reviewer, editor, debater, question, shared-machine rules, and additions for refactoring, release preparation, and fixing) injected per job |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | `/crew:run`, `/crew:debate`, `/crew:review`, `/crew:board`, self-reviewer subagent, hooks |
| `test/` | Unit tests (`npm test`) and Playwright regressions (`npm run test:e2e`) |

## Documentation

[AGENTS.md](AGENTS.md) maps the repository and says which file in [docs/](docs/) covers each topic: requirements, architecture, jobs, missions, roles, usage and presets, the daemon API, the board, each desktop app, distribution, and the roadmap. Earlier plans and surveys are in [research/](research/).

## Current status

Version 0.9.1 with desktop apps for macOS and Windows. Usage-based routing works when AgentGauge is installed. Planned work is in [docs/roadmap.md](docs/roadmap.md); the surveys behind it are in [research/](research/).
