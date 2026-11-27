# Daemon API

The Crew daemon provides HTTP routes and server-sent events for the React board, native macOS app, Windows app, lead MCP server, CLI, hooks, and worker MCP server. It authenticates clients and limits which routes each credential can use.

**Key files:** `plugin/bridge/daemon.ts`, `auth.ts`, `client.ts`, `worker-mcp.ts`, `plugin/board/src/`, and `native/Sources/Crew/`. See [architecture.md](architecture.md) for the process model and [jobs.md](jobs.md), [missions.md](missions.md), [roles.md](roles.md), and [usage-and-presets.md](usage-and-presets.md) for the behavior behind state and routes.

## State and events

`GET /api/state` and the initial `state` frame of `GET /api/stream` include these fields (optional for compatibility with older daemons):

| Field | Type | Meaning |
| --- | --- | --- |
| `usage` | `Usage` (`usage.ts`) | AgentGauge's latest classified reading for Claude, Codex, and Antigravity (supplemented by live Codex limits) |
| `preset` | `PresetName \| null` (`config.ts`) | Global preset in effect |
| `presets` | `Record<PresetName, Preset>` | What each preset sets, for display |
| `roles` | `Record<Role, RoleAssignment>` | Resolved role assignments (inheritance applied) |
| `roleSettings` | `RoleSettings` | Raw role assignments as written in `config.json` (preserving inheritance) |
| `roleInfo` | `RoleInfo[]` | Role registry metadata in display order |
| `peerRatings` | `boolean` | Whether peer ratings are enabled |
| `progressCards` | `boolean` | Whether a lead's chat shows [progress cards](jobs.md#progress-card) |
| `turnTokenBudget` | `number \| "unlimited" \| null` | The user's token cap for every worker turn; null follows job difficulty ([token use](jobs.md#token-use)) |
| `language` | `"en" \| "ko" \| null` | Interface language of the board and the apps; `null` follows the system ([localization.md](localization.md#how-the-language-is-chosen)) |
| `modelScores` | `ModelScore[]` (`notes.ts`) | Per-model scores and item breakdowns |
| `pulls` | `PullWatch[]` (`pulls.ts`) | Watched pull requests linked to missions (without internal delivery fields) |
| `leadHooks` | `{ compactedAt?: number } \| undefined` | Only with `?lead_session=<id>`: whether the daemon has heard that lead session's hooks, and when it last compacted (the lead's status footer uses it) |

A stream whose reader has stopped (a frozen tab, a suspended app) is dropped once more than 8 MiB has waited for it at two 25-second pings running, so its frames do not pile up in the daemon; the client reconnects and gets the whole state again. One ping is not enough to tell: the first frame is the whole state, which can pass that size while a reader that keeps up is still receiving it.

Server-sent events on `GET /api/stream` (in addition to `job`, `mission`, `event`, `claude`, `limits`, and `desktopLease`):

| Event | Data | Sent when |
| --- | --- | --- |
| `usage` | `Usage` | AgentGauge's cache changes, a live Codex limit updates, a limit error is reported, or status changes with time |
| `preset` | `{ preset, presets }` | `config.json` changes or `POST /api/preset` saves |
| `roles` / `roleSettings` | `Record<Role, RoleAssignment>` / `RoleSettings` | `config.json` changes or `POST /api/roles` saves |
| `agents` | `Agents` (`board/src/types.ts`) | `agy models` answers with this account's Antigravity models ([model settings](roles.md#model-and-effort-settings)) |
| `peerRatings` | `boolean` | `config.json` changes or `POST /api/peer-ratings` saves (followed by `modelScores`) |
| `progressCards` | `boolean` | `config.json` changes or `POST /api/progress-cards` saves |
| `turnTokenBudget` | `number \| "unlimited" \| null` | `config.json` changes or `POST /api/turn-token-budget` saves |
| `language` | `{ language }` | `config.json` changes or `POST /api/language` saves |
| `modelScores` | `ModelScore[]` | Notes, peer ratings, or the `peerRatings` switch change |
| `pull` | `PullWatch` (view) | A watched pull request is linked, changes, or is polled |

Jobs also carry `rounds?: Round[]`, `ask?: boolean`, `role?: Role`, `preset?: PresetName | null`, and `difficulty?: 'routine' | 'standard' | 'hard'` (`jobs.ts`). Missions carry `lead?: 'claude' | 'codex'`, `notes?: MissionNote[]`, `preset?: PresetName`, `tasks?: MissionTask[]`, and `difficulty?` (`missions.ts`).

Each status event has the shape `{seq, ts, agent, session_id, job_id, project, kind, detail}`, where `project` is the job's or session's project at the time it was recorded (omitted on events written before this field was added). Its `kind` is `started`, `progress`, `waiting`, `error`, `limit`, `stalled`, `done`, or `cancelled`.

## Endpoints

| Request | Body | Result |
| --- | --- | --- |
| `GET /api/usage` | | `Usage` |
| `GET /api/route?kind=<role>\|lead&mission=<id>` | | `RouteDecision`, plus `preset` and `policy` (the mission's preset or global preset). `mission` is optional; an unknown id is refused |
| `GET /api/missions/:id/runbook` | | `{ text }`; Markdown runbook for `crew export` |
| `GET /api/notes?agents=&evidence=` | | `{ scores, text }`; model scores and rendered summaries/lines for the lead |
| `POST /api/gc` | `{ "apply": false, "branches": false }` (both optional) | `{ text }`; user secret required; dry run unless `apply`; branches deleted only with both flags |
| `POST /api/preset` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | `{ preset, presets }`; writes `preset` in `~/.crew/config.json` |
| `POST /api/peer-ratings` | `{ "enabled": true \| false }` | `{ peerRatings }`; writes `peerRatings: false` or removes the key to turn on |
| `POST /api/progress-cards` | `{ "enabled": true \| false }` | `{ progressCards }`; writes `progressCards: false` or removes the key to turn on |
| `POST /api/turn-token-budget` | `{ "budget": tokens \| "unlimited" \| null }` | `{ turnTokenBudget }`; tokens are one of `TURN_TOKEN_CHOICES` (1M to 100M), and null removes the key to follow job difficulty |
| `POST /api/language` | `{ "language": "en" \| "ko" \| null }` | `{ language }`; writes `language` in `~/.crew/config.json`, or removes it (`null`) to follow the system |
| `POST /api/notes` | Evidence line or `{ "model", "summary" }` | `ModelScore`; user secret required ([model notes](roles.md#model-notes-and-scores) and [peer ratings](roles.md#peer-ratings)). A build line may add `"difficulty"`, `"reviewed_by": [review job ids or model ids]`, and, when omitting `job`, `"mission"`. A job's line takes the job's `difficulty`, and a line without a job takes its mission's; passing a different value is refused. Each `reviewed_by` job id resolves to that review job's model, and the ids are kept as `reviewJobs`, with each review's agent as `reviewAgents`; a job id that matches no job, or names a non-review job, is refused |
| `POST /api/jobs/:id/rating` | `{ "correctness"?, "report"?, "findings"?, "fact", "token" }` | `{ kept }`. The worker MCP server must supply the job token, and only jobs asked to rate can use the route ([peer ratings](roles.md#peer-ratings)) |
| `POST /api/missions` | `{ "title", "project", "lead"?: "claude" \| "codex", "stages"?, "preset"?, "tasks"?, "difficulty"?, ... }` | New (or matching open) mission. `difficulty` can be set only here; `POST /api/missions/:id` refuses it |
| `POST /api/missions/:id` | `{ "note": "text" }` | Mission with note appended; refused if not active |
| `POST /api/missions/:id` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | Mission with preset set or cleared (`null`); refused if not active; applies to its next jobs |
| `POST /api/missions/:id/pulls` | `{ "pr": "<number or URL>" }` | `{ watch, resumed, summary }`; user secret required |
| `POST /api/roles` | `{ "roles": <raw table> }` | `{ roles, roleSettings }`: resolved and stored tables ([role assignments](roles.md#role-assignments)) |
| `POST /api/instructions` | `{ "append": "text", "project": path \| null }` | `{ file, text }`; appends a paragraph to shared instructions (`text` replaces instead) |
| `POST /api/jobs` | `{ "kind": "delegate", "ask": true, "task": "question", "cwd": path }` | Read-only question job whose report is the answer. Any job may add `"skills": [names]` ([job instructions](jobs.md)), and a non-question delegate job may add `"difficulty": "routine" \| "standard" \| "hard"` |
| `POST /api/jobs/:id/rounds/:turn` | `{ "undo": true }` or `{ "keep": true }` | Updated job; `undo` reverts that round's commit on the job branch, `keep` reverts the revert |
| `GET /api/jobs/:id` | | The job as sent in state and job events, including sealed evidence and `outcomeContradiction` when applicable. The detail response also includes the original `prompt` and worker `instructions` |
| `GET /api/jobs/:id/diff` | | `{ turn, diff, at }`: the running turn's changes so far, as Codex last reported them (`turn/diff/updated`), cut at 200,000 characters; `diff` is empty once the turn ends or when none was reported. The job's `liveDiff` says when it last changed |

See [jobs.md](jobs.md) for round changes and question jobs, and [approvals.md](approvals.md#questions-to-the-lead) for worker question and tool routes.

## Issue suggestions

`GET /api/issues?project=<path>` accepts a project already known to the daemon and returns `{ project, repo, issues, checkedAt, error? }`. An unknown project gets HTTP 400. `repo` is the GitHub `owner/name`, or `null` when unavailable. `checkedAt` is the time of the check in epoch milliseconds. A failed lookup returns an empty list and a short error.

The daemon checks up to 50 open issues in the project's repository. It returns up to ten, starting with issues assigned to the signed-in GitHub CLI user, then issues with no assignees. Each group is sorted by most recent update. Each issue contains `number`, `title` (up to 200 characters), `url`, `assignees` (logins), `labels` (names), and `updatedAt` (GitHub's timestamp). Successes and failures are cached per project for ten minutes. Adding `&refresh=1` permits one check per minute.

`POST /api/issues/dismiss` accepts `{ "url": "https://github.com/owner/name/issues/123" }` from the board or a user-secret client and returns `{ "ok": true }`. GitHub Enterprise HTTPS issue URLs use the same path on their own host. The issue disappears from cached and future suggestions across projects. Crew atomically saves the newest 500 distinct dismissals in `~/.crew/issues.json`. If Crew cannot read this file, suggestions start with an empty dismissal list. Before saving the next dismissal, Crew sets the unreadable file aside as `issues.json.bad-<uuid>`. An invalid issue URL gets HTTP 400.

## Authentication

The daemon listens on localhost (`127.0.0.1`), which any local process can reach, including a `runs_app` worker whose sandbox allows network access. `Host` and `Origin` checks block web pages, so every API request also requires authentication.

The daemon that wins the port creates the master secret in `~/.crew/token` on first start. It has 64 hex characters, uses mode `0600`, and survives restarts. `~/.crew/token.version` (`2`) marks secrets created after ticket sign-in. Older secrets without it rotate once at the next start because pre-ticket cookies or URLs could have exposed them.

| Client | How it authenticates |
| --- | --- |
| Lead MCP server, CLI, and all Claude hooks (`report.ts`, `wake.ts`, `context.ts`) | `Authorization: Bearer <token>`, read from `~/.crew/token` |
| Native macOS app | Same header on HTTP requests and SSE stream |
| Web board in a browser | A scoped board credential held only in page memory and sent as `Authorization: Bearer`. `crew board` and the app's Open Web Board request a single-use ticket (`POST /api/session/ticket`) and open `http://127.0.0.1:<port>/#ticket=<ticket>`; the page strips the fragment and trades it at `POST /api/session` |
| Web board in the Windows Electron app | A board credential minted by Electron's main process from `~/.crew/token` and injected into requests; the renderer holds nothing |
| Worker MCP server | Its per-job in-memory token on worker routes only ([worker routes](approvals.md#questions-to-the-lead)) |

| Open without the secret | Why |
| --- | --- |
| `GET /`, board assets, `/fonts/*`, `/icons/*` | Static page assets needed before sign-in; hold no data |
| `GET /api/health` | Daemon discovery and version check (`version`, `build`, `root`, `pid`, `active`, and `partialEnv` when a Codex MCP server started it with a filtered environment); names no job |
| `POST /api/session` | Trades a one-minute, single-use ticket that only a secret holder can mint |
| `GET /api/jobs/:id/evidence/:file?sig=...` | `<img>`/`<video>` tags cannot send headers; requires that file's HMAC seal |
| Worker routes (`questions`, `siblings`, `browser`, `rating`) | Authenticated by the job's per-job token instead |

All other requests without valid credentials return `401` (`{ "error": "unauthorized" }`).

### Trust boundaries

- **No secret in browsers (no cookies, no web storage).** Workers can read most of the disk. Antigravity and Codex jobs using a permissions profile are denied access to `~/.crew/token`. Browser cookies are sent across ports on `127.0.0.1` (leaking to a `runs_app` worker's local server) and stored plaintext on disk. Web storage is also plaintext on disk. Any legacy `crew_session` cookie is ignored and cleared via `Set-Cookie: Max-Age=0`. Keeping the board credential in memory means a reload, bookmark, or 7-day expiry signs the browser tab out. Desktop apps retain their sign-in.
- **Tickets and credentials.** `POST /api/session/ticket` returns a 64-hex single-use ticket valid for 60 seconds in memory. `POST /api/session` trades it atomically for `board.<expiry>.<HMAC>`, valid for 7 days. Because the daemon uses an HMAC seal in place of storage, an open board reconnects across daemon restarts and stops working when it expires or the secret rotates (active SSE streams close at expiry).
- **Scoped board permissions.** A board credential may read and call only the 16 board routes (`BOARD_POSTS` in `daemon.ts`: `/api/jobs`, job `reply`/`cancel`/`rounds/:turn`, `/api/missions/:id`, `/api/instructions`, `/api/setup/repair`, `/api/setup/trust-hooks`, `/api/peer-ratings`, `/api/progress-cards`, `/api/preset`, `/api/language`, `/api/roles`, `/api/project-settings`, `/api/issues/dismiss`, `/api/turn-token-budget`). All other POSTs (tickets, hooks, lead routes, `answer`, `discard`, `gc`, heartbeat, starting missions, `notes`, `pulls`, `shutdown`) return `403`. Within allowed routes, `LEAD_FIELDS` (`approved_by_user`, `lead_session`, `lead`, `by`, `check`, `attachments`, `remember`, `summary`) also return `403`.
- **Evidence seals.** `sig` is an HMAC over `(job, file, modified)`, allowing access only to that recorded file version. The seal stops working if the file changes or the secret rotates.
- **Authenticated hooks and sandbox hardening.** `POST /api/hooks/claude` (Claude Code's hook payloads, and Codex's with `host: "codex"`) requires `~/.crew/token` because user prompt hooks are recorded and passed to Codex's automatic reviewer on refusal retries (a `runs_app` worker without the secret must not forge them). Codex profiles (`crew_read_only`, `crew_app`, `crew_workspace`) deny `~/.crew/token` and mark `.git` read-only so workers cannot repoint git filters/hooks that the bridge runs outside the sandbox. Antigravity policy refuses reading `~/.crew/token` and editing `.git`. Every Codex job runs under one of those three profiles ([sandbox.md](sandbox.md#role-permissions)). On macOS, the bridge's `sandbox-exec` profile for `browser` and `check` denies `lsopen`, `appleevent-send`, and `job-creation`.
- **Residual window.** `crew board --url` prints a live ticket into the calling session's transcript for up to 60 seconds until traded (`crew board` opens the browser directly without printing). If a worker with network access trades it first, the user's tab lands on the sign-in screen.

## Not verified

- A live Windows Electron run.
- A real browser profile/transcript attack.
- An older install beside a new one.

## Tests

`test/auth.test.ts`, `test/questions.test.ts`, and `test/evidence.test.ts`.

Verified against a real daemon (ticket race, spent/wrong tickets, cookie rejection, 403 on non-board routes and `LEAD_FIELDS`, sealed evidence, token rotation), Chromium, Electron 45.3.3 on macOS, macOS `sandbox-exec` (`open` fails with `-54` while Playwright runs), and a live `runs_app` Codex job that was denied access to `~/.crew/token`.

## History

See [architecture.md](architecture.md#history) for the dated bridge changes.
