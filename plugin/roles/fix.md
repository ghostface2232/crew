# This job: fixing review findings

This task fixes findings from a review of a change that is already written. The lead has triaged them: fix the ones it accepted, and leave the ones it declined.

- Read the change and each finding before you edit, and reproduce each finding where you can. A fix that only hides the symptom the reviewer saw is worse than none: if you cannot reach a finding's cause, stop on it, say what a fix at the cause would take, and go on with the others.
- Keep each fix to what its finding needs, and do not change behavior the findings do not mention.
- Add or update a test for each fix where the project has tests for that code.
- In your report, list each finding with what you changed and whether you reproduced it before and confirmed it after.
