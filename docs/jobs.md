# Jobs

Lead tools start and manage work in worker sessions. Writable jobs use isolated Git worktrees, and the bridge records each turn so the lead can read its report, continue the session, or accept its changes.

**Key files:** `plugin/bridge/mcp.ts`, `jobs.ts`, `git.ts`, `worker-mcp.ts`, and `prompts.ts`. See [roles.md](roles.md) for assignments, [sandbox.md](sandbox.md) for worker permissions, [delivery.md](delivery.md) for news, and [approvals.md](approvals.md) for decisions and worker questions.

## Lead tools

| Tool | Behavior |
| --- | --- |
| `delegate` | Hand a piece of work (`role`: `delegate`, `refactor`, `release`, or `fix`) to a role holder in an isolated git worktree (`~/.crew/worktrees/<repo>-<hash>/<job id>/<repo folder>`) on branch `crew-<job id>`. Optional `check` runs a sandboxed shell command in the worktree after each turn. Optional `difficulty` (`routine`, `standard`, or `hard`) is stored on the job (`Job.difficulty`) at creation so its review cannot change it; the job's build line in the [model notes](roles.md) uses it, and a `note` specifying another value is refused |
| `review` | Hand a read-only review to a cross-reviewer (`review` role). `runs_app: true` routes to `verify` in a writable snapshot. Defaults to `adversarial`. `mode: "standard"` uses Codex's built-in review. `target` is a change (`uncommitted`, `branch` against `base`, or `commit`) or `files`: the files and directories in `paths` as they stand, for an audit of code that is no one change. An audit has no diff, so its prompt says to read the role's "change" as that code, a reviewer that cannot run git is handed none, the reviewer is not asked to rate anyone's work, and Codex's built-in review, which reads a change, is refused |
| `polish` | Hand UI copy, comment, and doc cleanup to the `polish` role. `task` says what to change and `done_when` how it is judged, as for `delegate`; without `task` the editor improves what it finds in `targets`. Edits outside `targets` are reported as out of scope. Scope checks compare literal Git paths, including non-ASCII names and embedded newlines, and count a moved file at both its old and new path. Targets and the files an in-place job edits are kept with forward slashes, as Git names files, so a directory target matches on Windows too |
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

