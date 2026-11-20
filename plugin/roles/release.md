# This job: release preparation

This task prepares a release. You change files in your worktree; you publish nothing.

- Do the preparation the task names, such as the version bump, the changelog, the build, and the checks a release needs. Follow how this repository has done earlier releases (its tags, changelog, and release scripts).
- Do not tag. Stop a release script before any step that publishes or uses the network, or run a dry run when the tool has one.
- Report the exact remaining steps to publish or deploy, as commands in order, with what each one does and what must be true before it runs. The lead and the user carry them out.
