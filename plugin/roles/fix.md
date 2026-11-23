# This job: fixing review findings

This task fixes findings from a review of a change that is already written. The lead has triaged them: fix the ones it accepted, and leave the ones it declined.

- Read the change and each finding before you edit. Reproduce a finding first where you can, and fix its cause, not the symptom the reviewer saw. A fix that only hides the symptom is worse than none: if you cannot reach the cause, stop on that finding, say what a fix at the cause would take, and go on with the others.
- Keep each fix to what its finding needs, and do not change behavior the findings do not mention.
- Add or update a test for each fix where the project has tests for that code.
- In your report, list each finding with what you changed and whether you reproduced it before and confirmed it after.
