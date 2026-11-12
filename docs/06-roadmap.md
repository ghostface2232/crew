# 06. Roadmap

Written 2026-11-12. Covers the near-term rework and the long-term expansion of Crew, plus the control UI concept. Items are not implemented unless marked. External facts were gathered from vendor documentation on 2026-11-12 unless marked otherwise; items marked "unverified" come from secondary sources or were not checked on this machine.

## 1. Requirements this roadmap answers

The requirements are in [01-requirements.md](01-requirements.md). This roadmap covers the ones not yet met:

| Requirement | Plan item |
| --- | --- |
| R3 (reassignable roles) | A1 |
| R9 (shared instructions) | A2 |
| R11 (model and effort) | A3 |
| R10 (command-centered, clickable board) | B1, B2 |
| R8 (AgentGauge) | C1, L3 |
| R12 (Cursor) | C2 |
| R13 (other leads, own main screen, direct dispatch) | L1, L2 |

Near-term work targets Claude Desktop lead mode, as 01 section 3 sets out.

## 2. The one constraint behind most of it

Agents and roles are fixed in code. `WorkerAgent` is `'codex' | 'antigravity'` ([jobs.ts](../plugin/bridge/jobs.ts)), the job kind decides the agent (`delegate` and `review` are Codex, `polish` is Antigravity), and the configuration has one hand-written block per agent ([config.ts](../plugin/bridge/config.ts)). R3, R9, R11, and R12 each become a set of new branches unless this is lifted first. R13 extends the same change to the lead.

## 3. Control UI concept

The current board is organized by agent (three lanes). The proposal organizes it by command.

| Element | Behavior |
| --- | --- |
| Mission | One user command is one card. Under it, one strand per piece of work shows the assigned agent, a title, and the stages (implement, self-review, cross-review, polish, merge). Today a job does not record which command produced it. |
| Needs you | Pinned at the top. Holds only approvals, questions, and merge decisions, each answerable in place. Everything else can be ignored safely. |
| Strand drawer | Clicking a strand opens the report, changed files, out-of-scope files, that strand's own activity, and a follow-up input. The data is already served by `/api/jobs/:id`. |
| Command bar | Sends a command straight to one agent (`@codex ...`) without going through the lead. This is the path for directing agents independently. Long term (L2); until then commands start in the lead session. |
| Usage gauges | One per agent, fed by AgentGauge. A tight agent changes color, and the command bar suggests an alternative. |
| Progress roll-up | A mission's progress is computed from its strands, and a strand's from its stages, so the collapsed card already answers "how far along is it". |
| Intent | The command bar distinguishes three intents. Information is added to the shared instructions or pinned to a mission without starting work. A question is answered read-only, with no changes. A command starts a job. |
| Scoped follow-up | Selecting a strand scopes the command bar to it, so the next message continues that worker session. A note left on a strand while the worker is busy is delivered with its next turn. |
| Rounds | Each worker turn on a strand is one round with its own diff, shown with added and changed marks. A round can be kept or undone on its own. The bridge already commits per job; this needs a commit per turn. |

Borrowed ideas:

- Midmap: a board that the user and the agents both read and write, progress that rolls up from child to parent, the information / question / command split, notes left on a node for the agent's next turn, and keep or undo per round of changes.

- Linear for Agents: a human owner plus an agent delegate on each item, notification only when input is needed, and session states that include `awaitingInput` and `stale`.
- Conductor: the diff and the checks in one panel next to the conversation.
- Emdash: model and effort remembered per agent.

## 4. Near-term plan

Recommended order is A, then B, then C. Without A, both Cursor support and role reassignment turn into added branches.

### A. Foundation

**A1. Agent registry and role table.** Implemented 2026-11-12; see [04-implementation.md](04-implementation.md) section 2.1. Move the fixed agent list and the kind-to-agent mapping into configuration. A `roles` table maps `delegate`, `review`, and `polish` (the tool names) to an agent, a model, and an effort. Reassigning a role becomes a one-line configuration change. The default table is the R3 defaults, so an unconfigured install behaves as it does today. Antigravity defaults to the wording role and the user may assign it others; automatic routing never does (01 section 3). Touches `jobs.ts`, `config.ts`, [mcp.ts](../plugin/bridge/mcp.ts), and the role files.

**A2. Shared instructions.** Implemented 2026-11-12; see [04-implementation.md](04-implementation.md) section 2.2. Read `~/.crew/instructions.md` (global) and `.crew/instructions.md` (project) and inject them into every job:

| Agent | Channel |
| --- | --- |
| Codex | `developerInstructions`, where the role text already goes |
| Antigravity, Cursor | Prompt prefix |
| Claude (lead) | SessionStart hook context |

Injection keeps the decision recorded in [04-implementation.md](04-implementation.md) section 3: Crew does not write into each service's own `AGENTS.md`, `CLAUDE.md`, or rules folder. Touches [prompts.ts](../plugin/bridge/prompts.ts) and [hooks.json](../plugin/hooks/hooks.json).

