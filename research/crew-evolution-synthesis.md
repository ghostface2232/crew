# Crew evolution: synthesis of the Claude and Codex research

Date: 2026-11-14. Inputs: the lead's research (the seven linked sources, a commercial-tool survey, an open-source/protocol survey, and a read of Crew at `37d45f9`) and Codex's independent report ([codex-crew-evolution.md](codex-crew-evolution.md), GPT-6 Astra, effort high, 84 sources). Nothing here is implemented.

## 1. Thesis

Both investigations reached the same conclusion: do not add agents, stages, or a scheduler. Crew already has most of the orchestration infrastructure other tools sell (worktrees, structured protocols, approval routing, missions, usage routing, rounds). What sets the next tools apart is **evidence**, **authority**, and **cost discipline**:

- Codex `/goal` lets a goal close only with evidence. Factory milestones end in validation. Claude Code agent teams let a `TaskCompleted` hook veto "done". Antigravity treats artifacts as evidence.
- OpenAI's OpenClaw post and OpenClaw's own docs separate deterministic trusted code from untrusted agents, and keep a record of who authorized each action.
- `/goal` token budgets, Devin's per-child ACU caps, and Cursor's bill-shock complaints all point to budgets enforced by the orchestrator. Crew's own research job for this report used 9.4M tokens (8.9M cached).

## 2. Seven sources: what changes for Crew

| Source | Takeaway | For Crew |
| --- | --- | --- |
| OpenAI, Maintaining software with GPT-6 (2026-10-14) | Recurring maintenance at scale: 1,400+ PRs, 800k lines deleted. Small draft PRs, preserved killswitches, escalation on "Permanent" flags. Same prompt measured at Astra Ultra $0.77/finding, Sol Ultra $0.12, Sol Medium $0.06. Replay an AGENTS.md change on the same snapshot to A/B it | Choose presets by measured cost per accepted outcome (P1-4). Replay A/B for instruction changes |
| OpenAI, Securing persistent agents like OpenClaw (2026-11-12) | Trusted gateway vs untrusted harness. Four sandbox axes (network, workspace, process, secrets). Auto-review to avoid review fatigue. Per-agent identity. Log every turn and config change | Record authorization provenance deterministically. Show each job's effective capabilities (P0-2) |
| OpenAI, Automating repetitive work with Codex (2026-08-25) | Goal cell → plan → approval gate → record every command, output, decision, and dead end. Companion `*.index.md` for discovery | Capture decisions and dead ends at mission end; promote to skills only after review (P2-6) |
| Anthropic, Building effective agents (2024-12-19) | Simplest thing that works. Evaluator-optimizer only with clear criteria. Invest in the tool interface (ACI) | Keep Crew small. Improve tool contracts before adding a DSL |
| Claude Code agent teams (living docs, experimental) | Shared task list with file locks, mailbox, `TaskCompleted`/`TeammateIdle` hooks (exit 2 rejects). Peer messages cannot grant consent. Limits: one team per session, no resume, fixed lead | Borrow a vetoable completion contract. Do not duplicate the native task queue (Crew owns cross-runtime jobs) |
| Anthropic, Multi-agent research system (2025-06-13) | 90.2% better than single-agent, at ~15× chat tokens; coding parallelizes less. Embedded effort-scaling rules. A 20-query eval is enough to start. Artifacts on the filesystem, references passed back | Embed effort scaling in `/crew:run`. Keep artifacts by reference. Start evals small (P1-4) |
| DeepMind Institute, Artificial symbiotic intelligence (2026-09-24) | Collective intelligence lives in institutional templates (roles, procedures, precedent), not in individual agents. Conceptual essay, no evidence | Crew's role table is such a template. What's missing is its **record** (who proposed, checked, authorized, accepted) |

## 3. Other systems: what to borrow

The full tables are in Codex's report section 2 and in the lead's surveys. Only what feeds the proposals is listed here.

