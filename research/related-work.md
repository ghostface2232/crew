# Related Work and Takeaways

Surveyed 2026-11-12. Star counts, last push dates, and licenses were checked via `gh api`; code analysis was done by shallow-cloning repositories and reading source files without running them. Community reception comes from Hacker News threads and blog summaries, with little direct evidence from Reddit or X. Vendor-reported numbers are marked "(vendor)", and unverified items are marked "unverified".

## 1. Summary

- **Worktrees plus a dashboard is already commodity infrastructure.** Plenty of human-driven GUIs and TUIs do this, and several have already shut down or stalled (Conductor is shutting down its cloud on Nov 20 after joining Meta; Vibe Kanban is community-maintained after the company wound down). What sets Crew apart is that a lead agent delegates over MCP and reviews/merges diffs, workers run through structured protocols with no blind auto-approval (Codex defaults to its automatic reviewer with user escalation, and Antigravity routes delegate commands to the user and refuses commands in other roles), and Codex performs adversarial cross-review.
- **The closest point of comparison is `openai/codex-plugin-cc`** (35k★, Apache-2.0). It lacks worktree isolation, user approval routing, and a polish role—and its top open issues are almost all process lifecycle bugs. Crew needs to guard against the same class of bugs.
- **Evidence for cross-model code review is weaker than commonly assumed.** For code, existing research suggests a fresh reviewer with a clean context matters more than switching model vendors—whereas for documentation and prose, cross-model review showed a large gain (section 4).
- **The industry broadly warns against parallel writes and over-orchestration.** Both Anthropic and Cognition favor read-heavy fan-out while treating parallel writes as high-risk. Crew's "delegate only separable slices + single lead merges" design matches that consensus.

## 2. Survey by category

### A. Parallel coding-agent orchestrators

| Project | Metrics | Key points |
| --- | --- | --- |
| Conductor (proprietary) | Joined Meta; cloud shutting down 11/20 | 222 pts on HN. Praised for UX; criticized for shutdown timeline and lock-in. Early complaints: did not use local checkout, reinstalled dependencies per workspace, skipped `.env`, needed notifications |
| Vibe Kanban | 28.6k★, Apache-2.0 | Community-maintained after company shut down in 2026-04. Rust. Worktree creation lock, orphan run cleanup on boot, structured approval objects (id, question flag, timeout) |
| cmux | 28.8k★, GPL-3.0+ | Swift/Ghostty. Notification ring praised. CHANGELOG documents subagent status misreporting and session-restore storm bugs |
| Paradev (formerly Superset) | 16.2k★, MIT | Hook-based state detection; PTY daemon keeps sessions alive across app updates. Supports Antigravity via hooks |
| Claude Squad | 8.8k★, AGPL-3.0 | Detects state by hashing tmux panes; daemon forces AutoYes. Last push in August |
| Emdash | 6.2k★, Apache-2.0 | Best-documented ACP runtime and ADRs. Slows down around ~78 tasks |
| Agent of Empires | 4.1k★, MIT | State enum, hook status files, idle auto-stop, one-time approval nonces |
| CCManager | 1.3k★, MIT | Per-agent regex state detection; blocklist of dangerous commands followed by an LLM auto-approval gate |

Their state reading, deletion ordering, and approval models informed the candidates in section 5.

### B. Claude Code harnesses

| Project | Metrics | Key points |
| --- | --- | --- |
| `openai/codex-plugin-cc` | 35.1k★, Apache-2.0, last push July, 545 open issues | `/codex:review`, `:adversarial-review`, `:rescue`. Stop-hook review gate (README warns about token burn) |
| `oh-my-claudecode` | 40.8k★, MIT, 189 contributors | 19 agents, ~85 skills. `team-plan → prd → exec → verify → fix` pipeline. Very large surface area |
| Gas Town / Beads | 18.8k★ / 28.7k★ | Multi-tier hierarchy (Mayor, Polecat, Witness, etc.). High cost; the creator advises most people not to use it. Completion-signaling rules are well thought out |
| PAL MCP (`zen`) | 11.8k★, last push 2025-12 | Model-API multi-model tool, effectively dormant. `clink` (CLI bridge) is the one surviving idea |
| `wshobson/agents` | 42.4k★, MIT | 92 plugins. Three-tier progressive skill disclosure and `evals` directory |
| `github/spec-kit` | 149k★, MIT | Spec-first workflow; `NEEDS CLARIFICATION` markers block implementation |
| Claude Code Agent Teams | Official, experimental | Shared task list, teammate messaging, `TeammateIdle`/`TaskCompleted` hooks. Docs note a known issue where the lead implements tasks itself instead of waiting |

We also looked at `claude-flow` / `ruflo` (81k★) solely as a cautionary tale due to controversy over hype vs. substance (checked metadata only).

### C. General frameworks and protocols

