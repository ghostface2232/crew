# Roadmap

Written 2026-11-12. Covers the near-term rework and the long-term expansion of Crew, plus the control UI concept. Items are not implemented unless marked. External facts were gathered from vendor documentation on 2026-11-12 unless marked otherwise; items marked "unverified" come from secondary sources or were not checked on this machine.

## 1. Requirements this roadmap answers

The requirements are in [requirements.md](requirements.md). Current status against the code:

| Requirement | Plan item | Status |
| --- | --- | --- |
| R3 (reassignable roles) | A1 | Done (`config.ts`, `settings.ts`, `Settings.tsx`, `SettingsView.swift`) |
| R9 (shared instructions) | A2 | Done (`instructions.ts`, `context.ts`, `prompts.ts`) |
| R11 (model and effort) | A3 | Done (`config.ts`, `tiers.ts`, `codex.ts`, `antigravity.ts`) |
| R10 (command-centered, clickable board) | B1, B2 | Done (`missions.ts`, `plugin/board/src/`, `native/Sources/Crew/`) |
| R8 (AgentGauge) | C1, L3 | Partial — G1 done (`usage.ts`); G2, G3, and L3 open |
| R12 (Cursor) | C2 | Open |
| R14 (no collisions between agents) | — | Done (`prompts.ts`, `jobs.ts`, [sandbox.md](sandbox.md)) |
| R15 (approvals with little user involvement) | — | Done for Codex workers (`config.ts` `auto_review`, `jobs.ts` `retryRefused`) and writable Claude workers (`adapters/claude.ts`, automatic mode) |
| R13 (other leads, own main screen, direct dispatch) | L1, L2 | Partial — board, desktop apps, direct jobs (`Dispatch.tsx`, `DispatchView.swift`), and Codex as a lead done; mission start and merge execution open |

