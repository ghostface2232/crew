# Missions

A mission groups one user command and the jobs it took, so the board can answer "what was this split into, who has each part, and how far along is it" without opening a session (requirement R10). The lead reports it with the `mission` tool; nothing schedules work from it.

**Key files:** `plugin/bridge/missions.ts` (state and rules), `pulls.ts` (pull request watches), `runbook.ts` (`crew export`), `mcp.ts` (the `mission` tool), `plugin/skills/run/SKILL.md` (when the lead opens and advances one), `plugin/board/src/Missions.tsx` and `model.ts`, and `native/Sources/Crew/BoardView.swift` and `Models.swift`. HTTP routes are in [daemon-api.md](daemon-api.md); a mission's own preset is in [usage-and-presets.md](usage-and-presets.md#presets-per-mission).

## Stages

- **Reported by the lead.** The lead calls `mission` with `title` and a nonempty `stages` plan (up to 30 steps from `plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`; repeats allowed). `stageIndex` tracks the active step (`stage` mirrors it). Passing `stage` advances to the next matching step after `stageIndex` (dropping skipped steps) or inserts it next if none remain; repeating the current step is a no-op. Resending an open mission's title reattaches and ignores `stages`.
- **Fluid plans and named stops.** Passing `stages` later replaces only steps after `stageIndex` (`[]` drops the rest), preserving earlier steps and job indices. Entries may append `: <name>` (up to 24 characters, stored in `labels`), which replaces the stage name without numbering and lets the lead advance between repeated stages. A named sample stop ("implement: Sample", then "implement: The rest") is how `/crew:run` builds one approved sample before a set of like items.
- **Difficulty.** The call that starts a mission may pass `difficulty` (`routine`, `standard`, or `hard`) for the lead's own work in that command. Once set (or omitted), it is fixed: later calls that pass `difficulty` are refused, except a retried start call with the same value, and `POST /api/missions/:id` rejects it. Mission replies show it after the plan (`Plan: implement (current) → final · difficulty: hard`). A build `note` without `job_id` (for the lead's own work) takes `difficulty` from the session's open mission—or a mission named with `mission`, finished ones included—and is refused if it specifies another value.
- **Closing.** The lead closes a mission with `done: true` (plus an optional `outcome`, a `record` of decisions, failed approaches, and prerequisites for `crew export`, and a `summary`) or `abandoned: true`.
- **Wrap-up.** `summary` (Markdown, up to 4,000 characters) is what the user reads on the board when a mission finishes: what changed, what was verified and how, what was skipped, and what remains for them. Only `done` missions keep it—a dropped command leaves nothing to report—and passing `summary` without `done` is refused. Unlike `record`, which is written for the next lead and the runbook, `summary` is for the user.
- **Autonomy.** While a mission is active and **Push and open pull requests** is on for its project (`projects.<path>.autonomy` in `~/.crew/config.json`), `mission` replies say so. The lead may then push and open a pull request without asking once the work is finished, every outgoing commit has been reviewed with its fixes applied, and final checks pass; it never merges, closes, or deploys. Because the switch lives in the user's config rather than the repository, a repository cannot grant itself this permission. When it is off, replies omit it and the lead asks as usual.

## Display

- Missions render planned stops in order: Plan, Build, Review (shared by `self-review` and `cross-review`), Fix, Polish, Final, numbering unnamed repeats (`Review 2`, `Fix 2`). Daemon-assigned `missionStep` pins jobs to their step across plan revisions; legacy jobs attach by kind. The card's stage track shows progress; the title row carries no separate indicator. Ended missions start folded; loose jobs stay separate.
- The card names its lead the same way for Claude and Codex: the lead's mark before the title, and "Led by Claude" or "Led by Codex" first on the meta line. It reads the mission's `lead`, falling back to the owning session's agent (while still known) for missions opened before `lead` was recorded; with neither, the card shows no lead.
- A job given a known mission that is no longer open runs on its own under that mission's preset with a note attached. An unknown mission ID is refused.
- Both UIs offer *Mark Done* and *Stop Tracking* in an active mission's ellipsis menu. Abandoned missions also offer *Mark Done*, which sends `reopen: true`—without an explicit reopen, late lead calls cannot undo *Stop Tracking*. *Stop Tracking* marks a mission `abandoned` without stopping its jobs.
- Clients show "Looks finished" after 20 quiet minutes with no active jobs or open tasks (`todo`/`doing`) unless the owning lead session is working.