- On a host that draws MCP Apps, `mission` results also carry a [progress card](#progress-card).
- Every call is checked against its tool's schema before anything else, nested arguments included (`arguments.ts`). An argument the tool does not declare fails the call, which then has no effect (not even its `ack`), and the error names the tool's arguments and, for a likely mix-up, where the brief goes. Hosts pass undeclared arguments through, and a handler would otherwise drop them without a word: a `polish` brief sent as `task`, while the tool still took `guidance`, once started a job with no brief. The worker MCP server checks its tools the same way. A field a host adds to every call by itself is let through: agy 1.5 adds `toolSummary` to each Antigravity worker call.
- Workers receive the mission's decisions with their brief, including reviews without focus and polishes with only targets. A Codex standard review with mission decisions uses the adversarial mode so the reviewer receives the brief.
- Job tools (`delegate`, `review`, `polish`, `debate`, `reply`) return the job ID immediately by default. `background: false` blocks until the worker ends or needs the lead. The lead ends its turn instead of blocking in `wait` so the user can keep talking. The wake hook resumes it when [news](delivery.md#news-and-ownership) arrives.
- Although the daemon is shared across sessions, each job records its canonical starting project (`canonicalPath` in `config.ts`). Argument-less `wait` and `status` filter to the caller's project, while the board and `crew status` show all projects. Within the project, `status` lists every active job but only the caller's own finished jobs, counting the others so an earlier run's jobs in the same folder do not fill the list.
- Workers cannot commit because worktree Git metadata lives outside their sandbox. When a turn ends, the bridge creates a transport commit on `crew-<job id>` (hooks and `fsmonitor` disabled, commit signing off, default identity `Crew <crew@localhost>`), and the lead inspects the diff before merging or rejecting it. The bridge's own `status` and `diff` of a working tree run the same way and with `--ignore-submodules=all`: Git otherwise asks a repository inside the tree for its state under that repository's settings, so one a worker left there would have its `fsmonitor` command run by the bridge, outside any sandbox. A submodule's own changes are therefore not listed.

## Progress card

A host that declares the MCP Apps extension (`io.modelcontextprotocol/ui`) in `initialize` gets a card beside `mission` results: the Claude desktop app's Code tab and Codex in the ChatGPT desktop app ([what each host does](mcp-compatibility.md#6-mcp-apps-inline-cards)). Other hosts, the terminal CLIs among them, see the same tools, capabilities and results as before. The switch on the Crew page in Settings (`progressCards` in `config.json`, on by default) turns the card off: under Codex from the next call, and in the Claude app, which reads the card's declaration when its session starts, from the next session.

- **Which calls.** Under Codex, a card goes with the calls that start, move or end a mission (`title`, `stage`, `done`, `abandoned`), named in the result's `_meta`. The Claude app draws only cards a tool declares, so there `mission` declares it and every `mission` call carries one. `status` carries none, since a lead calls it on every wake-up (`carriesCard` in `mcp.ts`).

- **What it shows.** This session's open missions, newest first (at most 3), or else the one that ended last, each with its track and up to 6 of its jobs: those under way, then the latest to end, with the agent's mark from the board, the job's title, its state and how long it ran. Without a mission it lists the project's jobs under way. The data is the result's `structuredContent` (`cardView` in `card.ts`); the text `content` is unchanged.
- **Snapshot or live.** Where the host lets a card call the server's tools (`hostCapabilities.serverTools`, ChatGPT), the card calls the app-only `progress` tool every 4 seconds while it is on screen and anything is under way, and says Live. Once a mission moves to another step, a newer card shows it, so this one stops where its step ended. `progress` reads state only: it takes no `ack` and makes no offer. Elsewhere (the Claude app) the card shows the moment of the call that made it ("As of 16:12"), and the next `mission` call brings a new card. If a refresh fails, the card stops and shows when it was last current.
- **Open board.** The board signs in with a one-time ticket that only the `/crew:board` skill mints, so the button sends a chat message asking the lead to open the board (`ui/message`), and appears only where the host allows that.
- **Page.** `cardHtml()` serves one page at `ui://crew/progress.html`, with the board's marks from `plugin/board/src/icons/` inlined (the plugin bundle ships that folder). It follows the host's theme and language (English or Korean, from `hostContext`); its text sits in the page rather than in `t()`. The host draws the frame, and the page reports its content's height without the room a host's minimum height adds, so the footer sits at the bottom of a taller frame.

## Worktree includes and shared links

When a writable worktree's source checkout has no `.worktreeinclude`, Crew checks which of `node_modules`, `.venv`, `venv`, and `.env` exist at the root and are ignored by Git. The first matching job receives one note listing those paths so they can be added if needed. Crew records a marker under `~/.crew/worktree-preflight/` so the hint is not repeated across restarts; if writing that marker fails, the job starts without the note.

Gitignored paths listed in `.worktreeinclude` at the repository root (`.gitignore` syntax, shared with Claude Code's native worktrees) are attached to worktrees (such as `node_modules` and `.env`) so workers can run tests without reinstalling. Crew copies files and uses forced copy-on-write for directories. Whatever Git then reports as untracked in the new worktree is recorded on it (`worktree.copied`; a directory holding nothing tracked is one entry) and excluded from the worker's commits, status, and syncs, just like a shared link: the job's base may not ignore everything the main tree ignores (because of an older base or an uncommitted `.gitignore` edit), and otherwise a copied `.env` would be committed with the worker's changes. A recorded path stops being excluded once it is tracked, as when a sync brings in a commit that adds it, since a change to it is then the worker's.

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

If Codex does not acknowledge a turn start, Crew returns the still-active job and keeps its worktree. A late response or turn event can settle it. A reported active turn can still be interrupted. Claude Code has 30 seconds to confirm a permission mode change before Crew stops the worker and fails the turn.

## Follow-ups and sync

When a project's `autoResume` switch is on, a job stopped by a usage limit resumes in the same worker session once a newer usage reading for that agent shows room (`ok` or `tight`), provided the job still has its worktree and belongs to an active mission. Crew tells the lead to expect an automatic resume when AgentGauge has a usage-window reading for that agent. Spend and session caps require manual follow-up. Subfolders and linked worktrees follow the main working tree's setting. Crew sends one follow-up per failure, up to three automatic resumes over the job's life; when the cap prevents a resume, a job note tells the lead it can continue with `reply`. Closing the mission or turning off `autoResume` before the turn starts leaves the job stopped.

A worker's worktree starts from `HEAD` (or `base`) and does not follow later commits. `reply` with `sync: true` merges the lead's current `HEAD` into the worker's branch before the follow-up turn and advances `worktree.base` so results still show only the worker's changes. Syncing an ancestor of the current base leaves the base and receipts as they were. On conflict, the merge aborts (leaving worktree, base, and result unchanged) and the follow-up still runs, naming the lead commit and conflicting files in the prompt and adding a job note. Other sync failures reject the reply. Syncing blocks discard and round changes. Rounds still replay from `roundsBase` so pre-sync undos survive.

A message sent while a turn runs joins that turn. Codex takes it through `turn/steer`. Antigravity takes it as another `session/prompt`: agy 1.5.14 answers the running request at once with `end_turn` and carries the turn on under the new one, whose answer ends the turn. Crew sends overlapping messages in order, waiting for each handover or refusal before sending the next message. Crew refuses such a message while a permission request or question waits (as agy does), while the turn is still starting or already ending, and after Crew stopped it. If agy refuses a message after Crew has acknowledged it, Crew records the refusal on that turn as soon as it arrives. Once agy accepts the message, an error from its request fails the turn. Each prompt counts toward its own turn unless its usage arrives after a forced end.

When Codex completes a parent turn while its sub-agents are working, Crew waits for their latest turns to finish. A new turn on a child thread replaces the previous one even if its completion has yet to arrive.

Where agy supports `session/close`, Crew closes the session when a turn ends, which since agy 1.5.10 also stops its subagents and background work. A follow-up waits for that close, then restores the session with `session/resume` (or `session/load`). Crew reports a generation error immediately, even if another prompt is still outstanding. If a close is unavailable or unconfirmed, a follow-up can use the session once every prompt already sent has settled. Usage and tool calls replayed during a restore are ignored until the new turn sends its first prompt. agy 1.5.14 kept the conversation across a close and resume, but could reset the model (a job on Argon resumed on Neon); Crew re-applies the job's model when a restored session reports a different one, followed by its thinking level. A turn that ends after the job has moved on to the next one leaves the newer turn alone.

A job whose worktree was discarded takes no further turn. See [cleanup and garbage collection](#cleanup-and-garbage-collection) for discarded and orphaned worktrees.

## Question jobs

Question jobs (`ask: true`) are read-only. Codex runs without approval prompts and declines writes. Antigravity refuses edits and commands.

## Outcome reporting

When a delegate's bridge check exits nonzero, Crew runs the same command on the job's base commit in a temporary detached worktree, with the same includes, sandbox, network setting, and time limit. The receipt records the base exit status, duration, and output tail, or why the comparison could not run. If both runs fail, the lead gets both output tails to compare. Concurrent checks for the same repository, base, command, and sandbox settings share one comparison while it is running; later checks read current includes. Crew removes only that temporary worktree's own registration afterwards, so a missing folder of another worktree, such as one on an unmounted drive, keeps its registration.

If the check passes on the base, the check left the worker's tree clean, and the worker had no refused or declined actions that turn, Crew sends one automatic follow-up. It includes the command and the tail of its output, asking the worker to fix the cause without weakening the check. Both turns keep their receipts, and both the terminal event and the lead's completion or failure news identify the automatic fix turn. A check that modifies files leaves a stale receipt for the lead to inspect. Further failures on the same job go straight to the lead.

Work roles open their report with `## Outcome` (`done`, `partial`, or `blocked`; an engineer's report also has `## Decisions`, the choices the task did not settle, which the lead passes to the jobs they affect), stored in `Job.outcome` for the latest turn (omitted on reviews, debates, and questions). Results flag mismatches with bridge observations—such as `outcome: done as declared, but the bridge check failed`, no files changed after a refusal/decline, or `outcome: not declared`. Acceptance lines list kept round commits for cherry-picking when known.

The finished review view shows the reviewer's verdict and finding counts by severity and evidence. It warns if an approval has a blocker or if a cross-review has no verdict. For standard Codex reviews, Crew maps priority tags to blocker (P0), major (P1), and minor (P2 and P3). Report text, including paginated reports, is labeled as the worker's own words for the lead to weigh as evidence.

When the finished job view offers a squash merge, Crew checks the branch against the originating checkout's committed `HEAD`. It reports either a clean merge or the conflicting paths. Because the check only tests committed `HEAD`, uncommitted changes can still block the squash merge. Git may write merge objects during the check, while the index, worktree, and refs stay untouched. If Git cannot determine the result, the view omits the check line.

If the bridge cannot collect a finished turn's result (the transport commit or the diff fails), the job fails with `could not collect the result: …` and still keeps the worker's report, so the lead reads what the worker did beside the failure; when an earlier turn's result is on record, the message says the listed changes are that turn's. A turn that was cancelled and followed by another cannot fail its successor: a start or send that fails after the job has moved on is dropped.

## Worker tools

- Antigravity allows six Crew worker tools (`ask_lead`, `lead_answers`, `siblings`, `search`, `recent_changes`, `rate`) when matched by MCP metadata (`_meta.mcpServerName === 'crew'`) or exact `mcp_crew_<tool>` / `mcp_crew_<8 hex>_<tool>` title, with an optional `Run ` prefix. The 8-hex suffix matches the per-job `crew` server names used by one `agy acp` process from the second job on. Title matching applies only to `other` calls without conflicting MCP metadata or command fields. `execute` and edits still follow role policy.
- Workers launch their Crew MCP server (`worker-mcp.ts`) with the daemon's executable. Under the Electron desktop app, `nodeEnv()` sets `ELECTRON_RUN_AS_NODE=1` so it runs as Node instead of launching another app window.
- Codex reports worker MCP server failures via `mcpServer/startupStatus/updated`. When `crew` fails, Crew attaches a job note and activity entry so the lead knows `ask_lead`, `browser`, and other worker tools are unavailable. Antigravity emits no equivalent status.

## Worker instructions

Job instructions start with the role, state what the worker may run on the shared machine, and then add the sections that apply to the job: running the app, measuring alone, plugins (followed by the note on acting in the user's apps when Codex plugins are on), the temp directory, evidence and working files, shared dependencies, `ask_lead` usage, refused actions, rating, and skills, with the shared instructions last and subordinate to the rest ([prompts.ts](../plugin/bridge/prompts.ts)). Only a job that may start the app (an implementation, or a review with `runs_app`) gets `plugin/roles/machine.md`, evidence, and working files. Other command-running jobs get a short shared-machine rule instead: a Codex question, debate, or static review is told to run only commands that end by themselves, and a Codex polish job only commands that read files. A worker that runs no commands gets a static-review note (Antigravity as reviewer) or a note to read files directly (Antigravity questions and debates); Antigravity polish gets neither. Each rule is stated once, in the section that owns it: refusals under refused actions, the scratch directory in its own section, and the rating scales in the `rate` tool. A delegate's `check` is named in its task prompt.

To avoid injecting the user's entire Codex skill/app catalog into every thread, Crew starts Codex threads with `skills.include_instructions = false` and `features.apps`, `features.plugins`, and `features.tool_suggest` off. The lead can attach specific skills from `~/.agents/skills` via `skills` on `delegate`, `review`, and `polish`. Crew validates names and adds each skill's description and `SKILL.md` path (for Antigravity too). User MCP servers in `~/.codex/config.toml` remain available.

For plugin-enabled threads and eligibility, see [Codex plugins](sandbox.md#codex-plugins).

## Token use

Crew interrupts a running turn once it reaches either budget below. Each turn starts its own clock, which pauses while an approval or question awaits the user's answer. A gap longer than a minute between 15-second sweeps counts as one sweep interval. If the worker finishes before the interrupt is confirmed, Crew collects its report and result normally; the bridge's own result collection and checks always run after the worker's turn. If an interrupt remains unconfirmed, the next sweep checks the current caps before retrying. A confirmed budget stop sends standard failure news with `error.budget: true`, the cap, and the observed value. A follow-up can resume the session and its implementation worktree; for reviews that run the app, Crew removes the snapshot when the turn ends and creates a fresh one on `reply`.

| Job difficulty | Tokens added this turn (including cached input) | Wall time |
| --- | ---: | ---: |
| Routine | 60,000,000 | 2 hours |
| Standard or unspecified | 80,000,000 | 3 hours |
| Hard | 120,000,000 | 4 hours |

The user can replace the token column with one cap for every turn, or turn it off, under Turn Budget beside the presets, or with `turnTokenBudget` in `~/.crew/config.json`: one of 1M, 5M, 10M, 20M, 30M, 50M, or 100M tokens (`TURN_TOKEN_CHOICES` in `config.ts`), or `"unlimited"`. The low caps suit small models at low effort; a turn at high effort often passes 10M, since each request counts the cached context again. Left out, the cap follows the job's difficulty. The wall-time column always applies, so an unlimited turn that goes in circles still stops within 4 hours of work. The daemon reads the setting at each stall sweep (every 15 seconds), so a change reaches turns already running without a restart.

A job records `tokenUse` with total input, cached input, output, and what the latest turn added. Codex reports cumulative thread usage, including final totals delivered after a turn ends. Crew ignores totals that go backwards. Other notifications that name a turn must match the confirmed turn. Before confirmation, Crew accepts new turn IDs and ignores IDs that have already ended. For Antigravity, Crew counts each prompt's usage once toward the turn that sent it. Usage that arrives after Crew force-ends that turn is omitted. `status`, the board, and the desktop apps display it so follow-up turns show how much input was cached. A job also records `context`, how full the worker's context window is, from Codex's latest request (`last.totalTokens` of `modelContextWindow`) or agy's `usage_update`. `status`, the board, and the desktop apps show it.

Token savings measured on Codex CLI 0.167.0 for a no-op question (dropping 123 user skills, 22 app connectors, recommended plugins, and computer-use REPL tools):

| | Input tokens | Cached input |
| --- | --- | --- |
| Before | 23,052 | 13,312 |
| After | 14,723 | 12,032 |

## Tests

Verified on macOS/APFS (clone fallback via injected tests) and on Windows 11 (shared junctions, locked empty folder retries, full test suite). HTTP auth and CLI checks also run against an isolated daemon with fake agents.

Related tests include `test/jobs.test.ts`, `test/worktrees.test.ts`, `test/gc.test.ts`, `test/mcp.test.ts`, and `test/card.test.ts` (the progress card's data and page). `test/prompts.test.ts` snapshots every valid instruction combination and checks for contradictions. Regenerate with `node --test --test-update-snapshots test/prompts.test.ts`. See [architecture.md](architecture.md#tests) for the full pipeline checks.

## History

- On 2026-11-25, base checks began sharing only a running comparison because local includes can change between runs on the same commit.
- 2026-11-24: Scope targets keep forward slashes on Windows; with backslashes, every file under a directory target was reported as out of scope.
- 2026-11-20: Added hex-suffixed Antigravity worker tool title matching and Codex MCP startup failure notes.
- 2026-11-16: Windows bridge parity included canonical project paths (`canonicalPath`).
- 2026-11-14: Hardened Windows worktree cleanup, added delayed empty-folder retries (30 s, 2.5 min, startup), and added `crew gc`.
- 2026-11-12–13: Disabled commit signing with default identity `Crew <crew@localhost>` and renamed branches from `crew/<id>` to `crew-<id>` because Git rejects `crew/...` when a `crew` branch exists.
- 2026-11-11: Moved worktrees from `.crew/worktrees/` to `~/.crew/worktrees/` so repo tools stop scanning them, and added `.worktreeinclude` copying.
