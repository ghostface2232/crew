# Crew

A Claude Code plugin that divides roles across Claude, Codex, and Antigravity so they collaborate as a three-agent crew. Claude acts as the lead and self-reviewer, Codex handles supporting implementation and cross-review, and Antigravity polishes UX copy, comments, and documentation. A live status board shows what all three agents are doing in real time.

## Getting started

Requirements: Node.js 22.18+, git, and authenticated `claude`, `codex`, and `agy` CLIs.

```bash
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

The status board runs at http://127.0.0.1:47615.

When a worker asks for approval or has a question, an input dialog pops up in the Claude app. You can also answer using the approve/deny buttons on the status board. If you have configured Codex's built-in auto-reviewer, Codex handles its own approvals internally without prompting ([docs/04-implementation.md](docs/04-implementation.md) section 5.1).

## How it works

- Each implementation or polish job runs in its own isolated git worktree (under `~/.crew/worktrees/`) on a `crew-<job id>` branch. Nothing touches your working branch until the lead inspects the diff and merges it.
- Gitignored files that workers need to run tests (such as `node_modules` or `.env`) are copied into the worktree when listed in `.worktreeinclude` at the repository root. It uses `.gitignore` syntax and shares the same file as Claude Code's native worktrees.
- Codex runs via `codex app-server` and Antigravity runs via `agy acp`. Crew executes only the official binaries and never reads authentication files or tokens.
- When a background job finishes or needs a decision, the lead session wakes up automatically.
- Configuration lives in `~/.crew/config.json` (stall timeout, notifications, Codex approval policy, and whether Antigravity is enabled).

Using Antigravity carries a Terms of Service risk; read [docs/04-implementation.md](docs/04-implementation.md) section 6 before enabling it.

## Directory layout

| Path | Contents |
| --- | --- |
| `plugin/bridge/` | Daemon, MCP server, agent adapters, CLI (TypeScript, no build step) |
| `plugin/board/` | Status board (static HTML/CSS/JS) |
| `plugin/roles/` | Role instructions injected into Codex and Antigravity on every job |
| `plugin/skills/`, `plugin/agents/`, `plugin/hooks/` | `/crew:run`, `/crew:board`, self-reviewer subagent, hooks |
| `test/` | Unit tests (`npm test`) |

## Documentation

| Document | Contents |
| --- | --- |
| [docs/01-requirements.md](docs/01-requirements.md) | Original requirements, numbered requirements (R1–R8), tensions and interpretations, acceptance criteria |
| [docs/02-implementation-plan.md](docs/02-implementation-plan.md) | Architecture decisions, connection methods, roles and workflow, status display, rejected alternatives, risks, build phases |
| [docs/03-agentgauge-integration.md](docs/03-agentgauge-integration.md) | Current state of AgentGauge, integration gaps, phased integration plan, MCP tool spec, routing policy |
| [docs/04-implementation.md](docs/04-implementation.md) | Implemented architecture, changes from the plan and why, desktop app visibility findings, verification log |
| [docs/05-related-work.md](docs/05-related-work.md) | Survey of related projects, adoption candidates vs. current code, UX gaps |
| [docs/06-roadmap.md](docs/06-roadmap.md) | Near-term rework, long-term expansion, control UI concept, open items |

## Current status

The bridge (Phase 1) and status board (Phase 2) are implemented. AgentGauge integration (Phase 3) is not yet implemented.

## Updating the documentation

- Attach a verification date to facts about external tools. Because protocols and policies across all three services have shifted every few months, re-verify the sources at the end of document 02 before building.
- When reversing a recorded decision, do not delete it—append the reason and date to that document's revision log.
