# What Crew took from the Codex and Claude Code sources

Research date: **2026-11-25**. Sources read locally from shallow clones: `openai/codex` at `cec14d27` (the machine runs `codex-cli 0.172.0`), `anthropics/claude-code` at `4cc5e8b6` (CHANGELOG through 2.1.332, `mods/types/claude-code.d.ts`, workflows), and `anthropics/claude-plugins-official` (`code-review`, `pr-review-toolkit`, `ralph-loop`, `hookify`, `security-guidance`, `plugin-dev`). Topics: multi-agent orchestration, PR and repository tracking, automation, workflow progress, communication between sessions, permissions, and failure handling. Upstream code was read, never built or run. Facts marked *checked* were confirmed on this machine; the rest come from upstream source and may differ in a release.

## Adopted

| Change | Source | Where in Crew |
| --- | --- | --- |
| A turn Codex interrupts on its own fails the job instead of ending it silently as cancelled. The auto-reviewer's circuit breaker ends a turn as `interrupted`, with `tooManyDenials` only under `auto_review.circuit_break_action = "strict"`, which Crew now sets (*checked*: 0.172 accepts it) | `ext/guardian-reviewer/src/circuit_breaker.rs`, `app-server/src/bespoke_event_handling.rs` | `adapters/codex.ts`, [approvals.md](../docs/approvals.md) |
| Deny on a Codex command answers `decline`, which lets the turn go on; `cancel` aborts the turn, and Codex's default decision list offers only `cancel` | `protocol/src/approvals.rs` `default_available_decisions` | `adapters/codex.ts` |
| Endless connection retries (`willRetry`, on by default) no longer reset the stall clock after the first, so the probe reports that Codex cannot reach the model | `core/src/responses_retry.rs`, `features` `unbounded_connection_retries` | `adapters/codex.ts`, [delivery.md](../docs/delivery.md#stalls) |
| `codexErrorInfo` classified: spend limits are limits, `rateLimitExceeded` is transient (Codex already retried it), object variants are read, and `additionalDetails` is shown | `app-server-protocol/.../v2/shared.rs`, `protocol/src/error.rs` retry policy | `adapters/codex.ts` |
| Codex's built-in review returning "Reviewer failed to output a response." fails | `core/src/tasks/review.rs` | `adapters/codex.ts` |
| Worker threads pin `multi_agent_v2 = false` (Crew's child tracking needs v1; v2 refuses direct input to sub-agents) and turn Codex memories off (*checked*: 0.172 accepts both) | `app-server/src/request_processors/thread_input.rs`, `config/src/types.rs` | `adapters/codex.ts` `LEAN` |
| Review verdicts and finding counts parsed from the reviewer's report, with Codex's `[P0]`–`[P3]` mapped | `prompts/templates/review/rubric.md`, `protocol/src/review_format.rs` | `jobs.ts` `parseReview`, `render.ts` |
| A finished job says whether its branch merges cleanly into the lead's `HEAD` (`git merge-tree --write-tree`), as Codex's apply preflight does | `git-utils/src/apply.rs`, `cloud-tasks-client` | `git.ts` `mergeConflicts`, `render.ts` |
| Worker reports are labeled as the worker's words, as Claude Code labels sub-agent output | CHANGELOG 2.1.277 | `render.ts`, `mcp.ts` |
| Reviewers read `AGENTS.md`/`CLAUDE.md` and quote a broken rule; pre-existing problems are kept apart; linter-level and deliberate behavior is left out | `code-review` plugin, Codex review rubric | `plugin/roles/reviewer.md`, `plugin/agents/self-reviewer.md` |
| Wake-ups name their jobs (`rewakeSummary`) instead of "Stop hook feedback", and head the news as Crew's (`rewakeMessage`) (*checked* in the 2.1.328 binary) | `security-guidance/hooks/hooks.json` | `plugin/hooks/hooks.json`, `wake.ts` |
| Stop news goes as `additionalContext`, without the hook-error label (*checked*: continues the turn, sets `stop_hook_active` on the next Stop) | CHANGELOG 2.1.163 | `wake.ts` |
| `Stop`'s `background_tasks` drops sub-agents whose `SubagentStop` was missed | CHANGELOG 2.1.145, `claude-code.d.ts` | `claude.ts` |

Found on the way (*checked*): with Crew installed, every `claude -p` session hung on `SessionStart`, because Claude Code runs `asyncRewake` hooks in the foreground in print mode and Crew's watcher waits up to a day. The daemon now gives no watcher to a session that leads no job or pull request watch and has no mission open (`delivery.ts` `watch`).

## Tried and rejected

- **`disallowedTools` on the self-reviewer** to block `git stash`, `checkout` and the like. On Claude Code 2.1.328 a subagent whose `disallowedTools` holds `Bash(git stash:*)` lost Bash entirely and refused to start ("would be spawned with zero tools"); the same agent without the list ran. The rule stays in the instructions.

## Candidates not taken now

Ranked by value for effort; each needs a live check first.

1. **Codex sub-agent results.** Crew holds a parent's `turn/completed` until its children settle, but reports the parent's final message, written before they finished; upstream sends a child's result to its parent as queue-only mail (`core/src/agent/control/completion.rs`). One follow-up turn asking the worker to fold in its sub-agents' results would close it.
2. **Graceful budget stop.** Codex's goal budget steers the turn to wrap up (`ext/goal`, `templates/goals/budget_limit.md`) rather than interrupting; Crew's per-turn budget interrupts and leaves no report. A `turn/steer` at about 90% of the cap would get a `partial` outcome first.
3. **`thread/inject_items`** to deliver a note that missed a running turn without starting one, instead of asking the lead to resend.
4. **`acceptForSession`** for Allow for This Job on Codex commands: Codex caches the exact command for the thread. Never `acceptWithExecpolicyAmendment`, which appends a rule to the user's `~/.codex/rules/default.rules` for good.
5. **`thread/approveGuardianDeniedAction`** for `approved_by_user` retries: approves the exact refused action as trusted evidence rather than having the reviewer judge free text again.
6. **One automatic resume after an app-server crash**, capped at one, behind `autoResume`.
7. **Worker plan** from `turn/plan/updated`, shown as text ("3 of 7 steps, as the worker reports"), not as a progress ring.
8. **Opting into `experimentalApi`**: without it app-server strips `additionalPermissions` from command approvals, so a user approves a command without seeing the extra access it asks for.
9. **Git environment scrubbing** (`GIT_DIR`, `GIT_INDEX_FILE` and the rest) and **`NO_HOOKS` on worktree creation**, as `codex-rs/worktree` does; the second changes whether a project's post-checkout hooks run and needs a decision.

## Not for Crew

Codex's message board (shared channels between agents) and Claude Code's agent teams and cross-session `SendMessage` (macOS and Linux only): Crew routes coordination through the lead on purpose. Best-of-N attempts (Codex cloud tasks): costly, and two `delegate` calls do it. `PermissionRequest` auto-answers and `onFailure: "block"`: approvals stay the user's, and Crew's hooks must never block a lead when the daemon is down.
