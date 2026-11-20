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
| R8 (AgentGauge) | C1 (G1 implemented 2026-11-13), L3 |
| R12 (Cursor) | C2 |
| R14 (no collisions between agents) | Implemented 2026-11-12, [04-implementation.md](04-implementation.md) section 5.4 |
| R15 (approvals with little user involvement) | Implemented 2026-11-12 for Codex, [04-implementation.md](04-implementation.md) section 5.1 |
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

**A3. Model and effort.** Codex accepts `model` and `effort`. Antigravity accepted `model` only until 2026-11-18, when its session's `thought_level` was found and wired to `effort` ([05-related-work.md](05-related-work.md) section 11). Per-role `model` and `effort` arrived with the A1 role table. Presets (economy, balanced, best) and the model of the lead's subagents were implemented 2026-11-13; see [09-usage-presets-rounds.md](09-usage-presets-rounds.md) section 8.

### B. Board to control screen

**B1. Decision support.** Implemented 2026-11-12; see [04-implementation.md](04-implementation.md) section 5.2. The settings view covers roles and shared instructions; presets (A3) are not in it yet. These gaps are already listed in [05-related-work.md](05-related-work.md) section 9: the strand drawer, free-text answers to worker questions on the board, activity filtered by job, the pending count in the tab title, a project filter, and a settings view that edits A1 to A3 by clicking.

**B2. Missions.** Implemented 2026-11-12; see [04-implementation.md](04-implementation.md) section 5.3. Stages are reported by the lead through a `mission` tool, and job membership is recorded by the bridge; this settles the open item on who writes the plan. Intent (information, question, command), per-round keep or undo, and the progress roll-up were implemented 2026-11-13; see [09-usage-presets-rounds.md](09-usage-presets-rounds.md). Add `mission_id` to jobs so that one `/crew:run` is one mission, and build the view in section 3 on top of it. Touches `jobs.ts`, [daemon.ts](../plugin/bridge/daemon.ts), [run/SKILL.md](../plugin/skills/run/SKILL.md), and `plugin/board/`.

### C. New connections

**C1. AgentGauge.** G1 implemented 2026-11-13 inside the Crew daemon rather than as a separate MCP server, so the board and the lead read one source; see [09-usage-presets-rounds.md](09-usage-presets-rounds.md) sections 3, 6, and 7. G2 and G3 remain. Original plan: Follow [03-agentgauge-integration.md](03-agentgauge-integration.md), starting with G1: a read-only MCP server over the cache file and history database. It needs no change to AgentGauge and yields the gauges and `route` immediately. G2 (`--json` output) is work in the AgentGauge repository. AgentGauge is now at 0.8.0; the 03 document was written against 0.7.7 and its cache format notes should be rechecked first.

**C2. Cursor adapter.** Drive the Cursor CLI in headless mode (`agent -p --output-format stream-json`). Headless mode has no per-action approval: without `--force` it only proposes edits. Start Cursor in a read-only review role, or in a worktree with an allow list, until approvals can be routed to the user as they are for Codex. Open checks before building:

- CLI flags and the hidden `acp` command are from web documentation, not confirmed on this machine.
- Whether effort is encoded in the model id is unverified.
- Whether the terms allow a third-party client to run the CLI, as was checked for Antigravity in 04 section 6.

### D. Learning from reviews

Proposed 2026-11-15. Implemented 2026-11-15 as described in [09](09-usage-presets-rounds.md) sections 15 and 16, with two changes: the notes are kept as JSON (`~/.crew/model-notes.json`) so a score out of 10 can be computed from them and shown in the settings, and the status (too few samples, on trial, settled) follows the number of build reviews rather than being set by hand. The on-trial comparison against the model a new one would replace is still the lead's to run. The lead picks a tier and a holder for each job with no memory of how earlier jobs went. D1 gives it that memory, and D2 makes fixing a review's findings a role of its own, so how well a model fixes is judged apart from how well it builds.

