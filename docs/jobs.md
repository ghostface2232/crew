# Jobs

Lead tools start and manage work in worker sessions. Writable jobs use isolated Git worktrees, and the bridge records each turn so the lead can read its report, continue the session, or accept its changes.

**Key files:** `plugin/bridge/mcp.ts`, `jobs.ts`, `git.ts`, `worker-mcp.ts`, and `prompts.ts`. See [roles.md](roles.md) for assignments, [sandbox.md](sandbox.md) for worker permissions, [delivery.md](delivery.md) for news, and [approvals.md](approvals.md) for decisions and worker questions.

## Lead tools

| Tool | Behavior |
| --- | --- |
| `delegate` | Hand a piece of work (`role`: `delegate`, `refactor`, `release`, or `fix`) to a role holder in an isolated git worktree (`~/.crew/worktrees/<repo>-<hash>/<job id>/<repo folder>`) on branch `crew-<job id>`. Optional `check` runs a sandboxed shell command in the worktree after each turn |
| `review` | Hand a read-only review to a cross-reviewer (`review` role). `runs_app: true` routes to `verify` in a writable snapshot. Defaults to `adversarial`. `mode: "standard"` uses Codex's built-in review |
| `polish` | Hand UI copy, comment, and doc cleanup to the `polish` role. Edits outside `targets` are reported as out of scope |
| `debate` | Run a read-only multi-round debate (`debate` role, up to 6 rounds, default 3) over a hard decision |
| [`mission`](missions.md) | Start, advance, revise, or close a mission and manage its `tasks` and linked pull requests (`pr`) |
| [`route`](usage-and-presets.md) | Ask who should take a role (or `lead`) based on remaining usage and role holders, plus active preset policy and recent model notes |
| [`note`](roles.md) | Record one evidence line (and optional lead peer rating) in `~/.crew/model-notes.json` for a build, fix, or review |
| [`note_summary`](roles.md) | Rewrite a model's prose summary from its evidence lines when due |
| `status` | Return a bounded job summary, a paginated report (`report_offset`, `turn`), or active/recent jobs with agent usage and pending news |
| `wait` | Wait for jobs to finish or ask a lead question. Prompts the user via MCP elicitation if an approval or user question arrives meanwhile |
| `answer` | Answer a worker's `ask_lead` question without ending its turn |
| `reply` | Continue the same worker session (`sync: true` merges `HEAD` first), relay a user decision, decline an out-of-scope approval with a reason, or retry a refusal with `approved_by_user` |
| `cancel` | Stop a running job. With `discard: true`, remove a finished job's worktree and branch |

