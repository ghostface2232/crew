# 04. Implementation Notes

Written 2026-11-11. Records the implementation of Phase 1 (bridge) and Phase 2 (status board) from [02-implementation-plan.md](02-implementation-plan.md), along with what changed from the plan and why. AgentGauge integration (Phase 3, [document 03](03-agentgauge-integration.md)) was left out of this round.

All facts about external tools were verified directly on this machine on 2026-11-11 against Claude Code 2.1.321, Codex CLI 0.167.0, Antigravity CLI 1.5.5, and Node.js 24.22.1.

## 1. Architecture

```
Claude Code (Desktop or CLI) ── Lead
  │ stdio MCP                    │ Hooks (HTTP)
  ▼                              ▼
plugin/bridge/mcp.ts ──HTTP──▶ Crew Daemon (127.0.0.1:47615)
                                 ├─ codex app-server   (Codex: implementation, review)
                                 ├─ agy acp            (Antigravity: copy & doc cleanup)
                                 ├─ Event log ~/.crew/events.jsonl
                                 └─ Status board (SSE) http://127.0.0.1:47615
```

- A single daemon owns the worker processes, job state, event log, and status board. The MCP server is a thin stateless client. Jobs survive when a Claude session restarts or compacts, and multiple sessions share the same board.
- The daemon starts automatically when the MCP server comes up. If the running daemon's code differs from the `bridge/` code on disk (compared by file content hash), it is replaced on the next call—so edits take effect even without bumping the version. If jobs are running, replacement waits until they finish: the client sends `POST /api/shutdown` with `ifIdle`, and the daemon refuses (`409`) while any job is running, starting up, or syncing for a follow-up, since the client's health check may already be stale. A daemon from an installation in another folder is replaced only when the caller's version is newer. `crew daemon stop` and `restart` are explicit user commands and stop the daemon whatever it is doing; if the shutdown request goes unanswered, they terminate the process recorded in `~/.crew/daemon.json` (provided it matches the PID answering on the port), and report an error instead of "running" if the daemon stays up or rejects the token in `~/.crew/token`.
- A daemon binds the port before reading or writing anything else. If two start at once, the loser exits without creating a token, loading jobs, or clearing the running daemon's scratch directories and review snapshots.
- Everything is packaged as a single Claude Code plugin (`plugin/`) containing the MCP server, hooks, 2 skills, 1 subagent, and 3 role files.

## 2. Tools used by the lead

| Tool | Behavior |
| --- | --- |
| `delegate` | Hand an implementation slice to Codex in a dedicated worktree (`~/.crew/worktrees/<repo>/<job id>`) on branch `crew-<job id>` |
| `review` | Hand a read-only review to Codex. Defaults to adversarial; `mode: "standard"` uses Codex's built-in review |
| `polish` | Hand copy, comment, and doc cleanup to Antigravity. Edits outside `targets` are reported as out of scope |
| `status` | Return the full result of a single job, or the list of active and recent jobs plus Codex usage |
| `wait` | Wait for a job to finish. If an approval request or question arrives meanwhile, prompt the user in the app and keep waiting |
| `reply` | Send follow-up instructions to the same worker session, or forward an approval/denial that the user gave in chat |
| `cancel` | Cancel a job. With `discard: true`, remove the finished job's worktree and branch |