**D1. Model notes.** A short document the lead reads before it hands out work, instead of a score. Patterns ("solid logic, misses time zone and empty-state edge cases"; "good UI, edits beyond the task") steer the next assignment better than a number. Prose can also carry the context that a formula cannot correct for: task difficulty, which agent reviewed, who fixed.

- Where: `~/.crew/model-notes.md`, one section per model. The model is the one the session reported (`resolvedModel`), with its agent and effort.
- Each section has three parts:
  - **Summary**: three to five lines on what the model does well, where it is weak, and what to give it.
  - **Evidence**: one dated line per reviewed job, with the job id, for example `2026-11-15 cx-74bcd0 (Codex review, Claude fixed): Markdown parser, no findings, one follow-up on underscore boundaries`. Every claim in the summary must trace back to evidence lines.
  - **Status**: settled, on trial (a new model), or too few samples.
- Writing: after a job's review and fix, the lead adds one evidence line with a short tool call, like `mission`'s `record`. Lines carry facts from the review only: how serious the findings were, whether they were reproduced, read or suspected, whether the fix was a root-cause fix or a patch, who reviewed, and who fixed. Impressions are not evidence. Findings from the lead's own self-reviewer subagent count too, since the daemon never sees them otherwise.
- Consolidation: when a section passes a set number of evidence lines, the lead rewrites its summary and compresses old lines. This keeps the file short and stops contradicting notes from piling up.
- Reading: `route` and `delegate` attach the summaries of the role's holders to their answer, so the lead does not have to look them up.
- New models: when `tiers.ts` picks up a newer model, it gets an on-trial section. The lead gives it work under the existing preset, alternating with the model it would replace. Once enough evidence lines exist, the lead writes a verdict and proposes a change of preference to the user. Nothing switches by itself.
- Authority: the notes inform the lead's choice of tier and holder within what the user configured. Role assignments and presets remain the user's (A1, A3).
- Pitfalls to design against:
  - Harder work goes to stronger tiers and draws more findings, so compare within a tier and a change size.
  - A reviewer may be lenient or harsh toward its own family, so each line names the reviewer.
  - Fix quality belongs to whoever fixed, usually the lead today, not the model that built the change (see D2).
  - A few samples are noise. A section below a minimum sample stays "too few samples" and does not shift preference.

**D2. Fix role.** Fixing review findings is the lead's step today. Add `fix` to the role registry (A1), holdable by any agent including Claude. It defaults to Claude, so an unconfigured install behaves as it does now, and it may follow Implementation as its parent.

- Triage stays with the lead. Which findings to accept, and which to decline with a reason, needs the user's intent and this conversation's context. The fix holder receives the accepted findings, the lead's decisions, a map of the files involved, and a `done_when`.
- Where the fix goes:
  - A change a worker built goes back to that worker's session with `reply`, as today, because its context is intact.
  - The fix role is for the lead's own code, or for a result merged from several jobs. It runs in a fresh worktree, and the lead reads the diff before merging.
  - Giving the fix to a model other than the one that built the change also lowers the chance that a model misses its own mistakes again.
- `route` gains a `fix` kind, with the usual fallback to the lead when the holder is out of usage.
- Each fix adds an evidence line to the fixer's notes (D1): root-cause fix, patch, or needed another review. Building quality and fixing quality stay separate.
- The review-round limit is unchanged: one round by default, at most two, whoever fixes.
- Risk: a thin brief invites fixes that only hide symptoms. The brief must carry the findings and the reasons, not just the file names.

Order: D1's evidence lines first, so data builds up, then the D1 summaries in `route` and `delegate`, then D2.

**D3. Peer ratings.** Implemented 2026-11-18 as described in [09](09-usage-presets-rounds.md) section 17. D1 kept impressions out of the notes; a rating is admitted only with the fact it rests on, counts for half of an item beside the evidence, and can be turned off.

### E. From the game retrospective

Recorded 2026-11-20 from a retrospective of one game project on Windows: 58 jobs, about 110 hours and 1.5 billion tokens, mostly art (modeling, terrain, shading, VFX). Each item was taken only in the form that holds for any project. What belongs to that project (Blender's path, WebGL and GPU flags, Vite's config loader, HMR) goes in its own `.crew/instructions.md`.

