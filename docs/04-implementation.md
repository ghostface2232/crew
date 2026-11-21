# 04. Implementation Notes

Records the implemented bridge, status board, and desktop architecture built from [02-implementation-plan.md](02-implementation-plan.md), along with changes from the plan and why. AgentGauge usage and routing, presets, rounds, intents, roles, model scores, and peer ratings live in [09-usage-presets-rounds.md](09-usage-presets-rounds.md).

Baseline external-tool checks (2026-11-11): Claude Code 2.1.321, Codex CLI 0.167.0, Antigravity CLI 1.5.5, and Node.js 24.22.1; later Windows checks used Codex CLI 0.166.0 and Git for Windows 2.53.

## 1. Architecture

```
Claude Code (Desktop or CLI) ── Lead
  │ stdio MCP                    │ Command hooks (authenticated HTTP)
  ▼                              ▼
plugin/bridge/mcp.ts ──HTTP──▶ Crew Daemon (127.0.0.1:47615)
                                 ├─ codex app-server   (Codex)
                                 ├─ agy acp            (Antigravity)
                                 ├─ Event log ~/.crew/events.jsonl
                                 └─ Status board (SSE) http://127.0.0.1:47615
```

- One long-lived daemon owns worker processes, job state, event log, and status board. The MCP server (`plugin/bridge/mcp.ts`) is a thin client, so jobs survive Claude session restarts or compaction and multiple sessions share one board.
- The daemon starts automatically on the first MCP or CLI call and replaces itself when idle if `plugin/bridge/` file hashes differ on disk (so source edits apply without bumping versions). Replacement sends `POST /api/shutdown` with `ifIdle: true`; the daemon returns `409` while any mutating POST is in flight or a job is active (running, waiting, starting, syncing, changing rounds, or being discarded). A daemon from another folder is replaced only by a newer version.
- `crew daemon stop` and `restart` stop the daemon unconditionally. If shutdown goes unanswered, they send `SIGTERM` to the PID in `~/.crew/daemon.json` only if it matches the listener reported by `/api/health`, retry briefly if the PID file is missing, and remove the file after a forced stop only if it still names that PID (Windows `SIGTERM` bypasses shutdown). Replacement never spawns a new daemon while the old listener is up, and `restart` verifies `~/.crew/token` is accepted before reporting "running".
- The daemon binds its port before reading or writing any state, so a concurrent loser exits without creating a token, loading jobs, or clearing active scratch directories and review snapshots. If the system reserves a port with nothing listening (such as WSL mirrored networking's 4096-port blocks), the daemon steps down `PORTS` in `config.ts`; clients, hooks (`bridge/report.ts`), and desktop apps read the bound port from `~/.crew/daemon.json`.
- Everything ships in one Claude Code plugin (`plugin/`) containing the MCP server, hooks, 4 skills, 1 subagent (`self-reviewer`), and 9 role files.

## 2. Tools used by the lead

| Tool | Behavior |
| --- | --- |
| `delegate` | Hand a piece of work (`role`: `delegate`, `refactor`, `release`, or `fix`) to a role holder in an isolated git worktree (`~/.crew/worktrees/<repo>-<hash>/<job id>/<repo folder>`) on branch `crew-<job id>`. Optional `check` runs a sandboxed shell command in the worktree after each turn |
| `review` | Hand a read-only review to a cross-reviewer (`review` role; `runs_app: true` routes to `verify` in a writable snapshot). Defaults to `adversarial`; `mode: "standard"` uses Codex's built-in review |
| `polish` | Hand UI copy, comment, and doc cleanup to the `polish` role. Edits outside `targets` are reported as out of scope |
| `debate` | Run a read-only multi-round debate (`debate` role, up to 6 rounds, default 3) over a hard decision |
| `mission` | Start, advance, revise, or close a mission; manage its `tasks` and linked pull requests (`pr`) |
| `route` | Ask who should take a role (or `lead`) based on remaining usage and role holders, plus active preset policy and recent model notes |
| `note` | Record one evidence line (and optional lead peer rating) in `~/.crew/model-notes.json` for a build, fix, or review |
| `note_summary` | Rewrite a model's prose summary from its evidence lines when due |
| `status` | Return a bounded job summary, a paginated report (`report_offset`, `turn`), or active/recent jobs with agent usage and pending news |
| `wait` | Wait for jobs to finish or ask a lead question. Prompts the user via MCP elicitation if an approval or user question arrives meanwhile |
| `answer` | Answer a worker's `ask_lead` question without ending its turn |
| `reply` | Continue the same worker session (`sync: true` merges `HEAD` first), relay a user decision, decline an out-of-scope approval with a reason, or retry a refusal with `approved_by_user` |
| `cancel` | Stop a running job. With `discard: true`, remove a finished job's worktree and branch |

- Job tools (`delegate`, `review`, `polish`, `debate`, `reply`) return the job ID immediately by default; `background: false` blocks until the worker ends or needs the lead. The lead ends its turn instead of blocking in `wait` so the user can keep talking; the wake hook resumes it when news arrives.
- Although the daemon is shared across sessions, each job records its canonical starting project (`canonicalPath` in `config.ts`). Argument-less `wait` and `status` filter to the caller's project, while the board and `crew status` show all projects.
- Workers cannot commit because worktree Git metadata lives outside their sandbox. When a turn ends, the bridge creates a transport commit on `crew-<job id>` (hooks and `fsmonitor` disabled, commit signing off, default identity `Crew <crew@localhost>`), and the lead inspects the diff before merging or rejecting it.

**Worktree includes and shared links.** Gitignored paths listed in `.worktreeinclude` at the repository root (`.gitignore` syntax, shared with Claude Code's native worktrees) are attached to worktrees so workers can run tests (such as `node_modules` and `.env`) without reinstalling. Files are copied; directories use forced copy-on-write (`/bin/cp -cR -P` on macOS because libuv's `COPYFILE_FICLONE_FORCE` returns `ENOSYS` on APFS, and Node's `COPYFILE_FICLONE_FORCE` elsewhere). When cloning is unsupported (`ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, `ENOSYS`, `EINVAL`, or macOS `clonefile` refusal), Crew falls back to a junction on Windows or a symlink elsewhere. Crew records links on the worktree and job notes, excludes unignored links by pathspec in commits and dirty checks (directory-only ignore rules miss symlinks, and `info/exclude` is shared with the main checkout), instructs workers to treat them as read-only and put caches in temp, and marks each link and resolved target read-only in Codex's permissions profile.

**Worktree cleanup and garbage collection.** Before removing a worktree, snapshot, or recursive directory (such as scratch), Crew detaches links first using `unlink` (or non-recursive `rmdir` for directory-style Windows junctions) without descending into targets. On Windows, removal clears read-only attributes on the worktree and its validated Git admin directory (strictly inside `<common-git-dir>/worktrees/`) via two hidden `attrib -R` calls (`attrib -R <path> /D /L`, then `attrib -R <path>\* /S /D /L` when non-empty) while preserving ACLs. Before discard or snapshot removal, Codex unsubscribes the thread and child threads (`thread/unsubscribe`); because Codex unloads lazily, Windows removal retries transient `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` errors with bounded backoff. If cleanup fails, fallback removes only the validated admin directory and verifies Git no longer lists the worktree; remaining leftovers are recorded in `cleanupPending` (pointing to `crew gc`). Discard never runs a repository-wide prune. Crew deletes the branch only after Git stops listing the worktree and the branch is no longer checked out. When Windows holds only an emptied worktree directory, discard succeeds with a note and retries removal automatically after 30 s, 2.5 min (consecutive 30 s and 2 min delays), and on startup.

At most once a day on `codex app-server` start, Crew archives its own worktree threads idle for seven days (`thread/list` oldest first, then `thread/archive`) so Codex apps do not fill with old worktrees; `reply` unarchives a thread before resuming.

`crew gc [--apply] [--branches]` scans remembered repositories in dry-run mode by default, listing orphan worker directories, missing-worktree Git admin directories, and unused `crew-cx-*`/`crew-ag-*` branches with merge status against `HEAD`. `--apply` deletes orphan directories and prunes metadata (skipping global prune if unrelated or owned metadata could be touched); `--branches` (with `--apply`) deletes only branches merged into `HEAD`, printing `git branch -D <name>` for unmerged ones. Active jobs, workspace operations, and owned worktrees are protected; jobs with `cleanupPending` refuse follow-ups, `sync`, and round changes until resolved. Authenticated `POST /api/gc` accepts `{ apply?: boolean, branches?: boolean }` and returns `{ text: string }`.

Verified on macOS/APFS (clone fallback via injected tests) and on Windows 11 (shared junctions, locked empty folder retries, full test suite); HTTP auth and CLI checks also run against an isolated daemon with fake agents.

### Lead delivery (step 1)

The daemon owns delivery state in `jobs.json`. Each job records the starting MCP server's `CLAUDE_CODE_SESSION_ID` as `lead`; board and legacy jobs start unowned. When a session acts on a job through a Crew tool, the MCP server or wake hook adopts it before offering news. Completions, failures (including restart recovery), lead questions, decision requests, and watched pull request updates (section 5.5) append immutable `News` snapshots with a per-subject `newsSeq`; routine progress does not.

Running jobs silent past `stallSeconds` show as stalled immediately, and adapters with `probe` check them: Codex reads `thread/read` runtime status (sub-agents first) and re-reads non-active threads after 3 seconds. Active turns clear the stall silently, ended sub-agents stop blocking parent completion, and certainly-ended parents without `turn/completed` fail the job (producing failure news); inconclusive checks or adapters without `probe` emit one `stalled` news item per stall.

Only an echoed receipt acknowledges news. Every lead tool accepts `ack: "<receipt>"` or an array of receipt IDs and applies them before doing work or offering new news; tool responses and hook digests are offers, not ACKs. Receipts bind to exact `(jobId, newsSeq)` snapshots (`jobId` also holds pull-watch IDs), remain valid after the offering lease expires, and validate session ownership and revisions. `ackedSeq` tracks the contiguous acknowledged prefix, and `delivered` projects it onto event sequence numbers for legacy readers (`/delivered` no longer accepts sequence ACKs). Delivery mutations flush synchronously and roll back on save failure.

- **Offering and watcher leases.** Automatic offers share one 30-second offering lease per session and retry each news item at most twice, even across crashes or restarts. Explicit tool reads issue receipts without spending that budget. One watcher lease per session lasts 60 seconds, renews during polling, and is bounded by the hook deadline. New watchers exit if a healthy watcher exists, replace one within 15 seconds of its deadline, or take over after 25 seconds of silence (or immediately if a long poll disconnects early); generation tokens fence replaced watchers.
- **Hooks.** `SessionStart` (`startup`, `resume`, `clear`, `compact`), `PostToolUse`/`PostToolUseFailure` on Crew tools, and `Stop` arm `wake.ts watch` with `asyncRewake` (needed on `SessionStart` because Desktop can end idle processes under memory pressure). Synchronous `Stop` offers pending news with exit code 2 unless `stop_hook_active` is set. `SessionStart` and `UserPromptSubmit` inject a bounded summary of pending IDs (and open missions on `SessionStart`) via `additionalContext` without offering or acknowledging. All hooks authenticate with `~/.crew/token`, including `/api/hooks/claude`.
- **Timeout.** Hook timeout is 86,400 seconds (`HOOK_SECONDS`), and the watcher exits 10 seconds earlier. **Verify this finite timeout and `asyncRewake` behavior on the installed Claude Code/Desktop host before relying on that lifetime.** Killed hooks do not re-arm themselves; persisted news remains recoverable via the next hook, `status`, or the board.
- **Response bounds.** Digests hold at most 8 snapshots (`OFFER_ITEMS`), and every MCP tool response fits within 32 KiB (`LEAD_BYTES`): tool text takes at most 24,000 bytes (`LEAD_TEXT_BYTES`) and a report page 16,000 (`REPORT_PAGE_BYTES`), leaving omitted images on the board and in the evidence list. Read long reports with `status(job_id, report_offset: 0)` using the returned UTF-16 offset (never splitting surrogate pairs) and optional `turn`.

### 2.1 Role assignments

Each tool maps to one or more roles, and `roles` in `~/.crew/config.json` names which agents hold each role. Without `roles`, defaults apply (implementation/review/refactor/release/debate/verify to Codex, fixing to Claude, wording to Antigravity).

```json
{
  "roles": {
    "delegate": { "agents": ["codex"] },
    "review": { "agents": ["codex"], "codex": { "effort": "high" } },
    "polish": { "agents": ["antigravity"] }
  }
}
```

- `agents` lists `codex`, `antigravity`, or `claude` ([09](09-usage-presets-rounds.md) section 15). Per-role `codex` and `antigravity` entries (`model`, `effort`) override global agent settings, and per-job tool arguments override both. Antigravity's `effort` sets `thought_level` after selecting the model (stepping down to the nearest lower supported level; omitted/unsupported levels keep the session default). The legacy form (`agent`, `also`, `model`, `effort`) is still accepted on read.
- `polish` accepts `model` like `delegate` and `review`, and results print `model:` right after the header. `resolvedModel` and `resolvedEffort` record what the session reported (falling back to configured values or `unknown (agent default)`).
- Work roles open their report with `## Outcome` (`done`, `partial`, or `blocked`), stored in `Job.outcome` for the latest turn (omitted on reviews, debates, and questions). Results flag mismatches with bridge observations—such as `outcome: done as declared, but the bridge check failed`, no files changed after a refusal/decline, or `outcome: not declared`. Acceptance lines list kept round commits for cherry-picking when known.
- Antigravity allows Crew's six worker tools (`ask_lead`, `lead_answers`, `siblings`, `search`, `recent_changes`, `rate`) when matched by MCP metadata (`_meta.mcpServerName === 'crew'`) or exact `mcp_crew_<tool>` / `mcp_crew_<8 hex>_<tool>` title, with an optional `Run ` prefix. The 8-hex suffix matches the per-job `crew` server names used by one `agy acp` process from the second job on. Title matching applies only to `other` calls without conflicting MCP metadata or command fields; `execute` and edits still follow role policy.
- `roles` is read at job start so edits apply to the next job without a restart; an invalid table fails the job with the reason instead of falling back. The lead's tool titles and server instructions name the role holders as of session start.
- Role instructions (`plugin/roles/`: `engineer.md`, `reviewer.md`, `polisher.md`, `debater.md`, `question.md`, `machine.md`, plus `refactor.md`, `release.md`, `fix.md`) name no agent. Codex receives them in `developerInstructions`; Antigravity receives them via `_meta.antigravity.systemPrompt.append` when advertised, else prefixed to the first prompt.
- Every Codex job gets a fresh per-turn scratch directory writable in its sandbox with `TMPDIR`, `TMP`, and `TEMP` set via `shell_environment_policy.set` ([09](09-usage-presets-rounds.md) section 9). The system temp directory is excluded because on Windows Codex applies an inherited ACL over every file there (timing out `thread/start` on large temp folders). Scratch clears after each turn; files needed across turns go in `work/` inside the job's evidence directory (only top-level images/videos list as evidence). Antigravity shares one server process with no per-job scratch or `work/` folder.
- Workers launch their Crew MCP server (`worker-mcp.ts`) with the daemon's executable; under the Electron desktop app, `nodeEnv()` sets `ELECTRON_RUN_AS_NODE=1` so it runs as Node instead of launching another app window.
- Codex reports worker MCP server failures via `mcpServer/startupStatus/updated`; when `crew` fails, Crew attaches a job note and activity entry so the lead knows `ask_lead`, `browser`, and other worker tools are unavailable. Antigravity emits no equivalent status.

What each worker may do in each role:

| Role | Codex | Antigravity |
| --- | --- | --- |
| `delegate` | `workspace-write` sandbox; approvals follow `codex.approvalPolicy`. Token denial requires a permissions profile (see below) | Reads anywhere except `~/.crew/token`; edits inside the worktree (never `.git`). Commands, deletes, moves, and network requests go to the user for approval, or are refused if input is missing |
| `review` | `read-only` sandbox (with writable scratch), never prompts; `runs_app` (`verify`) uses a writable snapshot worktree with `delegate` approvals (section 5.4). `mode: "standard"` uses Codex's built-in review | Reads only; edits and commands are refused and noted. Because it cannot run git, the bridge writes a diff under `~/.crew/reviews/` per turn (deleted when the turn ends) and notes that no checks ran. Follow-ups regenerate the diff for the saved target. `mode: "standard"` falls back to adversarial review. Requires a git repo |
| `polish` | `workspace-write` sandbox; edits outside `targets` are reported as out of scope. Token denial requires a permissions profile (see below) | Reads anywhere except `~/.crew/token`; edits inside the worktree (never `.git`). Everything else is refused |

A writable Codex job with no enabled plugin, `runs_app`, or shared links uses plain `workspace-write` without a permissions profile. It can read the token but has no network to use it with (see [09](09-usage-presets-rounds.md) section 12).

Antigravity approvals follow the same rules as Codex (section 5.1): user answers, full request fields and workspace shown, one at a time, and only `allow_once` (never `allow_always` or `accept-edits`, because `accept-edits` skips per-edit path checks). Denials use `reject_once` when offered. Cancelling the job, ending the turn, or exiting the server cancels open requests.

Verified with swapped roles (Antigravity as `delegate` and `review`, Codex as `polish`) on Codex CLI 0.167.0 and Antigravity CLI 1.5.5; denied requests, missing `rawInput`, mode switches, and hex-suffixed Antigravity titles are covered by protocol stubs/fixtures.

### 2.2 Shared instructions

Instructions written once reach every agent (requirement R9):

| File | Applies to |
| --- | --- |
| `~/.crew/instructions.md` | Every project |
| `.crew/instructions.md` at the repository root | That project |

The project file is part of the repository and is trusted like its `AGENTS.md` or `CLAUDE.md`, even if someone other than the user wrote it. It can steer an agent within its role and is read last, so it can contradict the global file.

- **Workers:** Both files are read at job start from the repository's main working tree (even from a linked worktree or subdirectory; outside a repo, the project directory is used) and appended after the role text with a preface stating they do not widen the role. `status` lists which files a job received.
- **Claude:** A `SessionStart` and `SubagentStart` command hook (`bridge/context.ts`) prints them as `additionalContext`, including after compaction, noting that workers already receive them.
- Nothing is written to any service's own instruction files (`AGENTS.md`, `CLAUDE.md`, rules folders).
- Missing or empty files mean none; an unreadable file fails the job (or surfaces an error in the Claude hook).
- Because Claude Code replaces hook context over 10,000 characters with a 2,000-character preview, any file that would push the hook output past 9,000 characters (`CONTEXT_LIMIT`) is replaced by its path rather than truncated. Workers have no such cap.
- Each section is headed by its source so the agent can distinguish user instructions from repository instructions. Role limits are enforced by the bridge and sandbox, not prose.

Verified with marker instructions across Codex, Antigravity, and headless Claude Code 2.1.321. Not verified live: `SubagentStart` delivery inside a real subagent, whether Claude Code counts its 10,000-character cap per hook or per event, and whether Codex's built-in `standard` review honors `developerInstructions`.

## 3. Changes from the plan

| Area | Document 02 | Implementation | Reason |
| --- | --- | --- | --- |
| Antigravity connection | `agy acp` or `agy -p` | `agy acp` only | Official FAQ says wrapping `agy -p` in third-party agents is unsupported on consumer plans, whereas ACP docs allow any ACP client (section 6) |
| Phase 0 | Run with `codex-plugin-cc` and skills first | Skipped | `app-server` worked immediately on this machine |
| Role files | `CLAUDE.md`, `AGENTS.md`, Antigravity custom agent | `plugin/roles/*.md`, skills, and MCP server instructions inside the plugin | No files dropped into repositories; roles inject per job via `developerInstructions` (Codex) and ACP system-prompt append or prompt prefix (Antigravity) |
| Antigravity role enforcement | `--agent` and `--mode` | Bridge evaluates ACP permission requests | In default mode every edit asks permission, letting the bridge enforce per-role read/edit/command rules without touching user config |
| Event transport | WebSocket | SSE | One-way streaming suffices, browsers reconnect automatically, and actions use plain `POST` requests |
| Claude status source | `claude agents --json` polling plus Notification hook | Command hooks (`report.ts`, `context.ts`, `wake.ts`) | Push-based, covers Desktop sessions, discovers the daemon port from `~/.crew/daemon.json`, and authenticates with `~/.crew/token` (HTTP hooks cannot read files) |
| Waking the lead | Unspecified | `asyncRewake` command hook | Wakes an idle lead session when a job ends or needs input; Channels were skipped as a research preview behind a feature flag |

## 4. Resolved open items

| Item | Decision |
| --- | --- |
| Implementation language | TypeScript executed directly via Node.js 22.18+ type stripping, zero runtime dependencies, no build step for the bridge |
| MCP implementation | Written directly without the official SDK; only lifecycle, tools, progress, elicitation, and cancellation are needed |
| Event log and state | JSONL (`~/.crew/events.jsonl`); jobs, delivery state, and PR watches in `~/.crew/jobs.json`; missions in `~/.crew/missions.json` |
| Status board form factor | React web board served by the daemon (viewable in a browser or Claude Desktop's browser pane), plus native SwiftUI macOS and Electron Windows desktop apps (section 7) |
| Suspected stall timeout | 5 minutes (`stallSeconds` in `~/.crew/config.json`) |
| Codex thread start/resume timeout | 3 minutes (`THREAD_TIMEOUT_MS`); Windows sandbox ACL setup can exceed a minute under load. Other RPC calls time out after 30 seconds (`RPC_TIMEOUT_MS`). Stall probes report opening threads as working |
| Max review rounds | Default 1, max 2, stated in `/crew:run` rather than enforced by the bridge |
| Codex approval policy | `on-request` for implementation and `runs_app` reviews, `never` for static reviews and questions. User vs. automatic reviewer routing is in section 5.1 |

## 5. Status display and stall detection (R5)

- Event shape: `{seq, ts, agent, session_id, job_id, kind, detail}`, where `kind` is `started`, `progress`, `waiting`, `error`, `limit`, `stalled`, `done`, or `cancelled`.
- Quota exhaustion emits a `limit` event from Codex `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`), Antigravity error text, or Claude `StopFailure` (`rate_limit` or `billing_error`).
- A running job silent for `stallSeconds` (default 5 minutes) is marked `stalled` and probed if supported. For Claude sessions, the stall timer runs only when neither the main loop nor any active sub-agent is inside a tool call.
- `waiting`, `error`, `limit`, and `stalled` (plus `done` when `notifyOnDone` is true) trigger system notifications via `osascript` on macOS or a Windows PowerShell 5.1 toast under Crew's own app identity on Windows (suppressed for waiting/completion while the native desktop app holds a heartbeat lease).
- Codex's live `account/rateLimits/read` and `account/rateLimits/updated` readings display on the board and supplement AgentGauge for `route` whenever newer than AgentGauge's cache ([09](09-usage-presets-rounds.md) section 6).

### 5.1 Approval requests and questions

Codex approval requests go first to its automatic reviewer (`codex.approvalsReviewer`, default `auto_review`). Anything it refuses twice, and every user-bound request or question reaching Crew, goes to the user rather than the lead. The lead never approves, though it may decline a clearly out-of-scope approval with a reason (`reply` with `decision: "decline"` and `message`), which grants nothing and spares the user a prompt.

- While the lead blocks inside a job call (`wait`, or `background: false`), the MCP server sends `elicitation/create` so Claude shows its native input prompt and forwards the user's answer straight to the worker.
- For background jobs, the wake hook wakes the lead and the prompt appears when it calls `wait`. Answering first on the board or in the desktop app, or returning early from the call, withdraws the in-app prompt immediately.
- Multiple waiting jobs prompt sequentially; any settled on the board meanwhile are skipped. If dismissed, unsupported, or failed to show, `wait` returns distinct guidance so the lead asks in chat.
- Antigravity permission requests follow role policy (section 2.1), so only an engineer's non-edit actions reach the user. Its questions arrive via `elicitation/create` form prompts (choices match by text or number, free text passes as written, and declining declines the form).

**Allow for This Job.**
- *Codex plugin tools:* Requests matching `Allow <who> to use "<target>"?` (such as Computer Use per-app prompts) offer *Allow for This Job* (`allow_for_job`) beside Approve and Deny. The grant keys on MCP server and message (not tool name) in memory for the rest of the job, covering sub-agents and follow-ups, but not other apps, servers, jobs, or daemon restarts. Matching queued and later requests auto-approve and log to job activity.
- *Antigravity commands:* Simple engineer commands offer *Allow for This Job*, keyed by program, its first argument, and the request's working directory (`running "<program> <subcommand>" in <directory>`, or `the job workspace` when the request names none). The first argument must be a plain word. Later arguments may vary unless they contain an absolute path or a `..` path component, so `npm test` covers `npm test --watch` but not `npm test --prefix=/other` or `npm run lint`. Only non-MCP `execute` requests qualify. The input may hold one command field, an optional working-directory field, and the two fields agy 1.5 sends beside them (`WaitMsBeforeAsync`, `toolSummary`); agy runs each command as `cd <workspace> && <command>`, so a leading `cd` to a literal path supplies the working directory. A directory named by `cd` or a working-directory field must be absolute, with no `.` or `..` components or doubled slashes. Crew resolves it to a real directory when granting and matching, and shows the path as written. A symlink retargeted to a different directory prompts again. Shell operators (`;`, `&`, `|`, backticks, `<`, `>`, `()`, newlines), shell expansions (`$`, `~`, `{}`), leading variable assignments (`PATH=…`), directory-changing commands (`cd`, `pushd`, `popd`), shells, and programs that run another command (`sudo`, `env`, `xargs`, `nohup`, `timeout`, `find`, `ssh`, `osascript`, and the like) never get a grant. A grant for a command that runs workspace files (`npm test`, `make build`, `node script.js`) also covers what the worker later writes into them, since workspace edits need no approval. Windows gets no command grants, since the checks model a POSIX shell. Grants live in memory for the job and its follow-up turns; when the agy server restarts after being idle they are lost and the user is asked again. Crew still answers each call with `allow_once`, so role policy checks every request. Read-only jobs get none.

**Automatic reviewer and refusals.** Set `{"codex": {"approvalsReviewer": "user"}}` in `~/.crew/config.json` to send all Codex approvals straight to the user. When `auto_review` denies or times out (`item/autoApprovalReview/completed`), the bridge records action fields (program/arguments, `cwd`, and MCP input recovered from the started item by `targetItemId`), omits environment fields, and caps free-form input at 4,000 characters, reasons at 2,000, and descriptions at 8,000. Missing reasons are labeled missing; generic messages are quoted as received rather than expanded. The lead checks whether the user's conversation request covers the refused action:

1. If it does, the lead calls `reply` with `approved_by_user` quoting the user's words; the bridge sends the user's recent recorded prompts plus the quote for one more automatic review.
2. If refused again on that retry turn, the same call runs the next turn with `approvalsReviewer: user` so the user decides, then returns to `auto_review` on later turns. “Again” means the preceding turn was itself a retry. An unrelated later refusal starts over with `auto_review`.
3. If the user's request does not cover it, the lead asks the user.

Verified via `codex app-server` that `auto_review` approves a user-requested external deletion when the thread prompt authorizes it; `denied` paths are covered by stub-server tests.

### 5.2 Deciding from the board

The React web board (`plugin/board/src/`) and native macOS app let the user inspect work and act on it directly (requirement R10, roadmap item B1):

- **Navigation and projects.** A sidebar lists pages (`Overview`, `Needs You`, `Activity`, `History`) and alphabetical `Projects` (`All projects` plus each known project, saved in `localStorage` under `crew.selection`). Selecting a project scopes Overview to it; jobs and sessions group under their repository's main working tree even when started from a worktree or subfolder. `⌘K` or `/` opens a search palette; `N` opens New Job; `1`–`4` switch pages.
- **Job details.** Clicking a job row opens a non-modal side panel (`#<job id>`) showing status/errors, inline approval/question controls when waiting, facts (agent, model, project, branch, tokens, shared instructions), changed files (out-of-scope marked), bridge check receipt, evidence, rounds (undo/keep), automatic-review refusals, notes, report or debate transcript, a follow-up composer, original task, activity, Resume Command, Diff Command, and Cancel Job.
- **Evidence side by side.** Pressing a capture opens it alone; a thumbnail strip adds or removes up to four panes—ordered lead attachments first, then worker captures by turn with `<view>-before` ahead of `<view>-after`—in a row of up to three or a 2×2 grid. Captions show `Turn X of Y` (or `Attached by the lead`). The macOS app decodes images natively at pane size and opens recordings in the system player (no WebM decoder on macOS).
- **Answers and follow-ups.** Waiting approvals offer Approve, Deny, and *Allow for This Job* when eligible; questions accept written replies (or Yes/No). Answers carry `request_id` so they cannot settle a later request. Live updates preserve typed drafts, caret, focus, and action locks. Inline `ActionStatus` messages and a connection banner report failures.
- **Pending count.** The tab title shows `(<n>) Crew` whenever jobs or Claude sessions wait on the user across all projects.
- **Settings.** A dialog (`Settings.tsx`) edits Build/Review/Edit roles, Presets, Model Scores (including the peer-ratings toggle), shared instructions (global and per-project), and About Crew. Role saves keep other `config.json` keys and refuse unparseable files; instruction writes allow only daemon-known projects and never follow symlinks. Closing with unsaved edits prompts first.

Checked in the browser pane and Playwright regressions (`npm run test:e2e`), plus automated handler tests for instruction saves, concurrent edits, and request locks. Not checked: screen readers and IME composition.

### 5.3 Missions: a command as one unit

A mission groups one user command and its jobs (requirement R10, roadmap item B2):

- **Reported by the lead.** The lead calls `mission` with `title` and a nonempty `stages` plan (up to 30 steps from `plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`; repeats allowed). `stageIndex` tracks the active step (`stage` mirrors it). Passing `stage` advances to its next occurrence after `stageIndex` (dropping skipped steps) or inserts it next if none remains; repeating the current step is a no-op. Resending an open mission's title reattaches and ignores `stages`.
- **Fluid plans and named stops.** Passing `stages` later replaces only steps after `stageIndex` (`[]` drops the rest), preserving passed steps and job indices. Entries may append `: <name>` (up to 24 chars, stored in `labels`), shown in place of the stage name without numbering and usable to advance between repeated stages. The lead closes a mission with `done: true` (plus optional `outcome` and `record` for `crew export`) or `abandoned: true`.
- **Display and progress.** Missions render planned stops in order—Plan, Build, Review (shared by `self-review` and `cross-review`), Fix, Polish, Final—numbering unnamed repeats (`Review 2`, `Fix 2`). Daemon-assigned `missionStep` pins jobs to their step across plan revisions; legacy jobs attach by kind. Progress is `(stageIndex + share) / stages.length` (100% only when `done`), where `share` averages `0.5` for running/waiting unfinished jobs and `0` for other unfinished jobs (`0.5` if none); missions without `stages` keep the 7-stage formula. Ended missions start folded; loose jobs stay separate. A job given a known mission that is no longer open runs on its own under that mission's preset with a note attached. An unknown mission ID is refused.
- **Closing and quiet missions.** Active missions offer *Mark Done* and *Stop Tracking* in both UIs (and *Mark Done* on abandoned ones, sending `reopen: true` so late lead calls cannot undo *Stop Tracking*). *Stop Tracking* marks a mission `abandoned` without stopping its jobs. Clients show "Looks finished" after 20 quiet minutes with no active jobs or open tasks (`todo`/`doing`) unless the owning lead session is working.
- **Visual encoding, Needs You, and layout.** Status uses Lucide icons and tinted chips (`Chip`), while agents use SVG marks (`AgentMark`) and names in the `AgentPanel` beside the workspace. Summary KPI counts include ended jobs only while unsettled (undiscarded worktree or unread result). Waiting jobs and Claude sessions appear on the `Needs You` page (badged in the sidebar, header button, and Overview KPI) as full request cards with inline controls. The board follows system light/dark mode (`color-scheme: light dark`), scales down to `320px`, and folds its sidebar into a slide-over drawer with a bottom dock below `760px`.
- **Lifetime and ownership.** `~/.crew/missions.json` persists all open missions, the 100 most recently ended, the last 2 per project, and any ended mission with a watched PR, retaining their jobs beyond normal history limits. Idle missions auto-abandon after 12 hours (72 hours with open tasks or a watched PR). Unreadable `missions.json` files are set aside before starting clean. A session owns missions via `CLAUDE_CODE_SESSION_ID`; new jobs started after a lead-finished `done` mission (with no other mission open) auto-create a fallback follow-up mission (`후속 작업: <title>` or `Follow-up: <title>`), and `UserPromptSubmit` reminds the lead for 12 hours after a lead-finished mission to open a mission before new work.

Covered by automated unit tests (`test/mcp.test.ts`, `test/missions.test.ts`, `test/board.test.ts`) and browser checks. Not verified: whether Claude Desktop always passes `CLAUDE_CODE_SESSION_ID` to the MCP server.

### 5.4 Sharing the machine

The user and all agents share one machine (requirement R14):

- **Isolated instances.** Every command-capable worker job receives `plugin/roles/machine.md` ([09](09-usage-presets-rounds.md) section 14): start isolated copies on free ports with temp data/browser profiles, use headless browsers only, never touch the user's running instances or default ports, and clean up only what it started. Only the lead uses Claude Desktop's browser pane.
- **Parallel reviews, one app.** In `/crew:run`, the lead runs one review (self or cross) at substantial stopping points and reviews uncovered commits before push/PR (both in parallel for security, concurrency, or data loss), leaving the working tree untouched until all report. Worker reviews default to static (`read-only`); only one reviewer runs the app (`runs_app` cross-review or self-review, never both).
- **Codex plugins.** `codex.plugins` defaults to `["browser"]` and `codex.appPlugins` defaults to `["computer-use", "unified-computer-use"]` (giving shared-screen access when `runs_app: true`). Eligible jobs (writable Codex delegates and `runs_app` reviews) receive the deduplicated union of `codex.plugins`, `appPlugins` (if `runs_app`), and per-job `plugins`. On start/resume, Crew queries `plugin/installed`, enables matching installed-and-enabled plugins, disables other listed plugins by exact ID, and sets `plugins._default.enabled = false`. Threads with enabled plugins keep Codex's automatic skill catalog (Codex 0.167.0's `skills.include_instructions = false` hides plugin skills too), deny `~/.crew/token` via permissions profile even without `runs_app`, forward plugin approvals to the user, and append `PLUGIN_USER_APP` to `developerInstructions` (allowing a specific user-app action through plugin tools only when the lead's task explicitly requests it—never credentials, payments, messages, or settings). Set `codex.plugins` to `[]` to run lean.
- **Jobs that run the app.** `runs_app` enables network access so the worker can bind local ports. A `runs_app` review (`verify`) runs in a writable snapshot worktree from `HEAD` (or the target commit) with `.worktreeinclude` paths attached. For uncommitted targets, Crew also copies uncommitted and untracked files. Snapshots omit submodules and leave `skip-worktree` files as committed. They delete at turn end and regenerate on follow-ups. `polish` and reviewers that cannot run commands refuse `runs_app`. On macOS, Codex's sandbox blocks Chromium's Mach service, so `crew.browser` starts a sandboxed Playwright server outside it; on Windows, Chromium starts inside Codex's sandbox.
- **Measurement alone.** `delegate` with `exclusive: true` runs alone across all sessions and projects (disallowed on review and polish). Starts and follow-ups fail with blocking job details while an exclusive job is active (or if any job is active when starting one). The bridge cannot hold back the lead's own measurements, subagents, or outside processes, so `/crew:run` tells the lead to wait until the machine is idle.

Enforced by the bridge: exclusivity, network access, review snapshots, and token denial for Codex jobs with a permissions profile. Enforced by instruction: instance isolation, static reviews, and "one reviewer runs the app".

On macOS and Windows, `check` reads anywhere except the daemon token, writes only to the worktree and its temp directory, and keeps `.git` read-only. Local servers remain reachable, outside network access requires `runs_app`, and the check times out after 10 minutes.

Codex sandbox checks (Codex CLI 0.167.0):

| Sandbox | Result |
| --- | --- |
| `read-only` | No project/temp writes, no listening ports, no outbound network (hence writable scratch for checks and snapshots for `runs_app` reviews) |
| `workspace-write` | Project and temp writes work; cannot bind `127.0.0.1` (`listen EPERM`) and no outbound network without escalation |
| `workspace-write` + network (`runs_app`) | Binds local ports and reaches outside hosts without prompts; home writes stay blocked; headless Chrome failed inside the macOS sandbox (exit 134) and browser launch still needed approval. `kill` on the job's own server was refused, although an interrupt stopped it. `crew.browser` provides a sandboxed browser outside Codex's sandbox |

Not verified: whether Antigravity follows isolation instructions, whether Codex's `standard` review honors injected instructions, and live plugin approvals reaching the bridge.

### 5.5 Several missions, tasks, and pull requests

- **Several missions per session.** Opening a new mission keeps existing open missions active (`active`, `done`, `abandoned`). A fourth state would only record where the lead is looking, while the mission’s workers can still run. With one open mission, calls work implicitly. With two or more, any mutating `mission` call, job start, or `route` must name the target (`id` on `mission`, `mission` on job tools and `route`); unnamed calls fail with the list of open missions before changing anything. A wrong guess could close or advance the wrong mission or charge a job to the wrong preset, and those actions cannot be undone. A named ID must identify a mission the session opened in this project. The MCP server reads open missions from the daemon on each call, so restarts lose nothing.
- **Not built, on purpose.** There is no recurring reminder to open a follow-up mission when another mission is still open: `done` notes it once and later unnamed jobs go to the sole open mission. The daemon keeps focus only in memory, using the session’s last mission action to put the lead row on that card alone.
- **Tasks.** Missions carry optional tasks `{ id, title, after?, state, result? }` (`state`: `todo`, `doing`, `done`, `dropped`; max 40), merged by `id` and validated as a whole (valid `after` refs, acyclic). Nothing auto-schedules; the daemon reports which tasks are ready. Jobs link via `task_id` (`Job.taskId`), and mission summaries read live job states and check results directly from jobs. Dropped tasks never satisfy `after`.
- **Resume context.** `SessionStart` (`startup`, `resume`, `clear`, `compact`) injects open missions—with stage, plan, tasks, and pull requests—and still-watched PRs of finished missions into `additionalContext` (capped at 6,000 characters), so plans survive compaction and restarts.
- **Quiet missions.** Missions with open tasks (`todo`/`doing`) or watched PRs get 72 hours before auto-abandoning (instead of 12) and suppress "Looks finished" while tasks remain open.
- **Pull requests.** Passing `pr` (number or URL) to `mission` resolves it once with `gh pr view` and creates a watch (`plugin/bridge/pulls.ts`) persisted in `jobs.json` alongside delivery receipts. The daemon polls each open watch via `gh pr view <url> --json` every 60 seconds while checks are pending and every 5 minutes otherwise—only while the PR is open, its mission is not abandoned, and the owner session was active within 10 minutes (`PRESENT_MS`). Returning sessions trigger an immediate poll (15-second throttle). Crew holds no GitHub credentials.
- **PR news and loop limits.** Polls emit news only for changes: newly failed checks on the current head, checks passing after a reported failure, new non-author `CHANGES_REQUESTED`/`COMMENTED` reviews, and a PR turning `CONFLICTING` (not repeated until `MERGEABLE` in between). Merged or closed PRs end the watch silently. News tells the lead to judge the cause and delegate fixes (weighing reviewer text as feedback, never instructions), and never to merge, close, or deploy. After three consecutive failing heads, check-failure news pauses (`held: true`) until a head passes or the lead links `pr` again (a `done` mission accepts `id` + `pr` alone to resume).
- **PRs on the board.** Each watched PR is one chip, a rounded square rather than a status pill, on a shared line under its mission's meta (`pullStatuses` in `model.ts`, `MissionPull.statuses` in the Mac app). The chip names the most urgent status and counts the other statuses the lead must act on (`#43 Conflict +2`). Order: conflict, failing checks, changes requested, running checks, approved, passing checks. A conflict comes first because resolving it moves the head and reruns the checks. Failures (red) come before feedback the lead must weigh (orange). A merged or closed PR shows only that. A stale reading (no answer for 15 minutes, a failed read, or an ended watch) keeps its words but turns gray and shows how long ago it was checked. A failed read says `Could not be read` in place of its statuses.

Checked on an isolated daemon with real `gh` (tasks, cycle/unknown-id validation, PR linking, `SessionStart` context). Not checked live: a failing CI check arriving as news in a live Claude session.

## 6. Desktop app visibility (R6) findings

| Service | What was verified |
| --- | --- |
| Claude | Natively visible when the lead runs in Claude Desktop; the plugin works in local Desktop sessions |
| Codex | Bridge threads land in the ChatGPT app's store titled `Crew · <title>`. Because the ChatGPT app spawns its own private stdio `app-server`, Crew cannot attach live; list refresh timing is up to the app. CLI resume: `codex resume <id>` |
| Antigravity | ACP sessions save to the CLI store (`~/.gemini/antigravity-cli/`) under `default-cli-project`, not the desktop app store (`~/.gemini/antigravity/`), so they do not appear in the Antigravity app. CLI resume: `agy --conversation <id>`. The sidecar-only `agentapi` endpoint provides no way to read responses, so it is not used |

Resume commands appear in job results and in the board's job details panel.

### Antigravity policy risk

The official FAQ (https://antigravity.google/docs/faq/) states:

- "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
- "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service" / "Such actions can result in suspension or termination of your account."

The bridge runs only the official `agy` binary via ACP (which Google documents for third-party clients) and never touches credentials, though whether driving Antigravity from Claude Code via ACP falls under the wording above depends on Google's interpretation. To disable Antigravity, set `{"antigravity": {"enabled": false}}` in `~/.crew/config.json`.

## 7. Standalone status board app

Both desktop apps are now built as thin clients over the daemon's `/api/state`, `/api/stream` (SSE), and `POST` endpoints, while the React web board remains for browsers and Claude Desktop's browser pane:

- **macOS (`native/Sources/Crew/`):** Native SwiftUI/AppKit app (chosen over Tauri for menu bar integration, actionable approval notifications, and OS-native presentation). See [08-native-macos.md](08-native-macos.md).
- **Windows (`desktop/`):** Electron app wrapping the React web board with a system tray icon and daemon-signed requests. See [12-windows-electron.md](12-windows-electron.md).

## 8. Verification summary (2026-11-11)

Verified against live accounts and on macOS/Windows hosts across 2026-11-11 to 2026-11-20:

- Core pipeline: `delegate`, `review` (`adversarial` and `standard`), `polish`, out-of-workspace edit refusal, `.worktreeinclude` copy/link, project isolation, `cancel`/`discard`, and a full 7-stage `/crew:run` in headless Claude Code.
- Approvals and wake flow: `untrusted` approval round-trips, MCP elicitation approve/deny/dismiss/error/board-first/sequential prompts, live `asyncRewake` wakeups in Claude Desktop (7 s background review wakeup, `ask_lead`/`answer` round-trips), and `Host`/`Origin`/token request guards.
- Windows 11 host (2026-11-14, 2026-11-16): full unit test suite (macOS-only tests skipped), `check` under Git for Windows' `sh` in `codex sandbox` + PowerShell 5.1 kill-on-close job object, shared junctions, held empty worktree folder auto-retry, Windows toasts, and Remote Control wakeups.
- Claude Desktop: plugin tools, skills, and `self-reviewer` subagent loaded in local Desktop sessions.

Not yet verified:

- Visual appearance of the native approval dialog inside Claude Desktop (protocol round-trip verified only).
- When threads appear in the ChatGPT app UI.

## 9. Next steps

1. ~~AgentGauge integration (G1)~~ — Implemented inside the daemon ([09-usage-presets-rounds.md](09-usage-presets-rounds.md) sections 3, 6, and 7).
2. ~~macOS menu bar app~~ — Implemented as the native SwiftUI app ([08-native-macos.md](08-native-macos.md)), alongside the Windows Electron app ([12-windows-electron.md](12-windows-electron.md)).
3. Claude usage display: forward `rate_limits` from Claude Code's statusline to the daemon as a supplement to AgentGauge.

Further planned work is tracked in [06-roadmap.md](06-roadmap.md).

## 10. Revision log

- 2026-11-20: Multi-mission sessions, mission tasks, linked PR watches, and `SessionStart` resume context (section 5.5); hex-suffixed Antigravity worker tool title matching (section 2.1); Codex MCP startup failure notes.
- 2026-11-16: Windows bridge parity (verified on Windows 11 with Codex CLI 0.166.0 and Git for Windows 2.53): sandboxed `check` runs Git for Windows' `sh` inside `codex sandbox` under a PowerShell 5.1 kill-on-close job object with a stdin-secret status line (because Codex waits on open pipes and sandboxed processes can kill their parent), Windows toasts, Windows Gauge usage files, `crew.cmd`/Git Bash shims, and canonical project paths (`canonicalPath`). `crew.browser` stays macOS-only because Chromium starts inside Codex's Windows sandbox.
- 2026-11-14: Fluid mission plans with repeated/named stops and Mark Done/Stop Tracking (section 5.3); hardened Windows worktree cleanup, delayed empty-folder retries (30 s, 2.5 min, startup), and `crew gc` (section 2); `codex.plugins` default `["browser"]` and plugin token-denial profile (section 5.4).
- 2026-11-12–13: Migrated board to React/TypeScript/Vite and added desktop apps (superseding section 7's web-only note); added configurable roles (section 2.1), shared instructions (section 2.2), missions and board decision support (sections 5.2–5.3), shared-machine rules, `runs_app` snapshots, `exclusive` jobs, and `auto_review` default (sections 5.1, 5.4); switched daemon replacement to hashing `bridge/` files, bound port before writing state, disabled commit signing (`Crew <crew@localhost>`), and renamed branches from `crew/<id>` to `crew-<id>` (git rejects `crew/...` when a `crew` branch exists).
- 2026-11-11: Reverted Antigravity from `accept-edits` to default mode after live testing showed `accept-edits` skipped workspace bounds; moved worktrees from `.crew/worktrees/` to `~/.crew/worktrees/` so repo tools stop scanning them; added `.worktreeinclude` copying; routed approvals to the user instead of the lead.
