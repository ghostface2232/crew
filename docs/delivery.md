# Delivery

The daemon keeps news for the lead and uses Claude Code hooks to wake an idle session when a job finishes or needs attention. Lead tools and hook digests offer the news until the lead echoes a receipt.

**Key files:** `plugin/bridge/daemon.ts`, `mcp.ts`, `wake.ts`, `report.ts`, and `context.ts`. See [jobs.md](jobs.md) for lead tools, [missions.md](missions.md#pull-requests) for PR watches, and [daemon-api.md](daemon-api.md) for hook authentication and event formats.

## News and ownership

The daemon owns delivery state in `jobs.json`. Each job records the starting MCP server's `CLAUDE_CODE_SESSION_ID` as `lead`. Board and legacy jobs start unowned. When a session acts on a job through a Crew tool, the MCP server or wake hook adopts it before offering news. Completions, failures (including restart recovery), lead questions, decision requests, and updates from [watched pull requests](missions.md#pull-requests) append immutable `News` snapshots with a per-subject `newsSeq`. Routine progress does not create news.

## Receipts and leases

Only an echoed receipt acknowledges news. Every lead tool accepts `ack: "<receipt>"` or an array of receipt IDs and applies them before doing work or offering new news. Tool responses and hook digests only offer news. Receipts bind to exact `(jobId, newsSeq)` snapshots (`jobId` also holds pull-watch IDs), remain valid after the offering lease expires, and validate session ownership and revisions. `ackedSeq` tracks the contiguous acknowledged prefix, and `delivered` projects it onto event sequence numbers for legacy readers (`/delivered` no longer accepts sequence ACKs). Delivery mutations flush synchronously and roll back on save failure.

- **Offering and watcher leases.** Automatic offers share one 30-second offering lease per session and retry each news item at most twice, even across crashes or restarts. Explicit tool reads issue receipts without spending that budget. One watcher lease per session lasts 60 seconds, renews during polling, and is bounded by the hook deadline. New watchers exit if a healthy watcher exists, replace one within 15 seconds of its deadline, or take over after 25 seconds of silence (or immediately if a long poll disconnects early). Generation tokens fence replaced watchers.

## Hooks and response bounds

- **Hooks.** `SessionStart` (`startup`, `resume`, `clear`, `compact`), `PostToolUse`/`PostToolUseFailure` on Crew tools, and `Stop` arm `wake.ts watch` with `asyncRewake` (needed on `SessionStart` because Desktop can end idle processes under memory pressure). Synchronous `Stop` offers pending news with exit code 2 unless `stop_hook_active` is set. `SessionStart` and `UserPromptSubmit` inject a bounded summary of pending IDs (and open missions on `SessionStart`) via `additionalContext` without offering or acknowledging. All hooks authenticate with `~/.crew/token`, including `/api/hooks/claude`.
- **Timeout.** Hook timeout is 86,400 seconds (`HOOK_SECONDS`), and the watcher exits 10 seconds earlier. Killed hooks do not re-arm themselves. Persisted news remains recoverable via the next hook, `status`, or the board.
- **Response bounds.** Digests hold at most 8 snapshots (`OFFER_ITEMS`), and every MCP tool response fits within 32 KiB (`LEAD_BYTES`). Tool text takes at most 24,000 bytes (`LEAD_TEXT_BYTES`) and a report page 16,000 (`REPORT_PAGE_BYTES`), leaving omitted images on the board and in the evidence list. Read long reports with `status(job_id, report_offset: 0)` using the returned UTF-16 offset (never splitting surrogate pairs) and optional `turn`.

## Stalls

For stall detection (requirement R5), a running job silent for `stallSeconds` (default 5 minutes) is marked `stalled` immediately and probed if supported. For Claude sessions, the stall timer runs only when neither the main loop nor any active sub-agent is inside a tool call.

Codex implements `probe` by reading runtime status with `thread/read` (sub-agents first) and re-reading non-active threads after 3 seconds. Active turns clear the stall silently, ended sub-agents stop blocking parent completion, and certainly-ended parents without `turn/completed` fail the job (producing failure news). Inconclusive checks or adapters without `probe` emit one `stalled` news item per stall.

## Quota events and system notifications

- Quota exhaustion emits a `limit` event from Codex `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`), Antigravity error text, or Claude `StopFailure` (`rate_limit` or `billing_error`).
- `waiting`, `error`, `limit`, and `stalled` (plus `done` when `notifyOnDone` is true) trigger system notifications via `osascript` on macOS or a Windows PowerShell 5.1 toast under Crew's own app identity on Windows (suppressed for waiting/completion while the native desktop app holds a heartbeat lease).

## Not verified

- Verify the finite hook timeout and `asyncRewake` behavior on the installed Claude Code/Desktop host before relying on that lifetime.

## Tests

Related tests include `test/delivery.test.ts`, `test/claude.test.ts`, `test/mcp.test.ts`, and `test/toast.test.ts`. See [architecture.md](architecture.md#tests) for the live `asyncRewake`, Remote Control, and Windows toast checks.

## History

- 2026-11-16: Windows bridge parity added Windows toasts, verified on Windows 11.