Implemented 2026-11-20:

- **Sample before the set.** Work judged by eye or taste, in many like items, is built as one approved sample first, then the rest, with the full regression check once at the end. A rule for the lead (`/crew:run` and the MCP server instructions), using repeated `implement` steps with names of their own; no fixed template per kind of work, which would encode one project's pipeline.
- **Briefs.** The few points that decide acceptance, the user's own words and the reference where taste decides, and how much verification is wanted. From the second correction on, the lead restates the whole brief instead of appending; a worker treats a restated task as replacing earlier messages and asks when messages conflict.
- **Judging.** Evidence beside the reference, not the worker's account. Workers list what still differs instead of rating themselves, and do not add detail the task did not ask for.
- **Evidence.** The few captures that decide, of the final state, with stale ones replaced.
- **Environment.** A worker says at once when a tool the task needs will not run, and reports workarounds with the exact command; the lead adds them to `.crew/instructions.md`, so the next worker is given them.
- **Worker tools.** A job whose Crew tools did not start says so ([04](04-implementation.md) section 2.1).
- **Named stops (E3).** A stage in a mission's plan may carry a name, so a sample, the rest, and a fix for one item read as themselves on the board and in the app ([04](04-implementation.md) section 5.3).
- **Evidence side by side (E4).** On the board and in the app, a capture opens by itself and up to three others can be added beside it, each with the turn it is from ([04](04-implementation.md) section 5.2). The app shows images itself instead of opening Preview.
- **Crew cannot start a job.** The lead retries once, then does the piece itself.

Already fixed before the retrospective was read: worker tools under the desktop app and the three-minute thread start (0.3.1), the `work` folder that outlives a turn (0.3.1), the daemon's port fallback, and the system temp folder left out of writable paths, which was what timed out `thread/start` twelve times.

Open, each needing a decision first:

- **E1. A browser with a GPU on Windows.** `crew.browser` runs only on macOS. On Windows a worker starts Chromium itself, inside Codex's sandbox. The retrospective reports the GPU process dying there, rendering falling back to software at full CPU, and a headless shell showing an error window on the user's screen; the cause was not looked into. Running the job's browser server from the daemon, as on macOS, would give it the GPU and one place to stop it; but Windows has no `sandbox-exec` to hold that browser to the job's file limits, so it would read whatever the user can. Needs that trade settled and a Windows machine to verify on.
- **E2. A budget per job.** Tokens and time are shown when a job ends, not while it runs. A limit per job (a default in the settings, or `delegate` arguments) that wakes the lead once when passed. Open: the defaults, and whether a wake is worth the lead's own tokens.

Not taken:

- **Retrying `thread/start`.** The twelve timeouts had one cause, removed since; a retry would have waited three more minutes and failed the same way. The lead's rule (retry once, then do it yourself) covers what is left.
- **Blocking software rendering and `--disable-gpu`.** Right for a WebGL game, wrong for most web UI, where software rendering is cheaper and enough. A project that needs the GPU says so in its instructions.
- **Linking each capture to a model file's hash and a camera.** Specific to 3D assets. The general form exists: evidence records the turn it was written in, and each turn is a commit on the job's branch.

## 5. Long-term plan

**L1. The lead as an adapter.** Only three parts are tied to Claude Code: the MCP server, the hooks, and the skills. Jobs, events, and the board belong to the daemon. Defining the lead as the role that plans and decides merges lets Codex or a headless Claude take it. This also resolves the "Codex as temporary lead when Claude is nearly exhausted" case in 03 section 8.2.

Groundwork done 2026-11-15: worker roles are a registry the user assigns in the settings ([09](09-usage-presets-rounds.md) section 15), and routing names the lead through one constant (`LEAD` in `config.ts`) instead of spelling out Claude. No setting chooses the lead yet, because nothing can honor it. What a lead other than Claude Code needs, in order, each verified before the next:

