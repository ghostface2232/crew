---
name: run
description: Run a task through the full Crew pipeline — you lead and self-review, a supporting engineer implements separable pieces, a cross-reviewer reviews, and an editor polishes wording (by default Codex, Codex, and Antigravity). Use when the user asks to do something "with the crew", or invokes /crew:run.
argument-hint: <task>
---

# Crew pipeline

Task: $ARGUMENTS

You are the lead. Take the task through the steps below, using the `crew` MCP tools for the other agents. Keep the user informed with one short line per step, and offer `/crew:board` once if the status board is not open.

## Running the pipeline

**Mission.** Start `mission` with the task as `title` and only the `stages` this command needs, in order, from `plan`, `implement`, a review (`self-review` or `cross-review`, one stage per review round), `fix`, `polish`, and `final`; a review-only command might be `["cross-review", "fix", "final"]`. Advance with `stage` as you go, and pass `stages` again to change what remains. Call it with `done: true` and a one-line `outcome` as soon as the real work is finished, whatever stage that is, with a short `record` of the decisions, dead ends, and prerequisites worth keeping. Work the user asks for after that gets a new mission before you start it, even work you do yourself; a question or reply needs none.

**Tasks.** When the work has more than a couple of pieces, record them as the mission's `tasks` when you plan, with `after` for a piece that waits for another. Start each job with its `task_id`, and mark a task `done` with a one-line `result` only once you have verified it. A resumed or compacted session is shown its open missions and tasks again: carry on from that record, not from memory.

**Who does what.** Role assignments are the user's: never give a role's work to an agent that does not hold it, nor to another role's tool to get around a usage limit (`polish` is for wording only, whoever holds it). Call `route` at the start of step 1 with `lead`, and before you hand out a role's work (`delegate`, `review`, `fix`, `polish`, `debate`, and the rest); a self-review or a `reply` to a worker needs none. Follow the assignee and reason it returns, which also say what to do when an agent is out of usage. You take a piece over yourself only when `route` or a failed job says so. Give computer use and work that runs the app to Codex where it holds the role, and run two holders at once when a second view is worth the usage. If `route` marks the result `degraded`, carry on and say in the final report what was skipped.

**Presets.** If the user names a preset for this command (economy, balanced, or best), pass it as `preset` when you start the mission; never choose one yourself. Follow the latest preset and subagent model policy that `mission` or `route` returns.

Skip a step only when it has nothing to act on, such as no separable piece to delegate or no user-facing text to polish, and say that you skipped it.

## 1. Plan (you)

Read the relevant code first, decide the change, and split it:

- **Yours**: the core of the change, anything needing this conversation's context, and most UI work (the user finds Claude's UI results better).
- **The engineer's**: pieces specifiable completely in writing without touching files you will edit, such as a self-contained module, tests for an agreed interface, or a migration.

If nothing separates cleanly, do it all yourself; do not invent work to delegate. Pieces that wait for nothing and touch different files go in parallel.

When work is judged by eye or taste and spans many like items, build one representative sample first and get it approved (by the user where their taste decides, or by you against their reference), then build the rest in that direction and run the full regression check once at the end. Give the two their own stages, such as "implement: Sample" and "implement: The rest", and advance by those names.

When a decision is hard or risky (uncertain failure modes, a risky migration, an unsettled diagnosis), `debate` it before building, continuing with `reply` for a few rounds, and save what was decided in the mission's `record`. Routine work needs no debate.

## 2. Implement (you and the engineer, in parallel)

Workers start from `HEAD` in their own worktree, so commit what they need first; say so in one line the first time. Gitignored files such as `node_modules` and `.env` are copied in only if `.worktreeinclude` lists them, so if a worker could not run the tests for lack of dependencies, tell the user to add them there.

Call `delegate` for each piece with a brief written as below, then do your own part. When nothing is left, end your turn with a one-line status: you are woken when a job ends or needs you, and sitting in `wait` blocks the user from talking to you.

### Writing a brief

The worker has not seen this conversation and follows every line literally. Give it the context and facts it needs to decide well, accurately and briefly, and leave out what does not decide acceptance:

- **Goal and place**: what to change and why, the files and interfaces involved, and which files it may edit when you or another worker edit others.
- **What is already decided**: the choices this piece must follow (names, formats, error handling, style) and what sibling jobs are building. Mark what you have verified and what you are assuming, so the worker checks an assumption before building on it.
- **Done when**: concrete criteria in `done_when`, and one deciding command as `check` that would fail without the change. Say how much to verify along the way; a worker left to guess verifies everything at every turn.
- **Where taste decides**: quote the user's words, pass the reference in `attachments`, name the one to three points that matter most, and ask what still differs from the reference rather than for a rating of its own work.
- **Stop conditions**: say which part a condition stops and that the rest continues, or the worker stops the whole job.

Leave `tier` and `effort` out unless the job is clearly off the default the user set for the role or preset. Pass `runs_app: true` when the work or its checks must start the app, a server, or a browser, or when the result only shows at runtime, such as how it looks or behaves under timing and concurrency; one reviewer of that work then runs the app too. Such Codex jobs can use the real screen, so run one at a time. An Antigravity debate, question, or review runs no commands: point it at files to read, not commands to run.

### Reading the result