- **OpenHands** (93k★): Evolved into a self-hosted control plane called Agent Canvas that attaches ACP agents. Its SDK ACP client (`acp_agent.py`) is a strong practical reference, though it auto-approves ACP agent permissions (the opposite of Crew).
- **ACP** (v1 stable, v2 draft): Permission requests use `session/request_permission`; cancellation sends a `session/cancel` notification followed by a `stopReason: cancelled` response. The v2 draft defines `running / requires_action / idle` states.
- **MCP** (2026-07-28 spec): Moves toward statelessness, shifts Tasks into an extension, and makes `input_required` a first-class state.
- **LangGraph** (44.8k★): Stable IDs for `interrupt()`, response schema validation, and preserving writes from completed steps when a later step fails.
- **OpenAI Agents SDK**: `needs_approval`, serializable `RunState`, and rejection reason forwarding. Docs warn that "always allow" is keyed by tool name and can leak across agents.
- **Claude Agent SDK**: Control protocol and `session_state_changed`. Code comments note a subtlety: "`result` marks the end of a turn, not the end of execution."
- **A2A** (v1.0.1) and **Google ADK**: Useful mainly as references for state names (`REJECTED`, `AUTH_REQUIRED`) and at-least-once resume semantics.

CrewAI, Mastra, and Microsoft Agent Framework were skipped as too far removed from supervising CLI coding agents (inferred).

### D. Commercial products and industry research

- **Cognition**: Shifted from "Don't Build Multi-Agents" (2025-06) to "What's Actually Working" (2026-04). Endorses generator-verifier loops while viewing unstructured swarms as "mostly getting in the way." Claims a reviewer with a clean context beats a noisy one (vendor claim).
- **Anthropic multi-agent research**: 90.2% improvement over a single agent on internal evaluations at roughly 15x token cost, while noting that coding tasks are less parallelizable than research.
- **Anthropic long-running harness**: Uses a separate skeptical evaluator and "sprint contracts" (agreed completion criteria up front), costing \$200 with the harness vs. \$9 solo. Recommends re-auditing harness stages whenever a new model ships.
- **Cursor**: Up to 8 parallel agents in worktrees or remote VMs. User complaints center on worktree detection failures, token waste, and repetitive approvals; blog posts converge on 3–5 agents as the practical sweet spot.
- **GitHub Agent HQ**: Assigns Copilot, Claude, and Codex to the same issue for comparison. Main complaints are review fatigue and low-quality PRs.
- **Codex subagents**: Fail if an approval cannot be surfaced, propagating the error to the parent.
- **Factory Missions** (single vendor demo): Verifiers only report and never edit; verification takes ~37% of time and ~1/3 of tokens.
- **Amp Oracle**: Read-only second opinion from another vendor's model.

## 3. What Crew already does well

- Dedicated worktree and branch per job; the bridge commits and only the lead merges.
- No blind auto-approval (unlike `codex-plugin-cc`, OpenHands, or Claude Squad): Codex defaults to `auto_review` (`config.ts`) and escalates refusals or `user`-mode turns to the user; Antigravity allows reads and role-scoped workspace edits and forwards questions to the user. It routes commands to the user only for delegate jobs and refuses them in other roles (`adapters/antigravity.ts`).
- Uses structured protocols (`codex app-server`, `agy acp`) rather than terminal screen-scraping.
- Configurable roles (eight roles around implementation, adversarial review, and wording polish in `config.ts`) with out-of-scope edits flagged (`outOfScope` in `jobs.ts`) or refused (`antigravity.ts`).
- Background execution plus `wait` and `wake.ts` avoids long synchronous tool-call timeouts.
- Small surface area (2 worker runtimes, 4 skills, live React board plus macOS/Windows desktop clients) without the over-orchestration of OMC or Gas Town.

## 4. A candid look at the evidence for cross-model review

- Song, arXiv:2610.01471 (single author, preprint, based on seeded errors in Korean artifacts): For code, a fresh-session same-model reviewer (F1 40.7%) was not significantly different from a cross-model reviewer (37.2%). For documentation, cross-model review led by a wide margin (42.1% vs. 24.5%). Because the two caught partially non-overlapping errors, pairing 1 same-model + 1 cross-model reviewer reached 56.7%, beating 2 same-model reviewers (42.7%). A third reviewer added little, and a weak cross-model reviewer did not help.
- Other work reports that errors remain correlated across high-accuracy models even from different vendors (checked abstract summary only).
- Blog posts praising Codex reviews of Claude code contain no measurements, and say so themselves.

Takeaway: Crew's combination of `crew:self-reviewer` (fresh context) + Codex review matches the evidence. The right justification is "a clean context, a sufficiently strong second reviewer, and partially non-overlapping blind spots" rather than "a different vendor." The strong cross-model gain on documentation and prose also supports the Antigravity polish stage. Adding a third review stage is not worth it.

## 5. Candidates to adopt (suggested priority)

Each item below comes from the surveyed projects; section 8 checks them against Crew's actual codebase.

