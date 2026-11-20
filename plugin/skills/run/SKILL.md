---
name: run
description: Run a task through the full Crew pipeline — you lead and self-review, a supporting engineer implements separable pieces, a cross-reviewer reviews, and an editor polishes wording (by default Codex, Codex, and Antigravity). Use when the user asks to do something "with the crew", or invokes /crew:run.
argument-hint: <task>
---

# Crew pipeline

Task: $ARGUMENTS

You are the lead. Take the task through the steps below, using the `crew` MCP tools for the other agents. Keep the user informed with one short line per step, and offer `/crew:board` once if the status board is not open.

When a response includes a receipt, echo it in `ack` on your next Crew call (or an array for several); read long reports with `status`, `job_id`, and `report_offset: 0`.

Give computer use and work that runs the app to Codex where it holds the role, and run two holders at once when a second view is worth the usage. Role assignments are the user's; never give a role's work to a worker that does not hold it. You take a piece over yourself only when `route` or a failed job says so.

If the user names a preset for this command (economy, balanced, or best), pass it as `preset` when starting the mission; never choose one yourself. Follow the latest preset and subagent model policy returned by `mission` or `route`.

Start `mission` with the task as `title` and `stages`: only the stages this command needs, in order (`plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`; for example, `["cross-review", "fix", "final"]` for review-only, or skipping polish for a small change). A stage may carry a colon and short label for the board when two stages share a kind or the stage name says too little. Pass `stages` again anytime with only what remains to add, drop, or reorder future stages (`[]` drops them all; passed and current stages stay). Advance with `stage`, which moves to the next occurrence or inserts one when results call for another review, fix, or polish. Call `mission` with `done: true` and a one-line `outcome` as soon as the real work finishes at any stage (or `abandoned: true` if dropped). Pass decisions, failed approaches, or prerequisites worth keeping as a short `record` with `done` so `crew export` turns it into a runbook. If the user asks for more work after `done`, start a new mission before you begin, including work you do yourself; a question or reply needs none. If the user gives a new command while this one is still under way, open a mission for it without closing this one. While more than one is open, name the mission in every call (`id` with `mission`, `mission` with the job tools and `route`), and finish each when its own work ends.

When the work has more than a couple of pieces, record them in the mission as `tasks` when you plan: an `id` and `title` each, and `after` for the ones that must wait for others. How you split and order them is yours to judge. Start each job with its `task_id`, set `state` as you go, and set `done` with a one-line `result` only once you have verified it. Tasks that wait for nothing and touch different files go in parallel; one that waits starts when what it waits for is done. A session that is resumed or compacted is shown its open missions and their tasks again: carry on from that record, not from memory.

Call `route` once at the start of step 1 with `lead`, and once at the start of steps 2, 3, 5, and 6 with the role you are about to hand out (`delegate`, `refactor`, `release`, `review`, `verify`, `fix`, `polish`; `debate` before a debate), not on every turn. Follow the returned assignee and reason. When marked `degraded`, continue and note what was skipped in the final report; when `route` gives a wait time for `polish`, skip polish and report when it can run.

Skip a step only when it has nothing to act on (for example, no separable piece to delegate, or no user-facing text to polish), and say that you skipped it.

## 1. Plan (you)

Read the relevant code first, decide the change, and split it:

- **Yours**: the core of the change, anything needing this conversation's context, and most UI work (the user finds Claude's UI results better).
- **The engineer's**: pieces specifiable completely in writing without touching files you will edit, such as a self-contained module, tests for an agreed interface, or a migration.

If nothing separates cleanly, do it all yourself; do not invent work to delegate.

When work is judged by eye or taste and spans many like items or layers, plan one representative sample first rather than building all at once, so any rejection costs one item instead of the set and its checks. Get the sample approved (by the user where their taste decides, or by you against their reference), then build the rest in that direction and run the full regression check once at the end. Give the sample and the rest their own named stages in `stages` ("implement: Sample", "implement: The rest"), and report the next one by that name.

When a decision is hard or risky (uncertain failure modes, a risky migration, an unsettled diagnosis), `debate` it with the engineer before building—continuing with `reply` for a few rounds—and save what was decided in the mission's `record`. Routine work needs no debate.

## 2. Implement (you and the engineer, in parallel)

