# 01. Requirements

Written 2026-11-11. Sourced from the initial prompt and follow-up message in the conversation on the same day.

## 1. Initial request (translated from original)

> I use Claude, Codex, and Antigravity, and I want you to think through and evaluate the best way to connect them so they divide roles and collaborate. Feel free to research and analyze whatever information you need and look for similar implementations.
>
> What I want:
>
> 1. They can be connected via CLI or any other mechanism in the background, as long as the frontend looks clean.
> 2. We can use the lead model's own app directly, or build a new frontend page or a lightweight web-app wrapper. Design the best approach you can envision.
> 3. Claude should act as the lead collaborating with Codex and as the self-reviewer; Codex as the supporting engineer and reviewer; and Antigravity should only handle UX writing checks and cleaning up comments and documentation for readability.
> 4. Every service's features—subagents, inter-session messaging, Remote Control, computer use, built-in or background headless browsers, Chrome integration, side chat, MCP, compact sessions, and so on—should remain fully usable.
> 5. What each agent is doing should be visible in real time or near real time (so I can tell when work stops because of a stall, usage limit, or error).
> 6. Even better if sessions started here also show up in each service's desktop app.
> 7. Clean, intuitive, snappy, and smooth operation.

## 2. Follow-up request (translated from original)

> Since I already built AgentGauge, how about connecting it to this setup like an MCP server or API? A tool where the agent is connected, checks its own usage and the other services' usage, and automatically routes work to the right tool—while sticking to the original role assignments whenever all of them have plenty of capacity.

## 3. Numbered requirements

| ID | Requirement | Kind |
| --- | --- | --- |
| R1 | Any background connection method (CLI or otherwise) is fine, but the user-facing surface must stay clean and uncluttered | Required |
| R2 | Either use the lead model's own app, or build a new frontend or thin web-app wrapper—pick whichever works best | Choice |
| R3 | Fixed roles: Claude is lead and self-reviewer, Codex is supporting engineer and reviewer, Antigravity only checks UX copy and cleans up comments and docs for readability | Required |
| R4 | Subagents, inter-session communication, Remote Control, computer use, built-in or headless browsers, Chrome use, side chat, MCP, and session compaction across the services must remain usable | Required |
| R5 | Each agent's activity must be visible in near real time, including stalls, exhausted usage limits, and error stops | Required |
| R6 | Sessions started here should ideally appear in each service's desktop app as well | Nice to have |
| R7 | Operation must be intuitive, fast, and seamless | Required |
| R8 | Connect AgentGauge via MCP or API so the agent checks its own and other services' usage and routes tasks to the right tool, falling back to the original R3 roles when all have sufficient capacity | Required (follow-up) |

## 4. Tensions between requirements and how they are resolved

- The wrapper option in R2 conflicts with R4 and R6. Side chat, computer use, and the built-in browser pane are features of each vendor's desktop app and are unavailable in a custom frontend wrapping headless runtimes. Desktop app visibility (R6) is also most reliable when the lead runs inside its own desktop app. R2 is therefore resolved in favor of using the lead's native app.
- Fixed roles in R3 conflict with usage-based rerouting in R8. The last sentence of R8 sets the priority: follow R3 under normal conditions, and reroute only when a service runs low on quota. Promoting Antigravity into an engineering role is never requested and is not done.
- Real-time visibility in R5 must be weighed alongside the clean frontend in R1. Tiling multiple terminal windows satisfies R5 but fails R1. A separate view that aggregates and summarizes events is needed.
- The scope of R4 differs between the lead and the workers. The lead (Claude) uses every feature of its desktop app. While running in the background, workers (Codex, Antigravity) keep their runtime subagents, MCP servers, and compaction, but cannot use desktop-only UI features on the worker side. Their assigned roles do not need those features.

## 5. Acceptance criteria

| ID | What counts as met |
| --- | --- |
| R1 | In normal use, the user only looks at Claude Code Desktop and a single status board, without opening a terminal |
| R2 | Document 02 records the chosen approach, the rejected alternatives, and the reasons behind both |
| R3 | Role rules live in each agent's instruction files, and the lead rejects out-of-scope changes |
| R4 | All listed features work in the lead session; workers use their configured MCP servers and subagents as-is |
| R5 | Each of the three agents shows its current stage, last event, and wait reason; quota exhaustion, errors, and stalls trigger a notification within a configured timeout |
| R6 | Claude sessions appear in Desktop and mobile; Codex and Antigravity sessions can be resumed in their respective tools (see document 02 section 6 for visibility limits) |
| R7 | No manual copy-pasting is needed between delegation, review, and polish stages |
| R8 | The lead calls the routing tool at stage boundaries and delegates according to the returned assignee and reason; handoff begins before the lead's own quota runs out |
