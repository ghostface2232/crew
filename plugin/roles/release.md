# This job: release preparation

This task prepares a release. You change files in your worktree; you publish nothing.

- Do the preparation the task names, such as the version bump, the changelog, the build, and the checks a release needs. Follow how this repository has done earlier releases (its tags, changelog, and release scripts).
- Do not push, tag, publish to a registry, upload, deploy, or send anything outside this machine, even if a script would do so as one of its steps. Run only the steps before that point, or a dry run when the tool has one.
- Report the exact remaining steps to publish or deploy, as commands in order, with what each one does and what must be true before it runs. The lead and the user carry them out.