1. Lead identity as a property of the connected session, not a global setting, so leads of different kinds can run at once. Today a session is known by `CLAUDE_CODE_SESSION_ID`.
2. The MCP server driven by another client (Codex supports MCP servers), with the session id passed in.
3. Waking the lead when a job ends or needs it. Today Claude Code's hooks (`plugin/hooks`) do this, and they also record the user's own words, which `approved_by_user` is checked against; the new lead needs both.
4. Relaying approvals and questions to the user through that client.
5. A Claude worker adapter, needed only once Claude is to hold a worker role under another lead.

**L2. Own main screen.** Partially implemented 2026-11-12: React board, role-based direct jobs and Electron shell; see [07-desktop-and-react.md](07-desktop-and-react.md). Mission start with a lead, lead selection and merge execution remain open. Original plan: After B1 and B2 the board is close to a control screen. Add mission start, the command bar for direct dispatch (the daemon already accepts `POST /api/jobs`), lead selection, and merge execution, then wrap it in a thin native window. Deferred discussion on 2026-11-12: evaluate Electron as a thin client of the existing daemon, with one app instance, window-state restoration, a tray, and actionable approval notifications. Closing the board must not stop jobs; keep the web board available. The earlier Tauri preference (02 section 5) is not a final choice. Measure resource costs and consider packaging and updates before selecting the shell; avoid a heavy wrapper (05 section 6).

**L2a. Distribution.** Planned 2026-11-16: GitHub Releases with a Windows installer and the macOS app, where the app installs and updates the Claude Code plugin itself on its own runtime and shows a setup checklist; see [13-distribution-plan.md](13-distribution-plan.md).

**L3. Usage-based routing.** With AgentGauge G3 (threshold hooks), handoff starts before the lead's limit runs out.

**L4. More entry points.** Start missions from GitHub or Linear issues; a read-only mobile view.

**L5. Board UI foundation and design system.** Core implemented 2026-11-12 with React + TypeScript + Vite, shared tokens, a CSS Module, Lucide and Playwright. Radix, Motion and Storybook were evaluated and deferred because native elements and existing CSS cover the current scope; see [07-desktop-and-react.md](07-desktop-and-react.md). Original proposal (before the explicit React/Electron implementation request): Preserve the current visual design while evaluating React + TypeScript + Vite, shared CSS tokens and CSS Modules, selected Radix primitives, and CSS-first motion with Motion where needed. Define reusable status chips, job rows, action buttons, and session disclosures, including long Korean text, pending/error/retry states, narrow layouts, and reduced motion. Use Storybook for component states and Playwright for interaction and visual regressions. First establish regression baselines and separate SSE/request state from rendering, then migrate bounded UI areas without sharing DOM ownership between React and the old renderer. Prefer this foundation before desktop packaging. This is a future work item, not part of the current board PR's implementation scope.

### Cost of L1 and L2

Requirements R4 and R6 (computer use, side chat, visibility in the desktop app) hold only while the lead runs inside Claude Desktop. L1 and L2 are therefore options alongside the Claude Code lead mode, not replacements for it.

## 6. Open items

- Midmap was read from its Microsoft Store listing only (released 2026-11-04, Windows x64). Its website did not respond and the screenshots were not seen, so its actual layout is unknown. It has no built-in agent and does not run or isolate agents; the ideas taken from it concern the shared board, not orchestration.
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

## 8. Revision log

- 2026-11-12: The user explicitly requested React and Electron implementation. Completed the L5 foundation before desktop packaging, retaining the independent daemon and web entry point. Added role-based direct dispatch without claiming full L2/L1 support. The earlier SwiftUI/Tauri preferences are superseded for this implementation; native memory efficiency is not assumed. Dependency decisions, measurements and verification are in document 07.

- 2026-11-13: The user requested a native macOS desktop client. SwiftUI and AppKit replace Electron, with Swift 6 and macOS 26+ support. The TypeScript daemon and React browser board are retained. This changes the L2 desktop shell and native presentation, not lead selection or mission orchestration. See [08-native-macos.md](08-native-macos.md).