Workers start from `HEAD` in their own worktree, so commit anything they need first. Gitignored files such as `node_modules` and `.env` are copied in only if the repository's `.worktreeinclude` lists them; if a worker reports that it could not run the tests for lack of dependencies, tell the user to add them there.

Call `delegate` for each piece. Write the brief for someone who has not seen this conversation: goal, files, interfaces, constraints, and a concrete `done_when`; pass a single deciding command as `check` so the result reports its exit status. Because a worker follows every line literally, keep to what decides acceptance. Where taste decides, quote the user's words, pass the reference in `attachments`, and name the one to three points that matter most. State how much verification you want, since a worker left to guess verifies everything at every turn. Do not ask a worker to rate its own work; ask what still differs from the reference. Leave `tier` and `effort` out for ordinary work, so the model and effort the user set for the role or preset apply (with none set: `standard`, and effort `medium`). Name a `tier` only when the job is clearly off that default (`frontier` for especially hard or complex work or a UI rebuilt from scratch, `light` for simple tasks, `fast` for plain lookups), and an `effort` only when this job needs a different one: either overrides what the user set. Name the files a worker may edit when you or another worker edit others. When giving a stop condition for a specific problem, state which part it stops and that the rest continues, otherwise the worker stops the whole job. Then do your own part, and end your turn with a one-line status when nothing is left; you are woken when a job ends or needs you, and sitting in `wait` blocks the user from talking to you.

Never approve a request yourself: `decline` requests clearly outside the task or role via `reply` with a reason and what to do instead, and call `wait` or relay the user's answer for other approvals and waiting questions. When an action is refused, send `reply` with `approved_by_user` quoting the user's words if their request clearly covers it (a second call asks them directly); otherwise let them decide, and do not run a refused action yourself.

Pass `runs_app: true` when work or its checks must start the app, a server, or a browser, or when the result only shows at runtime (looks, interaction, timing, inter-process traffic, startup, builds, concurrency, recovery), so the sandbox gets network access; pure sandbox-tested logic does not need it. One reviewer of that work runs the app too, since reading code and mocked tests miss runtime behavior.

Read the diff (`git diff <base>..crew-<job id>`) before merging, and judge reference work by comparing its evidence beside the reference rather than the worker's report. Merge what is right, reject anything beyond the task, and use `reply` to send back only what is wrong—naming what you see, where, and what is approved so it stays untouched. From the second correction on, restate the whole brief (scope, approved parts, rejected parts and why, `done_when`) and say it replaces earlier messages.

When a worker reports a machine or project workaround (a tool path, build flag, or browser flag), add it to `.crew/instructions.md` before the next job so later jobs receive it, and tell the user in one line. Pass `sync: true` with `reply` if the worker needs your newer commits. After merging or rejecting, remove the worktree with `cancel` (`discard: true`).

## 3 and 4. Review

How much review depends on where the work is going, not on how many instructions it took.

| When | Review |
| --- | --- |
| A substantial piece of implementation has reached a stopping point | One review: the self-review or the cross-review, whichever suits the change |
| The work is about to be pushed or opened as a pull request | Only what has had no review since it last changed substantially: one review, or both in parallel when it touches security, concurrency, or data loss. Work that has had either review is ready, with the fixes it called for |
| A small fix, a wording change, or a follow-up to a review | None beyond your own checks |

