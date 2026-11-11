# 02. Implementation Plan

Written 2026-11-11. Requirement IDs (R1–R8) follow [01-requirements.md](01-requirements.md). All facts about external tools were verified on 2026-11-11; sources are listed in section 12.

## 1. Summary of decisions

1. The cockpit is Claude Code Desktop. The lead session runs as an interactive Desktop session.
2. Codex and Antigravity run in the background through their official runtimes: `codex app-server` for Codex, and `agy acp` or `agy -p` for Antigravity.
3. Calls and events for both workers flow through a single Crew bridge (a local MCP server). This matches Anthropic's guidance for parallel work in Claude Code, where native workers are Claude sessions and external tools attach as MCP servers.
4. Session status is shown on a lightweight status board fed by the bridge. Usage measurement and routing decisions belong to AgentGauge ([03-agentgauge-integration.md](03-agentgauge-integration.md)).
5. We do not build a custom wrapper around the entire frontend (section 8).

## 2. Architecture

```
User
  │
Claude Code Desktop ── Lead, self-review (interactive session)
  │ MCP
Crew Bridge ───── events ────▶ Status Board (three lanes)
  │   ▲
  │   └──── usage, routing decision ── AgentGauge (doc 03)
  │
  ├─ codex app-server ── Codex: supporting implementation, review
  └─ agy acp / agy -p ── Antigravity: UX copy, comment & doc cleanup
```

## 3. How each component connects

### 3.1 Claude (lead)

- Runs directly as a local session in Claude Code Desktop. Subagents, inter-session messaging, Remote Control, computer use, the browser pane, Claude in Chrome, side chat (`/btw`), MCP, and compaction all work natively in this session.
- Self-review is delegated to a dedicated review subagent that does not share the working conversation context. Rereading one's own diff inside the same context does not count as review.
- Background sessions are launched with `claude --bg` and inspected via `claude agents --json`. Files under `$HOME/.claude/jobs/` are documented as an unstable internal interface and are not read directly.

### 3.2 Codex (supporting engineer, reviewer)

- Phase 0 uses OpenAI's official plugin, `openai/codex-plugin-cc`.

  | Command | Purpose |
  | --- | --- |
  | `/codex:rescue` | Delegate an implementation slice. Supports `--background`, `--resume`, `--model`, `--effort` |
  | `/codex:adversarial-review` | Review that challenges design decisions and assumptions; accepts a focus prompt |
  | `/codex:review` | Read-only review of uncommitted changes or a branch (`--base`) |
  | `/codex:status`, `/codex:result`, `/codex:cancel` | Manage background jobs |
  | `/codex:transfer` | Hand the current Claude session over to a Codex thread and print `codex resume <id>` |

- The plugin wraps the global `codex` binary and `app-server`, honoring `$HOME/.codex/config.toml` and the project's `.codex/config.toml`.
- The review gate (automatic Stop-hook review) is kept off. The plugin README warns that Claude and Codex can loop and burn through quota quickly. The lead invokes reviews explicitly at each stage.
- Starting in Phase 1, the bridge drives `codex app-server` directly. `app-server` is a bidirectional JSON-RPC 2.0 process that owns thread state, streams agent events, and exchanges approval requests. `codex mcp-server` was deprecated on 2026-08-24 and is listed as removed in the current CLI reference, so it is not used.

### 3.3 Antigravity (UX copy, comment and doc cleanup)

- One-shot tasks run via `agy -p "<instruction>" --output-format stream-json`, which logs all tool calls in streaming JSON.
- Multi-turn sessions use `agy acp` (the official stdio ACP server added in CLI 1.5.0). In ACP mode, agents, tools, and settings match the CLI.
- Role restrictions are enforced through a custom agent passed to `--agent` and through `--mode`. Authentication reuses the cached credentials from a prior interactive `agy` login.
- MCP servers are registered in `.agents/mcp_config.json` or `$HOME/.gemini/config/mcp_config.json`.

### 3.4 Crew bridge

A single local MCP server. It starts with five tools for the lead:

| Tool | Behavior |
| --- | --- |
| `delegate` | Hand an implementation slice to Codex along with a worktree path and completion criteria |
| `review` | Hand a review to Codex along with the target diff and review focus |
| `polish` | Hand copy, comment, and doc cleanup to Antigravity along with the list of target files |
| `status` | Return the status of active delegations |
| `cancel` | Cancel a delegation |

- The bridge holds the `app-server` process and `agy` session, writes every received event to a local event log (JSONL or SQLite), and broadcasts events over WebSocket.
- Proposed event shape: `{ts, agent, session_id, kind, detail}`, where `kind` is `started`, `progress`, `waiting`, `error`, `limit`, or `done`.
- The bridge only executes the official `codex` and `agy` binaries. It never reads either service's authentication files or tokens.

## 4. Roles and workflow

