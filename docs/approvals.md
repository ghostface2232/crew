# Approvals and worker questions

Crew brings worker approvals and user questions to the user. A worker can also ask the lead for a decision and keep working while it waits.

**Key files:** `plugin/bridge/mcp.ts`, `daemon.ts`, `jobs.ts`, `worker-mcp.ts`, and the Codex and Antigravity adapters in `plugin/bridge/adapters/`. See [sandbox.md](sandbox.md) for role permissions, [delivery.md](delivery.md) for wake-ups, and [daemon-api.md](daemon-api.md#authentication) for daemon authentication.

## Approval requests and user questions

Codex approval requests go first to its automatic reviewer (`codex.approvalsReviewer`, default `auto_review`). Anything it refuses twice, along with every user-bound request or question reaching Crew, goes to the user. The lead's only decision on an approval is to decline a clearly out-of-scope request with a reason (`reply` with `decision: "decline"` and `message`), which grants nothing and spares the user a prompt.

- While the lead blocks inside a job call (`wait`, or `background: false`), the MCP server sends `elicitation/create` so Claude shows its native input prompt and forwards the user's answer straight to the worker.
- For background jobs, the wake hook wakes the lead and the prompt appears when it calls `wait`. Answering first on the board or in the desktop app, or returning early from the call, withdraws the in-app prompt immediately.
- Multiple waiting jobs prompt sequentially and skip any settled on the board meanwhile. If the prompt is dismissed, unsupported, or fails to show, `wait` returns distinct guidance so the lead asks in chat.
- Antigravity permission requests follow [role policy](sandbox.md), so only an engineer's non-edit actions reach the user. agy ends a turn when a request is rejected, often before the worker has written anything, and a rejection carries no reason. So when the lead declines a request, or role policy refuses one (an editor's `ls`, say), and the turn ends with no report, Crew sends the reason as the next prompt and the turn goes on. A role refusal is sent back at most twice per turn, so a worker that keeps trying the same thing ends with the refusal in its notes. On macOS an engineer's commands in a worktree do not either, while the [confined server](sandbox.md#the-confined-server) is on and could start: Crew's sandbox holds them, so Crew allows them. Its questions arrive via `elicitation/create` form prompts (choices match by text or number, free text passes as written, and declining declines the form).

### Antigravity approvals

