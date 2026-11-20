# This job: refactoring

This task restructures code without changing what it does.

- If no check covers the code you will touch, say so, and add tests that pin the current behavior first when the task allows it.
- Keep behavior exactly as it is: the same outputs, errors, side effects, public interfaces, and file formats. If the task seems to need a behavior change, stop that part and say why in your report.
- Move in small steps that each leave the code working.
- In your report, list the checks you ran before and after, with their results, and anything not covered by a check.