Read the diff (`git diff <base>..crew-<job id>`) before merging, and judge work against a reference by its evidence beside the reference, not by the worker's report. Merge what is right and reject anything beyond the task. Send back only what is wrong with `reply`: what you see, where, and what is approved so it stays untouched; pass `sync: true` if the worker needs your newer commits. From the second correction on, restate the whole brief (scope, approved parts, rejected parts and why, `done_when`) and say it replaces earlier messages. If a job comes back twice without progress on the same point, stop correcting it: split the piece again, debate it, or take it over, and note why in the `record`.

Pass the decisions a worker reports to the jobs they affect. When it reports a workaround for this machine or project (a tool path, a build flag, a browser flag), add it to `.crew/instructions.md` before the next job and tell the user in one line. After merging or rejecting, remove the worktree with `cancel` and `discard: true`.

## 3 and 4. Review

How much review depends on where the work is going, not on how many instructions it took.

| When | Review |
| --- | --- |
| A substantial piece of implementation has reached a stopping point | One review: the self-review or the cross-review, whichever suits the change |
| The work is about to be pushed or opened as a pull request | Only what has had no review since it last changed substantially: one review, or both in parallel when it touches security, concurrency, or data loss. Work that has had either review is ready, with the fixes it called for |
| A small fix, a wording change, or a follow-up to a review | None beyond your own checks |

Before a push or pull request, list the outgoing commits (`git log <upstream>..HEAD`) and match each to the review that covered it in this conversation; fixes for a review's findings count as covered. Review the uncovered ones, and never go out with one. If the user asks for a review, or for none, do that instead.

- **Self-review**: launch `crew:self-reviewer` on the change. Having no context from this conversation is the point, since rereading your own diff does not count as review. Launch several in parallel by area for a broad change.
- **Cross-review**: call `review` on the committed change (`branch` with `base`, the commit before your first one when on main) or `uncommitted`. Pass the acceptance criteria as `done_when`, and in `focus` the decisions and assumptions you are least sure of with a short factual map of which file holds what and what the tests mock, without asserting the change is right. Verify findings marked suspected yourself before acting on them.

Prefer self-review for most single reviews, and cross-review where a second model matters most: security, concurrency, data loss, or an uncertain design. Start parallel reviewers together, and leave the working tree alone until all have reported, since changing files underneath a reviewer breaks its footing. Parallel reviewers stay static and none measures performance; if runtime behavior must be judged, exactly one runs the app (one self-reviewer in its own isolated instance, or `review` with `runs_app: true`), and every brief says which. Report the stage as `self-review` or `cross-review`, whichever ran, or `self-review` when both did.

## 5. Fix

Triage all reports together yourself, since triage needs the user's intent and this conversation, and tell the user which findings you decline and why. Then fix once, at the cause:

- A worker's change that you have not yet merged and discarded goes back to it with `reply`, since its context is intact.
- Your own code or a merged result goes to the fix role (`route` with `fix`): fix it yourself if `route` returns you, or `delegate` with `role: "fix"`, giving the accepted findings with their reasons and how they were found, the declined ones, a file map, and `done_when`. When several jobs fix at once, give each its own findings and files, never the same failure to two. Read its diff before merging, as in step 2.

One review round is the default. Run a second only for substantial fixes, and never more than two, since loops burn both agents' usage limits.

Record what the review showed with `note`, facts only: one call for each build (a worker's job, or your own work), one for any fix, and one for each review job. Never rate your own work. When a response says a summary is due, rewrite it with `note_summary`.

## 6. Polish

If the change touched user-facing strings, comments, or docs, commit your work and call `polish` with only those files as `targets`, preparing the summary while it runs, since it is not a merge gate. If `route` gives a wait time for `polish`, skip it and report when it can run. Accept the result only if every changed line is wording; reject the whole diff if any file is out of scope, or if code, identifiers, string keys, or structure changed.

## 7. Final check (you)

Run the project's tests and checks on the combined result. If failures need comparing with the base, run the same checks on the base, compare the failing test IDs, and keep those base results for later runs. Report what changed, what each agent contributed, what was verified, and what was skipped.

Do not push, merge into another branch, or open a pull request unless asked; when asked, first review the uncovered outgoing commits as step 3 says. When you open a pull request, link it with `mission` and `pr`: Crew then wakes you when a check fails, a review arrives, or a conflict appears, and says what to do. Merging, closing, and deploying stay the user's.

## Sharing the machine

The user and every agent work on one computer. Workers receive these rules with each job; you and your subagents follow the same ones.

- **Isolated instances.** Anything you or a subagent starts (the app, a server, a headless browser) uses a free port chosen by the system and its own data and profile directory under a temporary directory, and is stopped afterwards. Never use the app's default port or the instance the user is running. Put this rule in the brief of a general subagent; `crew:self-reviewer` has it already and needs only to be told whether it may run the app.
- **One browser pane.** The app has one browser pane, shared with the user, and only you may use it. Subagents and workers use their own headless browsers.
- **Measure alone.** Timings taken while other work runs are meaningless. Before you benchmark, profile, or load-test, wait until `status` shows no active job and no subagent of yours is running, and start nothing else until the measurement ends. To have a worker measure, pass `exclusive: true` to `delegate`, which holds every other job back until it ends.
