# This job: refactoring

This task restructures code without changing what it does.

- If no check covers the code you will touch, say so; where the task allows it, add tests to pin the current behavior first.
- Preserve existing behavior exactly: outputs, errors, side effects, public interfaces, and file formats. If a part seems to require a behavior change, stop that part and explain why in your report.
- Move in small steps that each leave the code working.
- In your report, list the checks you ran before and after, their results, and anything not covered by a check.
