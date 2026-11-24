# Delivery

The daemon keeps news for the lead and uses Claude Code hooks to wake an idle session when a job finishes or needs attention. Lead tools and hook digests offer the news until the lead echoes a receipt.

**Key files:** `plugin/bridge/daemon.ts`, `mcp.ts`, `wake.ts`, `report.ts`, `context.ts`, and `codex-lead.ts`. See [jobs.md](jobs.md) for lead tools, [missions.md](missions.md#pull-requests) for PR watches, and [daemon-api.md](daemon-api.md) for hook authentication and event formats.

## News and ownership

The daemon owns delivery state in `jobs.json`. Each job records the starting MCP server's `CLAUDE_CODE_SESSION_ID` as `lead`. Board and legacy jobs start unowned; when a session acts on a job through a Crew tool, the MCP server or wake hook adopts the job before offering news. Completions, failures (including restart recovery), lead questions, decision requests, and updates from [watched pull requests](missions.md#pull-requests) append immutable `News` snapshots with a per-subject `newsSeq`. Routine progress does not create news.

## Receipts and leases

Only an echoed receipt acknowledges news. Every lead tool accepts `ack: "<receipt>"` or an array of receipt IDs, applying acknowledgements before doing work or offering new news. Tool responses and hook digests only offer news. Receipts bind to exact `(jobId, newsSeq)` snapshots (`jobId` also holds pull-watch IDs), remain valid after the offering lease expires, and validate session ownership and revisions. `ackedSeq` tracks the contiguous acknowledged prefix, and `delivered` projects it onto event sequence numbers for legacy readers (`/delivered` no longer accepts sequence ACKs). Delivery mutations flush synchronously and roll back on save failure.

- **Offering and watcher leases.** Automatic offers share one 30-second offering lease per session and retry each news item at most twice, even across crashes or restarts. Explicit tool reads issue receipts without spending that budget. Each session has one watcher lease that lasts 60 seconds, renews during polling, and is bounded by the hook deadline. New watchers exit if a healthy watcher exists, replace one within 15 seconds of its deadline, or take over after 25 seconds of silence (or immediately if a long poll disconnects early). Generation tokens fence replaced watchers.

## Hooks and response bounds

- **Hooks.** `SessionStart` (`startup`, `resume`, `clear`, `compact`, `fork`), `PostToolUse`/`PostToolUseFailure` on Crew tools, and `Stop` arm `wake.ts watch` with `asyncRewake` (needed on `SessionStart` because Claude Desktop can end idle processes under memory pressure). Synchronous `Stop` offers pending news with exit code 2 unless `stop_hook_active` is set. `SessionStart` and `UserPromptSubmit` inject a bounded summary of pending IDs (and open missions on `SessionStart`) via `additionalContext` without offering or acknowledging. All hooks authenticate with `~/.crew/token`, including `/api/hooks/claude`. A forked session (`/branch`, `/fork`, `--fork-session`) gets its own session ID and starts with none of its parent's jobs or missions, since the parent may go on working. It takes over a job only when one of its Crew calls names that job.
- **Timeout.** Hook timeout is 86,400 seconds (`HOOK_SECONDS`), and the watcher exits 10 seconds earlier. Killed hooks do not re-arm themselves. Persisted news remains recoverable via the next hook, `status`, or the board.
- **Response bounds.** Digests hold at most 8 snapshots (`OFFER_ITEMS`), and every MCP tool response fits within 32 KiB (`LEAD_BYTES`). Tool text is capped at 24,000 bytes (`LEAD_TEXT_BYTES`) and a report page at 16,000 bytes (`REPORT_PAGE_BYTES`), leaving omitted images on the board and in the evidence list. Read long reports with `status(job_id, report_offset: 0)` using the returned UTF-16 offset (never splitting surrogate pairs) and optional `turn`.

## Codex leads

A Codex session leads with the same lead tools, but Codex has no hook that can start a turn later, so the daemon wakes it instead (`codex-lead.ts`). Host facts are in [mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host).

- **Which sessions.** The lead MCP server learns its session from each tool call's `_meta.sessionId`, the root thread, which a subagent's calls name too. The server's first call sends `POST /api/lead/hello` with `host: "codex"`, and the daemon records the session in the delivery state's `hosts`, which is saved with the receipts. Recording a session drops the ones that lead no job or pull request and have said no hello for a week. A session not listed there is a Claude session that wakes itself. Calls that arrive together share one hello. A failed hello fails the call, and the next call tries again, because a session the daemon does not know is never woken. A Codex call without `_meta.sessionId` is refused rather than taken for the last session. A server whose session changes starts the new one with no mission tracking from the old.
- **Waking.** For each Codex-hosted session with unacknowledged news, the daemon takes an automatic offer, under the same 30-second lease as a hook watcher. It then runs `codex queue --thread <session> --message <note>`. A queued note stays in Codex until the thread runs it, so news it named is not offered automatically again; a second note would only cost the lead an empty turn. A failed command gives the offer back and is tried again 30 seconds later, doubling up to every 10 minutes while it keeps failing, so the news can still wake the lead once Codex recovers. A session keeps its record for a week after its last hello even before its first job. An open TUI or desktop thread that is idle runs the note as its next turn; a note queued during a turn waits for that turn to end. The note only names the subjects ("Crew has news for cx-…. Call the Crew status tool…"), and the lead reads the news with `status`, which offers it again with a fresh receipt. Windows runs `codex` through cmd.exe, which cannot pass the line breaks, quotes and percent signs an offer's text has. With no open session, the note stays in Codex's queue. On Codex 0.172 a thread whose last turn was interrupted held its queue until the user's next turn, even once resumed ([mcp-compatibility.md](mcp-compatibility.md#5-codex-as-a-lead-host)); the UserPromptSubmit hook names the waiting news on that turn.
- **Hooks.** `plugin/hooks/codex.json` runs `context.ts` and `wake.ts context` on `SessionStart`, `wake.ts context` on `UserPromptSubmit`, and `wake.ts stop-json` on `Stop`. `stop-json` offers pending news as the JSON decision `{"decision":"block","reason":…}` rather than exit code 2, which pwsh does not pass on. Codex runs these hooks only after the user trusts them in `/hooks`; until then a Codex lead still gets the queued notes, but no news at the end of a turn or in its context.

## Stalls

For stall detection (requirement R5), a running job silent for `stallSeconds` (default 5 minutes) is marked `stalled` immediately and probed if supported. For Claude sessions, the stall timer runs only when neither the main loop nor any active sub-agent is inside a tool call.

Codex implements `probe` by reading runtime status with `thread/read` (sub-agents first) and re-reading non-active threads after 3 seconds. Active turns clear the stall silently, ended sub-agents stop blocking parent completion, and parents confirmed ended without `turn/completed` fail the job (producing failure news). Inconclusive checks or adapters without `probe` emit one `stalled` news item per stall.

## Quota events and system notifications

- Quota exhaustion emits a `limit` event from Codex `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`), Antigravity error text, or Claude `StopFailure` (`rate_limit` or `billing_error`). A Codex turn ended with `tooManyDenials` is an ordinary failure, not a limit: its message says that refusals stopped the turn and, when the turn's refusals were recorded, that they are listed with the job.
- `waiting`, `error`, `limit`, and `stalled` (plus `done` when `notifyOnDone` is true) trigger system notifications via `osascript` on macOS or a Windows PowerShell 5.1 toast under Crew's own app identity on Windows (suppressed for waiting/completion while the native desktop app holds a heartbeat lease).