Near-term work targets Claude Desktop lead mode, as [requirements.md](requirements.md#3-defaults-and-priorities) sets out.

## 2. The one constraint behind most of it

Role selection has moved into configuration (`ROLES` eight-role registry with inheritance in `plugin/bridge/config.ts`, `resolveRole` in `jobs.ts`). `WorkerAgent` is still `'codex' | 'antigravity'` (`config.ts`), `config.codex` and `config.antigravity` remain separate blocks, and `LEAD` is still `'claude'`. Adding Cursor (C2) and supporting other leads (L1) still require lifting those remaining assumptions.

## 3. Control UI concept

The board is organized around missions, needs-you requests, activity, and history (`plugin/board/src/`, `native/Sources/Crew/`):

| Element | Behavior | Status |
| --- | --- | --- |
| Mission | One user command is one card (`MissionPanel`) showing assigned jobs under stages, progress, and outcome (`Job.mission`, `Job.missionStep`). | Done |
| Needs you | Dedicated `Needs You` view and attention banner (`NeedsYou.tsx`, `BoardView.swift`) answering approvals and questions in place; merge execution stays with the lead. | Done (merge execution open) |
| Strand drawer | Clicking a job opens `JobDrawer.tsx` / `JobDetailView.swift` with report, changed/out-of-scope files, check receipts, events, and follow-up input. | Done |
| Command bar | `Dispatch.tsx` / `DispatchView.swift` (`New Job`) sends a command, question, or information note without a lead (`POST /api/jobs`); inline `@codex` syntax and lead mission start remain open. | Partial |
| Usage gauges | Per-agent usage windows and status in `Overview.tsx` and `BoardView.swift`; New Job disables only agents whose configuration has `enabled: false`. The command bar does not suggest an alternative when an agent is tight. | Partial |
| Progress roll-up | A mission's stage track shows how far it has come (`Missions.tsx`, `BoardView.swift`); the separate progress ring was removed on 2026-11-22 ([missions.md](missions.md#history)). | Done |
| Intent | `New Job` distinguishes information (global/project instructions or mission note), read-only question (`ask: true`), and command. | Done |
| Scoped follow-up | `JobDrawer` / `JobDetailView` send follow-ups via `POST /api/jobs/:id/reply`, joining the running turn of either agent ([jobs.md](jobs.md#follow-ups-and-sync)); Antigravity refuses one while a request waits. | Done |
| Rounds | Per-turn commits on job branches (`jobs.ts` `rounds` / `round()`), Keep/Undo buttons, and `roundsNotice` on the worker's next turn. | Done |

Borrowed ideas:

- Midmap: a board that the user and the agents both read and write, progress that rolls up from child to parent, the information / question / command split, notes left on a node for the agent's next turn, and keep or undo per round of changes.

- Linear for Agents: a human owner plus an agent delegate on each item, notification only when input is needed, and session states that include `awaitingInput` and `stale`.
- Conductor: the diff and the checks in one panel next to the conversation.
- Emdash: model and effort remembered per agent.

## 4. Near-term plan

Recommended order is A, then B, then C. Without A, both Cursor support and role reassignment turn into added branches.

### A. Foundation

**A1. Agent registry and role table. *(Done)*** Implemented in [config.ts](../plugin/bridge/config.ts), `settings.ts`, [mcp.ts](../plugin/bridge/mcp.ts), and `plugin/roles/` ([roles.md](roles.md)). `ROLES` holds eight configurable roles with inheritance (`delegate`, `refactor`, `release`, `debate`, `review`, `verify`, `fix`, `polish`), defaulting to the R3 agents with `fix` defaulting to Claude. Antigravity defaults to `polish` and automatic routing never moves engineering or review work to it ([requirements.md](requirements.md#3-defaults-and-priorities)).

**A2. Shared instructions. *(Done)*** Implemented in `instructions.ts`, [prompts.ts](../plugin/bridge/prompts.ts), `context.ts`, and [hooks.json](../plugin/hooks/hooks.json) ([roles.md](roles.md)). Reads `~/.crew/instructions.md` and `.crew/instructions.md` without writing to any service's own instruction files:

| Agent | Channel |
| --- | --- |
| Codex | `developerInstructions`, where the role text already goes |
| Antigravity | `_meta.antigravity.systemPrompt.append` (or prompt prefix fallback) |
| Cursor (planned) | Prompt prefix |
| Claude (lead) | `SessionStart` and `SubagentStart` hook context (`context.ts`) |

**A3. Model and effort. *(Done)*** Implemented in `config.ts`, `tiers.ts`, `codex.ts`, and `antigravity.ts` ([usage-and-presets.md](usage-and-presets.md)). Codex accepts `model` and `effort`; Antigravity maps `effort` to `thought_level` (`tiers.ts`). Role settings override presets (`economy`, `balanced`, `best`), and presets guide lead subagent models.

### B. Board to control screen

**B1. Decision support. *(Done)*** Implemented in `plugin/board/src/` and `native/Sources/Crew/` ([board.md](board.md)). Includes the job drawer, free-text question composer, per-job event list, pending count in the tab title and menu bar, project sidebar filter, and settings panes for roles, presets, peer ratings, model scores, and shared instructions. (See [related-work.md](../research/related-work.md) section 9 for the remaining minor items.)

**B2. Missions. *(Done)*** Implemented in `missions.ts`, `jobs.ts`, `pulls.ts`, `mcp.ts`, [run/SKILL.md](../plugin/skills/run/SKILL.md), `plugin/board/src/`, and `native/Sources/Crew/` ([missions.md](missions.md), [usage-and-presets.md](usage-and-presets.md)). Jobs record `mission`, `missionStep`, `taskId`, and per-turn `rounds`; missions track `stages`, named stop `labels`, `tasks`, `notes`, `record`, and watched `pr` links.

### C. New connections

**C1. AgentGauge. *(Partial: G1 done; G2 and G3 open)*** G1 is implemented inside the Crew daemon (`usage.ts`, `daemon.ts`, `mcp.ts`) rather than as a separate MCP server, reading AgentGauge's macOS (v1) and Windows (v4) caches, `usage-history.db`, and live Codex limits ([usage-and-presets.md](usage-and-presets.md)). G2 (`--json` output in AgentGauge) and G3 (threshold hooks and consumer activity signals) remain open ([agentgauge-integration.md](../research/agentgauge-integration.md)).

**C2. Cursor adapter. *(Open)*** Drive the Cursor CLI in headless mode (`agent -p --output-format stream-json`). Headless mode has no per-action approval: without `--force` it only proposes edits. Start Cursor in a read-only review role, or in a worktree with an allow list, until approvals can be routed to the user as they are for Codex. Open checks before building:

- CLI flags and the hidden `acp` command are from web documentation, not confirmed on this machine.
- Whether effort is encoded in the model id is unverified.
- Whether the terms allow a third-party client to run the CLI, as was checked for Antigravity in [architecture.md](architecture.md#antigravity-policy-risk).

### D. Learning from reviews

**D1. Model notes. *(Done)*** Implemented in `notes.ts`, `mcp.ts` (`note`, `note_summary`), `daemon.ts` (`/api/notes`), `Settings.tsx` (`Scores.tsx`), and `SettingsView.swift` ([roles.md](roles.md)). Stored as JSON (`~/.crew/model-notes.json`, version 2) so each model is scored out of 10 from accepted finding rate over change size (`build`), fix quality (`fix`), and review acceptance (`review`). Status (`too few samples`, `on trial`, `settled`) is derived from weighted build reviews (`< 3`, `< 8`, `>= 8`). `route` and the first `delegate` attach recent summaries and evidence (`withNotes` in `mcp.ts`); `note_summary` rewrites summaries after 10 new lines (`CONSOLIDATE_AFTER`). Role assignments and presets stay the user's.

**D2. Fix role. *(Done)*** Implemented as `fix` in `config.ts` (defaulting to Claude), `plugin/roles/fix.md`, `delegate` (`role: "fix"`) in `mcp.ts`, and `route` in `usage.ts`. A worker's own change still goes back via `reply`; `fix` handles the lead's code or merged results in a fresh worktree, keeping build and fix evidence separate in `notes.ts`.

**D3. Peer ratings. *(Done)*** Implemented in `notes.ts`, `worker-mcp.ts` (`rate`), `daemon.ts` (`/api/jobs/:id/rating`, `/api/peer-ratings`), and `config.ts` (`peerRatings`, on by default) ([roles.md](roles.md)). The switch is available because rating adds usage. Ratings require a `fact` and count for half (`PEER_SHARE = 0.5`) beside evidence once at least `MIN_RATINGS = 3` exist.

### E. From the game retrospective

From a game project retrospective (58 jobs, ~110 hours, 1.5B tokens). Project-specific flags belong in `.crew/instructions.md`; general rules and features are below.

**Done** (`SKILL.md`, `mcp.ts`, `engineer.md`, `prompts.ts`, `codex.ts`, `missions.ts`, `JobDrawer.tsx`, `JobDetailView.swift`):

- **Sample before the set**: build and approve one sample first for taste-judged work across many like items, using named stages (`SKILL.md`).
- **Briefs & Judging**: pass exact words and reference attachments, limit verification scope, restate whole briefs from the second correction on, and compare evidence side by side instead of asking workers to self-rate (`SKILL.md`, `engineer.md`).
- **Evidence & Environment**: keep only final-state captures in evidence; report missing tools or workarounds immediately so the lead adds them to `.crew/instructions.md` (`prompts.ts`, `engineer.md`, `SKILL.md`).
- **Worker tools**: Codex notes when `crew` MCP tools fail to start (`codex.ts` `noteToolFailure`); workers put questions in `Open points` if tools are absent (`prompts.ts`).
- **Named stops (E3)**: stage names with `:` labels appear on the board and native app (`missions.ts`, `SKILL.md`).
- **Evidence side by side (E4)**: a capture opens alone in a viewer, and Compare shows up to four captures side by side with turn labels (`JobDrawer.tsx`, `JobDetailView.swift`).
- **Crew cannot start a job**: retry once, then report and take over (`SKILL.md`, `mcp.ts`).

**Open**, each needing a decision first:

- **E1. A browser with a GPU on Windows. *(Open)*** `crew.browser` (`browser.ts`) runs only on macOS (`process.platform !== 'darwin'` throws). On Windows a worker starts Chromium inside Codex's sandbox, where GPU crashes, software fallback, and a headless shell showing an error window on the user's screen were reported. The cause was not investigated. Running Chromium from the daemon would give it GPU access, but Windows has no `sandbox-exec` to enforce the job's file limits. Needs that tradeoff settled and a Windows machine to verify.
- **E2. A budget per job. *(Open)*** Tokens and elapsed time show when a job ends (`render.ts`, board, native app), with no live budget cap that wakes the lead mid-run. Open: defaults and whether waking the lead is worth its tokens.

**Not taken:** retrying `thread/start`, blocking software rendering globally (projects needing GPU set it in `.crew/instructions.md`), and asset-hash/camera metadata on captures (turns already commit on the job branch). `thread/start` timed out because Codex granted an ACL to the system temp folder, which is now excluded from writable paths. `THREAD_TIMEOUT_MS = 180_000` separately allows for slow ACL passes. A retry would have waited three more minutes and failed the same way.

## 5. Long-term plan

**L1. The lead as an adapter. *(Done for Codex leads)*** Only three parts are tied to Claude Code: the MCP server, the hooks, and the skills. Jobs, events, and the board belong to the daemon. Defining the lead as the role that plans and decides merges lets Codex or a headless Claude take it, and resolves the temporary-lead handoff in [agentgauge-integration.md](../research/agentgauge-integration.md) section 8.2.

Groundwork done: worker roles are a configurable registry (`config.ts`) and routing names the lead via `LEAD` (`'claude'`) instead of hardcoding Claude everywhere. No setting chooses the lead yet. What another lead needs, in order:

1. Lead identity per connected session (`CLAUDE_CODE_SESSION_ID` today), not a global setting, so leads of different kinds can run at once.
2. Driving the MCP server from another client with the session id passed in.
3. Waking the lead when a job ends or needs it, and recording the user's recent prompts (which `approved_by_user` forwards alongside the lead's quote for the worker's automatic reviewer to judge, `jobs.ts`).
4. Relaying approvals and questions to the user through that client.
5. A Claude worker adapter, needed once Claude holds a worker role under another lead.

Decided 2026-11-24: one plugin serves both hosts, and the host that starts a conversation leads it, so a Codex session leads its own jobs while a Claude session leads its own. The 2026-11-24 host checks ([mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)) settle items 1 to 3 for Codex: a tool call names its thread in `_meta`, hooks receive the same id, and `codex queue` wakes an idle interactive session. The Claude plugin layout loads in Codex with two changes: hooks must be string commands, and the MCP server cannot rely on `${CLAUDE_PLUGIN_ROOT}`.

Done 2026-11-24 (`mcp.ts`, `codex-lead.ts`, `delivery.ts`, `usage.ts`, `plugin/.codex-plugin/`, `plugin/hooks/codex.json`): items 1 to 3 for Codex, registered by `crew install` or the desktop apps ([architecture.md](architecture.md#bridge-and-state), [delivery.md](delivery.md#codex-leads)). Codex's hooks also report the session to the board and record the user's prompts for `approved_by_user` (`report.ts codex`), and the lead's own work is noted as Codex's.

Item 4 is done (2026-11-25): the board shows a Codex lead waiting on an approval, and Codex forwards a Crew tool call's elicitation to its app-server client unless the approval policy is `never` (2026-11-25, [mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)). The TUI (macOS) and the desktop app (Windows) draw it as their own prompt. A declined prompt goes back to the lead to ask in chat.

Item 5 is done (`adapters/claude.ts`, 2026-11-24): under a Codex lead, a job in a role Claude holds starts a Claude Code worker, and a role Codex holds is the lead's own work (2026-11-25; [sandbox.md](sandbox.md#role-permissions), [approvals.md](approvals.md#claude-worker-approvals)). The design was debated with Codex (`cx-387950`). A writable job's permissions run in Claude Code's automatic mode, as Codex workers run with Codex's automatic reviewer (a read-only job stays manual), and a refused action comes back to the lead to retry with the user's approval ([approvals](approvals.md#claude-worker-approvals)). Usage-limit results (`api_error_status` 429, a `rate_limit_event` whose status is `rejected`) follow the CLI's own schema, read from Claude Code 2.1.328, but have not been seen at a real limit. A Codex lead's report hooks and a Claude worker ran end to end on macOS with Codex 0.172 ([mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)). A Claude worker under a Claude lead stays out of scope.

**L2. Own main screen. *(Partial)*** React board (`plugin/board/src/`), role-based direct dispatch (`Dispatch.tsx`, `DispatchView.swift`), native macOS SwiftUI/AppKit app (`native/`), and Windows Electron shell (`desktop/`) are done ([board.md](board.md), [macos-app.md](macos-app.md)). Closing the UI leaves the daemon and jobs running, and the web board stays available. Mission start with a lead, lead selection, and merge execution remain open.

**L2a. Distribution. *(Done)*** Implemented via `.github/workflows/release.yml`, `native/Sources/Crew/Updater.swift`, `desktop/updater.ts`, `plugin/bridge/setup.ts`, `Overview.tsx` (`Setup`), and `BoardView.swift` (`SetupCard`): builds and publishes the macOS `.dmg`/`.zip` and Windows installer, self-updates from GitHub Releases, installs/updates the Claude Code plugin on the bundled Node runtime, and shows a setup checklist ([distribution.md](distribution.md)).

**L3. Usage-based routing. *(Open)*** With AgentGauge G3 (threshold hooks), trigger lead handoff before the lead's limit runs out.

**L3a. Claude usage display. *(Open)*** Forward `rate_limits` from Claude Code's statusline to the daemon as a supplement to AgentGauge ([agentgauge-integration.md](../research/agentgauge-integration.md) section 9).

**L4. More entry points. *(Open)*** Start missions from GitHub or Linear issues; a read-only mobile view. (Linked PR tracking in `pulls.ts` watches existing PRs rather than starting missions from issues.)

**L5. Board UI foundation and design system. *(Done)*** Implemented in `plugin/board/src/` with React 19, TypeScript, Vite, shared CSS tokens, `Settings.module.css`, Fluent icons, and Playwright e2e tests; Radix, Motion, and Storybook were deferred because native HTML elements and CSS transitions cover the scope ([board.md](board.md)).

### Cost of L1 and L2

Requirements R4 and R6 (computer use, side chat, visibility in the desktop app) hold only while the lead runs inside Claude Desktop. L1 and L2 are therefore options alongside the Claude Code lead mode, not replacements for it.

## 6. Open items

- Midmap was read from its Microsoft Store listing only (released 2026-11-04, Windows x64); its layout and site were not seen.
- Conductor's status *(settled)*: it joined Meta and announced a cloud shutdown on 2026-11-04, withdrew the shutdown on 2026-11-12–13 (0.94.2 changelog), and continues development, cloud included. [related-work.md](../research/related-work.md) is corrected to match.
- Antigravity's native `AGENTS.md` support is unverified; A2 does not depend on it.
- Direct dispatch shape *(settled in `Dispatch.tsx` / `DispatchView.swift`)*: the board’s New Job creates a job without a mission or lead. The lead’s tools use the same `POST /api/jobs` endpoint and pass lead and mission information.
- PR watches: the user has yet to decide whether Crew should poll slowly while the owning session is closed (Codex's preference). The current implementation skips polling while the session is closed.

## 7. Sources

- Conductor: https://www.conductor.build/docs/reference/harnesses, https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker, https://www.conductor.build/changelog
- Emdash: https://emdash.com/docs, https://emdash.com/docs/providers
- OpenHands: https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents, https://docs.openhands.dev/sdk/guides/security
- Linear for Agents: https://linear.app/developers/agent-interaction, https://linear.app/docs/agents-in-linear
- Midmap: https://apps.microsoft.com/detail/9n1dk4tqkjmf
- Paradev: https://docs.paradev.com
- Cursor CLI: https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/reference/configuration
- Codex configuration: https://developers.openai.com/codex/config-sample

## 8. Revision log

Summary of design turns recorded across the roadmap:

- 2026-11-12–13: **Board and desktop shells**: Built the React + Vite board (L5) and direct dispatch (`POST /api/jobs`) while keeping the independent daemon; replaced Electron with a native SwiftUI/AppKit macOS app (`native/`, Swift 6, macOS 26+) and kept Electron for Windows (`desktop/`) ([board.md](board.md), [macos-app.md](macos-app.md)).
- 2026-11-13 and 2026-11-15: **Roles, presets, and AgentGauge G1**: Expanded roles into an 8-role registry with inheritance (keeping `release` scoped to preparation because push, publish, and deploy need their own permission, network, and approval design), added global/mission presets, and built AgentGauge G1 inside the daemon ([roles.md](roles.md), [usage-and-presets.md](usage-and-presets.md)).
- 2026-11-15, 2026-11-16, and 2026-11-18: **Model notes, fix role, and peer ratings (D1–D3)**: Replaced calibrated/clamped scoring (which rewarded tier and let fixes lift build scores) with uncalibrated finding load over change size (`xlarge` exposure 4 for large integrations), a separate `fix` score, `adoption` tracking, and fact-backed `peerRatings` weighted at 50% alongside evidence ([roles.md](roles.md)).
- 2026-11-20: **Game retrospective (E)**: Adopted lead/worker prompt rules, tool-failure reporting, named stage labels (E3), and side-by-side evidence comparison opening one capture first (E4), leaving E1/E2 open ([jobs.md](jobs.md), [missions.md](missions.md)).
- 2026-11-20: **Release gate, PR watching, and concurrent missions**: Gated releases on passing typechecks and tests, added mission PR watching (no polling while the lead session is closed), and required explicit mission IDs when multiple missions are open instead of an implicit current mission or workflow engine ([missions.md](missions.md), [distribution.md](distribution.md)).
- 2026-11-25: **Roles follow the user's settings under either lead (L1)**: A role the lead's own agent holds is the lead's own work and every other holder runs as a worker, reversing the Codex lead's first design (a Claude role kept by the lead unless it named `claude`, a Codex role run as a Codex worker) ([roles.md](roles.md#history)).
- 2026-11-25: **Evidence viewer (E4)**: A pressed capture opens in a plain viewer whose strip and arrow keys switch captures, and comparison waits for Compare, reversing the 2026-11-20 design where the strip always added panes beside the first capture ([board.md](board.md#history)).
- 2026-11-24: **Claude workers in automatic mode (L1 item 5)**: Reversed the first design's manual mode for writable Claude workers, kept because automatic mode decides actions Crew never sees, since automatic mode is what most users run and matches Codex's automatic reviewer; refusals come back to the lead, and read-only jobs stay manual ([approvals.md](approvals.md#history)).
- 2026-11-24: **Codex lead parity (L1)**: Codex's hooks report its lead sessions to the board, waiting approvals and interruptions included, and record the user's prompts. A Codex lead's own work is noted as Codex's, and a daemon started with Codex's filtered environment gives way to a client with the whole one. Under a Codex lead, naming `claude` starts a Claude Code worker (item 5).
- 2026-11-24: **Codex as a lead (L1)**: One plugin serves Claude Code and Codex, and the host that starts a conversation leads it. A Codex lead is woken with `codex queue` rather than a hook, and a role held by Claude is its own work until a Claude worker exists ([delivery.md](delivery.md#codex-leads), [mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)).