**A3. Model and effort.** Codex already accepts `model` and `effort`; Antigravity accepts `model` only. Per-role `model` and `effort` arrived with the A1 role table. Remaining: three presets (economy, balanced, best), and include the model of the lead's subagents.

### B. Board to control screen

**B1. Decision support.** Implemented 2026-11-12; see [04-implementation.md](04-implementation.md) section 5.2. The settings view covers roles and shared instructions; presets (A3) are not in it yet. These gaps are already listed in [05-related-work.md](05-related-work.md) section 9: the strand drawer, free-text answers to worker questions on the board, activity filtered by job, the pending count in the tab title, a project filter, and a settings view that edits A1 to A3 by clicking.

**B2. Missions.** Add `mission_id` to jobs so that one `/crew:run` is one mission, and build the view in section 3 on top of it. Touches `jobs.ts`, [daemon.ts](../plugin/bridge/daemon.ts), [run/SKILL.md](../plugin/skills/run/SKILL.md), and `plugin/board/`.

### C. New connections

**C1. AgentGauge.** Follow [03-agentgauge-integration.md](03-agentgauge-integration.md), starting with G1: a read-only MCP server over the cache file and history database. It needs no change to AgentGauge and yields the gauges and `route` immediately. G2 (`--json` output) is work in the AgentGauge repository. AgentGauge is now at 0.8.0; the 03 document was written against 0.7.7 and its cache format notes should be rechecked first.

**C2. Cursor adapter.** Drive the Cursor CLI in headless mode (`agent -p --output-format stream-json`). Headless mode has no per-action approval: without `--force` it only proposes edits. Start Cursor in a read-only review role, or in a worktree with an allow list, until approvals can be routed to the user as they are for Codex. Open checks before building:

- CLI flags and the hidden `acp` command are from web documentation, not confirmed on this machine.
- Whether effort is encoded in the model id is unverified.
- Whether the terms allow a third-party client to run the CLI, as was checked for Antigravity in 04 section 6.

## 5. Long-term plan

**L1. The lead as an adapter.** Only three parts are tied to Claude Code: the MCP server, the hooks, and the skills. Jobs, events, and the board belong to the daemon. Defining the lead as the role that plans and decides merges lets Codex or a headless Claude take it. This also resolves the "Codex as temporary lead when Claude is nearly exhausted" case in 03 section 8.2.

**L2. Own main screen.** After B1 and B2 the board is close to a control screen. Add mission start, the command bar for direct dispatch (the daemon already accepts `POST /api/jobs`), lead selection, and merge execution, then wrap it in a thin native window. A heavy Electron app remains excluded (05 section 6).

**L3. Usage-based routing.** With AgentGauge G3 (threshold hooks), handoff starts before the lead's limit runs out.

**L4. More entry points.** Start missions from GitHub or Linear issues; a read-only mobile view.

### Cost of L1 and L2

Requirements R4 and R6 (computer use, side chat, visibility in the desktop app) hold only while the lead runs inside Claude Desktop. L1 and L2 are therefore options alongside the Claude Code lead mode, not replacements for it.

## 6. Open items

- Midmap was read from its Microsoft Store listing only (released 2026-11-04, Windows x64). Its website did not respond and the screenshots were not seen, so its actual layout is unknown. It has no built-in agent and does not run or isolate agents; the ideas taken from it concern the shared board, not orchestration.
- Whether the lead should write the mission plan to the board itself (a `plan` tool, as Midmap's agents write nodes), or the bridge should derive it from the jobs the lead creates. The second needs no new tool and cannot drift from what actually ran.
- Conductor's status is inconsistent between sources: 05 records a planned cloud shutdown, while its changelog showed a recent release on 2026-11-12. This does not affect the UX references.
- Antigravity's native `AGENTS.md` support is unverified. A2 does not depend on it.
- The shape of a mission when the user dispatches directly: one strand, no lead, no review stages.

## 7. Sources

- Conductor: https://www.conductor.build/docs/reference/harnesses, https://www.conductor.build/changelog/0.85.0-sections-routines-and-a-new-model-picker
- Emdash: https://emdash.com/docs, https://emdash.com/docs/providers
- OpenHands: https://docs.openhands.dev/openhands/usage/agent-canvas/acp-agents, https://docs.openhands.dev/sdk/guides/security
- Linear for Agents: https://linear.app/developers/agent-interaction, https://linear.app/docs/agents-in-linear
- Midmap: https://apps.microsoft.com/detail/9n1dk4tqkjmf
- Paradev: https://docs.paradev.com
- Cursor CLI: https://cursor.com/docs/cli/headless, https://cursor.com/docs/cli/reference/parameters, https://cursor.com/docs/cli/reference/configuration
- Codex configuration: https://developers.openai.com/codex/config-sample