**High priority: process and state hygiene (the #1 source of real-world user failures)**
1. On daemon startup, mark jobs recorded as `running` with no live worker process as `failed` and surface them (Vibe Kanban, Emdash, AoE).
2. Reap `codex app-server` and `agy acp` child processes when sessions end; key state by session/repository rather than cwd hash (`codex-plugin-cc` orphan-process issues).
3. Serialize worktree creation and removal with a per-repository mutex and persist deletion intent so cleanup is idempotent across restarts; never delete paths outside Crew's dedicated root, and treat a directory as a worktree only when `.git` is a file (Emdash ADR 0006, Vibe Kanban).
4. Model approvals and questions as structured objects: ID, options, timeout, question vs. permission flag, and single-use response token; do not consume malformed answers so the user can retry. Forwarding denial reasons requires a separate follow-up message because neither Codex nor ACP includes a reason field in the permission response (Vibe Kanban, LangGraph, OpenAI Agents SDK, AoE).
5. Cancellation flow: after `session/cancel`, answer pending permission requests with `cancelled`, mark open tool calls cancelled, and treat `stopReason: cancelled` as normal rather than an error; restart the session if it fails to stop after a grace period (ACP spec, OpenHands).
6. Call `resume/load/close` only when negotiated in capabilities, ignore unknown update kinds, never treat unknown permission outcomes as approval, and ignore non-JSON lines on stdout (ACP, OpenHands).
7. State detection: reset the idle timer on any `session_update`, use a separate startup timeout, and debounce briefly. A turn result is not necessarily the end of a job; do not wake the lead while background work remains active (OpenHands, Superset, Claude Agent SDK, cmux bugs).
8. Distinguish "definitely not sent" from "delivery uncertain" when dispatching prompts, and never auto-retry uncertain deliveries (Emdash).

**Medium priority: review and prompt quality**
9. Codex review prompt structure: role ("try to falsify confidence"), finding bar, evidence rules, calibration rules, and structured output (file, line range, confidence)—plus "if there are no defensible findings, say so" (`codex-plugin-cc` `adversarial-review.md`).
10. Add a pre-prediction → missing-change check → open-questions separation to reviewer prompts; require fresh command output for approval and never let an agent approve artifacts from its own context (`oh-my-claudecode` `critic.md`, `verifier.md`).
11. Include explicit acceptance criteria ("sprint contract") in delegation prompts and have the reviewer grade against them, running tests and checks rather than only reading the diff (Anthropic harness article).
12. Compare test baselines against post-change failures with deterministic tooling rather than model eyeballing, and forbid rewriting the baseline to make tests pass (OMC `ralph`).
13. Cap fix loops (e.g., max N rounds) and escalate to the user when exceeded (Devin loops, Factory's 4-round cap, `codex-plugin-cc` Stop-gate token warnings).
14. Include explicit worker rules: "report plainly if there is nothing to implement" and "edits outside the worktree will be discarded" (Gas Town).
15. Add a single instruction telling the lead to evaluate review findings critically rather than blindly accepting or rejecting them (PAL `challenge`), balanced against the rule prohibiting automatic application of review suggestions.

**Low priority / optional**
16. A fast path that skips the crew for small tasks (effort sizing) and per-job token display, given ~15x multi-agent token overhead (Anthropic).
17. Show the spec, diff summary, test results, and out-of-scope files for each merge candidate on the board; cap or queue concurrent jobs at 3–5.
18. Two-stage job deletion (trash → permanent delete) and rate-limiting bulk worker restarts (AoE, cmux restore storms).
19. Progressive skill disclosure (short `SKILL.md` with role details in `references/`) and a few replayable scenario tests for `/crew:run` (`wshobson/agents`, `ccpm`).
20. Re-audit pipeline stages whenever underlying models upgrade and drop stages that no longer add value (Anthropic).
21. Keep board card order stable across activity events, and show subagents and background tasks as running until they finish (cmux).
22. Optional Antigravity hooks for state detection: Superset uses `PreInvocation`/`Stop` in `~/.gemini/config/hooks.json` and intentionally omits `PreToolUse` because missing decision output blocks the tool. Since Crew uses ACP, hooks are unnecessary except as a fallback.

## 6. What we will not copy

- Terminal screen-scraping and AutoYes (Claude Squad), LLM auto-approval gates (CCManager), or auto-approving ACP agent permissions (OpenHands).
- Stop-hook review gates that run on every turn (token burn and runaway loops).
- Dozens of agents and watcher hierarchies (Gas Town), 19 agents and 85 skills (OMC), or large persona catalogs (`wshobson/agents`).
- Graph DSLs, handoff-as-tool patterns, A2A agent cards, or MCP OAuth / stateless transport machinery.
- Single-vendor cloud lock-in and closed distribution (the fate of Conductor and Vibe Kanban), or heavy Electron wrappers.
- ACP `fs/*` and `terminal/*` client methods that grant workers direct host access.

## 7. Limitations of this survey

- ACP v2 is a fast-moving draft that changes almost weekly; targeting v1 semantics and gating on advertised capabilities is safer. Whether Codex and Antigravity match every detail above was not verified across all edge cases.
- The cross-model review numbers come from a single preprint; Cognition, Devin, and Factory numbers come from vendor materials.
- Direct Reddit and X threads were largely unavailable, so community sentiment relies on HN and blog posts.
- Several commercial-tool comparison blogs are affiliate-driven and weak evidence.
- Section 8 compares the candidates from section 5 against Crew's codebase. The issue candidates in sections 8.A and 8.B were reproduced with a fake `codex app-server` and temporary repositories; whether live Codex triggers every condition was not verified in all cases (noted per item).

## 8. Comparison of candidates against Crew's code

Checked against `plugin/bridge/`, `plugin/roles/`, `plugin/skills/run/SKILL.md`, `plugin/board/src/`, and `native/Sources/` (initial survey 2026-11-12; updated against current code). Status is rated **Implemented / Partial / None**.

| # | Candidate | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| 1 | Startup orphan job cleanup | Implemented | `load()` in `jobs.ts` marks unfinished jobs `failed` and prompts `reply` to resume; `crew gc` (`gc.ts`) sweeps orphaned worktree slots, missing-worktree Git admin dirs, and merged `crew-*` branches. |
| 2 | Child process reaping | Mostly implemented | The daemon spawns at most one `codex app-server` and one `agy acp`, stops them after 10 minutes idle, and calls `peer.close()` in `shutdown()`. `agy acp` exits child processes on `SIGTERM` (section 11); `SIGKILL` survival for Codex was not verified. |
| 3 | Worktree serialization, retry, safe deletion | Partial | `createWorktree` (`git.ts`) still has no per-repo mutex. Deletion (`jobs.ts`, `gc.ts`) tracks `cleanupPending`, retries held Windows folders at 30 s and 2.5 min, checks paths stay under `home/worktrees`, and verifies `.git` is a file. |
| 4 | Structured approval objects | Partial | `codex.ts` and `antigravity.ts` queue requests in `run.pending` in arrival order, each with UUID `waiting.id`, `since`, `seq`, and duplicate-answer checks. Requests have no timeout; denial reasons use `decision: "decline"` via `turn/steer` (Codex) or next prompt (Antigravity). |
| 5 | Cancellation flow | Implemented | `codex.ts` interrupts child sub-agents, clears `run.pending` as cancelled, sends `turn/interrupt`, and waits 5 s. `antigravity.ts` clears `run.pending`, sends `session/cancel`, waits 5 s, and falls back to `session/close` if advertised. |
| 6 | Capability checks & noise tolerance | Implemented | `rpc.ts` ignores non-JSON lines. `antigravity.ts` reads `sessionCapabilities.resume`, `loadSession`, `sessionCapabilities.close`, and `_meta.antigravity.systemPrompt.append` from `initialize`. |
| 7 | State detection | Implemented | Activity resets the stall timer (`jobs.ts`); `codex.ts` holds parent completion until sub-agents finish (`busyChildren`) and calls `probe()` before waking the lead. `rpc.ts` enforces `RPC_TIMEOUT_MS` (30 s; `THREAD_TIMEOUT_MS` 180 s for Codex thread start/resume). |
| 8 | Uncertain prompt delivery | N/A | Retries are decided explicitly by the lead via `reply`; lost `turn/start` acknowledgements fail the job with a note to check the session (`codex.ts`). |
| 9 | Adversarial review prompt | Partial | `plugin/roles/reviewer.md` has verdict, severity, `[reproduced|read|suspected]`, `path/to/file:line`, `Not verified`, verified-ref rules, and a plain no-findings rule. Confidence scores and calibration rules are absent. |
| 10 | Pre-prediction & missing-change analysis | Partial | `reviewer.md` and `self-reviewer.md` instruct reviewers to derive expected changes from acceptance criteria first and check missing paths; no separate pre-prediction report section or explicit fresh-command gate for approval. |
| 11 | Acceptance criteria | Implemented | Both `delegate` and `review` accept `done_when` (`mcp.ts`, `prompts.ts`), and `delegate` accepts a bridge-run `check` command (`jobs.ts`). |
| 12 | Test baseline diffing | None | Final verification relies on the lead comparing base vs. post-change test IDs (`SKILL.md`). |
| 13 | Fix loop cap | Implemented (docs) | `SKILL.md` caps reviews at two rounds (not enforced in code); `config.ts` enforces `MAX_DEBATE_ROUNDS = 6`. |
| 14 | Worker exit & path rules | Implemented | `engineer.md` instructs workers to report blockers; prompts restrict edits to the worktree, and edits outside targets or worktree appear in `outOfScope` (`jobs.ts`) or are refused (`antigravity.ts`). |
| 15 | Critical evaluation of review findings | Implemented | Step 5 of `SKILL.md`: triage findings, fix what holds up, and explain declined findings to the user. |
| 16 | Skip crew on small tasks; usage display | Implemented | Skipping is allowed by `SKILL.md`. Recorded Codex `tokens` and `tokenUse` appear in `render.ts`, `JobDrawer.tsx`, `JobDetailView.swift`, `Missions.tsx`, and `Overview.tsx` alongside AgentGauge windows (`usage.ts`). |
| 17 | Merge candidate summary & concurrency cap | Partial | `JobDrawer.tsx`, `JobDetailView.swift`, and `describe()` show reports, changed/out-of-scope files, bridge `check` results, and `rounds`. Still no concurrency cap (only `exclusive: true` blocks concurrent jobs during measurements). |
| 18 | Trash-style deletion | None | `discard` immediately runs `worktree remove --force` and `branch -D`; `crew gc` requires `--apply` and only deletes branches with `--branches` when merged. |
| 19 | Rate-limiting bulk restarts | N/A | The daemon never auto-restarts jobs. |
| 20 | Progressive skill disclosure & evals | N/A | `/crew:run` is 121 lines (`SKILL.md`). Unit tests (`test/*.test.ts`) cover bridge modules and board logic. |
| 21 | Board order stability | Implemented | Cards in `Overview.tsx` and `BoardView.swift` stay stable within status/mission groups and no longer reorder Claude sessions on `activeAt`. |
| 22 | Antigravity hooks | Optional | ACP is sufficient; hooks are not needed. |

### A. Issue candidates from the code audit and reproduction results

Initial audit findings (reproduced with a fake `codex app-server`, temporary repositories, and an isolated `CREW_HOME`):

| Candidate | Initial result | Current status |
| --- | --- | --- |
| A-1 Subagent approvals silently declined | **Reproduced** (conditional) | Fixed: `codex.ts` maps `parentThreadId` to the parent job and surfaces child requests as `"Sub-agent request"`. |
| A-1b Overlapping approval requests | **Reproduced** | Fixed: `run.pending` queues requests in arrival order (`codex.ts`, `antigravity.ts`); each uses a unique `waiting.id`. |
| A-2 Worktree and branch leak | **Reproduced** | Fixed: `jobs.ts` keeps worktree-owning and unread jobs past `KEEP_JOBS` (200), and `gc.ts` sweeps orphans. |
| A-3 Stuck `discard` after manual deletion | **Refuted** | Manual dir deletion already worked; locked-ref recovery and path/branch checks were added to `discard` (`jobs.ts`, `git.ts`). |
| A-4 Infinite hang during startup | **Reproduced** | Fixed: `rpc.ts` enforces `RPC_TIMEOUT_MS` (30 s) on `initialize` and kills hung processes; `THREAD_TIMEOUT_MS` is 180 s. |
| A-5 Stall timer while waiting for input | **Reproduced** (low) | Expected while waiting on human input; `NeedsYou.tsx` and `BoardView.swift` show elapsed wait time (`waiting.since`). |
| A-6 Truncated approval command text | **Reproduced** | Fixed: `codex.ts` and `antigravity.ts` show the full command, working directory, and additional permissions (up to bounds). |

### B. Improvement candidates from the code audit

- **B-1 Forwarding denial reasons (Refuted)**: Neither Codex approval responses nor ACP permission responses carry a reason field. Instead, `reply` with `decision: "decline"` steers the waiting Codex turn immediately via `turn/steer`. Antigravity waits for the turn to end before sending a new prompt.
- **B-2 Claude lane card reordering (Reproduced, fixed)**: Replaced the 3-lane `activeAt`-sorted layout with mission/session panels (`Overview.tsx`, `BoardView.swift`) that keep card order stable across activity updates.

### C. Follow-up verification and fixes

Follow-up checks used temporary Git repositories, JSON-RPC stubs, the installed Codex protocol schema, and an Antigravity `1.5.5` handshake (later rechecked on `1.5.9` in section 11). The tests (`test/adapters.test.ts`, `test/adapter-contracts.test.ts`, `test/jobs.test.ts`) cover A-1, A-1b, A-2, A-4, and A-6. Codex child-thread and overlapping-approval traffic was simulated against stubs. Live parent turns ending while child turns are still active require separate evidence. Repository-wide worktree creation mutexes and abrupt `SIGKILL` daemon termination also remain unverified.

## 9. Usability and UX takeaways

Comparing Crew's board (`plugin/board/`) and workflow against the surveyed tools highlights both existing strengths and high-leverage gaps.

### What already works well

- Shows status with a single-word or short badge and color (`Needs approval` / `May be stuck` / `Done`), surfaces waiting items in `Needs You`, and separates finished work into `Recently finished` / `History`.
- Calibrates against server time so timers stay accurate even with clock skew, and displays `Lost the connection to Crew. Reconnecting…` on connection drop.
- Allows answering approvals from either the in-app prompt or the board, invalidating whichever was not used first, and never lets the lead decide on the user's behalf when a prompt is dismissed.
- Offers `Resume Command` (`JobDrawer.tsx`) so the user can pick up any worker or Claude session directly in its native CLI—clearer than almost any surveyed tool.
- Gives the lead ordered review, accept, revise, and cleanup commands in `describe` output.
- Solves Conductor's top early complaint (missing `.env` and dependencies) via `.worktreeinclude`, and stays fast on APFS via copy-on-write clones.
- Fires notifications only on waiting, error, limit, and stall events—keeping completion silent by default to avoid notification fatigue.

### High-impact UX gaps (ordered by impact)

Most of the original UX gaps are now implemented across `plugin/board/src/`, `native/Sources/Crew/`, and `plugin/bridge/`:

1. **Card detail drawer (Implemented)**: Clicking any job or session opens `JobDrawer.tsx` / `JobDetailView.swift` with the report, changed/out-of-scope files, check receipts, rounds, evidence, and job events.
2. **Free-text question answers (Implemented)**: `NeedsYou.tsx` and `Components.swift` (`AnswerView`) include a free-text composer alongside Yes/No buttons, matching the in-app prompt.
3. **Activity feed job identification (Partial)**: `EventList` (`Overview.tsx`, `Components.swift`) adds a `Show job` button linking to the job drawer (`openJob`), though feed lines still do not print the job ID or title inline.
4. **Notifications and tab count (Implemented)**: `notify.ts` focuses and opens the job on click, `App.tsx` prefixes `(N) Crew` to the document title, `daemon.ts` sends Windows toast notifications (`toast.ts`), and `CrewApp.swift` handles macOS native notifications.
5. **Project filtering (Implemented)**: `App.tsx` and `BoardView.swift` filter workspaces by project in the sidebar.
6. **Merge candidate summaries (Implemented in part)**: Job drawers show the full report (including `Verification`), changed/out-of-scope files, bridge `check` results, and per-turn `rounds`.
7. **Cost visibility (Implemented)**: `JobDrawer.tsx`, `JobDetailView.swift`, `Missions.tsx`, `Overview.tsx`, and `render.ts` display Codex token counts and `tokenUse` breakdowns (Antigravity does not report tokens).
8. **Approval context (Implemented)**: `codex.ts` and `antigravity.ts` include full commands, working directories, paths, and permissions.
9. **User confirmation checkpoint in `/crew:run` (Open)**: `/crew:run` still flows from planning into delegation without a plan-confirmation pause (aside from approving one sample first for taste-judged work).
10. **First-run onboarding (Implemented)**: `cli.ts` (`install`, `doctor`), `Overview.tsx` (`Setup`), and `BoardView.swift` (`SetupCard`) guide setup and plugin reloading.
11. **Accessibility and remote access (Partial / Out of scope)**: `Palette.tsx` uses `aria-live="polite"`, while waiting cards still lack an `aria-live` announcement; remote/mobile access remains out of scope.

### UX conclusion

Crew's status display, approval routing, detail drawers, and merge summaries now cover the main review bottleneck identified in the survey. Only inline job labels in the activity feed, `aria-live` on waiting cards, and an optional large-task plan checkpoint in `/crew:run` remain from the original UX list.

## 10. Session features in Claude Code and Codex (2026-11-14)

Checked against code.claude.com docs and Codex CLI 0.167.0 (app-server schema generated locally; GitHub release 0.169.0). Items marked "unverified" were not confirmed by a source.

### What exists

| Feature | Claude Code | Codex |
| --- | --- | --- |
| Fork | `/branch`, `/fork`, `--fork-session`; SDK `forkSession` | `thread/fork` (optionally `ephemeral`), `codex fork` |
| Side question | `/btw` (not added to history) | `/side` (alias `/btw`); whether it is ephemeral is unverified |
| History rewind | — | `thread/revert {beforeTurnId}` drops that turn and all later ones; `thread/rollback` is gone |
| Steer and queue | Messages are read between tool calls | `turn/steer` (needs `expectedTurnId`); `thread/queue/*` (experimental) for the next turn |
| Subagents | Agent tool, `isolation: worktree`, 20 concurrent, depth 3 | `multi_agent` on by default, 6 threads, depth 1; children are threads with `parentThreadId` |
| Cross-session messages | `ListAgents` / `SendMessage` over a per-session Unix socket; plain text, cannot approve prompts | Several clients can attach to one thread through a shared app-server daemon; which client gets a server request is unverified |
| Push into a running session | `asyncRewake` hooks; Channels (MCP push, research preview, `--channels` at launch) | Not applicable: the client drives the thread |
| Remote | Remote Control relays a local session to claude.ai and mobile; cloud sessions, `--teleport` | `codex remote-control` (experimental, pairing from the desktop app), `codex cloud`, WebSocket listener |
| Approvals | Permission prompts; peers cannot answer them | `approvalsReviewer: auto_review`; `thread/approveGuardianDeniedAction` overrides a denial |

### What Crew already matches

- Waking the lead with an `asyncRewake` hook is the documented mechanism.
- Sub-agent threads are tied to their job through `parentThreadId`, and their approval requests reach the user marked "Sub-agent request" ([codex.ts](../plugin/bridge/adapters/codex.ts)), so Codex's `multi_agent` is left on.
- A session that has Remote Control on runs on this machine, so its hooks reach the daemon and the board shows it like any other Claude session (checked 2026-11-14 with a live session). Sessions that run in the cloud send no hooks and are not shown. Crew shows a session's state and phase, not its transcript.

### Adopted

- Undoing a round now tells the worker on its next turn ([daemon-api.md](../docs/daemon-api.md)).

### Candidates, not adopted yet

- Answer a question about a strand from an ephemeral `thread/fork` of that worker, so it has the worker's context and leaves its history unchanged. Cross-review stays a fresh thread (section 4).
- Send a note left on a busy worker with `thread/queue/add`, keeping `turn/steer` for messages meant to change the running turn.
- Read waiting state from `thread/status/changed` (`waitingOnApproval`, `waitingOnUserInput`) instead of inferring it.
- Retry an action the automatic reviewer refused with `thread/approveGuardianDeniedAction` instead of a follow-up message.
- Wake the lead through a Channel for jobs started from the board, which arm no hook. Blocked until Channels leave research preview and work in Claude Desktop.
- Phone notifications through Remote Control and the lead's push notifications, which may cover much of roadmap item L4 without a separate mobile view.

## 11. Orca, rechecked (2026-11-17) and run (2026-11-18)

Checked against `stablyai/orca` at `e39fb3a` (v1.4.261, released 2026-11-16), first by reading a shallow clone and its documentation site. On 2026-11-18 the notarized release was installed and driven through its CLI against a headless runtime (`orca serve`), and `agy` was given real prompts through a small ACP client. What that showed is marked "run" below and replaces the earlier guesses. Metrics are from `gh api`: 126.9k★, MIT, 8,517 open issues, about 34,800 files. Facts about Antigravity marked "live" come from ACP sessions with `agy` 1.5.9 on this machine. Anything else about Antigravity is Orca's reading of it.

### What changed since the first look

[implementation-plan.md](implementation-plan.md) section 8.2 recorded three reasons Orca was not the primary setup. The decision stands. Two of the facts behind it no longer hold.

| Recorded on 2026-11-11 | Now |
| --- | --- |
| Launches agents in terminal panes | Still its default, but a Chat UI drives Codex through `codex app-server` and Antigravity, Cursor, Grok and others through ACP. These are the transports Crew uses. |
| Orchestration is experimental and a role pipeline must be built by hand | Still behind an Experimental setting, and still has no fixed roles or review stages. It now has durable Runs, Tasks with dependencies, Dispatches (one attempt of a Task), a mailbox that wakes the coordinator, and decision gates. |
| No evidence that usage tracking covers Antigravity | It does, by running `agy -p /usage --output-format json`. Crew dropped `agy -p` for the reason in 02's revision log, so this is a reference for AgentGauge at most. |

Orca is a workbench the user sits in: terminals, editor, browser, mobile app, remote hosts, a plugin catalog, and more than 30 agents. Crew stays a small surface beside Claude Desktop (R1, R2), so only the mechanisms below are of interest.

### Antigravity over ACP

Live on `agy` 1.5.9:

- `session/new` returns three config options: `model` (families such as `gemini-4-argon` and `gemini-4-hydrogen`), `thought_level`, and `mode`. The levels belong to the model: Argon offers `low`, `medium`, and `high`, while Hydrogen adds `xhigh`. A model without levels has no `thought_level` option at all, and setting one is refused with `-32602`. So the option has to be read again after the model is set.
- `agentCapabilities._meta.antigravity.systemPrompt.append` is `true`, and the addition takes effect: a session created with `_meta: { antigravity: { systemPrompt: { append } } }` followed a rule given only there, and a control session without it did not. Orca notes that the addition lasts for one activation and sends it again on resume. Here it was still in force after `session/resume` in a new server process with no addition sent, so the resend is a precaution for other versions.
- A question is the agent's `ask_question` tool. To a client that declares no elicitation, it does not arrive as a request at all: the question is printed as text and the turn ends with `end_turn` (which caused a Crew job to finish with a question as its report). To a client that declares `elicitation: { form: {} }`, it arrives as `elicitation/create` with `mode: "form"`, the message "The agent has a question.", and a schema with one property per question (`q1`, the question as `title`, choices under `oneOf` as `{ const, title }`) plus `q1_other` for a written answer. `{ action: "accept", content: { q1: "2" } }` picked a choice, `content: { q1_other: "…" }` gave free text, and `decline` or `cancel` reached the agent as "User Skipped". The `interaction_` permission request Orca handles for servers without forms was not seen on this version.
- A command asks permission with `kind: "execute"`, the command in `rawInput.CommandLine`, and two options (`allow_once`, `reject_once`). After a rejection the turn ended with no text.
- A bogus `GEMINI_API_KEY` in the environment changed nothing: the prompt was answered as usual. Orca's note that an inherited key switches `agy` to key authentication was not reproduced.
- `agy acp` ends the commands it started when it gets SIGTERM: a `sleep` it was running was gone with it. Crew needs no process-tree cleanup for it on macOS.
- `sessionCapabilities` has `resume`, `load`, `close`, `list`, and `additionalDirectories`. `authMethods` includes `gemini-api-key`.

From Orca's source (`src/main/acp/acp-dialects/antigravity-dialect.ts`), not reproduced:

- Command input arrives as `CommandLine`, `command_line`, or `commandLine` depending on the server, and the working directory under five names.
- A failed prompt reads `Cloud Code Assist API error (<status>): <JSON>`; the useful text is `error.message` inside the JSON.
- `session/load` replays the whole conversation, so `session/resume` is preferred. Crew already prefers it.

### Orca in use

Run on 2026-11-18 with Codex 0.167 workers in a scratch repository, through the CLI only.

What it puts in other tools' settings on first start, without asking:

- `~/.claude/settings.json`: hooks for 16 events and a status line, each running a script under `~/.orca/agent-hooks/`. They run in every Claude Code session on the machine and exit early outside Orca. Also `~/.claude/keybindings.json`.
- `~/.codex/hooks.json` with 9 hooks, and matching blocks in `~/.codex/config.toml` that mark its own hooks as trusted.
- `~/.gemini/config/hooks.json` for Antigravity.

Crew writes into none of these ([architecture.md](../docs/architecture.md)). That is the cost of reading agent state from outside the protocol.

What worked as documented:

- A worker started from one command, got a preamble naming its task and the three commands it may send (`ask`, an escalation, `worker_done`), and its report arrived about 18 s later with `outcome: succeeded` and the files it changed.
- `worker_done --outcome failed` came back as a failed Task, distinct from success.
- A worker that ended its turn without `worker_done` raised an escalation ("Worker stopped without reporting") within about 2 s of the turn's end, with its last output attached. While a worker waited for an answer to `ask`, no escalation was raised.
- A Task with an unmet dependency could not be started. Stopping a worker ended its whole process tree, including a command in another process group.

What did not hold up:

- Callers are not authenticated. A process outside Orca that set `ORCA_TERMINAL_HANDLE` was accepted as the coordinator, and one that passed a worker's handle sent a `worker_done` that completed the worker's Task.
- `task-update --status completed` turned a Task its worker had reported failed into a completed one, with no evidence asked. The rule against it is a sentence in the guide.
- A decision gate only blocks the start. Its resolution text did not reach the worker, and the refusal while it was blocked named the wrong remedy.
- The mailbox is read once: mail taken by a stray `check` is gone, and a coordinator Orca does not recognize as an agent is never woken.
- Workers are started with full access (`--dangerously-bypass-approvals-and-sandbox`, `--dangerously-skip-permissions`) by default, so the approval rules below never came into play.
- An Antigravity worker sitting on a first-run prompt was reported "gone" while its process was alive.

Not reached: Antigravity in chat mode (a GUI setting), `stop_unknown`, and the retry breaker.

Two points are principles rather than features. First, Orca separates "stopped" from "could not prove it stopped" and states that silence or a timeout never proves a process exited. Its daemon notes (`src/main/daemon/AGENTS.md`) record 23 defects from treating "cannot tell" as "dead". Crew applies the same rule to a stalled job (`probe` answers working, ended, or unknown) and when replacing a daemon ([client.ts](../plugin/bridge/client.ts)). Second, every state change in Orca goes through one compare-and-set transition, which is what made its refusals consistent in use.

### Candidates against Crew's code

Checked against `plugin/bridge/` and `plugin/roles/` on 2026-11-17. Status is rated as in section 8.

| # | Candidate | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| 1 | Effort for Antigravity (R11) | Implemented 2026-11-18 | A job's effort is set as `thought_level` after the model, at the level the model offers or the nearest lower one, never a higher one. The job shows the level the session reports. Roles and presets may set it, and both settings screens offer it. Checked live: a Hydrogen job asked for `low` ran at `low`. |
| 2 | Role instructions as a system prompt append | Implemented 2026-11-18 | Where the server advertises it, the role goes in `_meta.antigravity.systemPrompt.append` on `session/new` and again on restore, and the first prompt is the task alone. Otherwise it is prefixed as before. Checked live: a job's report followed the role's shape with the role sent only this way. |
| 3 | Questions from Antigravity | Implemented 2026-11-18, differently | The failure was not the one guessed from Orca's source. Without forms, a question ended the turn, and the job finished with the question as its report. Crew now declares form elicitation and puts the question before the user as a waiting question, as it does a Codex worker's. One answer serves the whole form: it picks a choice by its text or number (several, separated by commas, where the form allows), or goes in as the user's own words. Workers are still pointed at `crew.ask_lead` for what the lead can answer. Checked live: a job waited, took "Beta", and acted on it. |
| 4 | API key in the worker's environment | Dropped | Not reproduced on `agy` 1.5.9 with a bogus `GEMINI_API_KEY`, so no warning was added. |
| 5 | Command field names | Implemented 2026-11-18 | `decide` treats `command`, `CommandLine`, `command_line`, and `commandLine` as a command when it checks that an MCP-style title does not disguise one. Only `CommandLine` was seen live. |
| 6 | Outcome declared by the worker | Implemented 2026-11-18, with a check | The work roles' reports open with `## Outcome` and one word: `done`, `partial`, or `blocked`. The bridge keeps it per turn and sets it against what it observed: a failed `check`, or a turn that changed nothing after an action was refused or declined. A heading quoted inside a code block is not a declaration. The lead reads `outcome: done as declared, but …` or `outcome: not declared`, and the detail panel shows it. Unlike Orca's, it cannot be set by hand: only a new turn changes it. Checked live with an Antigravity job. |
| 7 | Lead may decline a worker's request with a reason | Implemented 2026-11-18 | `reply` takes `decision: "decline"` with a required reason, for an approval only. Approving stays the user's. The worker is told the lead declined and why. Codex receives it through `turn/steer` on the waiting turn, sent again once the refusal is released if the first attempt fails, with a note on the job when the reason did not arrive (checked against a stub server only). Antigravity receives it as the next prompt once the refused turn ends, because `agy` 1.5.9 refuses a prompt while a permission is open and ends the turn on a rejection (checked live: the job went on and did what the reason said). |
| 8 | Line-anchored review notes sent as one batch | None | Orca lets the user comment on lines of a diff and sends all comments in one prompt, because notes sent one at a time make the agent go back and forth. Crew's drawer shows the diff stat and a free-text follow-up. This continues section 9's conclusion that review is the bottleneck. |
| 9 | Guides loaded from the running binary | Optional | Orca's installed skill files are short stubs; the guide comes from `orca skills get <name>`, so it always matches the binary, and rarely needed parts are separate references. Crew's MCP instructions already come from the server. `/crew:run` is a static file that can lag the daemon until the plugin is re-registered. |
| 10 | Base drift warning in the worker's prompt | N/A | Orca refuses a dispatch more than 20 commits behind its base and lists the missing commit subjects below that. Crew creates each worktree from `HEAD` at dispatch and has its own sync. |
| 11 | Retry breaker | N/A | Three failed starts in one retry chain fail the Task and may not be routed around. Crew never retries by itself (section 8, row 19). |

### What we will not copy

- Anything that touches sign-in: Orca's own Antigravity sign-in and ACP server, account switching, and sending `zed` as the client name to servers before 1.5.1 so they offer more models. Crew runs the official binary and reads no credentials ([architecture.md](../docs/architecture.md)).
- A setting that lets the coordinator approve worker prompts, and `--dangerously-skip-permissions` for full access.
- Reading agent state from terminal output (per-agent screen rules, OSC 7501). Crew's protocols report state directly.
- Mobile, remote hosts, cloud VMs, a plugin catalog, and support for every CLI agent ([requirements.md](../docs/requirements.md) section 5).

### Limits of this recheck

- Orca was driven through its CLI with Codex workers in terminal mode. Its chat view, and Antigravity inside Orca, were not used.
- The Antigravity sessions used one account and one version (1.5.9). Config options, models, and the question form vary by account and version; the adapter reads them from each session and falls back when they are missing.
- The process cleanup and API key checks were each run once, on macOS.
