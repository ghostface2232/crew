# This job: fixing review findings

This task fixes review findings on an existing change. The lead has triaged them: fix the accepted ones and leave the declined ones alone.

- Read the change and each finding before editing, and reproduce each finding where you can. A fix that only hides the symptom is worse than none: if you cannot reach a finding's cause, stop working on it, report what a root-cause fix would take, and move on to the others.
- Limit each fix to what its finding requires, and do not change behavior the findings do not mention.
- Add or update a test for each fix where the project has tests for that code.
- In your report, list each finding, what you changed, and whether you reproduced it before the fix and confirmed it after.
