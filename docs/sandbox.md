# Sandbox

Crew limits what workers can read, write, and run on the user's machine. The bridge enforces sandbox settings and supplies per-job instructions for sharing the machine.

**Key files:** `plugin/bridge/daemon.ts`, `config.ts`, `prompts.ts`, `git.ts`, and `plugin/roles/machine.md`. See [jobs.md](jobs.md#worker-instructions) for worker instructions, [approvals.md](approvals.md) for approval policy, and [daemon-api.md](daemon-api.md) for daemon authentication.

## Role permissions

| Role | Codex | Antigravity |
| --- | --- | --- |
| `delegate` | Writes to the workspace under a permissions profile that denies `~/.crew/token` (see [scratch and read-only jobs](#scratch-and-read-only-jobs)). Approvals follow `codex.approvalPolicy` | Reads anywhere except `~/.crew/token`. Edits inside the worktree, excluding `.git`. On macOS a job in a worktree runs its commands without asking, inside [Crew's sandbox for the server](#the-confined-server). Elsewhere, and for a job that edits the user's directory in place, commands go to the user for approval. agy's own deletes, moves, and network requests always do, or are refused if input is missing |
| `review` | `read-only` sandbox (with writable scratch), never prompts. `runs_app` (`verify`) uses a writable snapshot worktree with `delegate` approvals ([app-running jobs](#jobs-that-run-the-app)). `mode: "standard"` uses Codex's built-in review | Reads only. Edits and commands are refused and noted. Because it cannot run git, the bridge writes a diff under `~/.crew/reviews/` per turn (deleted when the turn ends) and notes that no checks ran. Follow-ups regenerate the diff for the saved target. `mode: "standard"` falls back to adversarial review. Requires a git repo |
| `polish` | Writes to the workspace under the same profile as `delegate`. Edits outside `targets` are reported as out of scope | Reads anywhere except `~/.crew/token`. Edits inside the worktree, excluding `.git`. Everything else is refused |

**Claude workers** (under a Codex lead) run `claude -p --restricted` in the job's folder using `Read,Edit,Write,Glob,Grep,Bash,WebFetch,WebSearch` for writable jobs and `Read,Write,Glob,Grep,Bash,WebFetch,WebSearch` for read-only jobs. In a read-only job, Crew allows `Write` only in the evidence directory. Only a hard delegate job also receives `Agent`; with `Agent` enabled, Claude Code serves `WebFetch` through its `web-fetch` subagent rather than as a direct tool (Claude Code 2.1.331). The only MCP server is Crew's worker server (`--strict-mcp-config`). Restricted mode ignores the user's, project's and local settings, so no plugin or hook loads. Claude Code itself refuses a file tool's write outside the folder and runs read-only commands such as `git status` without asking. A writable job runs in Claude Code's automatic mode, so its classifier, not the user, approves other commands, and nothing but that judgment keeps such a command inside the folder or out of `.git` (a branch it moves is caught when the next turn starts); a read-only job stays in the manual mode ([approvals](approvals.md#claude-worker-approvals)). The job's evidence directory, which holds the lead's attachments and the worker's screenshots, is added with `--add-dir`, so the file tools reach it, and Crew allows writes there in any job. Crew allows writes inside the folder in a writable job and brings every other request that reaches it to the user. Crew refuses a file tool's relative path, which Claude Code would resolve against the folder. No OS sandbox confines a command on either platform, so a command could read the daemon token, which a Codex worker cannot. The MCP config, which holds the job's token, is passed as a file only the user can read. The variables a Claude Code session sets for its children (`CLAUDECODE`, its session id, desktop socket and effort) are removed, since a daemon that session started keeps them.

Antigravity's column applies to actions agy asks about. What agy runs without asking depends on the user's Antigravity settings; see [Antigravity's own settings](#antigravitys-own-settings). On macOS the [confined server](#the-confined-server) holds those actions to the same files whatever the settings say.

Every writable Codex job runs under a permissions profile (`crew_workspace`, or `crew_app` with `runs_app`), never bare `workspace-write` mode, which cannot deny a single file. A job that could read the token would not need network access to use it: it could leave a copy in its worktree for the lead's `check`, which reaches local ports (see [daemon-api.md](daemon-api.md)).

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

For files needed across turns, use `work/` inside the job's evidence directory. Only top-level images and videos appear as evidence. Antigravity jobs share a server process (two on macOS, one of them [confined](#the-confined-server)), with no per-job environment, scratch directory, or `work/` folder. Its reviewers read the saved diff file under the [role permissions](#role-permissions) above.

See [worktree includes and shared links](jobs.md#worktree-includes-and-shared-links) for link and target permissions and [cleanup and garbage collection](jobs.md#cleanup-and-garbage-collection) for detaching links before recursive removal.

Instructions state upfront what the worker can run, and reviewers mark findings as reproduced, read, or suspected.

## Sharing the machine

The user and all agents share one machine (requirement R14).

- **Isolated instances.** Every worker job that may start the app receives `plugin/roles/machine.md`; one that runs commands but starts nothing is told to run only commands that end by themselves (see [worker instructions](jobs.md#worker-instructions)). Workers start isolated copies on free ports with temp data/browser profiles, use headless browsers only, never touch the user's running instances or default ports, and clean up only what they started. Only the lead uses Claude Desktop's browser pane.
- **Parallel reviews, one app.** In `/crew:run`, the lead runs one review (self or cross) at substantial stopping points and reviews uncovered commits before push/PR (both in parallel for security, concurrency, or data loss), leaving the working tree untouched until all report. Worker reviews default to static (`read-only`). Only one reviewer runs the app (`runs_app` cross-review or self-review, never both).
- **Measurement alone.** `delegate` with `exclusive: true` runs alone across all sessions and projects (disallowed on review and polish). Starts and follow-ups fail with blocking job details while an exclusive job is active (or if any job is active when starting one). The bridge cannot hold back the lead's own measurements, subagents, or outside processes, so `/crew:run` tells the lead to wait until the machine is idle.

The bridge enforces exclusivity, network access, review snapshots, and token denial for Codex jobs. Instructions enforce instance isolation, static reviews, and the rule that only one reviewer runs the app.

## Antigravity's own settings

Crew enforces Antigravity's role permissions by answering `session/request_permission`. It never changes Antigravity's settings. So it sees an action in advance only when agy asks about it. agy asks before edits and commands only in its `default` mode, and even there it runs commands covered by the user's own allow rules without asking.

| Action (agy 1.5.14, measured 2026-11-22) | `default` | `accept-edits` | `auto` |
| --- | --- | --- | --- |
| Edit inside the workspace | Asks | Runs | Runs |
| Edit outside the workspace or in `.git` | Asks | Runs | Runs |
| Read outside the workspace, temp folder | Runs | Runs | Runs |
| Read outside the workspace, dot folder in home (where `~/.crew/token` lives) | Asks | Asks | Runs |
| Command covered by one of the user's Antigravity allow rules | Runs | Runs | Runs |
| Any other command, including writes outside the workspace and network access | Asks | Asks | Runs |

These results were measured with Non-Workspace Access set to allow and the user's allow rules in place.

- **Mode.** Crew keeps every session in `default`. It records the mode agy reports for each session, from `session/new`, a restore, an option change, and every `current_mode_update` or options update (between turns and during a restore too). A response's mode gives way to a report that came in while the request was out, unless the response names a mode that does not ask. Before every prompt and every message added to a turn, Crew switches a session that is in another mode back to `default`, and checks again if agy reports another switch meanwhile. A turn is taken before that check, so a cancel or a second message meanwhile sends no prompt. If agy refuses, the job fails. During a turn, Crew undoes a switch at once, and the turn's outcome waits for that: a refusal fails the job even when the turn ended first. It also refuses the agent's own `switch_mode`. While agy 1.5.14 started ACP sessions in `default` even when the saved Agent Mode was `auto`, its default for other sessions became Auto in 1.5.7, so Crew checks the mode instead of assuming it. Crew does not offer Auto as an option because the role table above does not survive it.
- **Actions that ran without asking.** These are commands covered by the user's allow rules and reads permitted by Non-Workspace Access. Crew sees them only once agy reports them `completed`, then checks them against the role (`unasked` in `adapters/antigravity.ts`). It skips calls that came to it as a permission request and calls that end `failed`, which may never have run. On Windows agy names files natively when a call starts or asks, but as URL paths (`/C:/Users/...`) when it reports one `completed`; Crew reads each path in native form first (`localPath`), or an edit inside the worktree would be judged outside it and stop the turn. The files a completed call wrote are taken from everything agy reported about it, since the completion may carry only its status, and the token file is matched without regard to case on Windows, as the file system matches it.
  - An engineer's command is permitted by the user's own rule, so Crew notes it in the result and lets the turn continue.
  - An edit, delete, move, or command outside the role stops the turn, and so does any read of `~/.crew/token`. Examples: a command in a reviewer's, editor's, or read-only job, or an edit outside the workspace. The job fails at once and reports what ran and which setting to narrow, or which mode let it through if the action started while the session was switched out of `default`. Crew sends the cancel immediately. If agy has not stopped after 5 seconds, Crew closes the session where supported. An outstanding mode or setup request can delay that close by up to 2 more seconds.
  - Crew notes other kinds outside the role. If a violation completes during the user's cancel, Crew notes it and a successful cancel leaves the job cancelled. If agy ignores the cancel and the session cannot be closed, the violation fails the job.
  - By then, the action has already run. This check reports it and stops the rest of the turn; it does not prevent the action itself.
- **Not used.**
  - `agy` with `--settings` before `acp`: deny rules, `toolPermission: "strict"`, `allowNonWorkspaceAccess: false`, and `agentMode` passed this way did not change an ACP session. `agy acp` itself rejects `--settings`.
  - `agy acp --sandbox`: blocked command writes even inside the workspace, while leaving network access open. It would break engineers' commands without blocking pushes.

## The confined server

On macOS Crew starts a second `agy acp` server inside a sandbox of its own (`serverProfile` in `adapters/antigravity.ts`, run with `sandbox-exec`), and with it every command that server runs. The sandbox is there so that a command cannot write outside the job's own ground or get code run outside the sandbox, which is what lets Crew stop asking about commands. It is not a wall against a command set on reading and sending things out, and its rules are kept few so that ordinary work is not refused. A new job goes to it when its files are Crew's to hold: a job in a worktree, and every read-only job (`confines`). A job that edits the user's directory (`isolation: "in_place"`) keeps the server without the sandbox, as every job does on Windows. So does a job whose worktree has the older layout, with the worktree in the job's own folder. `"antigravity": {"sandbox": false}` in `~/.crew/config.json` turns the confined server off at the next daemon start.

| Inside the sandbox | |
| --- | --- |
| Writable | `~/.crew/worktrees`, `~/.crew/evidence`, the user's temp directory and `/tmp`, and the server's own state in `~/.gemini/antigravity-crew` |
| Read-only | Everything else: the rest of `~/.crew` even when it sits in a temp directory, a worktree's `.git` pointer, the folders above a worktree (a renamed folder would bring a `.git` of its own), and the user's agy in `~/.gemini/antigravity-cli` |
| Unreadable | `~/.crew/token`, and `~/.ssh`, `~/.aws`, `~/.azure`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.git-credentials`, `~/.pypirc`, `~/.codex`, `~/.config/gh`, `~/.config/gcloud`, `~/.claude/.credentials.json` |
| Environment | The daemon's, without `SSH_AUTH_SOCK` and without variables whose names contain `KEY`, `SECRET`, `TOKEN`, `PASSWORD` or `CREDENTIAL` (`confinedEnv`), except agy's own sign-in (`GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`) |
| Network | Open, except the sockets of the SSH agent (launchd's and the one in the daemon's `SSH_AUTH_SOCK`) and of a container engine (`docker*.sock`, `podman*.sock`), which would run anything anywhere. The server needs the network to reach its model, and its commands share its sandbox |

Because the sandbox holds a command to those files, Crew answers an engineer's command request with `allow_once` instead of asking the user, provided the request names its command. This is as far as it matches Codex's `workspace-write`, and it is weaker in these ways:

- **Network.** A command can reach outside hosts, so it can send out anything it can read. The unreadable list and the trimmed environment narrow that; they are lists, not a wall.
- **Keychain.** agy reads its own sign-in from the keychain, so the keychain service stays reachable. A helper that hands out a stored secret without a prompt, such as `git credential-osxkeychain`, does so inside the sandbox too.
- **Other local services.** Any other socket or local port is reachable, and whatever listens there acts with its own rights.
- **Temp directories.** They are shared with everything else on the machine, so a project kept under one is writable, its `.git` included. Keep such a project elsewhere, or turn the confined server off.
- **One server for every job.** A command can write another job's worktree. agy's own edit tool cannot: Crew still refuses an edit outside the job's workspace.
- **agy's other tools.** Deletes, moves and network requests that agy makes itself, and plugin tools, still go to the user. In practice agy deletes and moves with `rm` and `mv`, which are commands.

The sandbox also holds agy's own edits, in any mode: an edit outside the writable folders fails even if agy does not ask about it. The mode and unasked-action checks above are unchanged, and a command that ran without asking is still reported.

The confined server keeps its sessions, settings and command script in `~/.gemini/antigravity-crew` (`--app-data-dir`, which agy takes only as a name under `~/.gemini`). The user's own agy, and the server outside the sandbox, run a script from `~/.gemini/antigravity-cli/bin` before each command and restore sessions from that folder, so a sandbox that could write there would reach outside itself. Two things follow:

- A job stays on the server that opened its session (`capabilities.confined` on the job), since the other server's store does not have it. A job started before the confined server existed continues outside it. A confined job cannot continue while that server is off or cannot start: a follow-up is refused with the reason.
- A confined job's session cannot be continued with `agy --conversation`: the CLI has no option for another state folder.

Crew cannot use agy's own terminal sandbox for this, or run agy's commands itself (agy 1.5.14, measured 2026-11-23):

- With `clientCapabilities.terminal` on, agy still ran `run_command` itself and sent no `terminal/create`.
- With `agy acp --sandbox`, a command could not write the session's workspace. The session's `cwd`, `additionalDirectories`, `--add-dir`, `accept-edits`, the server's own working directory, `--process-per-session`, and a `write_file(<workspace>/)` allow rule in a separate `--app-data-dir` all left it read-only; the server's log shows `workspaceDirs=[]`. Print mode (`agy -p --sandbox`) does write the workspace.
- `agy acp` does not take `--settings`, and `--app-data-dir` refuses an absolute path.

So the confined server starts agy with `--sandbox=false`: one sandbox cannot start inside another, and agy's would leave the workspace unwritable. Without read access to `~/Library/Keychains` every session failed with "Authentication required".

The confined server is prepared with the first job that needs it. If its folders cannot be made or no sandbox can start (a daemon that is itself sandboxed), such jobs run on the server that asks.

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

`runs_app` enables network access so the worker can bind local ports. A `runs_app` review (`verify`) runs in a writable snapshot worktree from `HEAD` (or the target commit) with [`.worktreeinclude` paths](jobs.md#worktree-includes-and-shared-links) attached. For uncommitted targets, and for an audit of files as they stand, Crew also copies uncommitted and untracked files; an audit's paths are then named from the snapshot's root, and one that Git ignores and `.worktreeinclude` does not list is refused before the job starts. Snapshots omit submodules and leave `skip-worktree` files as committed. They are deleted at turn end and regenerated on follow-ups.

`polish` and reviewers that cannot run commands refuse `runs_app`. On macOS, Codex's sandbox blocks Chromium's Mach service, so `crew.browser` starts a sandboxed Playwright server outside it. On Windows, Chromium starts inside Codex's sandbox.

## Sandboxed checks

The [base comparison](jobs.md#outcome-reporting) uses the same runner and permissions, with a detached checkout for the base and a fresh temp directory for the command.

On macOS and Windows, `check` reads anywhere except the daemon token, writes only to the worktree and its temp directory, and keeps `.git` read-only. Local servers remain reachable, outside network access requires `runs_app`, and the check times out after 10 minutes. On macOS the check's process group also carries a limit of its own, 30 seconds past the bridge's: a watchdog started in the check's shell kills the group, so a check does not outlive a daemon that was killed. On Windows a killed daemon takes its checks with it: Node holds a child it does not detach, here the PowerShell job host, in a job object that kills it when the daemon's handle closes, and the host's own job, nested in that one, ends everything in the check. On daemon shutdown, Crew kills each active check’s process group on macOS or terminates its PowerShell host on Windows. Terminating the host closes its Job Object and stops the processes inside it.

## Not verified

- Whether Antigravity follows isolation instructions.
- Antigravity actions that ran without asking were checked live only for a command covered by an allow rule (2026-11-22, agy 1.5.14). Edits, token reads, and mode switches are covered by protocol stubs.
- On the confined server: a long job, two jobs at once, a review or polish job, a server restarted after sitting idle, a job that writes evidence, a real container engine or SSH agent (the socket rules were tested on stand-ins), and whether agy needs to write anywhere else in the home folder. The live checks ran one engineer job at a time, for one or two short turns.
- What the keychain hands out inside the confined server. Only `security list-keychains` was run there (it succeeded); no stored secret was requested.
- Whether Codex's `standard` review honors injected instructions.
- Live plugin approvals reaching the bridge.

## Tests

Sandbox checks used Codex CLI 0.167.0, and were run again on 0.171.0 (below).

| Sandbox | Result |
| --- | --- |
| `read-only` | No project/temp writes, no listening ports, no outbound network (hence writable scratch for checks and snapshots for `runs_app` reviews) |
| `workspace-write` | Project and temp writes work. Binding `127.0.0.1` fails with `listen EPERM`, and outbound network access requires escalation |
| `workspace-write` + network (`runs_app`) | Binds local ports and reaches outside hosts without prompts. Home writes stay blocked. Headless Chrome failed inside the macOS sandbox (exit 134) and browser launch still needed approval. `kill` on the job's own server was refused, although an interrupt stopped it. `crew.browser` provides a sandboxed browser outside Codex's sandbox |

Verified on macOS with Codex CLI 0.167.0 (read-only reviews/questions writing to `$TMPDIR` while repo/home writes fail, and live writable jobs writing to scratch and worktree without prompts) and unit tests.

Re-verified on macOS with Codex CLI 0.171.0 on 2026-11-22. A script drove `CodexAdapter` with a dummy token under a temporary `CREW_HOME` for the four setups: read-only (`crew_read_only`), plain `workspace-write`, a plugin job (`crew_workspace`), and `runs_app` (`crew_app`). It also checked a follow-up resumed in a new app-server. Every result matched the table above. The token was denied wherever a profile applies and readable only under plain `workspace-write`. (Since 2026-11-24, no job runs under plain `workspace-write`; see History.) `.git` and everything under `~/.crew` except scratch and evidence stayed read-only in all four. `/tmp` was writable except in read-only jobs. Ports and outside network opened only with `runs_app`. Resumed threads kept the same profile, and 0.171.0 reported no warnings about the profiles or the overrides on resume. In the `runs_app` job the model itself declined to read the token file, so that read was checked with `codex sandbox` and the same profile instead. Windows was not re-run. Live shared links on APFS (where cloning succeeds) were tested via injected failures.

The confined server was checked live on 2026-11-23 (macOS 27, agy 1.5.14) with a daemon under a temporary `CREW_HOME`: a two-turn engineer job edited files, ran `ls`, a Node script that wrote a file, `rm … && mv …`, and a local HTTP server, and called `crew.siblings` and `crew.recent_changes`, with no approval request; `touch $HOME/…` and a write to the worktree's `.git` were refused; the follow-up restored the closed session. `test/antigravity.test.ts` runs the profile under `sandbox-exec`, including attempts to move a worktree, the folders above it and the state folder aside, and routes a worktree job and an in-place job through a stub server that reports whether it could write beside itself.

The Antigravity mode table above came from live ACP probes on 2026-11-22. The probes used agy 1.5.14, Crew's client capabilities, and scratch targets, approving each request once. A live Crew job then confirmed that an engineer's `git branch` under the user's allow rule is noted, while the same command in a read-only job stops the turn.

Related tests include `test/antigravity.test.ts`, `test/policy.test.ts`, `test/browser.test.ts`, and `test/worktrees.test.ts`. See [architecture.md](architecture.md#tests) for the live Windows `check` and out-of-workspace edit refusal checks.

## History

- 2026-11-24: Previously, a writable Codex job with no plugin, `runs_app`, or shared link used bare `workspace-write` mode and could read `~/.crew/token`, on the reasoning that it had no network access to use it with. A review pointed out how to bypass that: the worker can copy the token into its worktree, and the lead's `check`, which reaches local ports, runs the worker's code with that copy in reach. Every writable Codex job now runs under a profile: `crew_workspace`, which plugin jobs already ran under, or `crew_app` with `runs_app`. Not re-run live on Windows.
- 2026-11-24: Antigravity paths in URL form (`/C:/...`) are read as native Windows paths. Seen with two polish jobs whose edits to their own targets were reported as out of scope; an unasked edit reported that way would also have stopped its turn. The token guard also stopped telling paths apart by case on Windows.
- 2026-11-23: An Antigravity engineer's commands no longer ask on macOS. The plan was to match Codex by having Crew run agy's commands in its own sandbox, or by auto-approving agy's delete and move requests; probes of agy 1.5.14 ruled both out (it ignores ACP's terminal capability, and deletes and moves arrive as `rm` and `mv` commands), and agy's own terminal sandbox cannot write an ACP session's workspace. Crew now runs the `agy acp` server itself inside a Seatbelt profile and allows an engineer's commands there. The network stays open and one server still serves every job, which the user accepted; a server per job was left out for its start-up cost. Two reviews of the first version found that a command could move a worktree aside and put a prepared one, with its own `.git`, in its place (reproduced through to the bridge's own `git` running a filter outside the sandbox), and that the confined server shared `bin/agentapi` and the session store with the user's agy. The profile now refuses writes to the folders above a worktree, and the confined server has a state folder of its own. A second round reproduced one more way out, a repository left inside the worktree whose `fsmonitor` the bridge's own `git diff` ran, closed in `git.ts` ([jobs.md](jobs.md#lead-tools)); it also led to the evidence folder being writable and the container sockets closed. Left as they are, on purpose: the temp directories and other local sockets stay open, the confined server's own settings stay writable, and a state folder that is itself a link is not checked for, since closing each would refuse ordinary work or add rules that break with agy's next version. Two findings predate this change and apply to every agent, so they are not part of it: a filter the user's repository already configures can run a script from the worktree when the bridge commits, and a `check` inherits the daemon's environment.
- 2026-11-23: The macOS watchdog was meant to get a Windows half, a limit on the job host's wait. On Windows 11 with Codex CLI 0.170.0, killing a daemon stand-in, started attached or detached, ended its check within 6 ms with nothing left running, because of Node's job object, so the host got no limit of its own. `test/jobs.test.ts` keeps this on Windows.
- 2026-11-22: Re-ran the Codex sandbox checks on Codex CLI 0.171.0 (macOS), after Codex reworked permission profiles and resume-time override checks in 0.168–0.171. Nothing changed.
- 2026-11-22: Probes of agy 1.5.14 found two gaps. Actions covered by the user's Antigravity allow rules or Non-Workspace Access never trigger a permission request in any mode, and `auto` and `accept-edits` skip every edit check. Crew now pins sessions to `default`, checks actions that ran without asking against the role, and stops the turn on a violation. A per-job Auto option was considered and dropped because `auto` also skipped the edit, `.git`, token-folder, and network checks.
- 2026-11-16: Windows bridge parity verified on Windows 11 with Codex CLI 0.166.0 and Git for Windows 2.53. Sandboxed `check` runs Git for Windows' `sh` inside `codex sandbox` under a PowerShell 5.1 kill-on-close job object with a stdin-secret status line because Codex waits on open pipes and sandboxed processes can kill their parent. `crew.browser` stayed macOS-only because Chromium starts inside Codex's Windows sandbox.
- 2026-11-14: Added the `codex.plugins` default `["browser"]` and the plugin token-denial profile.
- 2026-11-12–13: Added shared-machine rules, `runs_app` snapshots, and `exclusive` jobs.
