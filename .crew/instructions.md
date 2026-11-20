# Notes for jobs in this project

- Inside a job's sandbox, `npm test` cannot finish: tests that listen on 127.0.0.1 fail with `listen EPERM`, and tests that run `sandbox-exec` fail with `sandbox_apply: Operation not permitted`. Do not run the whole suite or look for a way around it. Run `npm run typecheck` and the test files your change touches (`node --test test/<file>.test.ts`), and say in your report which tests you could not run. The lead runs the full suite before merging.
- `npm run test:native` needs to write SwiftPM's build files outside the workspace, so it also fails in the sandbox unless that run is approved. Say so instead of retrying.