The user answers Antigravity approvals one at a time and sees the full request fields and workspace. Grants use only `allow_once`. Crew excludes `allow_always` and keeps sessions in `default` mode because `accept-edits` and `auto` skip per-edit path checks ([Antigravity's own settings](sandbox.md#antigravitys-own-settings)). Denials use `reject_once` when offered. Cancelling the job, ending the turn, or exiting the server cancels open requests.

### Allow for This Job

- *Codex plugin tools:* Requests matching `Allow <who> to use "<target>"?` (such as Computer Use per-app prompts) offer *Allow for This Job* (`allow_for_job`) beside Approve and Deny. The grant uses the MCP server and message as its only keys. It stays in memory for the rest of that job, including its sub-agents and follow-ups, and expires on daemon restart. A different app, server, or job needs its own grant. Matching queued and later requests auto-approve and log to job activity.
- *Antigravity commands:* Simple engineer commands that reach the user (on macOS, only those of a job outside the [confined server](sandbox.md#the-confined-server), such as one that edits the user's directory in place) offer *Allow for This Job*, keyed by program, its first argument, and the request's working directory (`running "<program> <subcommand>" in <directory>`, or `the job workspace` when the request names none). The first argument must be a plain word. Later arguments may vary unless they contain an absolute path or a `..` path component, so `npm test` covers `npm test --watch` but not `npm test --prefix=/other` or `npm run lint`.

  Only non-MCP `execute` requests qualify. The input may hold one command field, an optional working-directory field, and the two fields agy 1.5 sends beside them (`WaitMsBeforeAsync`, `toolSummary`). agy runs each command as `cd <workspace> && <command>`, so a leading `cd` to a literal path supplies the working directory. A directory named by `cd` or a working-directory field must be absolute, with no `.` or `..` components or doubled slashes. Crew resolves it to a real directory when granting and matching, and shows the path as written. A symlink retargeted to a different directory prompts again.

  Shell operators (`;`, `&`, `|`, backticks, `<`, `>`, `()`, newlines), shell expansions (`$`, `~`, `{}`), leading variable assignments (`PATH=…`), directory-changing commands (`cd`, `pushd`, `popd`), shells, and programs that run another command (`sudo`, `env`, `xargs`, `nohup`, `timeout`, `find`, `ssh`, `osascript`, and the like) never get a grant. A grant for a command that runs workspace files (`npm test`, `make build`, `node script.js`) also covers what the worker later writes into them, since workspace edits need no approval. Windows gets no command grants, since the checks model a POSIX shell.

  Grants live in memory for the job and its follow-up turns. When the agy server restarts after being idle, it loses the grants and the user is asked again. Crew still answers each call with `allow_once`, so role policy checks every request. Read-only jobs get none.

### Automatic reviewer and refusals

Set `{"codex": {"approvalsReviewer": "user"}}` in `~/.crew/config.json` to send all Codex approvals straight to the user.

When `auto_review` denies or times out (`item/autoApprovalReview/completed`), the bridge records action fields (program/arguments, `cwd`, and MCP input recovered from the started item by `targetItemId`), omits environment fields, and caps free-form input at 4,000 characters, reasons at 2,000, and descriptions at 8,000. Missing reasons are labeled missing, and the bridge quotes generic messages as received. The lead checks whether the user's conversation request covers the refused action.

1. If it does, the lead calls `reply` with `approved_by_user` quoting the user's words. The bridge sends the user's recent recorded prompts plus the quote for one more automatic review. The lead session's hooks record those prompts, in Claude Code and in Codex; a Codex sub-agent's task and Crew's own queued note are not recorded as the user's (`claude.ts`).
2. If refused again on that retry turn, the same call runs the next turn with `approvalsReviewer: user` so the user decides, then returns to `auto_review` on later turns. “Again” means the preceding turn was itself a retry. An unrelated later refusal starts over with `auto_review`.
3. If the user's request does not cover it, the lead asks the user.

## Questions to the lead

Each job receives a small per-job MCP server (`plugin/bridge/worker-mcp.ts`) with six tools and an optional peer rating tool.

| Tool | Does |
| --- | --- |
| `ask_lead` | Records a question (optional `blocks` and evidence `attachments`, max 20 questions per job) and returns at once so the worker keeps going |
| `lead_answers` | Returns newly arrived answers and open questions, waiting up to 600 seconds (`wait_seconds`) |
| `browser` | Starts a sandboxed headless Playwright server outside the worker's sandbox on macOS and returns its WebSocket endpoint |
| `siblings` | Lists other unfinished jobs in the same mission or project |
| `search` | Runs `git grep` inside the job's working tree (for workers that cannot run commands) |
| `recent_changes` | Shows the last 5 commits and latest diff for a path inside the working tree |
| `rate` | Offered only when `CREW_JOB_RATES` is set (`review` or `delegate`); submits the worker's peer rating ([peer ratings](roles.md#peer-ratings)) |

The worker waits in requests of at most two minutes against a single deadline. Each request includes the number of answers already shown so an answer arriving between requests wakes the worker even when another question remains open.

A new `ask_lead` question wakes the lead while the worker keeps running. The lead responds with `answer`, a separate tool from the flow for user approvals and user questions.

| Request | Body | From |
| --- | --- | --- |
| `POST /api/jobs/:id/questions` | `{ text, blocks?, attachments?, token }` | Worker MCP server |
| `GET /api/jobs/:id/questions?token=&wait=&answered=` | | Worker MCP server |
| `GET /api/jobs/:id/siblings?token=` | | Worker MCP server |
| `POST /api/jobs/:id/browser` | `{ token }` | Worker MCP server |
| `POST /api/jobs/:id/questions/:questionId` | `{ answer, attachments? }` | Lead |

The worker MCP server also calls `POST /api/jobs/:id/rating`. See the [endpoint table](daemon-api.md#endpoints) for its request body. The job's in-memory token is passed via an environment variable and never written to disk or sent to boards. Codex registers the server with `default_tools_approval_mode = "approve"` so `approvalPolicy: "never"` jobs can call it.

## Not verified

- Live restoration of an Antigravity session with the worker MCP server.
- A live `ask_lead` call from a Codex sub-agent thread.

## Tests

`test/codex-refusals.test.ts`, `test/antigravity.test.ts`, `test/mcp.test.ts`, and `test/questions.test.ts`.

Verified via `codex app-server` that `auto_review` approves a user-requested external deletion when the thread prompt authorizes it. The `denied` paths are covered by stub-server tests.

The worker MCP server was verified on Codex CLI 0.167.0 (read-only and writable jobs) and Antigravity CLI 1.5.5 (`polish` via ACP `mcpServers`).

## History

- 2026-11-12–13: `auto_review` became the default.
- 2026-11-11: Approvals moved to the user. Live testing showed that Antigravity's `accept-edits` skipped workspace bounds, so Crew reverted to default mode.