| System | Mechanism | Borrow |
| --- | --- | --- |
| Codex `/goal` | Evidence-only completion, token budget, `budget_limited` state, no continuation after a turn without tool calls, fixed-shape blocked report | Job/mission budgets and blocked-report shape (P1-3) |
| Codex Automations | Background worktree, triage inbox, runs with no findings auto-archived | Later, for recurring missions (section 6) |
| Factory Missions | Milestone → validation; fresh worker per feature; validators only report | Bind validation to the delivered content (P0-1) |
| Devin Managed Devins | ACU cap per child; coordinator is notified, never polls; successful sessions turned into skills | Budgets (P1-3), skill promotion (P2-6) |
| Antigravity Agent Manager | Artifacts as evidence with document-style comments | Evidence in the job detail view (P0-1) |
| OpenClaw | "No decision" is not allow; exact-fingerprint allow-always; agents told not to work around a denial; `sandbox explain`; batch-settle yield handoff; snapshot before removing a worktree | P0-2, P2-5 |
| Agent Orchestrator (OrchestratorInc) | Same transports as Crew (`codexappserver`, `agyacp`); facts → derived status; ACP/app-server history replay tests | Golden-transcript replay tests (P1-3) |
| Claude Managed Agents | Append-only session log, stateless harness, `wake(sessionId)` | Recovery receipts (P1-3) |
| MCP 2026-07-28 | Stateless, Tasks as an extension, MRTR replaces server requests, sampling deprecated | Probe host support only (P2-7) |
| Agent Skills (agentskills.io) | `SKILL.md` + progressive disclosure, shared across hosts | Export format for runbooks (P2-6) |
| OTel GenAI agent spans | `invoke_workflow` / `invoke_agent` / `execute_tool` | Optional, once evals exist |

Corrections Codex found in Crew's earlier docs: Conductor's cloud shutdown was reversed (0.94.2 changelog). Jules went read-only after 2026-11-11, per the official changelog (the lead's survey still described it as active; Codex's reading of the official source wins). AutoGen is archived in favor of Microsoft Agent Framework. [06-roadmap.md](../docs/06-roadmap.md) section 6 should be updated.

## 4. Where the two reports agree and differ

| Topic | Claude | Codex | Synthesis |
| --- | --- | --- | --- |
| Evidence-bound acceptance | P0 | E1 P0 | **Agree, P0** |
| Authorization provenance | P0, with a concrete check (below) | E2 P0, labels provenance honestly | **Agree, P0**: verify the quote instead of only labeling it |
| Recovery and replay tests | P1 | E3 P1 | **Agree, P1** |
| Outcome evals for presets | P1, plus cheap in-production signals | E5 P1, controlled replay | **Agree, P1**: collect production signals first, add replays after |
| Runbook → skill export | P2 | E6 P2 | **Agree, P2** |
| MCP 2026-07-28 | Probe only | E4 P1 (probe 1–2 days, then implement) | **P2, probe only**: Claude Code's support is unverified |
| Budgets / cost caps | **P1** | Not proposed | Lead's addition. Directly supported by `/goal`, Devin, Cursor, and this job's 9.4M tokens |
| Batch-settle wakeup | P2 | Not proposed | Lead's addition, small |

## 5. Prioritized proposals

### P0-1. Turn receipts: bind checks and reviews to the content they covered

- **Problem.** `done_when` is free text ([prompts.ts](../plugin/bridge/prompts.ts) lines 83–102). A worker reports "tests pass" only in prose in `Job.report`. After a sync, undo, or fix turn, nothing marks an earlier review as stale ([jobs.ts](../plugin/bridge/jobs.ts) `Round`).
- **Design.**
  1. Add an optional `check` (command) to `delegate`/`review`. When a turn ends, **the bridge itself** runs it in the worktree and records the exit code and a bounded, redacted output tail. Keep "runner-observed" apart from "agent-reported".
  2. Per turn, store `{base/head SHA or dirty-tree hash, criteria version, check results, review target SHA, verdict}`.
  3. Mark coverage stale on any new commit, sync, or undo.
  4. Show coverage and unknowns in the web `JobDrawer` and the native `JobDetailView`.
  5. Records from before the change are migrated as "unknown", never "passed".
- **Effort.** 6–9 days (Codex estimate).
- **Risks.** Secrets in output, long logs, false confidence from a green check.
- **Success.** In 10 real handoffs, the checked revision, failures, and unknowns are identifiable without opening a transcript.

### P0-2. Authorization provenance verified, not asserted

- **Problem.** `retryRefused()` ([jobs.ts:659](../plugin/bridge/jobs.ts)) accepts any non-empty `approved_by_user` and tells the worker "the user approved". Nothing checks that the user said those words. This is a trust-boundary gap, not a reproduced exploit.
- **Design.**
  1. The daemon already receives each prompt through the `UserPromptSubmit` hook ([claude.ts:72](../plugin/bridge/claude.ts)). Keep a bounded, memory-only window of the lead session's recent prompts.
  2. Accept `approved_by_user` only when it is a (normalized) substring of one of them. Record the matched prompt's event id and timestamp as provenance.
  3. On a mismatch, ask the user directly instead of refusing.
  4. Add OpenClaw's rules to the worker role prompts: "no decision is not an allow" and "do not work around a denial; pick a materially safer alternative or ask".
  5. At dispatch, record and show each job's effective capability profile: sandbox mode, writable roots, network, plugins, MCP servers. Show "unknown" where it cannot be introspected.
