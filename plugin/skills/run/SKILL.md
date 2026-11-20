---
name: run
description: Run a task through the full Crew pipeline — you lead and self-review, a supporting engineer implements separable pieces, a cross-reviewer reviews, and an editor polishes wording (by default Codex, Codex, and Antigravity). Use when the user asks to do something "with the crew", or invokes /crew:run.
argument-hint: <task>
---

# Crew pipeline

Task: $ARGUMENTS

You are the lead. Take the task through the steps below, using the `crew` MCP tools for the other agents. Keep the user informed with one short line per step; they can watch every agent live on the status board (offer `/crew:board` once if it is not open).

When a tool response or wake digest includes a receipt, pass `ack: "<receipt>"` with your next Crew call (or an array for several receipts). Only that echo acknowledges the snapshots shown; a tool read or hook event does not. Automatic offers stop after two attempts, but pending news stays in `status` and on the board. Read long reports with `status`, `job_id`, and `report_offset: 0`, then follow the next offset.

The user assigns each role to an agent in the settings. `delegate` defaults to the implementation role, or takes `role: "refactor"` for restructuring that keeps behavior, `role: "release"` for release preparation (it publishes and deploys nothing; you and the user run the steps it reports), or `role: "fix"` for fixing review findings (step 5). `review` is the cross-review, or with `runs_app` the review that runs the app (`verify`). `debate` and `polish` are their own roles. Pick the role that matches the work; each job's result names the agent that took it. A role may have several holders: pick one per job with `agent` (without it, Antigravity takes wording and Codex other work). Give computer use and work that runs the app to Codex where it holds the role, and run two holders at once when a second view is worth the usage. When you hold a role yourself (`claude`), the tool starts nothing: do the work in this session or a subagent. Role assignments are the user's; never give a role's work to an agent that does not hold it.

If the user names a preset for this command (economy, balanced, or best), pass it as `preset` when you start the mission; never choose one yourself. The mission's response says which preset is in effect and what model to give your own subagents; follow the latest one you were told.

Start `mission` with the task as `title` and `stages`: only the stages this command needs, in order (`plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`). A review-only command might use `["cross-review", "fix", "final"]`; a small change may need no polish. A stage may carry a short name after a colon, which the board shows in place of the stage's: use it where two steps share a stage, or the stage's own name says too little. At any time, pass `stages` again with only what remains to add, drop or reorder future steps (`[]` drops them all); passed and current steps stay. Report `stage` to move on: it advances to the next occurrence or inserts one, so add another review, fix or polish whenever results call for it. Call `mission` with `done: true` and a one-line `outcome` as soon as the real work is finished, whatever stage you are at (or `abandoned: true` if the task is dropped). When the work turned on decisions, failed approaches, or prerequisites worth keeping, pass them as a short `record` with `done`; `crew export` turns it into a runbook. Each is one short call. If the user asks for more work after you called `done`, start a new mission for it before you begin, including work you do yourself; a question or a reply needs none. Each of the user's messages after `done` carries a reminder of this. Jobs started after `done` without one are put under a follow-up mission named after the finished one ("후속 작업: …" or "Follow-up: …").

At the start of step 1, call `route` with `lead`; at the start of steps 2, 3, 5, and 6, call it with the role you are about to hand out (`delegate`, `refactor`, `release`, `review`, `verify`, `fix`, `polish`; `debate` before a debate). `route` checks each agent's remaining usage from AgentGauge and returns who should take the work: the role's holder or you. Follow the returned assignee and reason. When the result is marked `degraded`, continue and note what was skipped in the final report; when `route` gives a wait time for `polish`, skip polish and report when it can run. Call `route` once per step, not on every turn. If AgentGauge has no data, `route` returns the role's holder as before.

Skip a step only when it has nothing to act on (for example, no separable piece to delegate, or no user-facing text to polish), and say that you skipped it.

## 1. Plan (you)

Read the relevant code first. Decide the change, then split it:

- **Yours**: the core of the change, anything that needs this conversation's context, and most UI work (the user finds Claude's UI results better).
- **The engineer's**: pieces that can be specified completely in writing and built without touching the files you will edit, such as a self-contained module, tests for an agreed interface, or a migration.

If nothing separates cleanly, do it all yourself. Do not invent work to delegate.

When the result is judged by eye or taste (how it looks, reads, or feels) and the work is many like items or several layers, do not have it all built at once. Plan one representative sample first and get it approved: by the user where their taste decides, or by you against the reference they gave. Then build the rest in the approved direction, and run the full regression check once, at the end. Give each stop its own step in the mission's `stages`, named for what it is ("implement: Sample", "implement: The rest"), and report the next one by that name. A rejected sample costs one item; a rejected set costs the set and every check run on it.

