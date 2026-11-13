# 01. Requirements

Current as of 2026-11-13. This document states what Crew is for and what it must do now. It is rewritten when the goals change; earlier versions, including the original request text, are in the git history.

## 1. Goal

One person directs several coding agents from a clean surface: gives a command, sees how it was split and who has each part, follows progress, answers only what needs a decision, and judges the result. The agents can work as a crew with divided roles, or be directed one at a time.

The supported agents are Claude, Codex, and Antigravity. Cursor is to be added.

## 2. Requirements

IDs R1 to R8 keep the meaning other documents refer to. R9 to R15 were added on 2026-11-12; R16 was added on 2026-11-13.

| ID | Requirement | Kind |
| --- | --- | --- |
| R1 | Agents may be connected by any background mechanism, but the user-facing surface stays clean and uncluttered | Required |
| R2 | Claude Desktop as the lead's app is the primary mode. Crew's own screen grows out of the status board alongside it | Required |
| R3 | Each role has a default agent: Claude leads and self-reviews, Codex implements separable pieces and cross-reviews, Antigravity checks UX copy and tidies comments and docs. The user can reassign any role, including Antigravity's | Required |
| R4 | In Claude Desktop lead mode, the services' own features stay usable: subagents, inter-session messaging, Remote Control, computer use, built-in and headless browsers, Chrome, side chat, MCP, compaction | Required |
| R5 | Each agent's activity is visible in near real time, including stalls, exhausted usage limits, and error stops | Required |
| R6 | Sessions started through Crew also appear in each service's desktop app where the service allows it | Nice to have |
| R7 | Operation is intuitive, fast, and smooth, with nothing to carry by hand between stages. In the pipeline, reviews happen without being asked for, and only as often as the work warrants | Required |
| R8 | AgentGauge reports each service's remaining usage, and work is routed by it. When every service has capacity, the role assignments in effect are followed | Required |
| R9 | Shared custom instructions are written once and reach every agent | Required |
| R10 | The board shows each command as a unit: how it was split, which agent has each part, and how far each part has progressed. Its elements are clickable, and approvals, questions, and follow-ups are answered in place | Required |
| R11 | Model and reasoning effort are selectable per role and per service | Required |
| R12 | Cursor is supported as an agent | Required |
| R13 | Crew can run with a lead other than Claude Code, from its own main screen, and can dispatch a command to a single agent without a lead | Long term |
| R14 | Agents working at the same time do not collide. Each runs its own isolated instance of whatever it starts, reviews that run in parallel are independent and at most one of them runs the app, and performance is measured with nothing else running | Required |
| R15 | Approvals need the user as little as is safe. Each agent's automatic reviewer decides first, and the user is asked only about what it will not allow | Required |
| R16 | The Mac app uses SwiftUI and AppKit with Swift 6, supports macOS 26+, and preserves the TypeScript daemon and existing workflows. Its modern native design uses Liquid Glass, SF Symbols, and supplied service marks | Required |

## 3. Defaults and priorities

- **Defaults are the original setup.** With no configuration, roles are the R3 defaults and the lead is Claude in Claude Desktop. Anything else happens only because the user set it.
- **Only the user changes a role.** Automatic routing (R8) moves work between agents when a service runs low, following [03-agentgauge-integration.md](03-agentgauge-integration.md) section 8. It does not give Antigravity engineering or review work; that requires an explicit assignment by the user.
- **Claude Desktop lead mode comes first.** Work on R9 to R12 targets this mode. R13 is built after it and never replaces it.
- **R4 and R6 are scoped to the lead's app.** Workers running in the background keep their runtime's subagents, MCP servers, and compaction, but not their desktop-only features. Under R13, a lead outside Claude Desktop loses those features too, and the screen says which ones are unavailable.
- **Visibility must not cost cleanliness.** R5 and R10 are met by one view that aggregates and summarizes, not by tiled terminals (R1).
- **The surface stays small.** New agents, roles, and views are added only where a requirement above needs them. Orchestration for its own sake is out ([05-related-work.md](05-related-work.md) section 6).

## 4. Acceptance criteria

| ID | Met when |
| --- | --- |
| R1 | In normal use the user looks at Claude Desktop and one board, and never opens a terminal |
| R2 | Every pipeline step can be run from a Claude Desktop session, and the board opens in its browser pane |
| R3 | An unconfigured install runs the default roles. Changing one role is a single setting, and the next job uses it. The lead rejects work outside the assigned role |
| R4 | Every listed feature works in the lead session. Workers use their configured MCP servers and subagents as they are |
| R5 | Each agent shows its current stage, last event, and reason for waiting. Limits, errors, and stalls raise a notification within the configured time |
| R6 | Claude sessions appear in Desktop and mobile. Worker sessions can be resumed in their own tools |
| R7 | Nothing is copied by hand between delegation, review, and polish. Under `/crew:run`, a substantial piece of work gets one review when it is done, and both reviews before it is pushed or opened as a pull request. Outside it, nothing is reviewed unless the user asks |
| R8 | The board shows usage for every agent. The lead asks for routing at stage boundaries and follows the returned assignee and reason. Handoff starts before the lead's limit runs out |
| R9 | Editing one instructions file changes what every agent receives on its next job, without writing to any service's own instruction files |
| R10 | For any command, the board answers "what was it split into, who has each part, and what stage is each in" without opening a session. A waiting item can be answered from the board |
| R11 | Model and effort can be set per role and per service, and a job shows which ones it ran with |
| R12 | A job can be assigned to Cursor and appears on the board like any other |
| R13 | A command can be started, followed, and merged without a Claude Code session |
| R14 | Every worker job carries the isolation rules. Before a push or pull request the self-review and the cross-review run together, and at most one of them runs the app; a worker's review that does runs in a snapshot, not in the user's tree. A job marked as measuring is refused while another job runs, and no job starts until it ends |
| R15 | A Codex job's approval requests are answered without the user by default. An action the reviewer refused is sent back once when the user's request covers it, and the user is asked if it is refused again |
| R16 | The standalone app runs without Electron or a shell-installed Node, retains jobs when the UI quits, and exposes the board's tasks, requests, settings, and details with native controls |

## 5. Not required

- Automatic switching between accounts of the same service.
- Remote or multi-user access. Crew is local and single-user.
- Agents beyond the four named above.