| Agent | Owns | Does not own |
| --- | --- | --- |
| Claude | Planning, core implementation, self-review, merge decisions, routing calls | |
| Codex | Separable implementation slices (in isolated worktrees), post-implementation adversarial review | Merging, changing the plan |
| Antigravity | Readability cleanup for UI strings, comments, and documentation files | Logic changes, structural changes |

Workflow:

1. Plan (Claude)
2. Implement (Claude and Codex in parallel, one isolated worktree per slice)
3. Self-review (Claude's dedicated review subagent)
4. Cross-review (Codex adversarial review)
5. Fix (Claude)
6. Polish copy, comments, and docs (Antigravity, submitted as a diff from a separate worktree)
7. Final check and merge (Claude). If Antigravity's diff steps outside its scope, the lead rejects it.

Where role rules live:

- `CLAUDE.md`: workflow order, rule to call `route` at stage boundaries, rejection criteria
- `AGENTS.md`: Codex's role, prohibitions, and report format
- Antigravity custom agent definition: allowed file types and prohibitions

## 5. Status display and stall detection (R5)

Data sources:

| Agent | Source | What it provides |
| --- | --- | --- |
| Claude | `claude agents --json` | Per-session `state` (`working`, `blocked`, `done`, `failed`, `stopped`), `status` (`busy`, `waiting`, `idle`), `waitingFor` |
| Claude | Notification hook | `agent_needs_input`, `agent_completed` |
| Codex | `app-server` event stream | Thread state, tool calls, approval requests |
| Antigravity | Streaming JSON or ACP session updates | Tool calls, message chunks |

Stall and limit detection rules:

- Agent view exposes six states—Working, Needs input, Idle, Completed, Failed, Stopped—with no dedicated usage-limit state. Because quota exhaustion surfaces as Failed or silence, the bridge classifies error messages and emits a `limit` event.
- If no event arrives for a set duration (initially 5 minutes, configurable), the bridge marks the job as suspected stalled and sends a notification.
- Measured quota numbers come from AgentGauge (document 03).

Status board:

- Three lanes showing the current stage, last event, wait reason, and elapsed time. Controls are limited to cancel and resume.
- First choice is a Tauri v2 + React tray app (the same stack as Noten), though starting with a local web page is fine.
- It is not merged into the AgentGauge popover (document 03 section 10).

## 6. Desktop app visibility (R6)

| Service | Status |
| --- | --- |
| Claude | Visible natively because the lead is a Desktop session. With Remote Control enabled, it also appears in the mobile app and at claude.ai/code (Remote Control support for Desktop sessions was confirmed by a maintainer comment on 2026-08-17) |
| Codex | Jobs run by the plugin can be resumed with `codex resume`. Visibility in the ChatGPT desktop app is unreliable: open issues report CLI-created sessions appearing only after an app restart (`openai/codex#56089`) or mixing into the ChatGPT list instead of Codex (`#33910`) |
| Antigravity | Conversations started in the terminal open in the Antigravity 2.0 app (per secondary sources). Whether sessions created via `agy acp` behave the same way is unverified |

## 7. Feature coverage (R4)

- Lead: All features listed in R4, because it runs as a Desktop session.
- Codex: Configured MCP servers, subagents, and compaction work as-is under `app-server`.
- Antigravity: CLI-configured tools and MCP servers work as-is. Remote Control (released 2026-08-21) lets a CLI session open in a browser on another device.
- Limitation: Worker-side desktop-only features, such as the Antigravity app's built-in browser, are unavailable during background runs.
- Unverified: The current state of any Codex equivalent to Remote Control was not investigated.

## 8. Rejected alternatives

### 8.1 Custom wrapper around the entire frontend

A Tauri app talking directly to the Claude Agent SDK, Codex `app-server`, and `agy acp`. It would receive the most uniform event streams across all three agents, but was rejected for these reasons:

- Side chat, computer use, and the built-in browser pane are Claude Desktop app features and do not exist in SDK sessions, sacrificing R4.
- The protocols change frequently: `codex mcp-server` has already been removed, and `app-server` is marked experimental in the CLI reference.
- Separating Agent SDK and `claude -p` billing from subscription plans was announced for 2026-06-15 and then put on hold. Plan logins currently draw from subscription quota, but that policy could change again. Keeping the lead as an interactive session avoids the risk.
- Google banned users who connected third-party agents in February 2026. Once a custom wrapper touches authentication, it enters the same risk zone.

### 8.2 Existing multi-agent workbenches (Orca and others)

Orca (`stablyai/orca`) is an MIT-licensed open-source workbench that runs CLI agents in parallel across separate worktrees on the user's own subscriptions and tracks Claude and Codex usage and reset times. Antigravity is also on its supported list. It was excluded as the primary setup because:

- It launches agents in terminal panes, falling short of R1.
- Its orchestration layer is experimental, and a fixed-role pipeline (R3) would still have to be built by hand.
- We found no evidence that its usage tracking covers Antigravity.

Its worktree management and usage display are still useful references. ACP-based clients (Codeg, Jockey, acp-ui, etc.) are kept as references for the same reason.

## 9. Risks and constraints

| Risk | Mitigation |
| --- | --- |
| Protocol churn (`app-server` experimental, ACP version changes) | Isolate per-service adapters inside the bridge; rely only on the official plugin in Phase 0 |
| Billing policy changes | Keep the lead as an interactive session; build no path that depends on `claude -p` or the Agent SDK |
| Account enforcement | Execute only official binaries and never touch auth tokens |
| Quota burn from review loops | Keep the automatic review gate off and cap the number of review rounds |
| Worker makes out-of-scope edits | Isolate worktrees, require diff submission, and have the lead reject violations |
| Re-delegation loops (A delegates to B, B delegates back to A) | Centralize routing decisions in the lead only; workers only report usage |
| An exhausted lead cannot reroute work | Place the watchdog outside the lead (via AgentGauge threshold events) |

## 10. Build phases

| Phase | Scope | Done when |
| --- | --- | --- |
| Phase 0 | Install `codex-plugin-cc`, write the 3 role files, wrap `agy -p` calls in a Claude Code skill, set up worktree rules. Almost no new code | One small feature completes all seven steps of section 4 end to end |
| Phase 1 | Crew bridge MCP server (5 tools) and event log; move Codex and Antigravity calls behind the bridge | The lead delegates, reviews, and polishes using only bridge tools; events from all three agents land in the log |
| Phase 2 | Status board; notifications for suspected stalls and `limit` events | Force-stopping a worker triggers a notification within the configured timeout |
| Phase 3 | AgentGauge integration (G1–G3 in doc 03). G1 requires no changes to AgentGauge and can run in parallel with Phase 1 | The lead delegates according to `route`, and a pre-exhaustion lead handoff is reproduced once |

## 11. Open items

- Target machine: whether to run on the MacBook or the Windows desktop. AgentGauge supports both, so either works.
- Status board form factor: Tauri tray app vs. local web page.
- Bridge implementation language and event store (JSONL vs. SQLite).
- Exact numbers for the stall timeout and maximum review rounds.
- Whether `agy acp` sessions appear in the Antigravity desktop app (needs check).
- Progress on the Codex desktop app visibility issues (needs check).

## 12. Verification sources (2026-11-11)

Official documentation and repositories:

- Claude Code parallel execution overview: https://code.claude.com/docs/en/agents
- Agent view (states, `--bg`, `claude agents --json`, notifications): https://code.claude.com/docs/en/agent-view
- Claude Desktop (side chat, computer use, browser pane, Dispatch): https://code.claude.com/docs/en/desktop
- Remote Control support for Desktop sessions: https://github.com/anthropics/claude-code/issues/29006
- Agent SDK and plan billing: https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
- Codex plugin: https://github.com/openai/codex-plugin-cc
- Codex CLI reference (`app-server`, `exec`, removal of `mcp-server`): https://developers.openai.com/codex/cli/reference
- Codex `app-server`: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- Codex desktop visibility issues: https://github.com/openai/codex/issues/56089 , https://github.com/openai/codex/issues/33910
- Antigravity headless mode: https://antigravity.google/docs/cli/headless/
- Antigravity ACP: https://antigravity.google/docs/ide/extensions/acp/
- Antigravity Remote Control: https://antigravity.google/docs/remote-control/
- Antigravity changelog: https://antigravity.google/docs/changelog/
- Orca: https://github.com/stablyai/orca
- ACP client list: https://agentclientprotocol.com/get-started/clients

Items based only on secondary sources (recheck against primary sources before implementation):

- Deprecation announcement date for `codex mcp-server` (2026-08-24)
- Terminal conversations opening in the Antigravity 2.0 app
- Google's February 2026 ban of third-party agent connections (cited via Wikipedia)
- Scope of Orca's usage tracking and experimental status of its orchestration layer

## 13. Revision log

- 2026-11-11: Changed the following during implementation. Reasons and details are in [04-implementation.md](04-implementation.md) section 3.
  - Dropped `agy -p` from the Antigravity connection. Because the official FAQ states that wrapping `agy -p` inside third-party coding agents is not supported on consumer plans, only ACP (`agy acp`) is used.
  - Skipped Phase 0 (completing a run with the official plugin first) and went straight to Phase 1.
  - Kept role files inside the plugin and injected them per job instead of placing `CLAUDE.md`, `AGENTS.md`, and custom agent files in each project.
  - Replaced WebSocket with SSE for event delivery, and replaced `claude agents --json` polling with hooks for Claude status.
  - Added `wait` and `reply` to the bridge tools.
- 2026-11-11: Proposed and then withdrew merging the status board into the AgentGauge popover. It conflicted with the recorded direction of the AgentGauge repo (depth over breadth, and no scanning of local agent processes). Reverted to keeping the status board on the bridge side.