When the decision itself is hard, tricky, or important (a design with failure modes you are unsure of, a risky migration, a diagnosis you cannot settle), `debate` it with the engineer before you build: state your position, answer its points with `reply` for a few rounds, and put what was decided in the mission's `record`. Routine work does not need a debate.

## 2. Implement (you and the engineer, in parallel)

Workers start from `HEAD` in their own worktree, so commit anything they need first. Gitignored files such as `node_modules` and `.env` are copied in only if the repository's `.worktreeinclude` lists them; if a worker reports that it could not run the tests for lack of dependencies, tell the user to add them there.

Call `delegate` for each delegated piece; it returns at once while the engineer works. Write the task for someone who has not seen this conversation: goal, files and interfaces involved, constraints, and a concrete `done_when`. A worker carries out what is written line by line, including the lines that did not matter, so keep to what decides acceptance. Where the result is judged against the user's taste, quote their own words, pass the reference in `attachments`, and name the one to three points that matter most. Say how much verification you want; a worker left to guess verifies everything at every step. Do not ask a worker to rate its own work: ask what still differs from the reference. Give every job a `tier` and an `effort`: `standard` for most work, `frontier` only for especially hard or complex work or a UI rebuilt from scratch, `light` for simple tasks, `fast` for plain lookups; effort `medium` for most work and `high` when the task calls for it. Under a preset that sets effort (economy sets `low`), leave effort out unless the task needs a different one: the preset's effort then holds. Name the files it may edit when you or another worker are editing others. If you give a stop condition for a specific problem, state which part it stops and that the rest should continue: a worker told simply to stop will stop the whole job. Then do your own part. When you have nothing left to do, end your turn with a one-line status: you are woken when a job ends or needs you. Do not sit in `wait` on a running job; the user cannot talk to you meanwhile.

Never approve a worker's request on your own. If it is clearly outside the task or role, use `reply` with decision `decline` and a message saying why and what to do instead. For other approvals and waiting questions, call `wait` so the user is asked, or relay the answer they already gave you.

Codex's own automatic reviewer answers most of its approval requests. When a result lists an action it refused and the user's request clearly covers that action, call `reply` with `approved_by_user` quoting their words, without asking them again. If it is refused once more, make the same call again: the user is then asked directly. If their request does not cover the action, tell them and let them decide.

If a delegated piece can only be done or verified by starting the app, pass `runs_app: true`: the worker's sandbox then has the network access a local server needs. Work whose result only shows while it runs always takes it: how it looks, interaction and timing, traffic between processes, startup and builds, concurrency and recovery, and any work whose checks start a server, a browser, or the app. One reviewer of that work runs the app too: reading code and mocked tests do not show these. Pure logic that tests can check in the sandbox does not need it.

When a job is done, read its diff before merging (`git diff <base>..crew-<job id>`). Judge work that has a reference by looking at its evidence beside the reference, not by the report or the worker's own account of how close it is. Merge what is right. Use `reply` with a message to have the worker fix what is not, and reject anything beyond the task. Send back only the part that is not right, say what you see and where rather than a general verdict, and name what is approved so it is not touched again. A second correction no longer adds to the brief: restate it whole as it now stands (scope, what is approved, what is rejected and why, `done_when`) and say that it replaces your earlier messages.