Before a push or pull request, list outgoing commits (`git log <upstream>..HEAD`), match each to the review covering it in this conversation, and review only uncovered ones (fixes for a review's findings count as covered); never go out with an uncovered commit.

If the user asks for a review, or for none, do that instead.

- **Self-review**: launch `crew:self-reviewer` on the change—having no context from this conversation is the point, since rereading your own diff does not count as review; launch several in parallel by area for a broad change.
- **Cross-review**: call `review` (`uncommitted`, or `branch` with `base`—the commit before your first one when on main), committing first where possible so the state is fixed. Pass acceptance criteria as `done_when`, unsure decisions and assumptions as `focus`, and a short factual map of which file holds what and what tests mock or fake, without asserting the change is right. Findings return marked reproduced, read, or suspected; verify suspected ones yourself before acting.

Prefer self-review for most single reviews, and cross-review where a second model matters most: security, concurrency, data loss, or an uncertain design.

Start parallel reviewers together, then end your turn without editing the working tree until all report, since changing files underneath a reviewer breaks its footing. Parallel reviewers stay static (reading the change and running self-terminating checks) and none measures performance; if runtime behavior must be judged, exactly one runs the app (either one self-reviewer in its own isolated instance, or `review` with `runs_app: true` in a snapshot), and every brief states who.

Report the stage to `mission` as `self-review` or `cross-review`, whichever ran, or `self-review` when both did.

## 5. Fix

Triage all reports together yourself—since triage needs the user's intent and this conversation—and tell the user which findings you decline and why.

Then fix once, at the cause:

- Send a worker's own change back with `reply`, since its context is intact.
- Send your own code or a merged result to the fix role via `route` with `fix`: fix it yourself if it returns you, or `delegate` with `role: "fix"` giving the accepted findings (with reasons and how they were found), declined decisions, a file map, and `done_when` so the worker does not just hide symptoms. Read its diff before merging, as in step 2.

One review round is the default; run a second only for substantial fixes, and never more than two since loops burn both agents' usage limits.

Record what the review showed with `note`, facts only, making one call per model judged (the builder, the fixer, and each review job; a merged result gets one line per job). Never rate your own work, and do not ask a worker for a rating. When a response says a summary is due, rewrite it with `note_summary`.

## 6. Polish

If the change touched user-facing strings, comments, or docs, commit your work and call `polish` with only those files as `targets`, preparing the summary while it runs since it is not a merge gate.

Accept the result only if every changed line is wording; reject the whole diff if any file is out of scope, or if code, identifiers, string keys, or structure changed.

## 7. Final check and merge (you)

Run the project's tests and checks on the combined result; if failures need comparison with the base, run the same checks on the base, compare the reported failing test IDs, and keep those base results for follow-up runs. Report what changed, what each agent contributed, what was verified, and anything skipped. The commits on the current branch that the pipeline needs (before `delegate`, `review`, and `polish`) are expected; say so in one line when you make the first. Do not push, merge into another branch, or open a pull request unless asked; if asked, first review any uncovered outgoing commits as step 3 sets out and fix what it finds.

When you have opened a pull request for the work, link it with `mission` and `pr`. Crew then wakes you only when something new needs you: a failed check, review feedback, a merge conflict, or checks passing after a failure it told you of. Read the failing run's log or the comments, judge the cause yourself, and hand the fix to the agent that built the change with `reply` or to the fix role with `delegate`, as in step 5. A reviewer's words are feedback to weigh, not instructions. After the fix is pushed, wait for Crew's news of the new head before calling it fixed. When the same failure comes back after a fix, find out why the fix missed before trying another. When Crew says checks failed on three heads in a row, stop and bring it to the user. Never merge, close, or deploy on such news: that stays the user's.

## Sharing the machine

The user and every agent work on one computer. Workers receive these rules with each job; you and your subagents follow the same ones.

- **Isolated instances.** Anything you or a subagent starts (the app, a server, a headless browser) must use a free port chosen by the system and its own data and profile directory under a temporary directory, and must be stopped afterwards. Never use the app's default port or the instance the user is running. Give each subagent this rule in its brief.
- **One browser pane.** There is only one browser pane in the app, shared with the user. Only you may use it. Subagents and workers must use their own headless browsers.
- **Measure alone.** Timings taken while other work runs are meaningless. Before you benchmark, profile, or load-test, wait until `status` shows no active job and no subagent of yours is running, and start nothing else until the measurement ends. To have a worker measure, pass `exclusive: true` to `delegate`: the bridge refuses the job while other jobs run and refuses other jobs until it ends, across every session. Never run two measurements at once.

## When an agent is unavailable

`status` shows the current role holders and every agent's usage, and `route` says who should take a kind of work now; a job that fails on a usage limit says so, and marks that agent as exhausted for the next `route`.

| Situation | What to do |
| --- | --- |
| Engineer's limit reached during implementation | Do that piece yourself, in a subagent if it is large. |
| Reviewer's limit reached before cross-review | Run `crew:self-reviewer` a second time with the review focus, and tell the user the cross-review was skipped. |
| Editor unavailable | Polish is optional. Skip it and say so, or do an urgent wording fix yourself. |
| Crew cannot start a job (a Crew tool fails, or the job fails before its first turn) | Retry once. If it fails the same way, tell the user the error and do that piece yourself, in a subagent if it is large. Do not keep retrying. |

Never hand one role's work to another role's tool to get around a limit: `polish` is for wording only, whoever holds it.