- **Effort.** 3–5 days.
- **Risks.** Prompts held in memory (never persist them). Paraphrased quotes failing the match (fall back to asking the user).
- **Success.** A fabricated quote cannot cause a retry. Already-authorized retries add no extra interruption.

### P1-3. Budgets, recovery receipts, golden-transcript replays

- **Budgets.**
  1. Add optional `budget_tokens` to `delegate`/`review` and a mission-level budget.
  2. When it runs out, stop at a turn boundary in a `budget_limited` state. Have the worker report what it tried, the evidence, the blocker, and the input it needs (the `/goal` shape).
  3. Have `route` and presets propose defaults.
  4. Effort: 2–3 days.
- **Recovery receipts.**
  1. Before each significant transition, persist the runtime version, session/turn ids, dispatch acknowledgement, last event, open request ids, and artifacts.
  2. After a restart, say what is known and what may have executed. Never replay automatically.
  3. Effort: 5–8 days (Codex E3).
- **Golden replays.** Record real `codex app-server` and `agy acp` JSON-RPC transcripts and replay them through the bridge, as Agent Orchestrator does in `controller_acp_replay_test.go`. This extends `test/fake-bin.ts`. Required cases: lost acknowledgement, out-of-order events, child approvals, parent done with children active, cancel during elicitation.

### P1-4. Measure before adding orchestration

1. **Production signals first, nearly free.** For each mission, record cross-review findings and the lead's disposition (accepted, declined, reason), whether polish was accepted, the number of fix rounds, and tokens per role. In time this answers whether cross-review or polish is earning its cost (see [05-related-work.md](../docs/05-related-work.md) section 4).
2. **Then controlled replays.** Run 8–12 frozen scenarios (Codex E5), with an LLM judge plus human spot checks (Anthropic). Change one preset or stage at a time.
3. **Success.** Every default-preset change ships with matched outcomes and total cost. Removing a stage that adds nothing counts as success.

### P2-5. Batch-settle wakeup

Today each `delegate` call arms its own `wake.ts` watcher, so N parallel jobs wake the lead N times. When the lead starts a batch in one step, wake it once after all the jobs settle (or one needs a decision), and fence out stale completions (OpenClaw yield handoff). This saves lead tokens and matches the review rule "wait until all reviewers report". Effort: 1–2 days.

### P2-6. Mission runbook export → reviewed skill

1. On `mission done`, have the lead record decisions, dead ends, and environment prerequisites in mission notes (the Runme pattern).
2. On request, export them as Agent Skills–format Markdown.
3. A skill enters shared instructions or the skill catalog only after review.
4. Effort: 3–5 days, after P0-1.

### P2-7. MCP 2026-07-28 probe

Both MCP entry points advertise protocol versions only up to `2025-11-25` ([mcp.ts:585](../plugin/bridge/mcp.ts), [worker-mcp.ts:57](../plugin/bridge/worker-mcp.ts)). Spend 1–2 days checking which revisions the Claude Code and Codex hosts actually negotiate. Implement Tasks/MRTR only once a host needs them.

## 6. Deliberately not now

- **Unattended recurring maintenance** (Automations, Routines, OpenClaw heartbeat). This is the most attractive next step, but it waits for P0-1 and P1-3: unclear completion and uncertain side effects get worse with no one watching. Later, build it on the Codex Automations pattern: a background worktree, a triage inbox, and auto-archive for runs with no findings.
- **A general framework or graph DSL** (LangGraph, CrewAI, ADK).
- **More reviewers or voting.** A third reviewer adds little ([05-related-work.md](../docs/05-related-work.md) section 4).
- **Duplicating Claude Code agent teams' task queue.** It is experimental, the lead is fixed, and it does not span runtimes.
- **Automatically promoting transcripts or web pages into instructions.**
- **A2A federation, MCP sampling, or a Jules adapter.**
- **Vendor leaderboards from anecdotes.**

## 7. Suggested order

P0-2 (smallest, closes a trust gap) → P0-1 → P1-3 budgets → P1-4 production signals → P1-3 recovery and replays → P2 items. Reassess recurring missions after P1.