When a worker reports something about this machine or project that it had to work around (a tool's path, a flag a build or a browser needs), add it to the project's `.crew/instructions.md` before the next job starts, and tell the user in one line. Every later job is given that file, so no worker has to find the same thing again. If the worker needs commits you made after it started, pass `sync: true` with the reply to bring its branch up to date first. After merging or rejecting, `cancel` with `discard: true` removes the worktree.

## 3 and 4. Review

How much review depends on where the work is going, not on how many instructions it took.

| When | Review |
| --- | --- |
| A substantial piece of implementation has reached a stopping point | One review: the self-review or the cross-review, whichever suits the change |
| The work is about to be pushed or opened as a pull request | Only what has had no review since it last changed substantially: one review, or both in parallel when it touches security, concurrency, or data loss. Work that has had either review is ready, with the fixes it called for |
| A small fix, a wording change, or a follow-up to a review | None beyond your own checks |

Before a push or pull request, list the commits going out (`git log <upstream>..HEAD`) and match each to the review that covered it in this conversation. Review only the ones that no review covered; never go out with one uncovered. Fixes made for a review's findings count as covered by it.

If the user asks for a review, or for none, do that instead.

- **Self-review**: launch the `crew:self-reviewer` subagent on the change. It has none of this conversation's context, which is the point: rereading your own diff in the same context does not count as review. For a broad change, launch several at once, each with its own area.
- **Cross-review**: call `review` on the change (target `uncommitted`, or `branch` with the base; on the main branch the base is the commit before your first one). Commit first where you can, so the reviewer reads a fixed state. Pass the acceptance criteria as `done_when` and use `focus` for decisions and assumptions you are least sure about. In a few lines, give the reviewer the map you already have: which file holds what, and what the tests mock or fake. Give it facts about the structure, not your view that the change is right. Findings come back marked reproduced, read, or suspected; weigh them accordingly, and verify any suspected finding yourself before acting on it.

For the single review, prefer the self-review for most changes, and the cross-review where a second model's view matters most: security, concurrency, data loss, or a design you are unsure of.

Whenever more than one reviewer runs, start them in one step, then end your turn until all of them have reported; you are woken as each one ends. Change nothing in the working tree until all have reported: a reviewer that sees files change underneath it loses its footing. Parallel reviewers are static by default: they read the change and run checks that finish on their own. If the change can only be judged by running the app, exactly one of them runs it, and each brief says who. Either tell one self-reviewer it may run the app in its own isolated instance, or pass `runs_app: true` to `review`, which then runs in a snapshot of the change. None of them measures performance.

Report the step to `mission` as `self-review` or `cross-review`, whichever ran; as `self-review` when both did.

## 5. Fix

Take the reports together and triage them yourself: decide which findings to accept, and tell the user about any you decline and why. Triage stays with you whoever holds the fix role, because it needs the user's intent and this conversation.

Then fix once, at the cause:

- A change a worker built goes back to that worker with `reply`, since its context is intact.
- Your own code, or a result merged from several jobs, goes to the fix role. Call `route` with `fix`. When it returns you (the default), fix it yourself. When it returns a worker, `delegate` with `role: "fix"` and give it the accepted findings with their reasons and how they were found, your decisions on the declined ones, a map of the files involved, and a `done_when`. A brief of file names alone invites fixes that only hide symptoms. Read its diff before you merge, as in step 2.

One review round is the default. Run a second only if the fixes were substantial; never more than two, because review loops burn both agents' usage limits.

Then record what the review showed with `note`, one call per model judged. Every call needs the change's `size` and `text`, one line of facts, and a builder's or fixer's line needs `reviewer`:

- The builder's line (`role: "build"`): `job_id` of the job that built the work (never the review's), or `model` with your own model id for work done here or in a subagent. A result merged from several jobs gets one line per job, each with the findings in its part; a finding that spans the pieces goes on your own line. For a delegated job, also give `adoption`: how you took its work (`as-is`, `after-reply`, `partly`, `rejected`); issues you found in its diff count as findings, with `reviewer: "claude"` if no other review covered it. Give the findings you accepted by severity and the ones you `declined`. When several reviews covered the work, note it once with every accepted finding counted once, naming as `reviewer` one from another agent if any ran.
- The fixer's line (`role: "fix"`): `outcome` is `root-cause`, `patch`, or `another-review` when the fix needed another round, and `findings` are what the check of the fix raised.
- The reviewer's line (`role: "review"`), one per review a job ran: `job_id` of the review job, the work it covered as `of_job` (the job that built it) or `of_model` (your own model id, for work done here), and its own findings as you triaged them, accepted in `findings` and the rest in `declined`. It scores the reviewer on how its findings held up, and gives the reviewer's rating of the work, and the builder's rating of the review, their target.

Unless the user turned peer ratings off, add `rating` to a job's line for what you saw of its work, each item from 1 to 5: `correctness` (a builder only), `brief` (how it followed your brief) and `report` (how well its report matched the work) for a builder or fixer, `findings` (how useful they were) for a review. The line's `text` is the fact the numbers rest on, so leave out an item it does not bear out. Never rate your own work: its reviewer does. Workers rate in turns they already have, so do not ask one for a rating.

Facts only, never impressions. When a response says a model's summary is due, rewrite it with `note_summary` (`model` and `summary`) from its evidence lines. The notes inform which tier and holder you pick; the roles and presets stay the user's.

## 6. Polish

If the change touched user-facing strings, comments, or docs, commit your work and call `polish` with exactly those files as `targets`. It is not a merge gate, so prepare the summary while it runs.

Accept the result only if every changed line is wording. Reject the whole diff if any file is listed as out of scope, or if code, identifiers, string keys, or structure changed.

## 7. Final check and merge (you)

Run the project's tests and checks on the combined result. If failures need comparison with the base, run the same checks on the base and compare the reported failing test IDs. Keep the base results for any follow-up runs. Report what changed, what each agent contributed, what was verified, and anything skipped. Commit or merge to the user's branch only if they asked for that. If they asked you to push or open a pull request, first review whatever going out no review has covered, as step 3 sets out, and fix what it finds.

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
| Crew cannot start a job (a Crew tool fails, or the job fails before its first turn) | Retry once. If it fails the same way, tell the user the error and do that piece yourself, in a subagent if it is large. Do not keep retrying: each attempt can wait minutes before it fails. |

Never hand one role's work to another role's tool to get around a limit: `polish` is for wording only, whoever holds it.
