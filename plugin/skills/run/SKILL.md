---
name: run
description: Run a task through the full Crew pipeline — Claude leads and self-reviews, Codex implements separable pieces and cross-reviews, Antigravity polishes wording. Use when the user asks to do something "with the crew", or invokes /crew:run.
argument-hint: <task>
---

# Crew pipeline

Task: $ARGUMENTS

You are the lead. Take the task through the steps below, using the `crew` MCP tools for the other agents. Keep the user informed with one short line per step; they can watch all three agents live on the status board (offer `/crew:board` once if it is not open).

Skip a step only when it has nothing to act on (for example, no separable piece to delegate, or no user-facing text to polish), and say that you skipped it.

## 1. Plan (you)

Read the relevant code first. Decide the change, then split it:

- **Yours**: the core of the change and anything that needs this conversation's context.
- **Codex's**: pieces that can be specified completely in writing and built without touching the files you will edit, such as a self-contained module, tests for an agreed interface, or a migration.

If nothing separates cleanly, do it all yourself. Do not invent work to delegate.

## 2. Implement (you and Codex, in parallel)

Workers start from `HEAD` in their own worktree, so commit anything they need first. Gitignored files such as `node_modules` and `.env` are copied in only if the repository's `.worktreeinclude` lists them; if a worker reports that it could not run the tests for lack of dependencies, tell the user to add them there.

Call `delegate` with `background: true` for each Codex piece. Write the task for someone who has not seen this conversation: goal, files and interfaces involved, constraints, and a concrete `done_when`. Then do your own part while Codex works. You are notified when a job ends; call `wait` if you finish first.

If a worker asks for approval or has a question, the user answers it in the app; do not decide for them. If you are told a job is waiting, call `wait` on it so they are asked.

When a job is done, read its diff before merging (`git diff <base>..crew-<job id>`). Merge what is right. Use `reply` with a message to have Codex fix what is not, and reject anything beyond the task. After merging or rejecting, `cancel` with `discard: true` removes the worktree.

## 3. Self-review (you, with fresh eyes)

Launch the `crew:self-reviewer` subagent on the combined change. It has none of this conversation's context, which is the point: rereading your own diff in the same context does not count as review. Fix what it finds.

## 4. Cross-review (Codex)

Call `review` on the change (target `uncommitted`, or `branch` with the base). Pass the acceptance criteria as `done_when` and use `focus` for decisions and assumptions you are least sure about.

## 5. Fix (you)

Address the findings you agree with, and tell the user about any you decline and why. One review round is the default. Run a second only if the fixes were substantial; never more than two, because review loops burn both agents' usage limits.

## 6. Polish (Antigravity)

If the change touched user-facing strings, comments, or docs, commit your work and call `polish` with exactly those files as `targets`. It is not a merge gate, so `background: true` is fine while you prepare the summary.

Accept the result only if every changed line is wording. Reject the whole diff if any file is listed as out of scope, or if code, identifiers, string keys, or structure changed.

## 7. Final check and merge (you)

Run the project's tests and checks on the combined result. If failures need comparison with the base, run the same checks on the base and compare the reported failing test IDs. Keep the base results for any follow-up runs. Report what changed, what each agent contributed, what was verified, and anything skipped. Commit or merge to the user's branch only if they asked for that.

## When an agent is unavailable

`status` shows Codex's usage; a job that fails on a usage limit says so.

| Situation | What to do |
| --- | --- |
| Codex limit reached during implementation | Do that piece yourself, in a subagent if it is large. |
| Codex limit reached before cross-review | Run `crew:self-reviewer` a second time with the review focus, and tell the user the cross-review was skipped. |
| Antigravity unavailable | Polish is optional. Skip it and say so, or do an urgent wording fix yourself. |

Never give Antigravity implementation or review work, whatever the limits.