## Not verified

- Codex leads, as reviewed but not tested:
  - When a Codex lead's MCP server is the first client to start the daemon, the daemon inherits the filtered environment Codex gives MCP servers. On Windows 0.170 that was the system variables, `APPDATA`, `LOCALAPPDATA`, `USERPROFILE`, `TEMP` and `PATH`; on macOS only `HOME` and `PATH`. A custom `CODEX_HOME`, proxy settings or `CREW_*` variables then do not reach that daemon or its workers until it restarts from another client.
  - That daemon also runs from Codex's copy of the plugin, which a source checkout of the same version does not replace until `crew daemon restart`.
  - On Windows a `codex queue` command that times out stops `cmd.exe` but may leave `codex` running.
- Verify the finite hook timeout and `asyncRewake` behavior on the installed Claude Code/Desktop host before relying on that lifetime.

## Tests

Related tests include `test/delivery.test.ts`, `test/claude.test.ts`, `test/mcp.test.ts`, `test/codex-lead.test.ts`, and `test/toast.test.ts`. See [architecture.md](architecture.md#tests) for the live `asyncRewake`, Remote Control, and Windows toast checks.

## History

- 2026-11-24: Codex sessions can lead. The daemon wakes them with `codex queue`, and their Stop hook answers in JSON. Verified end to end on Windows 11 with Codex CLI 0.170.0; `codex queue` was also verified on macOS, for the TUI and the desktop app.

- 2026-11-16: Windows bridge parity added Windows toasts, verified on Windows 11.
