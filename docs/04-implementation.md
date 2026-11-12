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
- The daemon starts automatically when the MCP server comes up. If the running daemon's code differs from the `bridge/` code on disk (compared by file content hash), it is replaced on the next call—so edits take effect even without bumping the version. If jobs are running, replacement waits until they finish. A daemon from an installation in another folder is replaced only when the caller's version is newer.
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
- Because a worktree is created from `HEAD`, untracked files are absent. Any gitignored path listed in `.worktreeinclude` at the repository root (the same `.gitignore`-syntax file that Claude Code uses for its own worktrees) is copied into the worktree. Listing `node_modules` and `.env` lets workers run tests without reinstalling dependencies. On APFS this uses copy-on-write clones, so large directories are cheap.
- Although the daemon is shared across sessions, each job belongs to the project of the session that started it. Argument-less `wait` and `status` listings filter to the caller's project, while the status board and `crew status` show all projects.
- Workers do not commit—and cannot, because the worktree's git metadata sits outside their sandbox. When a job finishes, the bridge commits to the job branch, and the lead inspects the diff to merge or reject it.

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
- The table is read when a job starts, so an edit applies to the next job without a restart. A table that is not exactly valid (unknown role or setting, wrong type, unknown agent) fails that job with the reason; it never falls back to the defaults or the previous assignments. Other settings are still read when the daemon starts.
- The role text (`plugin/roles/engineer.md`, `reviewer.md`, `polisher.md`) names no agent. Codex receives it as `developerInstructions`; Antigravity receives it at the top of the first prompt, because ACP has no instruction channel.
- The lead's tool titles and server instructions name the role holders as of session start. `status` and every job result name the agent that actually ran.
- The board shows the roles each agent holds and updates when the file changes.

What each agent may do in each role:

| Role | Codex | Antigravity |
| --- | --- | --- |
| `delegate` | `workspace-write` sandbox; approvals follow `codex.approvalPolicy` | Reads anywhere, edits inside the worktree. Every other action (commands, deletes, moves, network) is put to the user as an approval, unless the request omits its input, in which case it is refused |
| `review` | `read-only` sandbox, never prompts. `mode: "standard"` uses Codex's built-in review | Reads only. Edits and commands are refused and listed in the job's notes. Because it cannot run git, the bridge saves a diff under `~/.crew/reviews/` for each turn (removed when the turn ends) and the job notes say that no tests or checks were run. Follow-ups regenerate the diff for the saved review target and receive its new path, including after a bridge restart. Older jobs without a saved target require a new review. `mode: "standard"` falls back to the prompted review, also noted. Needs a git repository |
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
| Codex approval policy | `on-request` for implementation, `never` for review. Who answers approval prompts is covered in section 5.1 |

## 5. Status display and stall detection (R5)

- Event shape adds `job_id` and a sequence number to the proposal in document 02: `{seq, ts, agent, session_id, job_id, kind, detail}`, where `kind` is `started`, `progress`, `waiting`, `error`, `limit`, `stalled`, `done`, or `cancelled`.
- Quota exhaustion: emits a `limit` event based on `codexErrorInfo` (`usageLimitExceeded`, `rateLimitExceeded`, `sessionBudgetExceeded`) on turn errors for Codex, error text for Antigravity, and `error: rate_limit` from the `StopFailure` hook for Claude.
- Stalls: a running job that emits no events for 5 minutes is marked `stalled`. For Claude sessions, the timer applies only when no tool call is actively running.
- `waiting`, `error`, `limit`, and `stalled` also trigger macOS system notifications.
- Codex usage is read via `app-server`'s `account/rateLimits/read` and `account/rateLimits/updated` and shown on the board and in `status` (the supplemental path in document 03 section 9). It is not yet used for routing decisions.

### 5.1 Approval requests and questions

Worker approval requests and questions are answered by the user, not by the lead.

- If the lead is inside a tool call waiting on that job (`delegate`, `wait`, etc.), the MCP server sends an elicitation request so the Claude app displays its native input prompt. The user's answer goes straight to the worker without passing through the lead, and the tool call continues uninterrupted.
- For a background job, the wake hook wakes the lead, and the prompt appears when the lead calls `wait`.
- If the request is answered first via the status board buttons, or if another job finishes and causes the tool call to return early, the in-app prompt is withdrawn immediately.
- When multiple jobs are waiting at once, prompts are shown one at a time. Any request already answered on the board while an earlier prompt was open is skipped.
- If the user dismisses the prompt without answering, the app fails to display it, or the client does not support elicitation, the waiting state returns to the lead with distinct guidance for each case. The lead asks the user in chat rather than deciding on its own.
- Antigravity never prompts the user; the bridge's role policy decides automatically.

Depending on the user's Codex settings, approval requests may never reach Crew at all: if `approvals_reviewer` in `~/.codex/config.toml` is set to `guardian_subagent` or `auto_review`, Codex's built-in reviewer handles approvals internally. The bridge honors that setting by default. To always route approvals to the user, set `{"codex": {"approvalsReviewer": "user"}}` in `~/.crew/config.json`.

### 5.2 Deciding from the board

The board is also where the user reads what happened and acts on it (requirement R10, roadmap item B1).

