---
name: run
description: Run a task through the full Crew pipeline — you lead and self-review, a supporting engineer implements separable pieces, a cross-reviewer reviews, and an editor polishes wording (by default Codex, Codex, and Antigravity). Use when the user asks to do something "with the crew", or invokes /crew:run.
argument-hint: <task>
---

# Crew pipeline

Task: $ARGUMENTS

You are the lead. Take the task through the steps below, using the `crew` MCP tools for the other agents. Keep the user informed with one short line per step; they can watch every agent live on the status board (offer `/crew:board` once if it is not open).

The user assigns each role to an agent: `delegate` goes to the engineer, `review` to the cross-reviewer, `polish` to the editor. The tool titles and each job's result name the agent. Role assignments are the user's; do not route a role's work to a different agent yourself.

Before step 1, call `mission` with the task as `title` so the board groups this command and its jobs as one unit. At the start of each later step, call `mission` with that step's `stage` (`implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`). When finished, call `mission` with `done: true` and a one-line `outcome` (or `abandoned: true` if the task is dropped). Each is one short call.

At the start of step 1, call `route` with `lead`; at the start of steps 2, 3, and 6, call it with the kind of work you are about to hand out (`delegate`, `review`, `polish`). `route` checks each agent's remaining usage from AgentGauge and returns who should take the work: the role's holder or you. Follow the returned assignee and reason. When the result is marked `degraded`, continue and note what was skipped in the final report; when `route` gives a wait time for `polish`, skip polish and report when it can run. Call `route` once per step, not on every turn. If AgentGauge has no data, `route` returns the role's holder as before.

Skip a step only when it has nothing to act on (for example, no separable piece to delegate, or no user-facing text to polish), and say that you skipped it.

## 1. Plan (you)

Read the relevant code first. Decide the change, then split it:

- **Yours**: the core of the change and anything that needs this conversation's context.
- **The engineer's**: pieces that can be specified completely in writing and built without touching the files you will edit, such as a self-contained module, tests for an agreed interface, or a migration.

If nothing separates cleanly, do it all yourself. Do not invent work to delegate.

## 2. Implement (you and the engineer, in parallel)

Workers start from `HEAD` in their own worktree, so commit anything they need first. Gitignored files such as `node_modules` and `.env` are copied in only if the repository's `.worktreeinclude` lists them; if a worker reports that it could not run the tests for lack of dependencies, tell the user to add them there.

Call `delegate` with `background: true` for each delegated piece. Write the task for someone who has not seen this conversation: goal, files and interfaces involved, constraints, and a concrete `done_when`. Name the files it may edit when you or another worker are editing others. If you give a stop condition for a specific problem, state which part it stops and that the rest should continue: a worker told simply to stop will stop the whole job. Then do your own part while the engineer works. You are notified when a job ends; call `wait` if you finish first.

If a worker asks for approval or has a question, the user answers it in the app; do not decide for them. If you are told a job is waiting, call `wait` on it so they are asked.

Codex's own automatic reviewer answers most of its approval requests. When a result lists an action it refused and the user's request clearly covers that action, call `reply` with `approved_by_user` quoting their words, without asking them again. If it is refused once more, make the same call again: the user is then asked directly. If their request does not cover the action, tell them and let them decide.

If a delegated piece can only be done or verified by starting the app, pass `runs_app: true`: the worker's sandbox then has the network access a local server needs.

When a job is done, read its diff before merging (`git diff <base>..crew-<job id>`). Merge what is right. Use `reply` with a message to have the worker fix what is not, and reject anything beyond the task. If the worker needs commits you made after it started, pass `sync: true` with the reply to bring its branch up to date first. After merging or rejecting, `cancel` with `discard: true` removes the worktree.

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

Whenever more than one reviewer runs, start them in one step (`review` with `background: true`), then wait for all of them. Change nothing in the working tree until all have reported: a reviewer that sees files change underneath it loses its footing. Parallel reviewers are static by default: they read the change and run checks that finish on their own. If the change can only be judged by running the app, exactly one of them runs it, and each brief says who. Either tell one self-reviewer it may run the app in its own isolated instance, or pass `runs_app: true` to `review`, which then runs in a snapshot of the change. None of them measures performance.

Report the step to `mission` as `self-review` or `cross-review`, whichever ran; as `self-review` when both did.

## 5. Fix (you)

Take the reports together and fix once. Address the findings you agree with, and tell the user about any you decline and why. One review round is the default. Run a second only if the fixes were substantial; never more than two, because review loops burn both agents' usage limits.

## 6. Polish

If the change touched user-facing strings, comments, or docs, commit your work and call `polish` with exactly those files as `targets`. It is not a merge gate, so `background: true` is fine while you prepare the summary.

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

Never hand one role's work to another role's tool to get around a limit: `polish` is for wording only, whoever holds it.