- Job tools (`delegate`, `review`, `polish`, `debate`, `reply`) return the job ID immediately by default. `background: false` blocks until the worker ends or needs the lead. The lead ends its turn instead of blocking in `wait` so the user can keep talking. The wake hook resumes it when [news](delivery.md#news-and-ownership) arrives.
- Although the daemon is shared across sessions, each job records its canonical starting project (`canonicalPath` in `config.ts`). Argument-less `wait` and `status` filter to the caller's project, while the board and `crew status` show all projects.
- Workers cannot commit because worktree Git metadata lives outside their sandbox. When a turn ends, the bridge creates a transport commit on `crew-<job id>` (hooks and `fsmonitor` disabled, commit signing off, default identity `Crew <crew@localhost>`), and the lead inspects the diff before merging or rejecting it.

## Worktree includes and shared links

Gitignored paths listed in `.worktreeinclude` at the repository root (`.gitignore` syntax, shared with Claude Code's native worktrees) are attached to worktrees (such as `node_modules` and `.env`) so workers can run tests without reinstalling. Crew copies files and uses forced copy-on-write for directories.

On macOS, `cloneTree` in `git.ts` clones the entire directory inside the kernel with one `clonefile(2)` call (invoked through `osascript` because Node has no binding for it), taking about 0.5 s for a 56,000-file `node_modules` compared with 5 s file by file. The clone is made beside its destination and moved into place so nothing already there is ever replaced or removed. It also preserves every mode from the source, whereas `cp` applies the umask to the directories it creates. If that fails for any reason, `/bin/cp -cR -P` clones file by file (libuv's `COPYFILE_FICLONE_FORCE` returns `ENOSYS` on APFS) and determines what the failure means. Other systems use Node's `COPYFILE_FICLONE_FORCE`.

When cloning is unsupported (`ENOTSUP`, `EOPNOTSUPP`, `EXDEV`, `ENOSYS`, `EINVAL`, or macOS `clonefile` refusal), Crew falls back to a junction on Windows or a symlink elsewhere. Crew records links on the worktree and job notes, excludes unignored links by pathspec in commits and dirty checks (directory-only ignore rules miss symlinks, and `info/exclude` is shared with the main checkout), instructs workers to treat them as read-only and put caches in the temp directory, and marks each link and its resolved target read-only in Codex's permissions profile.

## Cleanup and garbage collection

Before removing a worktree, snapshot, or recursive directory (such as scratch), Crew detaches links first using `unlink` (or non-recursive `rmdir` for directory-style Windows junctions) without descending into targets. On Windows, removal clears read-only attributes on the worktree and its validated Git admin directory (strictly inside `<common-git-dir>/worktrees/`) via two hidden `attrib -R` calls (`attrib -R <path> /D /L`, then `attrib -R <path>\* /S /D /L` when non-empty) while preserving ACLs.

Before discard or snapshot removal, Crew unsubscribes the Codex thread and child threads (`thread/unsubscribe`). Because Codex unloads lazily, Windows removal retries transient `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` errors with bounded backoff. If cleanup fails, fallback removes only the validated admin directory and verifies Git no longer lists the worktree. Crew records leftovers in `cleanupPending` (pointing to `crew gc`). Discard never runs a repository-wide prune, and Crew deletes the branch only after Git stops listing the worktree and the branch is no longer checked out. When Windows holds only an emptied worktree directory, discard succeeds with a note and retries removal automatically after 30 s, 2.5 min (consecutive 30 s and 2 min delays), and on startup.

At most once a day on `codex app-server` start, Crew archives its own worktree threads idle for seven days (`thread/list` oldest first, then `thread/archive`) so Codex apps do not fill with old worktrees. `reply` unarchives a thread before resuming.

`crew gc [--apply] [--branches]` scans remembered repositories in dry-run mode by default, listing orphan worker directories, missing-worktree Git admin directories, and unused `crew-cx-*`/`crew-ag-*` branches with merge status against `HEAD`. `--apply` deletes orphan directories and prunes metadata (skipping global prune if unrelated or owned metadata could be touched). `--branches` (with `--apply`) deletes only branches merged into `HEAD`, printing `git branch -D <name>` for unmerged ones.

Active jobs, workspace operations, and owned worktrees are protected. Jobs with `cleanupPending` refuse follow-ups, `sync`, and round changes until resolved. The [daemon API](daemon-api.md) also exposes authenticated `POST /api/gc`, which accepts `{ apply?: boolean, branches?: boolean }` and returns `{ text: string }`.

## Rounds

See [daemon-api.md](daemon-api.md) for the `POST /api/jobs/:id/rounds/:turn` endpoint.

A round can be undone or kept only when the job is idle (terminal), its worktree exists as its own directory on the job branch, no `cleanupPending`/sync/discard/gc is active, and the revert applies cleanly. Otherwise the request fails with the reason and changes nothing. Round states replay from branch reverts before each change so pre-stop reverts survive.

Undoing a round changes files only, not the worker's conversation. The next follow-up turn lists rounds whose state changed since the worker was last notified (`Round.toldWorker`) and tells it not to redo undone edits unless asked. An undo followed by a keep before the next turn says nothing. This works for every agent (Codex's `thread/revert` was skipped because it drops later turns, cannot undo a middle round, and cannot restore a kept round).

## Follow-ups and sync

A worker's worktree starts from `HEAD` (or `base`) and does not follow later commits. `reply` with `sync: true` merges the lead's current `HEAD` into the worker's branch before the follow-up turn and advances `worktree.base` so results still show only the worker's changes. On conflict, the merge aborts (leaving worktree, base, and result unchanged) and the follow-up still runs, naming the lead commit and conflicting files in the prompt and adding a job note. Other sync failures reject the reply. Syncing blocks discard and round changes. Rounds still replay from `roundsBase` so pre-sync undos survive.

A message sent while a turn runs joins that turn. Codex takes it through `turn/steer`. Antigravity takes it as another `session/prompt`, which agy 1.5.14 answers at once while the running turn goes on to reply to it; agy refuses one while a permission request or question waits, so Crew refuses it then too. When an Antigravity turn ends, Crew closes the session (`session/close`), which since agy 1.5.10 also stops its subagents and background work, and a follow-up restores it with `session/resume`. agy 1.5.14 kept the conversation across a close and resume.

A job whose worktree was discarded takes no further turn. See [cleanup and garbage collection](#cleanup-and-garbage-collection) for discarded and orphaned worktrees.

## Question jobs

Question jobs (`ask: true`) are read-only. Codex runs without approval prompts and declines writes. Antigravity refuses edits and commands.

## Outcome reporting

Work roles open their report with `## Outcome` (`done`, `partial`, or `blocked`), stored in `Job.outcome` for the latest turn (omitted on reviews, debates, and questions). Results flag mismatches with bridge observations—such as `outcome: done as declared, but the bridge check failed`, no files changed after a refusal/decline, or `outcome: not declared`. Acceptance lines list kept round commits for cherry-picking when known.

## Worker tools

- Antigravity allows six Crew worker tools (`ask_lead`, `lead_answers`, `siblings`, `search`, `recent_changes`, `rate`) when matched by MCP metadata (`_meta.mcpServerName === 'crew'`) or exact `mcp_crew_<tool>` / `mcp_crew_<8 hex>_<tool>` title, with an optional `Run ` prefix. The 8-hex suffix matches the per-job `crew` server names used by one `agy acp` process from the second job on. Title matching applies only to `other` calls without conflicting MCP metadata or command fields. `execute` and edits still follow role policy.
- Workers launch their Crew MCP server (`worker-mcp.ts`) with the daemon's executable. Under the Electron desktop app, `nodeEnv()` sets `ELECTRON_RUN_AS_NODE=1` so it runs as Node instead of launching another app window.
- Codex reports worker MCP server failures via `mcpServer/startupStatus/updated`. When `crew` fails, Crew attaches a job note and activity entry so the lead knows `ask_lead`, `browser`, and other worker tools are unavailable. Antigravity emits no equivalent status.

## Worker instructions

Job instructions combine the role, shared-machine rules (omitted for workers that cannot run commands, namely Antigravity as reviewer, editor, or question responder), `ask_lead` usage, sandbox/scratch limits, refused-action rules, optional rating/evidence/plugin/skill sections, and shared instructions ([prompts.ts](../plugin/bridge/prompts.ts)).

To avoid injecting the user's entire Codex skill/app catalog into every thread, Crew starts Codex threads with `skills.include_instructions = false` and `features.apps`, `features.plugins`, and `features.tool_suggest` off. The lead can attach specific skills from `~/.agents/skills` via `skills` on `delegate`, `review`, and `polish`. Crew validates names and adds each skill's description and `SKILL.md` path (for Antigravity too). User MCP servers in `~/.codex/config.toml` remain available.

For plugin-enabled threads and eligibility, see [Codex plugins](sandbox.md#codex-plugins).

## Token use

A job records `tokenUse` with total input, cached input, output, and what the latest turn added. Codex reports the running total; for Antigravity, Crew adds up the usage that agy returns with each prompt. `status`, the board, and the desktop apps display it so follow-up turns show how much input was cached. A job also records `context`, how full the worker's context window is, from Codex's latest request (`last.totalTokens` of `modelContextWindow`) or agy's `usage_update`. `status`, the board, and the desktop apps show it.

Token savings measured on Codex CLI 0.167.0 for a no-op question (dropping 123 user skills, 22 app connectors, recommended plugins, and computer-use REPL tools):

| | Input tokens | Cached input |
| --- | --- | --- |
| Before | 23,052 | 13,312 |
| After | 14,723 | 12,032 |

## Tests

Verified on macOS/APFS (clone fallback via injected tests) and on Windows 11 (shared junctions, locked empty folder retries, full test suite). HTTP auth and CLI checks also run against an isolated daemon with fake agents.

Related tests include `test/jobs.test.ts`, `test/worktrees.test.ts`, `test/gc.test.ts`, and `test/mcp.test.ts`. `test/prompts.test.ts` snapshots every valid instruction combination and checks for contradictions. Regenerate with `node --test --test-update-snapshots test/prompts.test.ts`. See [architecture.md](architecture.md#tests) for the full pipeline checks.

## History

- 2026-11-20: Added hex-suffixed Antigravity worker tool title matching and Codex MCP startup failure notes.
- 2026-11-16: Windows bridge parity included canonical project paths (`canonicalPath`).
- 2026-11-14: Hardened Windows worktree cleanup, added delayed empty-folder retries (30 s, 2.5 min, startup), and added `crew gc`.
- 2026-11-12–13: Disabled commit signing with default identity `Crew <crew@localhost>` and renamed branches from `crew/<id>` to `crew-<id>` because Git rejects `crew/...` when a `crew` branch exists.
- 2026-11-11: Moved worktrees from `.crew/worktrees/` to `~/.crew/worktrees/` so repo tools stop scanning them, and added `.worktreeinclude` copying.