## Several missions in one session

- Opening a new mission leaves existing open missions `active` (the three states are `active`, `done`, and `abandoned`). A fourth state would only record where the lead is looking, even though that mission's workers can still run.
- With one open mission, calls work implicitly. With two or more, any mutating `mission` call, job start, or `route` must name the target (`id` on `mission`, `mission` on job tools and `route`); unnamed calls fail with the list of open missions before changing anything. A wrong guess could close or advance the wrong mission or charge a job to the wrong preset, and those actions cannot be undone. A named ID must identify a mission the session opened in this project. A `done` or `abandoned` call that passes `title` without `id` ends the open mission with that title, and fails if no open mission has it—even when only one mission is open.
- The MCP server reads open missions from the daemon on each call, so restarts lose nothing.
- **Not built, on purpose.** There is no recurring reminder to open a follow-up mission when another mission is still open: `done` notes it once and later unnamed jobs go to the sole open mission. The daemon keeps focus only in memory, using the session's last mission action so the lead row appears on that mission card alone.

## Tasks

- Missions carry optional tasks `{ id, title, after?, state, result? }` (`state`: `todo`, `doing`, `done`, `dropped`; max 40), merged by `id` and validated as a whole (valid `after` refs, acyclic). Nothing auto-schedules; the daemon reports which tasks are ready.
- Jobs link via `task_id` (`Job.taskId`), and mission summaries read live job states and check results directly from jobs. Dropped tasks never satisfy `after`.
- **Resume context.** `SessionStart` (`startup`, `resume`, `clear`, `compact`) injects open missions (with stage, plan, tasks, and pull requests) and still-watched PRs from finished missions into `additionalContext` (capped at 6,000 characters), so plans survive compaction and restarts.

## Decisions