- **Job details.** Clicking a job card, its title, or a job's name in the activity feed opens a side sheet with the job's agent, model, project, branch, tokens, and shared-instruction files; the changed files with out-of-scope ones marked; notes; the worker's report; the task it was given; and that job's own activity. The address names the open job (`#<job id>`), so a link opens it directly.
- **Follow-up.** The sheet sends a message that continues the same worker session, the board's counterpart of the lead's `reply`. The lead is told when the turn ends, as for any job.
- **Answers in words.** A worker's question can be answered with text from the card or the sheet. Approvals keep Approve and Deny. Every answer carries the id of the request it was shown with, so it cannot settle a later one.
- **Updates do not disturb.** Cards and the sheet are re-rendered when a job changes, the sheet section by section. Text being typed, its caret, the focused control, an opened section, and the result line of a send are carried over, and a re-render waits while an input method is composing. Answer text is tied to its request and follow-up text to its job, so neither can reach another.
- **Failures are said.** A job that cannot be opened, a refused copy, and a send whose form has since gone are reported in a line at the top of the board.
- **Activity by job.** Each feed row names its job. Two jobs of one agent can be told apart, and the name opens the job.
- **Projects.** Agents are columns and projects are rows. With more than one project on the board, each gets its own headed group holding its sessions and jobs, with a count of what is running and what waits on the user; groups are in alphabetical order and do not move when something happens in one. A job or session belongs to the main working tree of its repository, so work started from a subfolder or a worktree sits with its project. The top bar narrows the board and the feed to one project (remembered in the browser) and shows each project's waiting count; a project's name in its heading does the same. With all projects shown, feed rows say which project they belong to.
- **Pending count.** The tab title shows how many jobs and sessions wait on the user, across all projects.
- **Settings.** Roles (agent, model, and effort per role) and shared instructions (global or per project) are edited in a sheet. It writes the same files a text editor would: `~/.crew/config.json`, `~/.crew/instructions.md`, and `.crew/instructions.md` in the project's main working tree. Saving roles keeps every other setting and refuses to overwrite a file it cannot parse. Only projects the daemon knows from a job or a session can be written to, and a symbolic link at `.crew`, at the instructions file, or at a temporary name is never written through, since a project's `.crew` folder comes with its repository. Closing the sheet with unsaved changes asks first.
- The resume command moved from the card footer into the sheet, next to a command that shows the job's diff.

Checked on 2026-11-12 in the built-in browser pane against a separate daemon with stub agents: opening a job from a card, the feed, and a link; answering a question in words; a follow-up turn; a job update arriving while an answer was half typed (text, focus, and caret kept); project groups and the project filter with two projects, including a job started from a subfolder; saving roles and per-project instructions and reading the files back; refused writes (unknown project, foreign origin, unknown agent); dark mode and a phone-width pane. Not checked: a screen reader, typing with an input method, and browsers other than the built-in pane. Automated board-handler tests cover instruction saves with concurrent edits, failed requests, and editor reloads. The remaining board behavior was checked by hand as listed.

### 5.3 Missions: a command as one unit

A mission is one user command that the lead takes through the pipeline (requirement R10, roadmap item B2). It answers "what was this command split into, who has each part, and how far along is it" without opening a session.

- **Reported by the lead, not inferred.** The lead calls the `mission` tool: with `title` to start one, with `stage` at each step (`plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`), and with `done` or `abandoned` and a one-line `outcome` at the end. `/crew:run` tells it to. The lead's own steps are not jobs, so only the lead can say which step it is on. Which jobs belong to the mission is not left to the lead: every job it starts while a mission is open carries that mission's id.
- **On the board.** Each project group shows its open missions and the two most recent finished ones, above the agents' columns: the command, a seven-step track, "Step 3 of 7 · 1 of 2 jobs finished", and one row per job with its agent and state, which opens the job's details. A mission with a job waiting on the user reads "Waiting on you". Dismiss closes a mission on the board; its jobs keep running.
- **Needs you.** One line at the top lists every job and session waiting on the user across all projects. A job's entry opens its details. The line is a status region, so a new entry is announced.
- **Lifetime.** Missions are stored in `~/.crew/missions.json` and survive a daemon restart still open, since the lead's session may be alive. A mission with no update for 12 hours and no running job is closed as abandoned; activity of its jobs counts as an update. Every open mission is kept, with the 100 that ended last and the last two of each project; a kept mission's jobs are kept with it, beyond the job history limit.
- **Ownership.** A session advances and closes only the mission it opened. Passing the same title again reports a step instead of opening a second card, and a different title opens a new mission before closing the session's previous one. A mission closed from outside (dismissed, or left too long) is not reopened: the lead is told to carry on without reporting.
- **Jobs do not depend on missions.** A job given a mission that is not open still runs, on its own, with a note. If `missions.json` cannot be read, the daemon sets it aside under a new name and starts with none.
- After a restart of its MCP server a session no longer knows its mission. Passing the title again takes up the open mission with that title in the same project; without that, the old card stays until it is dismissed or goes stale. Two sessions that start the same title in one project would share a card.
- A project with an open mission has a group on the board even when it has no jobs or sessions left, so the mission can always be seen and dismissed.

Checked on 2026-11-12 against a separate daemon with stub agents: starting, advancing, finishing, and dismissing missions through the routes; jobs linked to a mission and a job given an unknown one; refused input (unknown stage, empty title); the mission card, its job rows, and the Needs-you line in the browser pane. The `mission` tool itself was not exercised from a live Claude session in this round: the session that built it was started before the tool existed, and its logic in `mcp.ts` has no automated test.

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
- 2026-11-12: Added missions and the Needs-you line (section 5.3, roadmap item B2). The mission store was written by Codex through `delegate` and merged after review by the lead.
- 2026-11-12: The board gained job details, text answers, a project filter, and settings (section 5.2, roadmap item B1).
- 2026-11-12: Added shared instructions (section 2.2, roadmap item A2).
- 2026-11-12: Roles are no longer fixed in code (section 2.1, roadmap item A1). Requirement R3 changed from fixed roles to default roles the user can reassign. The row "Antigravity role enforcement" in section 3 now describes only the editor role; the bridge decides permission requests by the role of the job.
