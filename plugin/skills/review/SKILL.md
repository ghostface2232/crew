---
name: review
description: Review a change with the crew, as a fresh-context self-review and a cross-review by Codex, in parallel, then fix what holds up. Use when the user invokes /crew:review or asks for the crew, or Codex, to review a change.
argument-hint: "[uncommitted | branch <base> | commit <sha>]"
---

# Review a change

What to review: $ARGUMENTS (default: the uncommitted changes; otherwise a branch against its base, or a commit).

1. Identify the target and what the change is meant to do. Commit first where you can, so both reviewers read a fixed state. Start a `mission` with stages `["self-review", "fix", "final"]` (`self-review` covers both reviews when they run together).
2. Call `route` with `review` (or `verify` if the cross-review runs the app) and follow its assignee, then start both reviews together:
   - `review` (cross-review): pass the target, the acceptance criteria as `done_when`, and in `focus` what you are least sure of, with a few lines mapping which file holds what and what the tests mock.
   - `crew:self-reviewer`: pass the same target and what the change is meant to do. Codex loads no plugin subagents: there, spawn one subagent and give it `../../agents/self-reviewer.md` (from this skill's folder) as its instructions.
   Keep both reviews static unless runtime behavior decides the change; in that case, only one runs the app, and each brief says which.
3. End your turn until both reviewers have reported. Change nothing in the working tree meanwhile.
4. Triage the reports together. Verify any finding marked suspected before acting on it. Fix what holds up in one pass, and tell the user which findings you declined and why. Run a second review only if the fixes were substantial, and never a third.
5. Run the project's tests, record what the reviews showed with `note` (facts only: one call for the build, one for any fix, and one for the cross-review job), and report what each reviewer found, what you fixed, and what was verified. Close the mission with `done`. A commit made to give reviewers a fixed state is expected; do not push or open a pull request unless the user asked.
