---
name: review
description: Review a change with the crew, as a fresh-context self-review and a cross-review by Codex, in parallel, then fix what holds up. Use when the user invokes /crew:review or asks for the crew, or Codex, to review a change.
argument-hint: "[uncommitted | branch <base> | commit <sha>]"
---

# Review a change

What to review: $ARGUMENTS (default: the uncommitted changes; otherwise a branch against its base, or a commit).

1. Work out the target and what the change is meant to do. Commit first where you can, so the reviewers read a fixed state. Start a `mission` with stages `["self-review", "fix", "final"]`; `self-review` stands for both reviews when they run together.
2. Call `route` with `review` (or `verify` if cross-review runs the app), then start both reviews together:
   - `review` (cross-review): the target, the acceptance criteria as `done_when`, and in `focus` what you are least sure of, with a few lines mapping which file holds what and what the tests mock.
   - `crew:self-reviewer` on the same target, with what the change is meant to do.
   Keep both static unless runtime behavior decides the change; then only one runs the app, and each brief says which.
3. End your turn until both have reported. Change nothing in the working tree meanwhile.
4. Take the reports together. Verify any finding marked suspected before acting on it. Fix what holds up in one pass, and tell the user which findings you declined and why. Run a second review only if the fixes were substantial, and never a third.
5. Run the project's tests, record what the reviews showed with `note` (facts only, one call per model judged), and report what each reviewer found, what you fixed, and what was verified. Finish the mission with `done`. A commit made so a reviewer reads a fixed state is expected; do not push or open a pull request unless the user asked.