- Added `wait` and `reply` to the five tools from document 02 section 3.4. Both are needed for parallel implementation (the lead and Codex working at the same time) and multi-turn revision requests.
- Tool calls wait for the worker to finish by default. Passing `background: true` returns the job ID immediately.
- Because a worktree is created from `HEAD`, untracked files are absent. Any gitignored path listed in `.worktreeinclude` at the repository root (the same `.gitignore`-syntax file that Claude Code uses for its own worktrees) is attached to the worktree. Files are copied. Directories are cloned with forced copy-on-write where supported (`cp -cR -P` on macOS, Node's `COPYFILE_FICLONE_FORCE` elsewhere); when cloning is unsupported (`ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, `ENOSYS`, or `EINVAL`), Crew links the directory instead of copying it in full (a junction on Windows, a symlink elsewhere). Permission and other errors still fail. Linked paths are recorded on the worktree and in the job notes, and workers are told that those directories are shared read-only with the main checkout: do not install into or delete them, and put tool caches in the temp directory. Codex's permissions profile marks both each link and its resolved target read-only, even under a writable temp root; if a link is broken, the link stays read-only and its missing target is omitted. Because shared targets do not change across turns, loaded threads continue without a forced resume. Listing `node_modules` and `.env` lets workers run tests without reinstalling dependencies.
- Although the daemon is shared across sessions, each job belongs to the project of the session that started it. Argument-less `wait` and `status` listings filter to the caller's project, while the status board and `crew status` show all projects.
- Workers do not commit—and cannot, because the worktree's git metadata sits outside their sandbox. When a job finishes, the bridge commits to the job branch, and the lead inspects the diff to merge or reject it.

Before removing a worktree or review snapshot, Crew detaches its recorded links on every platform; off Windows it checks only those paths, since Node removes other symlinks without following them. On Windows it also detaches any other symlinks and junctions before `git worktree remove` or the `fs.rm` fallback, and does the same in scratch directories after moving them aside, including on restart.

Checked on macOS/APFS on 2026-11-14 with Node 24.22.1 (libuv 1.52.1): `COPYFILE_FICLONE_FORCE` returned `ENOSYS` even on a regular APFS file, while `/bin/cp -c` succeeded, and cloning `/dev/null` failed with `clonefile failed: Invalid argument`—which is why macOS uses `/bin/cp -c` instead of treating Node's `ENOSYS` as an unsupported filesystem. Tests with injected clone failures cover link creation, Codex permissions, detaching before removal, and keeping the main checkout's `.bin` files intact. Windows behavior is covered by fixtures rather than a live Windows run, and no live agent or daemon was started.

### 2.1 Role assignments

Each tool is a role, and `roles` in `~/.crew/config.json` names the agent that holds it. With no `roles` entry the defaults apply, which are the original fixed roles (requirement R3).

```json
{
  "roles": {
    "delegate": { "agent": "codex" },
    "review": { "agent": "codex", "effort": "high" },
    "polish": { "agent": "antigravity" }
  }
}
```

- `agent` is `codex` or `antigravity`. `model` and `effort` are optional and override the agent's own settings for that role; a `model` or `effort` passed to the tool overrides both. Antigravity has no effort setting.
- `polish` takes `model` like `delegate` and `review`. Text results put `model:` right after the title. Optional `resolvedModel` and `resolvedEffort` fields keep the model and effective effort the session reported, falling back to what was configured; when neither is known the result reads `unknown (agent default)`. Older saved jobs still load. Codex reports both when starting or resuming a thread; Antigravity reports its model in the ACP session config or legacy model state, and on config updates.
- When a job changes nothing and its latest turn had a refusal or a declined action, the result says so and points to the refusals/notes; notes from earlier turns do not count. The acceptance lines list the kept round commits for cherry-picking, and omit that hint when no commit is known.
- Antigravity allows Crew's five worker tools (`ask_lead`, `lead_answers`, `siblings`, `search`, `recent_changes`) when named in MCP metadata or by an exact `mcp_crew_<tool>` title (with or without a `Run ` prefix). Title matching applies only to `other` calls with no conflicting MCP metadata and no command input (a `rawInput` string, `command`, or `CommandLine`); `execute` calls and other unrecognized editor calls still follow the role policy. The Windows refusal that prompted this had no captured ACP request, so the title form is covered by a fixture rather than a live run.
- The table is read when a job starts, so an edit applies to the next job without a restart. A table that is not exactly valid (unknown role or setting, wrong type, unknown agent) fails that job with the reason; it never falls back to the defaults or the previous assignments. Other settings are still read when the daemon starts.
- The role text (`plugin/roles/engineer.md`, `reviewer.md`, `polisher.md`) names no agent. Codex receives it as `developerInstructions`; Antigravity receives it at the top of the first prompt, because ACP has no instruction channel.
- The lead's tool titles and server instructions name the role holders as of session start. `status` and every job result name the agent that actually ran.
- The board shows the roles each agent holds and updates when the file changes.

Every Codex job—including writable and `runs_app` jobs—gets a fresh per-turn scratch directory writable in its sandbox, with `TMPDIR`, `TMP`, and `TEMP` set to it via `shell_environment_policy.set` ([09](09-usage-presets-rounds.md) section 9), while read-only and `runs_app` permission profiles keep their restrictions. Antigravity shares one server process with no per-job environment, so its environment is unchanged.

What each agent may do in each role:

| Role | Codex | Antigravity |
| --- | --- | --- |
| `delegate` | `workspace-write` sandbox; approvals follow `codex.approvalPolicy` | Reads anywhere, edits inside the worktree. Every other action (commands, deletes, moves, network) is put to the user as an approval, unless the request omits its input, in which case it is refused |
| `review` | `read-only` sandbox, never prompts; with `runs_app`, a writable sandbox in a snapshot worktree, with approvals as for `delegate` (section 5.4). `mode: "standard"` uses Codex's built-in review | Reads only. Edits and commands are refused and listed in the job's notes. Because it cannot run git, the bridge saves a diff under `~/.crew/reviews/` for each turn (removed when the turn ends) and the job notes say that no tests or checks were run. Follow-ups regenerate the diff for the saved review target and receive its new path, including after a bridge restart. Older jobs without a saved target require a new review. `mode: "standard"` falls back to the prompted review, also noted. Needs a git repository |
| `polish` | `workspace-write` sandbox. Scope is checked after the fact: files outside `targets` are reported as out of scope | Reads anywhere, edits inside the worktree. Everything else is refused |

Antigravity approvals follow the same rules as Codex approvals (section 5.1): the user answers, the prompt shows the whole request (every input field, not only the command) and the job workspace, requests are answered one at a time in arrival order, and the bridge only ever answers "allow once". A denial is sent as "reject once" whenever that is offered. Cancelling the job, the end of the turn, or the server exiting answers any open request as cancelled. No role may switch Antigravity's mode, because "accept-edits" skips the per-edit path check (section 10).

Verified on 2026-11-12 with Codex CLI 0.167.0 and Antigravity CLI 1.5.5, in a throwaway repository on a separate daemon, with the roles swapped:

| Run | Result |
| --- | --- |
| Antigravity as `delegate` | Edited two files in its worktree, then asked to run the tests. The approval showed the whole request: Antigravity sends the command as `rawInput.CommandLine` alongside other fields, so the prompt prints the full input as JSON. After approval the tests ran, and the bridge committed the result on the job branch |
| Antigravity as `review` | Reviewed uncommitted changes from the saved diff, including an untracked file, found the planted defect, and listed the test run under "Not verified". Both notes were attached, and the diff file was removed when the job ended |
| Codex as `polish` | Rewrote the one target file and nothing else; no approval was requested. It used about 166,000 tokens for a three-line README |

Not exercised against the real services: denying an Antigravity request, a request without `rawInput`, and a mode switch. These are covered by protocol stubs only.

### 2.2 Shared instructions

Instructions written once reach every agent (requirement R9).

| File | Applies to |
| --- | --- |
| `~/.crew/instructions.md` | Every project |
| `.crew/instructions.md` at the repository root | That project. Read last, so it can refine the global file |

- Workers: both files are read when a job starts and appended to the job's instructions after the role text, with a preface saying they apply within the role and do not widen it. Codex receives them in `developerInstructions`, Antigravity at the top of its first prompt. `status` lists the files a job was given.
- Claude: a `SessionStart` and `SubagentStart` command hook (`bridge/context.ts`) prints them as `additionalContext`, so the lead and its subagents have them too. It runs again after compaction. The text tells the lead that workers already have the instructions, so delegated tasks need not repeat them.
- The project file is looked up in the repository's main working tree, for a worker job and a Claude session alike, even when either starts inside a linked worktree or a subdirectory. An uncommitted edit therefore applies to the next job. Outside a repository, the session's project directory is used.
- Nothing is written to any service's own instruction files (`AGENTS.md`, `CLAUDE.md`, rules folders).
- A missing or empty file means none. A file that exists but cannot be read fails the job with the reason. The hook reports any failure of its own (unreadable file, git error, malformed input) in the session instead of exiting quietly.
- Claude Code replaces hook context over 10,000 characters with a 2,000-character preview. A file that would take the total past 9,000 characters is replaced by its path, with a statement that none of it is in context until read; files that fit are still sent whole. A cut-off copy is never sent, because it would look complete. Workers have no such limit in the bridge.
- A project file is part of the repository, so it is trusted to the same degree as that repository's `AGENTS.md` or `CLAUDE.md`, and may have been written by someone other than the user. Each part is therefore headed by where it comes from. It cannot widen a role: what a role may do is enforced by the bridge and the sandbox, not by the text. It can still steer an agent within its role, and because it is read last it can contradict the global file.

Verified on 2026-11-12 with marker instructions in both files (write in English, end with a fixed line, use a given word in the first sentence): a Codex review, an Antigravity polish, and a headless Claude Code 2.1.321 session each followed or quoted both. The Codex report came back in English although the same setup had reported in Korean before, so shared instructions took precedence over the user's own Codex defaults in that run.

Not verified: whether `SubagentStart` context reaches a real subagent (the hook's output for that event was only checked by running the script), whether Claude Code counts the 10,000-character cap per hook or across all hooks of an event, and whether Codex's built-in review mode honors `developerInstructions`.

## 3. Changes from the plan

| Area | Document 02 | Implementation | Reason |
| --- | --- | --- | --- |
| Antigravity connection | `agy acp` or `agy -p` | `agy acp` only | The official FAQ states that wrapping `agy -p` inside third-party coding agents is not supported on consumer plans, whereas the ACP docs state "Any ACP client can launch Antigravity CLI" (section 6) |
| Phase 0 | Complete a run with `codex-plugin-cc` and skills first | Skipped | `app-server` worked immediately on this machine, leaving no reason for an intermediate step |
| Role files | `CLAUDE.md`, `AGENTS.md`, Antigravity custom agent | `roles/*.md`, skills, and MCP server instructions inside the plugin | No files need to be dropped into each repository. Roles are injected per job via `developerInstructions` for Codex and a prompt prefix for Antigravity |
| Antigravity role enforcement | `--agent` and `--mode` | Bridge evaluates ACP permission requests | In default mode, every edit triggers a permission request. The bridge allows reads anywhere, allows edits only inside the worktree, and denies command execution, deletion, moves, and network requests—recording any denials in the job result. No files need to be written into the user's config directory |
| Event transport | WebSocket | SSE | One-way streaming is sufficient, the browser reconnects automatically, and actions use plain `POST` requests |
| Claude status source | `claude agents --json` polling plus Notification hook | Hooks only | Hooks are push-based, cover Desktop sessions, and use HTTP so no extra process is spawned |
| Waking the lead | Unspecified | `asyncRewake` hook | Wakes an idle lead session when a background job finishes or needs a decision. Channels were skipped because they are a research preview and require a feature flag |

## 4. Resolved open items

| Item | Decision |
| --- | --- |
| Implementation language | TypeScript executed directly via Node.js 22.18+ type stripping, with zero runtime dependencies and no build step |
| MCP implementation | Written directly without the official SDK; only lifecycle, tools, progress notifications, and cancellation are needed |
| Event log | JSONL (`~/.crew/events.jsonl`); job state lives in `~/.crew/jobs.json` |
| Status board form factor | Local web page served by the daemon, viewable inside Claude Desktop's browser pane. Standalone app discussed in section 7 |
| Suspected stall timeout | 5 minutes (`stallSeconds` in `~/.crew/config.json`) |
| Max review rounds | Default 1, max 2, written as a rule in the `/crew:run` skill rather than enforced by the bridge |
| Codex approval policy | `on-request` for implementation and for a review that runs the app, `never` for a static review. Who answers approval prompts is covered in section 5.1 |

## 5. Status display and stall detection (R5)

- Event shape adds `job_id` and a sequence number to the proposal in document 02: `{seq, ts, agent, session_id, job_id, kind, detail}`, where `kind` is `started`, `progress`, `waiting`, `error`, `limit`, `stalled`, `done`, or `cancelled`.
- Quota exhaustion: emits a `limit` event based on `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`) on turn errors for Codex, error text for Antigravity, and `error: rate_limit` from the `StopFailure` hook for Claude.
- Stalls: a running job that emits no events for 5 minutes is marked `stalled`. For Claude sessions, the timer applies only when no tool call is actively running.
- `waiting`, `error`, `limit`, and `stalled` also trigger macOS system notifications.
- Codex usage is read via `app-server`'s `account/rateLimits/read` and `account/rateLimits/updated` and shown on the board and in `status` (the supplemental path in document 03 section 9). It is not yet used for routing decisions.

### 5.1 Approval requests and questions

Codex's approval requests go first to its own automatic reviewer (`codex.approvalsReviewer`, default `auto_review`). What that reviewer refuses twice, and every request and question that reaches Crew, is answered by the user, not by the lead.

- If the lead is inside a tool call waiting on that job (`delegate`, `wait`, etc.), the MCP server sends an elicitation request so the Claude app displays its native input prompt. The user's answer goes straight to the worker without passing through the lead, and the tool call continues uninterrupted.
- For a background job, the wake hook wakes the lead, and the prompt appears when the lead calls `wait`.
- If the request is answered first via the status board buttons, or if another job finishes and causes the tool call to return early, the in-app prompt is withdrawn immediately.
- When multiple jobs are waiting at once, prompts are shown one at a time. Any request already answered on the board while an earlier prompt was open is skipped.
- If the user dismisses the prompt without answering, the app fails to display it, or the client does not support elicitation, the waiting state returns to the lead with distinct guidance for each case. The lead asks the user in chat rather than deciding on its own.
- Antigravity never prompts the user; the bridge's role policy decides automatically.

**The automatic reviewer and refusals.** Crew starts every Codex thread with `approvalsReviewer: auto_review`, so Codex's built-in reviewer answers approval requests and they do not reach Crew. To route every request to the user instead, set `{"codex": {"approvalsReviewer": "user"}}` in `~/.crew/config.json`. Antigravity has no such reviewer; the bridge's role policy (section 2.1) plays that part.

When the reviewer refuses an action (`item/autoApprovalReview/completed` with status `denied` or `timedOut`), the bridge records the action details—including executable argument boundaries, working directory, and MCP input—on the job and shows them in the result. MCP input is recovered from the started item by `targetItemId` within the same thread and turn, or labeled as missing if unavailable. Codex approval prompts and refusal notes show action fields rather than whole protocol payloads, omit environment fields, and cap free-form input at 4,000 characters, reasons at 2,000, and full action descriptions at 8,000, appending `… (truncated)` when cut.

Missing reasons are labeled as missing, and generic messages such as "blocked by policy" are quoted and marked generic rather than expanded into a guessed rationale. The result suggests another way within the job's permissions alongside the retry path below. Job notes for declined Codex approvals and Antigravity role refusals, user declines, and missing one-time approval options likewise keep the action input, paths, and next step. ACP permission responses still select reject-once (or cancel if no suitable option is offered), since that protocol response carries only an option id. Workers are instructed to report the exact command or tool input and message received. Crew's own source did not contain the string "blocked by policy"; a provider or worker can supply it, though its source in the reported Windows runs was not captured. The lead then decides whether the user's request in the conversation covers the action:

1. If it does, the lead calls `reply` with `approved_by_user`, quoting the user's words, without asking them again. The bridge sends the worker a follow-up that states the approval and names the refused action, and the reviewer judges it once more.
2. If it is refused again, the same call starts a turn with `approvalsReviewer: user`, so each request of that turn comes to the user as in the list above. Later turns return to the automatic reviewer. "Again" means the turn before was itself a retry: an unrelated action refused later starts over with the automatic reviewer. If a retry turn fails before the worker can act, the refused action stays on the job and can be sent back once more.
3. If the request does not cover the action, the lead tells the user and lets them decide.

The first retry rests on the lead's reading of the conversation, not on a check by the bridge: the reviewer treats the follow-up as the user's own message. Checked on 2026-11-12 through `codex app-server`: the reviewer read the thread's user message as authorization ("authorization: high") and approved deleting a folder outside the workspace that the task had asked for. A real refusal was not produced in that check, so the `denied` path is covered only by tests with a stub server.

### 5.2 Deciding from the board

The board is also where the user reads what happened and acts on it (requirement R10, roadmap item B1).

- **Job details.** Clicking a job card, its title, or a job's name in the activity feed opens a side sheet with the job's agent, model, project, branch, tokens, and shared-instruction files; the changed files with out-of-scope ones marked; notes; the worker's report; the task it was given; and that job's own activity. The address names the open job (`#<job id>`), so a link opens it directly.
- **Follow-up.** The sheet sends a message that continues the same worker session, the board's counterpart of the lead's `reply`. The lead is told when the turn ends, as for any job.
- **Answers in words.** A worker's question can be answered with text from the card or the sheet. Approvals keep Approve and Deny. Every answer carries the id of the request it was shown with, so it cannot settle a later one.
- **Updates do not disturb.** Cards and the sheet are re-rendered when a job changes, the sheet section by section. Text being typed, its caret, the focused control, an opened section, and the result line of a send are carried over, and a re-render waits while an input method is composing. Answer text is tied to its request and follow-up text to its job, so neither can reach another.
- **Failures are said.** A job that cannot be opened, a refused copy, and a send whose form has since gone are reported in a line at the top of the board.
- **Activity by job.** Each feed row names its job. Two jobs of one agent can be told apart, and the name opens the job.
- **Projects.** The board is organized by command, grouped by project; agents are not an axis. Each project is a headed group holding its lead sessions (one line each) and its commands, with a count of what is running and what waits on the user; groups are in alphabetical order and do not move when something happens in one. A job or session belongs to the main working tree of its repository, so work started from a subfolder or a worktree sits with its project. The top bar narrows the board and the feed to one project (remembered in the browser) and shows each project's waiting count; a project's name in its heading does the same. With all projects shown, feed rows say which project they belong to.
- **Pending count.** The tab title shows how many jobs and sessions wait on the user, across all projects.
- **Settings.** Roles (agent, model, and effort per role) and shared instructions (global or per project) are edited in a sheet. It writes the same files a text editor would: `~/.crew/config.json`, `~/.crew/instructions.md`, and `.crew/instructions.md` in the project's main working tree. Saving roles keeps every other setting and refuses to overwrite a file it cannot parse. Only projects the daemon knows from a job or a session can be written to, and a symbolic link at `.crew`, at the instructions file, or at a temporary name is never written through, since a project's `.crew` folder comes with its repository. Closing the sheet with unsaved changes asks first.
- The resume command moved from the card footer into the sheet, next to a command that shows the job's diff.

Checked on 2026-11-12 in the built-in browser pane against a separate daemon with stub agents: opening a job from a card, the feed, and a link; answering a question in words; a follow-up turn; a job update arriving while an answer was half typed (text, focus, and caret kept); project groups and the project filter with two projects, including a job started from a subfolder; saving roles and per-project instructions and reading the files back; refused writes (unknown project, foreign origin, unknown agent); dark mode and a phone-width pane. Not checked: a screen reader, typing with an input method, and browsers other than the built-in pane. Automated board-handler tests cover instruction saves with concurrent edits, failed requests, and editor reloads. The remaining board behavior was checked by hand as listed.

### 5.3 Missions: a command as one unit

A mission is one user command that the lead takes through the pipeline (requirement R10, roadmap item B2). It answers "what was this command split into, who has each part, and how far along is it" without opening a session.

- **Reported by the lead, not inferred.** The lead calls the `mission` tool (as instructed by `/crew:run`): with `title` to start a mission, with `stage` at each step (`plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`), and with `done` or `abandoned` plus a one-line `outcome` at the end. Because the lead's own steps are not jobs, only the lead knows which step it is on. Job membership is automatic: every job the lead starts while a mission is open carries that mission's ID.
- **On the board.** Each project group shows its open missions and the two most recently finished ones, each as a track of six stops: Plan, Build, Review, Fix, Polish, Final. The lead's seven stages map onto them, with the two reviews sharing one stop. A job sits under the stop of its kind (delegate under Build, review under Review, polish under Polish), and the lead's own work shows at the current stop when the session that opened the mission is known. Clicking a job opens its details. A mission folds to one line whose six squares summarize its stops; ended missions start folded. Jobs started outside any mission are kept in one card per project. Dismiss closes a mission on the board while its jobs keep running.
- **Reading it.** Color and shape mean state, never agent: working is a blue dot, waiting on the user an amber square, failed a red diamond, no activity a hollow amber ring, done gray, cancelled a hollow gray ring. An agent is named in text. Time is shown only as a label on the thing it describes ("7m", "3m so far", "waiting 4m", "quiet for 8m", "stopped after 11m"); nothing is laid out along a time axis. The agents appear once, in the top bar, with their state, role, and Codex's usage.
- **Needs you.** Above the projects, each waiting request is a card with the full request and the controls that answer it, so nothing has to be opened to decide.
- **Width.** Below 760px the track stands upright, with stops running top to bottom and their jobs beside them, and the details layer rises from the bottom. The page does not go below 360px. The board is light whatever the system setting; the dark variant was removed with this layout.
- **Needs you.** One line at the top lists every job and session waiting on the user across all projects. Clicking a job's entry opens its details. The line is a status region, so new entries are announced.
- **Lifetime.** Missions are stored in `~/.crew/missions.json` and remain open across daemon restarts, since the lead's session may still be active. A mission with no update for 12 hours and no running job is closed as abandoned (job activity counts as an update). The store keeps every open mission, the 100 that ended most recently, and the last two of each project; a kept mission's jobs are retained with it, even beyond the normal job history limit.
- **Ownership.** A session advances and closes only the mission it opened. Passing the same title again updates the existing mission instead of opening a second card; passing a different title opens a new mission before closing the session's previous one. A mission closed from outside (dismissed or timed out) is not reopened: the lead is told to continue without reporting.
- **Jobs do not depend on missions.** A job given a mission that is not open still runs on its own, with a note attached. If `missions.json` cannot be read, the daemon sets it aside under a new name and starts with an empty store.
- After an MCP server restart, a session no longer remembers its mission ID. Each mission records the Claude session that opened it (`CLAUDE_CODE_SESSION_ID`, when the client passes it to the server). Passing the same title again reattaches to the open mission of that title only if this session opened it; otherwise a new mission starts and the old card stays until it is dismissed or goes stale. Two sessions in one project that use the same title therefore get separate cards. Not verified: that Claude Desktop passes the session id to the MCP server; without it nothing is reattached.
- A project with a mission keeps its group on the board even when it has no jobs or sessions left, so an open mission can always be seen and dismissed and the last finished ones stay visible.

Checked on 2026-11-12 against a separate daemon with stub agents: starting, advancing, finishing, and dismissing missions through the routes; jobs linked to a mission and a job given an unknown one; refused input (unknown stage, empty title); the mission card, its job rows, and the Needs-you line in the browser pane. The `mission` tool itself was not exercised from a live Claude session in this round: the session that built it was started before the tool existed, and its logic in `mcp.ts` has no automated test.

### 5.4 Sharing the machine

The user and every agent work on one computer, often at the same time (requirement R14). Three rules keep them out of each other's way.

- **Isolated instances.** Every worker job that can run commands receives `plugin/roles/machine.md` after its role text ([09](09-usage-presets-rounds.md) section 14): start your own copy of anything you run on a free port chosen by the system, keep its data and browser profile under a temporary directory, use headless browsers only, never touch the app's default port or the user's running instance or browser, and stop only what you started. The lead and its subagents get the same rules from `/crew:run` and the self-reviewer's instructions. Only the lead may use the browser pane, because there is only one and it is shared with the user.
- **Reviews in parallel, one app.** When to review is a rule for the lead while it runs the pipeline, given in the MCP server instructions and in `/crew:run`; outside the pipeline the lead reviews only when asked. The rule: one review (self or cross) when a substantial piece of implementation reaches a stopping point, before a push or pull request a review of only what no review has covered (both in parallel where security, concurrency, or data loss is involved), and none for small fixes. The bridge does not track which commits were reviewed; the lead does, from the conversation, by matching the commits going out to the reviews that covered them. Reviewers that run together are started in one step, and the working tree is left untouched until all report. A worker's review is static by default: it runs in a read-only sandbox that cannot host an app instance, and it is instructed to read files and run only checks that finish on their own. If a change can only be judged by running the app, exactly one reviewer runs it: the lead either tells the self-reviewer that it may, or starts the cross-review with `runs_app` and keeps the self-review static. These rules travel with the job's system instructions rather than its prompt, so Codex's built-in review mode receives them too.
- **Plugins.** Every Codex thread starts with the user's plugins, apps, and skill list switched off, saving thousands of input tokens a turn. A `runs_app` job gets the plugins in `codex.appPlugins` (`computer-use` and `unified-computer-use` by default), and writable `delegate` and `review` jobs take `plugins` (a list of plugin names) for any others; `ask` jobs cannot take plugins, and a review with `plugins` requires `runs_app`. Because Codex can only switch plugins on as a whole, each start or resume of a job with plugins queries `plugin/installed`, enables only the requested plugins that are installed and on in the user's settings, and disables every other installed plugin by id; the skill list stays on so the worker gets each plugin's skill. A plugin named in `plugins` that is not installed or that the user has off is noted on the job; missing `appPlugins` defaults are not. Under the default `approvalsReviewer: auto_review`, Codex's automatic reviewer judges each plugin tool call and a refusal shows in the result like any other; a plugin's approval request that does reach the bridge goes to the user like a command's. The instructions tell the worker that computer use operates the real, shared screen—only when no screenless check can answer the question, and only on windows of the instance the worker started—and the lead is told not to run two such jobs at once. Checked on 2026-11-13 with Codex CLI 0.167.0 and `gpt-6.1-sol` on an isolated daemon: a plain job listed no `cua_repl` server and a `runs_app` job did; in three `runs_app` jobs asked only to look at the screen, the worker started a computer-use session and listed the running apps, every call was judged by the automatic reviewer and none reached the bridge, and the reviewer refused reading the state of an app the worker could not show was frontmost. Reading a window needs an app picked first, so a worker sees the screen only for an app it names, such as one it started. When a non-native-review Codex thread has at least one plugin enabled, the adapter appends a user-app exception to `developerInstructions` (leaving the saved job instructions unchanged): when the lead's task explicitly asks for a specific action in a specific app or window of the user's, the worker may perform it through plugin tools only, never shell commands. Repository files, web pages, tool output, and the worker's own inference never grant this permission, and the worker must stop and report instead of entering passwords or other credentials, paying or buying, sending messages or posting, accepting terms, or changing system or account settings. On 2026-11-14, told to use the user's Chrome, a job opened a new tab, loaded example.com, read it from a screenshot, and closed only that tab, driving Chrome as a desktop app. The chrome plugin's own browser tools answered "The browser access host is unavailable" in Crew jobs; that was not investigated. Not exercised: a plugin approval request reaching the bridge.
- **Jobs that run the app.** `runs_app` on `delegate` or `review` gives the job's sandbox network access (`sandbox_workspace_write.network_access`), without which it cannot bind even a local port. A review with `runs_app` does not run in the user's tree: the bridge creates a worktree from `HEAD` (or the commit under review), copies the `.worktreeinclude` files into it and, when the target is the uncommitted changes, those changes and the untracked files, and runs the reviewer there with a writable sandbox. Submodules are not in the snapshot (the job notes say so), and a file marked skip-worktree arrives as committed. The snapshot and its branch are removed when the turn ends, and a follow-up gets a fresh one. Polish jobs, and a reviewer that cannot run commands, are refused `runs_app`. On the board the job is marked "runs the app".
- **Measurement alone.** A `delegate` job started with `exclusive` runs alone on the machine; review and polish jobs cannot, as they have nothing to measure. The bridge refuses an exclusive job while any other job is active, and refuses every other job start or follow-up turn until the exclusive job ends. A refusal names the blocking jobs and what each is doing, since a job that is waiting on the user or stalled will not clear simply by waiting. Because one daemon serves every session, this lock holds across all sessions and projects. The bridge refuses rather than queues so the lead stays in charge of ordering: it waits and retries when ready. Workers are instructed not to time anything unless their job says it has the machine to itself. On the board, an exclusive job is marked "runs alone".

What is enforced vs. instructed: the exclusivity rule for jobs is enforced by the bridge. Network access and the review snapshot are set by the bridge. Instance isolation, static reviews, and "only one reviewer runs the app" are instructions; the bridge does not allocate ports or monitor processes. Because the lead's own measurements, its subagents, and processes outside Crew are not bridge jobs, the bridge cannot hold them back; `/crew:run` instructs the lead to wait until nothing is running first.

What Codex can run was checked on 2026-11-12 with Codex CLI 0.167.0 (`codex exec`, a throwaway repository, a one-page Node server):

| Sandbox | Result |
| --- | --- |
| `read-only` (how reviews run) | Could not write under the temporary directory or in the project, could not start the server, and had no outbound network. A Codex reviewer cannot run the app here, which is why a review that must run it gets a snapshot worktree instead |
| `workspace-write` (how engineers run) | Could write in the project and under the temporary directory. Could not bind a local port (`listen EPERM ... 127.0.0.1`) and had no outbound network |
| `workspace-write` with permission requests allowed | Started the server on a free port, fetched it, and loaded a page in headless Chrome with a fresh profile, each after requesting escalation |
| `workspace-write` with network access, no escalation (how `runs_app` jobs run) | Started the server on a free port, fetched it, and reached an outside host. Headless Chrome still failed (exit code 134), a write to the home directory was blocked, and `kill` on its own server was not permitted, though the server stopped on an interrupt |

- Without `runs_app`, an engineer can follow the isolation rules only through an approval for each command that listens or launches a browser. With it, a server needs no approval and a browser still does. Codex's automatic reviewer answered those requests without asking the user (section 5.1).
- A real `delegate` job with `runs_app`, run through a separate daemon, started the server on a free port, fetched it, and stopped it with no approval request (about 120,000 tokens). A real review with `runs_app` was not run; its snapshot is covered by tests against a real git repository.
- `codex app-server` accepts the network setting per thread: `thread/start` with `config: {"sandbox_workspace_write": {"network_access": true}}` reported `networkAccess: true` in its sandbox policy, and `false` without it.
- Computer use and browser use: both tools are listed in a headless run, but neither worked there. The in-app browser failed with "The browser access host is unavailable", and the one read-only computer-use observation returned no screen state. Through `codex app-server`, which is how Crew drives Codex, computer use answered: a read-only state call listed the apps on the machine and which were running, after the automatic reviewer approved it. Clicking and typing were not tried. The in-app browser failed the same way there; it appears to need a host that a background thread does not have.

Not verified: whether Antigravity follows the isolation rules, and whether Codex's built-in review mode applies the instructions it is sent. Two reviewers running the same test suite at once in one working tree could still collide if the tests use fixed ports or files; this project's do not.

## 6. Desktop app visibility (R6) findings

| Service | What was verified |
| --- | --- |
| Claude | Natively visible when the lead runs in Desktop; the plugin works in local Desktop sessions |
| Codex | Threads created by the bridge land in the same store used by the Codex desktop app under the title `Crew · <title>` (confirmed via `thread/list`, matching the `source` value of app-created threads). Because the ChatGPT app spawns its own private stdio `app-server`, Crew cannot attach to a running app instance live; when the list refreshes is up to the app (see the issues in document 02 section 6). From the CLI, resume with `codex resume <id>` |
| Antigravity | ACP sessions are saved to the CLI-specific store (`~/.gemini/antigravity-cli/`) under `default-cli-project`, not the desktop app store (`~/.gemini/antigravity/`), so they do not appear in the Antigravity app list. Resume from the CLI with `agy --conversation <id>`. The `agentapi` endpoint that creates conversations inside the app is documented as sidecar-only and provides no way to read responses, so it was not used |

Resume commands are shown in both job results and the board's job details.

### Antigravity policy risk

The official FAQ (https://antigravity.google/docs/faq/) states:

- "Wrapping `agy` inside third-party coding agents or applications, or automating account rotation, is not supported under consumer plans."
- "Using third-party software, tools, or services to access Antigravity is a violation of our Terms of Service" / "Such actions can result in suspension or termination of your account."

The bridge runs only the official `agy` binary via ACP—which Google documents for third-party clients—and never touches credentials. Even so, whether driving Antigravity from Claude Code through an ACP client falls under the wording above depends on Google's interpretation. To disable Antigravity completely, set `{"antigravity": {"enabled": false}}` in `~/.crew/config.json`.

## 7. Standalone status board app

Right now there is only the web board. If a standalone app is built later, a native macOS menu bar app (SwiftUI) is recommended ahead of Tauri:

- What a standalone app adds over a web page is OS integration—menu bar status, notifications with approve/deny buttons, and launch at login—where native SwiftUI is a better fit.
- All state and logic already live in the daemon. A client only needs `/api/state`, `/api/stream` (SSE), and a few `POST` endpoints, keeping any platform UI thin.
- The web board stays for Claude Desktop's browser pane.

## 8. Verification summary (2026-11-11)

Verified against live accounts in a temporary repository:

- `delegate`: worktree creation, Codex implementation and test run, bridge commit, and report in ~30 seconds.
- `review`: both `adversarial` and `standard` modes returned verdicts and supporting evidence.
- `polish`: Antigravity edited only the README and comments, verified via diff.
- Out-of-workspace edit protection: instructed Antigravity to edit a file outside the worktree; confirmed the bridge denied the request and left the file untouched.
- `.worktreeinclude`: confirmed `node_modules/` and `.env` were copied into the worktree and excluded from the worker's commit.
- Project isolation: confirmed an argument-less `wait` called from another project did not consume jobs belonging to a different project.
- Approval flow: with approval policy set to `untrusted`, verified transition to `waiting`, approval and denial via `reply`, and resumption.
- Approval prompts: using a test client that responds to elicitation, verified approve, deny, dismiss, client error, answering on the board first, three jobs waiting simultaneously (prompts opened sequentially without overlapping), and early return when another job finished (prompt withdrawn immediately). Confirmed Claude Code 2.1.321 advertises `elicitation: {form, url}` on initialization, and that in a headless session the unanswered prompt fell back to the lead, which then asked the user in chat.
- `cancel` and `discard`: removed the worktree and branch cleanly.
- Wake hook: exited with code 2 and printed the result when a background job finished; exited silently for jobs already delivered.
- Hooks: confirmed prompt submission and session stop in a live Claude Code session were recorded in the event log.
- Request guards: `POST` requests from another `Origin` and requests with a foreign `Host` header returned HTTP 403.
- 18 unit tests (`npm test`).
- Full pipeline: completed a small feature end to end across all seven stages with `/crew:run` in a headless Claude Code session. Codex wrote tests in parallel, the self-review subagent and Codex cross-review both passed, the lead rejected an unrelated comment change from Antigravity's polish diff, and all three lanes appeared simultaneously on the board.
- Claude Desktop: after installing the plugin, confirmed the `crew` tools, skills, and subagent loaded in an open Desktop session.

Not yet verified:

- `asyncRewake` actually waking an idle interactive session (verified only by running the hook script standalone).
- Visual appearance of the native approval dialog inside Claude Desktop (verified protocol round-trip only).
- When threads appear in the Codex desktop app UI.
- Windows.

## 9. Next steps

1. AgentGauge integration (document 03 G1): wire up `route` to replace the static fallback table in `/crew:run` with measured usage routing.
2. macOS menu bar app (section 7).
3. Claude usage display: forward `rate_limits` from the statusline to the daemon and show it in the Claude lane.

## 10. Revision log

- 2026-11-11: Updated after the first code review:
  - Reverted Antigravity sessions from `accept-edits` mode back to the default mode. Live testing showed `accept-edits` allowed edits outside the workspace without prompting, contrary to its description ("Approve file edits in the workspace without asking"). The bridge now checks the target path on every edit permission request.
  - Moved worktrees out of `.crew/worktrees/` inside the repository to `~/.crew/worktrees/`. Keeping them inside the repo caused test runners, `tsc`, linters, and file watchers to scan worktree copies, and required touching `.git/info/exclude`.
  - Added `.worktreeinclude` copying so gitignored files can be brought into worktrees. Initial verification in section 8 used a dependency-free temp repo, which hid this gap.
  - Recorded the owning project on each job and filtered argument-less `wait` and `status` listings by project. Previously, a session in another project could wait on and mark-delivered a job from the wrong project, preventing the original session's wake hook from delivering the result.
  - Changed the responder for approval requests from the lead to the user. Previously, waiting states returned to the lead, which could approve requests on its own if they looked safe. Now the app prompts the user directly (section 5.1).
  - Tightened daemon replacement from "whenever the version differs" to "when the caller has a newer version and no jobs are active," preventing two installations with different versions from repeatedly killing each other's daemon or interrupting active jobs. Note that plugins installed from a local-path marketplace run directly from the source folder rather than a cached copy (verified via process path).
- 2026-11-12: Updated after the second code review:
  - Switched daemon replacement checks from version comparison to hashing the `bridge/` files on disk. Because local-path installations run straight from the source folder, edits made without bumping the version were not picked up by a running daemon. Hashing the files on disk rather than in the calling process also keeps a long-lived session with older in-memory code from repeatedly restarting a newer daemon. Version comparison is kept only for breaking ties between installations in different directories.
  - Separated "the app failed to open the approval dialog" from "the user dismissed the dialog," giving the lead distinct instructions for each case.
  - Serialized approval dialogs across multiple waiting jobs so they appear one at a time, and withdrew any open dialog immediately when the tool call returns.
  - Backfilled the repository path as the owning project when loading jobs saved before project tracking existed.
  - Insulated bridge delivery commits from the user's git commit config by disabling commit signing and falling back to `Crew <crew@localhost>` when git user identity is unset, preventing background daemon commits from hanging on an invisible GPG/SSH passphrase prompt.
  - Renamed job branches from `crew/<job id>` to `crew-<job id>`, because git cannot create `crew/...` refs if a branch named `crew` already exists in the repository.
- 2026-11-12: Rebuilt the board around commands: tracks of stops, state shown by color and shape, time as labels only, and an upright layout on narrow screens (sections 5.2 and 5.3).
- 2026-11-12: From the pull request review: a mission is taken up again only by the session that opened it, and a project whose only records are finished missions stays on the board (section 5.3).
- 2026-11-13: From the same report: `runs_app` jobs get the user's computer-use plugins and `delegate`/`review` take `plugins` (section 5.4); results name the model that ran, never print `cherry-pick null`, and say when a job that changed nothing was refused something; `polish` takes `model`; Antigravity's usage is judged by the family its model belongs to (document 09, section 3). For Windows, fixed in code and covered by unit tests only, not run on Windows: agent binaries are found with `PATHEXT` and npm `.cmd` shims run through a shell; a worktree Git cannot remove is deleted directly and pruned; links inside a worktree are detached before removal so a junction is never followed; a review snapshot's removal is retried before a follow-up is refused.
- 2026-11-13: From a user report: the daemon now binds the port before writing a token or touching job state, so a lost startup race cannot overwrite the active listener's token; the daemon refuses `ifIdle` replacement while a job is active or starting; `crew daemon restart` terminates a daemon that rejects the token on disk and no longer reports a false "running" (section 1); and a `sync` whose merge conflicts still delivers the reply (document 09, section 10). Not reproduced: four running Codex jobs failing with "codex app-server exited" during a restart. A daemon shutdown records "was closed"; "exited" means the `app-server` process was terminated from outside.
- 2026-11-13: Before a push or pull request, only what no review has covered is reviewed, with both reviews in parallel where security, concurrency, or data loss is involved (section 5.4).
- 2026-11-12: Reviews are now tied to where the work is going: one review at a stopping point, both before a push or pull request (section 5.4).
- 2026-11-12: Codex approvals now go to its automatic reviewer by default, a refused action can be sent back once with the user's approval before the user is asked, and jobs marked `runs_app` get network access and, for reviews, a snapshot worktree (sections 5.1 and 5.4).
- 2026-11-12: Added shared-machine rules, static-by-default reviews, and jobs that run alone (section 5.4). `/crew:run` now runs the self-review and the cross-review at the same time.
- 2026-11-12: Added missions and the Needs-you line (section 5.3, roadmap item B2). The mission store was written by Codex through `delegate` and merged after review by the lead.
- 2026-11-12: The board gained job details, text answers, a project filter, and settings (section 5.2, roadmap item B1).
- 2026-11-12: Added shared instructions (section 2.2, roadmap item A2).
- 2026-11-12: Roles are no longer fixed in code (section 2.1, roadmap item A1). Requirement R3 changed from fixed roles to default roles the user can reassign. The row "Antigravity role enforcement" in section 3 now describes only the editor role; the bridge decides permission requests by the role of the job.
- 2026-11-12: Hardened the board's narrow, pending, failed, and live-update states. The minimum page width is now 320px (superseding the 360px note in section 5.3); drawer controls reflow and job flags occupy their own row. Session summaries expand to reveal full titles and details. The narrow project panel contains focus and makes the background inert. Request decisions and text answers share a job/request lock across the dock and drawer, survive redraws, and report failures beside fixed button labels. Completed requests stay locked while awaiting SSE; failed ones can be retried. Existing work text no longer replays entrance effects, height changes retarget from their current size, folds use one interruptible height transition, and reduced-motion disables chart movement. Activity now has an independent, visible scrollbar. Verified with local fixtures at 320, 360, 1168 and 1440px, overlapping request controls, retries, accepted requests, keyboard navigation, and rapid updates. Typecheck and 32 board/session/settings/policy/mission tests passed; the full suite still encounters the existing adapter-test failures on this Windows environment, so this entry does not claim a full-suite pass.

- 2026-11-12: Crew 0.2.0 migrates the board to React/TypeScript/Vite and adds an Electron app as explicitly requested by the user, superseding the unimplemented SwiftUI recommendation in section 7. The independent daemon, web board and Claude lead mode remain. Details, dependency decisions, direct dispatch scope and verification are in [07-desktop-and-react.md](07-desktop-and-react.md).
