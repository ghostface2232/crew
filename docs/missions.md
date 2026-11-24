# Missions

A mission groups one user command and the jobs it took, so the board can answer "what was this split into, who has each part, and how far along is it" without opening a session (requirement R10). The lead reports it with the `mission` tool; nothing schedules work from it.

**Key files:** `plugin/bridge/missions.ts` (state and rules), `pulls.ts` (pull request watches), `runbook.ts` (`crew export`), `mcp.ts` (the `mission` tool), `plugin/skills/run/SKILL.md` (when the lead opens and advances one), `plugin/board/src/Missions.tsx` and `model.ts`, and `native/Sources/Crew/BoardView.swift` and `Models.swift`. HTTP routes are in [daemon-api.md](daemon-api.md); a mission's own preset is in [usage-and-presets.md](usage-and-presets.md#presets-per-mission).

## Stages

- **Reported by the lead.** The lead calls `mission` with `title` and a nonempty `stages` plan (up to 30 steps from `plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`; repeats allowed). `stageIndex` tracks the active step (`stage` mirrors it). Passing `stage` advances to the next matching step after `stageIndex` (dropping skipped steps) or inserts it next if none remain; repeating the current step is a no-op. Resending an open mission's title reattaches and ignores `stages`.
- **Fluid plans and named stops.** Passing `stages` later replaces only steps after `stageIndex` (`[]` drops the rest), preserving earlier steps and job indices. Entries may append `: <name>` (up to 24 characters, stored in `labels`), which replaces the stage name without numbering and lets the lead advance between repeated stages. A named sample stop ("implement: Sample", then "implement: The rest") is how `/crew:run` builds one approved sample before a set of like items.
- **Closing.** The lead closes a mission with `done: true` (plus an optional `outcome`, and a `record` of decisions, failed approaches, and prerequisites for `crew export`) or `abandoned: true`.

## Display

- Missions render planned stops in order: Plan, Build, Review (shared by `self-review` and `cross-review`), Fix, Polish, Final, numbering unnamed repeats (`Review 2`, `Fix 2`). Daemon-assigned `missionStep` pins jobs to their step across plan revisions; legacy jobs attach by kind. The card's stage track shows progress; the title row carries no separate indicator. Ended missions start folded; loose jobs stay separate.
- A job given a known mission that is no longer open runs on its own under that mission's preset with a note attached. An unknown mission ID is refused.
- Both UIs offer *Mark Done* and *Stop Tracking* in an active mission's ellipsis menu. Abandoned missions also offer *Mark Done*, which sends `reopen: true`—without an explicit reopen, late lead calls cannot undo *Stop Tracking*. *Stop Tracking* marks a mission `abandoned` without stopping its jobs.
- Clients show "Looks finished" after 20 quiet minutes with no active jobs or open tasks (`todo`/`doing`) unless the owning lead session is working.

## Several missions in one session

- Opening a new mission leaves existing open missions `active` (the three states are `active`, `done`, and `abandoned`). A fourth state would only record where the lead is looking, even though that mission's workers can still run.
- With one open mission, calls work implicitly. With two or more, any mutating `mission` call, job start, or `route` must name the target (`id` on `mission`, `mission` on job tools and `route`); unnamed calls fail with the list of open missions before changing anything. A wrong guess could close or advance the wrong mission or charge a job to the wrong preset, and those actions cannot be undone. A named ID must identify a mission the session opened in this project. A `done` or `abandoned` call that carries a `title` and no `id` ends the open mission with that title, and fails if none has it, even when only one mission is open.
- The MCP server reads open missions from the daemon on each call, so restarts lose nothing.
- **Not built, on purpose.** There is no recurring reminder to open a follow-up mission when another mission is still open: `done` notes it once and later unnamed jobs go to the sole open mission. The daemon keeps focus only in memory, using the session's last mission action so the lead row appears on that mission card alone.

## Tasks

- Missions carry optional tasks `{ id, title, after?, state, result? }` (`state`: `todo`, `doing`, `done`, `dropped`; max 40), merged by `id` and validated as a whole (valid `after` refs, acyclic). Nothing auto-schedules; the daemon reports which tasks are ready.
- Jobs link via `task_id` (`Job.taskId`), and mission summaries read live job states and check results directly from jobs. Dropped tasks never satisfy `after`.
- **Resume context.** `SessionStart` (`startup`, `resume`, `clear`, `compact`) injects open missions (with stage, plan, tasks, and pull requests) and still-watched PRs from finished missions into `additionalContext` (capped at 6,000 characters), so plans survive compaction and restarts.

