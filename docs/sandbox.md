# Sandbox

Crew limits what workers can read, write, and run on the user's machine. The bridge enforces sandbox settings and supplies per-job instructions for sharing the machine.

**Key files:** `plugin/bridge/daemon.ts`, `config.ts`, `prompts.ts`, `git.ts`, and `plugin/roles/machine.md`. See [jobs.md](jobs.md#worker-instructions) for worker instructions, [approvals.md](approvals.md) for approval policy, and [daemon-api.md](daemon-api.md) for daemon authentication.

## Role permissions

| Role | Codex | Antigravity |
| --- | --- | --- |
| `delegate` | `workspace-write` sandbox. Approvals follow `codex.approvalPolicy`. Token denial requires a permissions profile (see [scratch and read-only jobs](#scratch-and-read-only-jobs)) | Reads anywhere except `~/.crew/token`. Edits inside the worktree, excluding `.git`. Commands, deletes, moves, and network requests go to the user for approval, or are refused if input is missing |
| `review` | `read-only` sandbox (with writable scratch), never prompts. `runs_app` (`verify`) uses a writable snapshot worktree with `delegate` approvals ([app-running jobs](#jobs-that-run-the-app)). `mode: "standard"` uses Codex's built-in review | Reads only. Edits and commands are refused and noted. Because it cannot run git, the bridge writes a diff under `~/.crew/reviews/` per turn (deleted when the turn ends) and notes that no checks ran. Follow-ups regenerate the diff for the saved target. `mode: "standard"` falls back to adversarial review. Requires a git repo |
| `polish` | `workspace-write` sandbox. Edits outside `targets` are reported as out of scope. Token denial requires a permissions profile (see [scratch and read-only jobs](#scratch-and-read-only-jobs)) | Reads anywhere except `~/.crew/token`. Edits inside the worktree, excluding `.git`. Everything else is refused |

A writable Codex job with no enabled plugin, `runs_app`, or shared links uses plain `workspace-write` without a permissions profile. It can read the token but has no network to use it with (see [daemon-api.md](daemon-api.md)).

## Scratch and read-only jobs

Static reviews and questions run read-only, yet checks still write temp files and caches. Every Codex job—writable delegates, `runs_app` reviews, static reviews, and questions—gets a fresh per-turn scratch directory at `~/.crew/scratch/<job id>` with `TMPDIR`, `TMP`, and `TEMP` set via `shell_environment_policy.set`.

For read-only Codex jobs (`crew_read_only` profile):

| | |
| --- | --- |
| Writable | The scratch directory (and the job's evidence directory, when created). `TMPDIR`, `TMP`, and `TEMP` point to scratch |
| Readable | The whole disk, except `~/.crew/token` (denied) |
| Closed | The network, and listening on a port |
| Lifetime | Created at turn start, moved aside and deleted at turn end. Follow-up turns get a fresh empty directory |

Read-only jobs use a Codex permissions profile (`default_permissions`) because `read-only` sandbox mode cannot exempt one directory. Writable Codex jobs keep workspace and scratch access (`runs_app` reviews keep their writable snapshot and network access), while leaving the user's system temp directory out because on Windows Codex applies an inherited ACL to every file there, which can time out `thread/start` on large temp folders.

For files needed across turns, use `work/` inside the job's evidence directory. Only top-level images and videos appear as evidence. Antigravity shares one server process, with no per-job environment, scratch directory, or `work/` folder. Its reviewers read the saved diff file under the [role permissions](#role-permissions) above.

See [worktree includes and shared links](jobs.md#worktree-includes-and-shared-links) for link and target permissions and [cleanup and garbage collection](jobs.md#cleanup-and-garbage-collection) for detaching links before recursive removal.

Instructions state upfront what the worker can run, and reviewers mark findings as reproduced, read, or suspected.

## Sharing the machine

The user and all agents share one machine (requirement R14).

- **Isolated instances.** Every command-capable worker job receives `plugin/roles/machine.md` (see [worker instructions](jobs.md#worker-instructions)). Workers start isolated copies on free ports with temp data/browser profiles, use headless browsers only, never touch the user's running instances or default ports, and clean up only what they started. Only the lead uses Claude Desktop's browser pane.
- **Parallel reviews, one app.** In `/crew:run`, the lead runs one review (self or cross) at substantial stopping points and reviews uncovered commits before push/PR (both in parallel for security, concurrency, or data loss), leaving the working tree untouched until all report. Worker reviews default to static (`read-only`). Only one reviewer runs the app (`runs_app` cross-review or self-review, never both).
- **Measurement alone.** `delegate` with `exclusive: true` runs alone across all sessions and projects (disallowed on review and polish). Starts and follow-ups fail with blocking job details while an exclusive job is active (or if any job is active when starting one). The bridge cannot hold back the lead's own measurements, subagents, or outside processes, so `/crew:run` tells the lead to wait until the machine is idle.

The bridge enforces exclusivity, network access, review snapshots, and token denial for Codex jobs with a permissions profile. Instructions enforce instance isolation, static reviews, and the rule that only one reviewer runs the app.

## Codex plugins

Crew uses these Codex plugin defaults in `~/.crew/config.json`.

```json
{
  "codex": {
    "plugins": ["browser"],
    "appPlugins": ["computer-use", "unified-computer-use"]
  }
}
```

`codex.appPlugins` gives shared-screen access when `runs_app: true`. Eligible jobs (writable Codex delegates and `runs_app` reviews, excluding ask jobs, static reviews, polish, and other agents) receive the deduplicated union of `codex.plugins`, `appPlugins` (if `runs_app`), and per-job `plugins`. Missing or disabled defaults stay silent; only explicitly requested plugins emit notes.

On start or resume, Crew queries `plugin/installed`, enables matching installed-and-enabled plugins, disables other listed plugins by exact ID, and sets `plugins._default.enabled = false`. Threads with enabled plugins keep Codex's automatic skill catalog (Codex 0.167.0's `skills.include_instructions = false` hides plugin skills too), deny `~/.crew/token` via a permissions profile even without `runs_app` (network stays tied to `runs_app`), forward plugin approvals to the user, and append `PLUGIN_USER_APP` to `developerInstructions`. This lets workers use plugin tools for a specific action in the user's app only when the lead's task explicitly requests it; credentials, payments, messages, and settings are always excluded. Set `codex.plugins` to `[]` to run lean.

## Jobs that run the app

`runs_app` enables network access so the worker can bind local ports. A `runs_app` review (`verify`) runs in a writable snapshot worktree from `HEAD` (or the target commit) with [`.worktreeinclude` paths](jobs.md#worktree-includes-and-shared-links) attached. For uncommitted targets, Crew also copies uncommitted and untracked files. Snapshots omit submodules and leave `skip-worktree` files as committed. They are deleted at turn end and regenerated on follow-ups.

`polish` and reviewers that cannot run commands refuse `runs_app`. On macOS, Codex's sandbox blocks Chromium's Mach service, so `crew.browser` starts a sandboxed Playwright server outside it. On Windows, Chromium starts inside Codex's sandbox.

## Sandboxed checks

On macOS and Windows, `check` reads anywhere except the daemon token, writes only to the worktree and its temp directory, and keeps `.git` read-only. Local servers remain reachable, outside network access requires `runs_app`, and the check times out after 10 minutes.

## Not verified

- Whether Antigravity follows isolation instructions.
- Whether Codex's `standard` review honors injected instructions.
- Live plugin approvals reaching the bridge.

## Tests

Sandbox checks used Codex CLI 0.167.0.

| Sandbox | Result |
| --- | --- |
| `read-only` | No project/temp writes, no listening ports, no outbound network (hence writable scratch for checks and snapshots for `runs_app` reviews) |
| `workspace-write` | Project and temp writes work. Binding `127.0.0.1` fails with `listen EPERM`, and outbound network access requires escalation |
| `workspace-write` + network (`runs_app`) | Binds local ports and reaches outside hosts without prompts. Home writes stay blocked. Headless Chrome failed inside the macOS sandbox (exit 134) and browser launch still needed approval. `kill` on the job's own server was refused, although an interrupt stopped it. `crew.browser` provides a sandboxed browser outside Codex's sandbox |

Verified on macOS with Codex CLI 0.167.0 (read-only reviews/questions writing to `$TMPDIR` while repo/home writes fail, and live writable jobs writing to scratch and worktree without prompts) and unit tests. Live shared links on APFS (where cloning succeeds) were tested via injected failures.

Related tests include `test/policy.test.ts`, `test/browser.test.ts`, and `test/worktrees.test.ts`. See [architecture.md](architecture.md#tests) for the live Windows `check` and out-of-workspace edit refusal checks.

## History

- 2026-11-16: Windows bridge parity verified on Windows 11 with Codex CLI 0.166.0 and Git for Windows 2.53. Sandboxed `check` runs Git for Windows' `sh` inside `codex sandbox` under a PowerShell 5.1 kill-on-close job object with a stdin-secret status line because Codex waits on open pipes and sandboxed processes can kill their parent. `crew.browser` stayed macOS-only because Chromium starts inside Codex's Windows sandbox.
- 2026-11-14: Added the `codex.plugins` default `["browser"]` and the plugin token-denial profile.
- 2026-11-12–13: Added shared-machine rules, `runs_app` snapshots, and `exclusive` jobs.
