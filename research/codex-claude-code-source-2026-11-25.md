# What Crew took from the Codex and Claude Code sources

Research date: **2026-11-25**. Sources were read locally from shallow clones: `openai/codex` at `cec14d27` (this machine runs `codex-cli 0.172.0`), `anthropics/claude-code` at `4cc5e8b6` (CHANGELOG through 2.1.332, `mods/types/claude-code.d.ts`, and workflows), and `anthropics/claude-plugins-official` (`code-review`, `pr-review-toolkit`, `ralph-loop`, `hookify`, `security-guidance`, and `plugin-dev`). Topics covered multi-agent orchestration, PR and repository tracking, automation, workflow progress, cross-session communication, permissions, and failure handling. Upstream code was read only, never built or run. Facts marked *checked* were confirmed on this machine; all others come from upstream source and may differ in a release.

## Adopted

| Change | Source | Where in Crew |
| --- | --- | --- |
| A turn Codex interrupts on its own now fails the job instead of ending silently as cancelled. The auto-reviewer's circuit breaker ends a turn as `interrupted` and attaches `tooManyDenials` only under `auto_review.circuit_break_action = "strict"`. Crew now sets that option (*checked*: 0.172 accepts it). | `ext/guardian-reviewer/src/circuit_breaker.rs`, `app-server/src/bespoke_event_handling.rs` | `adapters/codex.ts`, [approvals.md](../docs/approvals.md) |
| Deny on a Codex command answers `decline` so the turn can continue. `cancel` aborts the turn, and Codex's default decision list offers only `cancel`. | `protocol/src/approvals.rs` `default_available_decisions` | `adapters/codex.ts` |
| Endless connection retries (`willRetry`, on by default) no longer reset the stall clock after the first retry. The stall probe then reports that Codex cannot reach the model. | `core/src/responses_retry.rs`, `features` `unbounded_connection_retries` | `adapters/codex.ts`, [delivery.md](../docs/delivery.md#stalls) |
| `codexErrorInfo` is now classified: spend limits map to limits, and `rateLimitExceeded` is treated as transient because Codex already retried it. Object variants are read, and `additionalDetails` is shown. | `app-server-protocol/.../v2/shared.rs`, `protocol/src/error.rs` retry policy | `adapters/codex.ts` |
| When Codex's built-in review returns "Reviewer failed to output a response.", Crew treats it as a failure. | `core/src/tasks/review.rs` | `adapters/codex.ts` |
| Worker threads pin `multi_agent_v2 = false` and turn Codex memories off (*checked*: 0.172 accepts both). Crew's child tracking needs v1 because v2 refuses direct input to sub-agents. | `app-server/src/request_processors/thread_input.rs`, `config/src/types.rs` | `adapters/codex.ts` `LEAN` |
| Review verdicts and finding counts are parsed from the reviewer's report, with Codex's `[P0]`–`[P3]` tags mapped. | `prompts/templates/review/rubric.md`, `protocol/src/review_format.rs` | `jobs.ts` `parseReview`, `render.ts` |
| A finished job reports whether its branch merges cleanly into the lead's `HEAD` using `git merge-tree --write-tree`, matching Codex's apply preflight. | `git-utils/src/apply.rs`, `cloud-tasks-client` | `git.ts` `mergeConflicts`, `render.ts` |
| Worker reports are labeled as the worker's words, as Claude Code labels sub-agent output. | CHANGELOG 2.1.277 | `render.ts`, `mcp.ts` |
| Reviewers read `AGENTS.md` and `CLAUDE.md` and quote any broken rule. Pre-existing problems are kept separate, and linter-level or deliberate behavior is left out. | `code-review` plugin, Codex review rubric | `plugin/roles/reviewer.md`, `plugin/agents/self-reviewer.md` |
| Wake-ups name their jobs in `rewakeSummary` instead of showing "Stop hook feedback". They also head the news as Crew's via `rewakeMessage` (*checked* in the 2.1.328 binary). | `security-guidance/hooks/hooks.json` | `plugin/hooks/hooks.json`, `wake.ts` |
| Stop news is sent as `additionalContext`, without the hook-error label (*checked*: continues the turn and sets `stop_hook_active` on the next Stop). | CHANGELOG 2.1.163 | `wake.ts` |
| `Stop`'s `background_tasks` clears sub-agents whose `SubagentStop` was missed. | CHANGELOG 2.1.145, `claude-code.d.ts` | `claude.ts` |

Found on the way (*checked*): with Crew installed, every `claude -p` session hung on `SessionStart`. In print mode, Claude Code runs `asyncRewake` hooks in the foreground, and Crew's watcher waits up to a day. The daemon now gives no watcher to a session that leads no job or pull request watch and has no open mission (`delivery.ts` `watch`).

## Tried and rejected

- **`disallowedTools` on the self-reviewer** to block `git stash`, `checkout`, and similar commands. On Claude Code 2.1.328, a subagent with `Bash(git stash:*)` in `disallowedTools` lost Bash entirely and refused to start ("would be spawned with zero tools"). The same agent ran without that list, so the rule stays in the instructions.

## Candidates not taken now

Ranked by value for effort; each needs a live check first.

1. **Codex sub-agent results.** Crew holds a parent's `turn/completed` until its children settle, yet still reports the parent's final message written before they finished. Upstream sends a child's result to its parent as queue-only mail (`core/src/agent/control/completion.rs`). One follow-up turn asking the worker to fold in its sub-agents' results would close this gap.
2. **Graceful budget stop.** Codex's goal budget steers the turn to wrap up (`ext/goal`, `templates/goals/budget_limit.md`) rather than interrupting. Crew's per-turn budget interrupts and leaves no report. Sending `turn/steer` at about 90% of the cap would collect a `partial` outcome first.
3. **`thread/inject_items`** to deliver a note that missed a running turn without starting a new turn, instead of asking the lead to resend it.
4. **`acceptForSession`** for Allow for This Job on Codex commands: Codex caches the exact command for the thread. Never use `acceptWithExecpolicyAmendment`, which permanently appends a rule to the user's `~/.codex/rules/default.rules`.
5. **`thread/approveGuardianDeniedAction`** for `approved_by_user` retries: it approves the exact refused action as trusted evidence instead of having the reviewer judge free text again.
6. **One automatic resume after an app-server crash**, capped at one and gated behind `autoResume`.
7. **Worker plan** from `turn/plan/updated`, shown as text ("3 of 7 steps, as the worker reports") rather than a progress ring.
8. **Opting into `experimentalApi`**: without it, app-server strips `additionalPermissions` from command approvals. A user then approves a command without seeing the extra access it asks for.
9. **Git environment scrubbing** (`GIT_DIR`, `GIT_INDEX_FILE`, and related variables) and **`NO_HOOKS` on worktree creation**, matching `codex-rs/worktree`. Using `NO_HOOKS` changes whether a project's post-checkout hooks run and needs a decision first.

## Not for Crew

Codex's message board (shared channels between agents) and Claude Code's agent teams and cross-session `SendMessage` (macOS and Linux only): Crew routes coordination through the lead on purpose. Best-of-N attempts (Codex cloud tasks): costly, and two `delegate` calls do the same job. `PermissionRequest` auto-answers and `onFailure: "block"`: approvals stay with the user, and Crew's hooks must never block a lead when the daemon is down.