- 2026-11-13: Implemented C1 phase G1, A3 presets, and the open parts of B2. The macOS cache format was rechecked against AgentGauge 0.8.2. C2, L1, the rest of L2, L3, and L4 are unchanged.

- 2026-11-15: The user asked for roles beyond the original three, easier reassignment, a preset per mission, and, later, a lead other than Claude. Roles became a registry with inheritance (refactor, release preparation, debate, and review that runs the app join the three), missions carry their own preset, and L1 gained its groundwork and an ordered plan. Executing a release (push, publish, deploy) is not part of the release role; it needs its own permission, network, and approval design. Decided after debating the design with Codex (Astra and Sol, independently). See [09](09-usage-presets-rounds.md) sections 8 and 15.

- 2026-11-15: The user proposed remembering which models draw few or light review findings and which fix at the root, so the lead can consult it when it picks a model, with a few trial runs under the existing preset when a new model arrives. They preferred a short document a model reads over a score, and asked for fixing to become a role of its own. Recorded as D1 (model notes) and D2 (fix role). Documented only; nothing is implemented.

- 2026-11-15: The user asked to build D1 and D2, with a score as well: out of 10 to one decimal, across every mission and job, corrected for task difficulty and by cross-evaluation, shown per model in the settings. The prose summaries stay what the lead reads; the score sits beside them. See [09](09-usage-presets-rounds.md) section 16.

- 2026-11-16: The user asked for a detailed, parallel review of the scoring and for a better method, fundamental if need be. A self-review and a cross-review reproduced that reviewer calibration mistook the work a reviewer was given for harshness, that tier acted as a fixed bonus per Codex model, that the per-line clamp hid how bad a bad job was, and that fixes lifted the overall score. The build score became a finding rate over change size with no calibration and no tier, fix became a separate score that does not rank, the start counts each other model once, and the lead records declined findings. See [09](09-usage-presets-rounds.md) section 16.
- 2026-11-16: Replaying the Crew history (35 reviews, 112 findings, 89% accepted) through the new method showed scores holding steady as reviews accumulate. Two things charged the lead for its roles: its largest integrations (up to 5,800 lines) counted as ordinary large changes, and findings in a merged result fell on the lead's line. A size xlarge (exposure 4) and one line per merged job fix these without a bonus. The lead also records how it took each delegated job (adoption), shown per model and not scored.
- 2026-11-18: The user found that a curve over review counts and change sizes does not reflect how a model really did, and proposed that the models of a mission score each other near its end. Built as peer ratings laid over the evidence ([09](09-usage-presets-rounds.md) section 17): each rating rests on a fact and is given in a turn the rater already has, reviewers get a score of their own from how their findings held up, and four items (correctness, brief, report, findings) replace the single number beside build and fix. The user asked for a switch, since rating adds usage; it is `peerRatings`, on by default. They also set the shares of evidence and ratings in an item to half each, from the 70 to 30 first proposed.
- 2026-11-20: The user brought a retrospective of a game project run with Crew and asked which of its points to take, generalizing or declining those that fit only that project. Rules for the lead and the worker, and the check on a worker's Crew tools, were built; four larger items were left open and three declined. The user then asked for two of the four, named stops and evidence side by side, since the board is a web page whatever shell shows it. See section 4 E. A capture first opened beside its before and the lead's reference; the user found several appearing from one press odd, so it opens alone and the others are added by hand.

- 2026-11-20: The user asked for four things in one command: a release that cannot be built unless types and tests pass, tracking of a mission's pull requests (handing fixes to agents, never merging), a plan that survives a stopped or resumed session, and a way to give a second command without the first being closed. The last was debated with Codex and Antigravity (Neon) separately. Both rejected an implicit "current mission" and a stored paused state, and the rule taken is theirs: one open mission needs no id, several need one on every call. A workflow engine was declined: tasks are a record the lead writes, and the daemon schedules nothing. Left to the user: whether a pull request should also be read, slowly, while its session is closed (Codex's preference; built as no polling at all for a closed session). See [04](04-implementation.md) section 5.5 and [13](13-distribution-plan.md).