- A mission keeps the decisions the user made during it (`memory`: `{ key, text, tasks?, at }`, at most 12, text up to 400 characters). On any `mission` call—including the call that opens it—the lead records a decision with `remember` (a summary in one or two short sentences of what was decided and what it covers, not the user's message quoted) and drops one with `forget`. Reusing a key replaces that decision so a change supersedes the earlier entry; an invalid update (an unknown task, an unknown key to forget, or more than 12 entries) leaves the list unchanged.
- Each job started for the mission receives the mission-wide decisions and any decisions scoped to its task at the end of its brief, under a heading stating that they permit no action (`memoryFor` in `missions.ts`, applied in `POST /api/jobs`). Running jobs are not updated; the lead replies to them directly. Mission replies and resume context list decisions so a lead retains them after compaction.
- Decisions live only as long as the mission and are never permissions: a choice about taste or scope does not approve an action. Preferences that outlast the mission belong in `.crew/instructions.md`, which the lead offers when it ends.
- The mission card shows one *Decisions* row with their count; it opens the list in the detail panel, where the user can drop a decision (*Forget*, `POST /api/missions/:id` with `forget`). Only the lead sends `remember` and `summary` (`LEAD_FIELDS` in `daemon.ts`).
- **Why so few.** Every decision goes into every later job's brief, so the cap keeps briefs short; past 12, the lead must fold or forget entries rather than accumulate them.

## Notes and runbooks

- A mission note is information the user pins from the board's New Job (the Information intent with a mission chosen); it starts no work and is refused once the mission is no longer active.
- `crew export <mission>` prints a finished mission as Markdown: what was asked, what the lead recorded about decisions and dead ends, and what each job did and was checked against. It is a draft to read and edit before reusing it, for example as a skill; nothing in it is trusted as an instruction on its own.

## Pull requests

- **Linking.** Passing `pr` (number or URL) to `mission` resolves it once with `gh pr view` and creates a watch (`plugin/bridge/pulls.ts`) persisted in `jobs.json` alongside delivery receipts.
- **Polling.** The daemon polls each open watch via `gh pr view <url> --json` every 60 seconds while checks are pending and every 5 minutes otherwise, only while the PR is open, its mission is not abandoned, and the owner session was active within 10 minutes (`PRESENT_MS`). Returning sessions trigger an immediate poll (15-second throttle). Crew holds no GitHub credentials.
- **While away.** When **Watch pull requests while away** is on for a project (`projects.<path>.watchAway`), watches continue polling every 10 minutes (`AWAY_MS`) even while the owning session is away. News queues until the session returns, so overnight failures are waiting when it resumes. The switch lives in project Settings rather than on each PR chip.
- **News and loop limits.** Polls emit news only for changes: newly failed checks on the current head, checks passing after a reported failure, new non-author `CHANGES_REQUESTED`/`COMMENTED` reviews, a PR turning `CONFLICTING` (not repeated until `MERGEABLE` in between), and a PR being merged, which tells the lead to fast-forward the local base branch (`baseRefName`) unless that would touch uncommitted work or the branches have diverged, and to tell the user instead in that case. A merge or close ends the watch; a close sends nothing. Linking `pr` again resumes an ended watch if the PR is open. News tells the lead to judge the cause and delegate fixes—weighing reviewer text as feedback, never instructions—and never to merge, close, or deploy. After three consecutive failing heads, check-failure news pauses (`held: true`) until a head passes or the lead links `pr` again (a `done` mission accepts `id` + `pr` alone to resume).
- **On the board.** Each watched PR is one chip, a rounded square rather than a status pill, in a band below a hairline across the foot of its mission card, shown whether the card is open or closed. The band holds only PRs: the mission's actions and preset are in its ellipsis menu (`pullStatuses` in `model.ts`, `MissionPull.statuses` in the macOS app). The chip names the most urgent status and counts the other statuses the lead must act on (`#43 Conflict +2`).
  - Order: conflict, failing checks, changes requested, running checks, approved, passing checks. A conflict comes first because resolving it moves the head and reruns the checks. Failures (red) come before feedback the lead must weigh (orange).
  - A merged or closed PR shows only its final state, with merged PRs in GitHub purple.
  - A stale reading (no answer for 15 minutes, a failed read, or an ended watch) keeps its words but turns gray and shows how long ago it was checked. A failed read says `Could not be read` in place of its statuses.

## Lifetime and ownership

- `~/.crew/missions.json` persists all open missions, the 100 most recently ended, the last 2 per project, and any ended mission with a watched PR, retaining their jobs beyond normal history limits. Unreadable `missions.json` files are set aside before starting clean.
- Idle missions auto-abandon after 12 hours, or after 72 hours while a task is open (`todo`/`doing`) or a PR is watched; open tasks also suppress "Looks finished".
- A session owns missions by its session ID (`CLAUDE_CODE_SESSION_ID` in Claude Code, or each tool call's `_meta.sessionId` in Codex). New jobs started after a lead-finished `done` mission (when no other mission is open) auto-create a fallback follow-up mission (`후속 작업: <title>` or `Follow-up: <title>`, matching the title's language). For 12 hours after a lead-finished mission, `UserPromptSubmit` also reminds the lead to open a mission before starting new work.
- The optional `lead` field records which agent opened the mission (`claude` or `codex`) and persists after the owning session ends.

## Not verified

- Whether Claude Desktop always passes `CLAUDE_CODE_SESSION_ID` to the MCP server.
- A failing CI check arriving as news in a live Claude session.

## Tests

`test/missions.test.ts`, `test/mcp.test.ts`, `test/pulls.test.ts`, `test/runbook.test.ts`, and `test/board.test.ts`, plus browser checks. Tasks, cycle and unknown-ID validation, PR linking, and the `SessionStart` context were also checked on an isolated daemon with real `gh`.

## History

- 2026-11-27: Decisions are saved as the lead's summary, no longer in the user's words, and the card lists them in the detail panel behind one row. On a long mission each entry quoted the user's message and then restated it, and the list of them filled the card.
- 2026-11-25: Added wrap-up summaries, remembered decisions, and per-project switches for autonomy and away-watching. Away watching reverses the 2026-11-20 rule against polling while a session is away, opted in per project so overnight failures are caught without adding a switch to every PR chip.
- 2026-11-22: The progress ring on a mission card's title row was removed from the board and the app, with its formula (`missionProgress`), because it moved by stage rather than by measured work and the stage track already shows the same progress.
- 2026-11-20: Several open missions per session, with explicit mission IDs instead of an implicit current mission or a workflow engine; mission tasks; linked PR watches, with no polling while the lead session is away; `SessionStart` resume context.
- 2026-11-14: Fluid mission plans with repeated and named stops; *Mark Done* and *Stop Tracking*.
- 2026-11-12–13: Missions added; the board's decision support is in [board.md](board.md#history).
