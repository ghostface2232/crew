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

## 6. Desktop app visibility (R6) findings

| Service | What was verified |
| --- | --- |
| Claude | Natively visible when the lead runs in Desktop; the plugin works in local Desktop sessions |
| Codex | Threads created by the bridge land in the same store used by the Codex desktop app under the title `Crew · <title>` (confirmed via `thread/list`, matching the `source` value of app-created threads). Because the ChatGPT app spawns its own private stdio `app-server`, Crew cannot attach to a running app instance live; when the list refreshes is up to the app (see the issues in document 02 section 6). From the CLI, resume with `codex resume <id>` |
| Antigravity | ACP sessions are saved to the CLI-specific store (`~/.gemini/antigravity-cli/`) under `default-cli-project`, not the desktop app store (`~/.gemini/antigravity/`), so they do not appear in the Antigravity app list. Resume from the CLI with `agy --conversation <id>`. The `agentapi` endpoint that creates conversations inside the app is documented as sidecar-only and provides no way to read responses, so it was not used |

Resume commands are shown in both job results and status board cards.

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
