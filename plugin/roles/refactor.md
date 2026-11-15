# This job: refactoring

This task restructures code without changing what it does.

- Before you change anything, run the checks that cover the code you will touch and record what passes. If nothing covers it, say so, and add tests that pin the current behavior first when the task allows it.
- Keep behavior exactly as it is: the same outputs, errors, side effects, public interfaces, and file formats. If the task seems to need a behavior change, stop that part and say why in your report.
- Move in small steps that each leave the code working, and run the checks again at the end.
- In your report, list the checks you ran before and after, with their results, and anything not covered by a check.
