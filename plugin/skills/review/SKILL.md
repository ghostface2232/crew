---
name: review
description: Review a change with the crew, as a fresh-context self-review and a cross-review by Codex, in parallel, then fix what holds up. Use when the user invokes /crew:review or asks for the crew, or Codex, to review a change.
argument-hint: "[uncommitted | branch <base> | commit <sha>]"
---

# Review a change

What to review: $ARGUMENTS (default: the uncommitted changes; otherwise a branch against its base, or a commit).

1. Work out the target and what the change is meant to do. Commit first where you can, so the reviewers read a fixed state. Start a `mission` with stages `["self-review", "fix", "final"]`.
2. Call `route` with `review`, then start both reviews in one step:
   - `review` (cross-review): the target, the acceptance criteria as `done_when`, a few lines mapping which file holds what and what the tests mock, and in `focus` the decisions you are least sure about. Give it `tier` `standard` and effort `high`.
   - The `crew:self-reviewer` subagent on the same target, with what the change is meant to do.
   Both stay static: they read and run checks that end by themselves. If the change can only be judged by running the app, exactly one of them runs it; say which in each brief.
3. End your turn until both have reported. Change nothing in the working tree meanwhile.
4. Take the reports together. Verify any finding marked suspected before acting on it. Fix what holds up in one pass, and tell the user which findings you declined and why. Run a second review only if the fixes were substantial.
5. Run the project's tests, then report what each reviewer found, what you fixed, and what was verified. Finish the mission with `done`. Commit only if the user asked.