## Notes and runbooks

- A mission note is information the user pins from the board's New Job (the Information intent with a mission chosen); it starts no work and is refused once the mission is no longer active.
- `crew export <mission>` prints a finished mission as Markdown: what was asked, what the lead recorded about decisions and dead ends, and what each job did and was checked against. It is a draft to read and edit before reusing it, for example as a skill; nothing in it is trusted as an instruction on its own.

## Pull requests

- **Linking.** Passing `pr` (number or URL) to `mission` resolves it once with `gh pr view` and creates a watch (`plugin/bridge/pulls.ts`) persisted in `jobs.json` alongside delivery receipts.
- **Polling.** The daemon polls each open watch via `gh pr view <url> --json` every 60 seconds while checks are pending and every 5 minutes otherwise, only while the PR is open, its mission is not abandoned, and the owner session was active within 10 minutes (`PRESENT_MS`). Returning sessions trigger an immediate poll (15-second throttle). Crew holds no GitHub credentials.
- **News and loop limits.** Polls emit news only for changes: newly failed checks on the current head, checks passing after a reported failure, new non-author `CHANGES_REQUESTED`/`COMMENTED` reviews, a PR turning `CONFLICTING` (not repeated until `MERGEABLE` in between), and a PR being merged, which tells the lead to fast-forward the local base branch (`baseRefName`) unless that would touch uncommitted work or the branches have diverged, and to tell the user instead in that case. A merge or close ends the watch; a close sends nothing. Linking `pr` again resumes an ended watch if the PR is open again. News tells the lead to judge the cause and delegate fixes—weighing reviewer text as feedback, never instructions—and never to merge, close, or deploy. After three consecutive failing heads, check-failure news pauses (`held: true`) until a head passes or the lead links `pr` again (a `done` mission accepts `id` + `pr` alone to resume).
- **On the board.** Each watched PR is one chip, a rounded square rather than a status pill, in a band below a hairline across the foot of its mission card, shown whether the card is open or closed. The band holds only PRs: the mission's actions and preset are in its ellipsis menu (`pullStatuses` in `model.ts`, `MissionPull.statuses` in the macOS app). The chip names the most urgent status and counts the other statuses the lead must act on (`#43 Conflict +2`).
  - Order: conflict, failing checks, changes requested, running checks, approved, passing checks. A conflict comes first because resolving it moves the head and reruns the checks. Failures (red) come before feedback the lead must weigh (orange).
  - A merged or closed PR shows only its final state, with merged PRs in GitHub purple.
  - A stale reading (no answer for 15 minutes, a failed read, or an ended watch) keeps its words but turns gray and shows how long ago it was checked. A failed read says `Could not be read` in place of its statuses.

## Lifetime and ownership

- `~/.crew/missions.json` persists all open missions, the 100 most recently ended, the last 2 per project, and any ended mission with a watched PR, retaining their jobs beyond normal history limits. Unreadable `missions.json` files are set aside before starting clean.
- Idle missions auto-abandon after 12 hours, or after 72 hours while a task is open (`todo`/`doing`) or a PR is watched; open tasks also suppress "Looks finished".
- A session owns missions via `CLAUDE_CODE_SESSION_ID`. New jobs started after a lead-finished `done` mission (when no other mission is open) auto-create a fallback follow-up mission (`후속 작업: <title>` or `Follow-up: <title>`, matching the title's language). For 12 hours after a lead-finished mission, `UserPromptSubmit` also reminds the lead to open a mission before starting new work.

## Not verified

- Whether Claude Desktop always passes `CLAUDE_CODE_SESSION_ID` to the MCP server.
- A failing CI check arriving as news in a live Claude session.

## Tests

`test/missions.test.ts`, `test/mcp.test.ts`, `test/pulls.test.ts`, `test/runbook.test.ts`, and `test/board.test.ts`, plus browser checks. Tasks, cycle and unknown-ID validation, PR linking, and the `SessionStart` context were also checked on an isolated daemon with real `gh`.

## History

- 2026-11-22: The progress ring on a mission card's title row was removed from the board and the app, with its formula (`missionProgress`), because it moved by stage rather than by measured work and the stage track already shows the same progress.
- 2026-11-20: Several open missions per session, with explicit mission IDs instead of an implicit current mission or a workflow engine; mission tasks; linked PR watches, with no polling while the lead session is away; `SessionStart` resume context.
- 2026-11-14: Fluid mission plans with repeated and named stops; *Mark Done* and *Stop Tracking*.
- 2026-11-12–13: Missions added; the board's decision support is in [board.md](board.md#history).
