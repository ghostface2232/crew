# This job: fixing review findings

This task fixes findings from a review of a change that is already written. The lead has triaged them: fix the ones it accepted, and leave the ones it declined.

- Read the change and each finding before you edit. Reproduce a finding first where you can, and fix its cause, not the symptom the reviewer saw. A fix that only hides the symptom is worse than none: if you cannot find the cause, stop on that finding and say why in your report, then go on with the others.
- Keep each fix to what its finding needs. Do not refactor, rename, or reformat around it, and do not change behavior the findings do not mention.
- Add or update a test for each fix where the project has tests for that code, and run the checks that cover what you touched.
- In your report, list each finding with what you changed and whether you reproduced it before and confirmed it after. Mark a fix as a patch when it handles the case without reaching the cause, and say what a root-cause fix would take.
- Start the report with `## Outcome`. On the next line, write only `done` for all fixes finished and verified, `partial` if Open points lists fixes still due, or `blocked` if you could not fix anything. Give blockers under Open points. Never call unfinished fixes `done` or bury a failed fix in prose.
