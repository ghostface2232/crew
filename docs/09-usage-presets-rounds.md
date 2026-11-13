# 09. Usage, presets, rounds, and intents

Written 2026-11-13. Delivers roadmap items C1 (AgentGauge, phase G1), A3 (presets), and the open parts of B2 (intent, per-round keep or undo, progress roll-up). This file is the contract between the daemon, the web board, and the native app; the types named here are in `plugin/bridge/`.

## 1. State and events

`GET /api/state` and the first frame of `GET /api/stream` gain three fields. All are optional to a client, because a daemon from an older install does not send them.

| Field | Type | Meaning |
| --- | --- | --- |
| `usage` | `Usage` (`usage.ts`) | AgentGauge's latest reading for Claude, Codex, and Antigravity, classified |
| `preset` | `PresetName \| null` (`config.ts`) | The preset in effect |
| `presets` | `Record<PresetName, Preset>` | What each preset sets, for display |

Server-sent events added to the stream:

| Event | Data | Sent when |
| --- | --- | --- |
| `usage` | `Usage` | AgentGauge's cache changes, a limit is reported, or a status changes with time |
| `preset` | `{ preset, presets }` | `config.json` changes |

Jobs gain `rounds?: Round[]` and `ask?: boolean` (`jobs.ts`); missions gain `notes?: MissionNote[]` (`missions.ts`). Both arrive through the existing `job` and `mission` events.

## 2. Endpoints

| Request | Body | Result |
| --- | --- | --- |
| `GET /api/usage` | | `Usage` |
| `GET /api/route?kind=delegate\|review\|polish\|lead` | | `RouteDecision` |
| `POST /api/preset` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | `{ preset, presets }`; writes `preset` in `~/.crew/config.json` |
| `POST /api/missions/:id` | `{ "note": "text" }` | The mission, with the note appended. Refused for a mission that is not active |
| `POST /api/instructions` | `{ "append": "text", "project": path \| null }` | `{ file, text }`; adds the text as a new paragraph to the shared instructions |
| `POST /api/jobs` | `{ "kind": "delegate", "ask": true, "task": "question", "cwd": path }` | A read-only job whose report is the answer. Any job may add `"skills": [names]` (section 14) |
| `POST /api/jobs/:id/rounds/:turn` | `{ "undo": true }` or `{ "keep": true }` | The job. `undo` reverts that round's commit on the job branch; `keep` reverts the revert |

A round can be undone or kept only while the job is not running or waiting, its worktree still exists as its own directory on the job branch, and the revert applies cleanly; otherwise the request fails with the reason and nothing changes. Round states are replayed from the reverts on the branch before each change, so one made just before the daemon stopped is not lost.

A question job is read-only for both agents: Codex runs it with no approval prompts and the bridge declines any request to write, and Antigravity's edits and commands are refused.

## 3. Usage status

| Status | Means |
| --- | --- |
| `ok` | Room to spare |
| `tight` | At the recent pace the window runs out before it resets, or little is left |
| `exhausted` | Nothing left, or a job just failed on this agent's usage limit |
| `stale` | AgentGauge's reading is too old to act on |
| `unknown` | No reading: AgentGauge is not installed, or its file has a format this version does not know |

A provider's status is that of its tightest account-wide window. Windows scoped to one model (`group` set) are listed with their own status and do not decide the provider's status. A provider that reports only per-model windows (Antigravity) is judged by the family of its configured model, matched by name. With no model configured, or none that matches, it is judged by its tightest family, because a job does not switch models on its own.

On the board, a provider that is stale, unknown, or exhausted by a reported limit shows that status on its account-wide gauges instead of each window's own.

## 4. Intents on the board

The board's New Job form sends one of three intents:

| Intent | What the board calls |
| --- | --- |
| Command | `POST /api/jobs`, as before |
| Question | `POST /api/jobs` with `kind: "delegate"` and `ask: true` |
| Information | `POST /api/missions/:id` with `note` when a mission is chosen, else `POST /api/instructions` with `append` |

## 5. Progress roll-up

Each client computes progress from data it already has using the same rule, so the two boards agree:

- A done mission is 100%.
- Otherwise progress is `(stage index + share) / 7`. The stage index is the position of the mission's current stage among the seven stages, and `share` is how far along the current stage is.
- `share` is the mean of `0.5` across the mission's unfinished jobs, or `0.5` when it has none. Because every unfinished job currently has a weight of `0.5`, `share` is always `0.5` today; that per-job weight is the single place to update when jobs report finer progress.

## 6. Where usage comes from

| Source | Used for | Freshness |
| --- | --- | --- |
| AgentGauge's `usage-cache.json` | Every agent's windows | As AgentGauge polls: 3 to 10 minutes, stretching to 30 while the user is away |
| AgentGauge's `usage-history.db` | The last 90 minutes of samples per window, for the projection | Same |
| Codex's own rate limits (`account/rateLimits/*` on its app-server) | Codex, whenever newer than AgentGauge's reading | Live while a Codex job runs |
| A job failing on a usage limit | Marks that agent exhausted at once | Immediate; lifted by a later reading that shows room, or after 5 hours |

Both files are opened read-only; Crew holds no provider credentials and makes no provider request. Only the macOS cache format (version 1, checked against AgentGauge 0.8.2) is read. On other platforms, or when the version differs, every agent is `unknown` and the roles are followed as assigned.

A reading older than 45 minutes is `stale`. Stale and unknown readings never move work: routing then answers with the role's holder and says that usage is not known.

Open, as in [03-agentgauge-integration.md](03-agentgauge-integration.md): G2 (`--json` output) and G3 (activity signal and threshold hook) are work in the AgentGauge repository. Until G3, AgentGauge slows its polling exactly when agents work unattended, so Claude's usage in particular can go stale; Codex is covered by its own channel, and Claude and Antigravity by limit failures.

## 7. Routing

`route` (the lead's tool, and `GET /api/route`) follows section 8.2 of document 03. It answers only with the role's holder or the lead.

| Kind | Holder tight | Holder exhausted |
| --- | --- | --- |
| `delegate` | The lead implements, unless the lead is short too | The lead implements |
| `review` | Still the holder, one round | The lead repeats its self-review; `degraded` |
| `polish` | Deferred until the reset; the lead makes urgent wording fixes | Same |
| `lead` | Claude keeps to planning and merging | Hand off to Codex if it is the engineer and has room; `degraded` |

## 8. Presets

`preset` in `~/.crew/config.json` is `economy`, `balanced`, or `best`; absent by default. A setting on a role wins over the preset, and the preset over the agent's own configuration.

| Preset | Codex effort | Lead's subagents |
| --- | --- | --- |
| `economy` | low | haiku |
| `balanced` | medium | sonnet |
| `best` | high | the lead's own model |

The built-in presets name no worker models, because which models an account has differs. Add them under `presets`:

```json
{
  "preset": "best",
  "presets": { "best": { "codex": { "model": "gpt-6.1-sol" } } }
}
```

The lead is told the preset's subagent model in its session instructions, which are fixed when the session starts.

## 9. What a read-only job can write

A static review or a question runs read-only, and a check that only reads is rare: tests make temporary files, tools write caches. Each such job on Codex gets one directory of its own, `~/.crew/scratch/<job id>`, for the length of a turn.

| | |
| --- | --- |
| Writable | The scratch directory only. `TMPDIR` points to it |
| Readable | The whole disk, as before |
| Closed | The network, and listening on a port |
| Lifetime | Created when a turn starts and moved aside the moment it ends, then deleted; a follow-up turn gets a fresh, empty one |

It uses a Codex permissions profile (`default_permissions` with a `filesystem` table) passed in the thread's config instead of the `read-only` sandbox mode, which cannot exempt a single directory. Checked on 2026-11-13 with Codex CLI 0.167.0 and a real review on an isolated daemon: `mktemp -d`, Node's `mkdtemp`, and a `git clone` plus commit inside the scratch directory succeeded; writing to the repository and to the home directory was refused. Checked again on the same day with a real question after the instructions changed: `mktemp -d`, a `git clone` into `$TMPDIR`, and `node --test test/usage.test.ts` in the clone succeeded; `touch` in the repository and in the home directory was refused.

Antigravity runs no commands as a reviewer, so it gets no scratch directory and is handed the diff as before. A review started with `runs_app` already has a writable snapshot and is unchanged.

The job's instructions state upfront what it can run so it does not find out by failing, and the reviewer marks each finding as reproduced, read, or suspected.

## 10. Bringing a worker up to date

A worker's worktree starts from the lead's `HEAD` and does not follow it. `reply` with `sync: true` merges the lead's current `HEAD` into the worker's branch before the follow-up turn and moves the job's base to that commit, so the job's result still lists only the worker's own changes. A merge that conflicts is aborted: the reply fails with the conflicting files and no turn starts. While the merge runs, the job cannot be discarded and its rounds cannot be changed. Rounds are still replayed from the commit the job first started from, so an undo made before a sync is not lost.

A job whose worktree was discarded takes no further turn; ask a new question instead.

## 11. Questions from a worker to the lead

A worker that needs a decision or a fact only the lead has can ask without ending its turn. Each job is given a small MCP server (`plugin/bridge/worker-mcp.ts`) with three tools:

| Tool | Does |
| --- | --- |
| `ask_lead` | Records a question, with what it blocks, and returns at once; the worker carries on with what the answer does not affect |
| `lead_answers` | Returns the job's questions and their answers, waiting up to ten minutes when asked to |
| `siblings` | Lists the other unfinished jobs of the same mission or project |

The lead is woken by a new question as it is by a finished job, while the job keeps running. It answers with the `answer` tool and waits again. This is separate from approvals and from questions put to the user, which are unchanged.

| Request | Body | From |
| --- | --- | --- |
| `POST /api/jobs/:id/questions` | `{ text, blocks?, token }` | The job's worker |
| `GET /api/jobs/:id/questions?token=&wait=` | | The job's worker |
| `GET /api/jobs/:id/siblings?token=` | | The job's worker |
| `POST /api/jobs/:id/questions/:questionId` | `{ answer }` | The lead |

The worker routes require the job's token, which is created when the job starts, kept in memory only, and passed to the worker's MCP server in its environment. It is never saved to disk or sent to a board.

Checked on 2026-11-13 with Codex CLI 0.167.0 and real jobs on an isolated daemon, as a read-only question and as a writing job in a worktree: the worker asked, the lead's answer arrived through `lead_answers`, and a request with a wrong token was refused. Codex refuses an MCP tool call outright under approval policy `never`, so the server is registered with `default_tools_approval_mode = "approve"`; its tools only talk to the bridge.

Antigravity CLI 1.5.5 was checked the same way with a polish job: the server passed in ACP's `mcpServers` was started, the worker asked, and it used the lead's answer. Not exercised: restoring an Antigravity session that has the server, and a question from a Codex sub-agent thread.

## 12. Who may talk to the daemon

The daemon listens on a local port, which every process on the machine can reach. Checking `Host` and `Origin` keeps web pages out, but not a local process, such as a worker whose sandbox has the network open for `runs_app`. So every request carries a secret.

The secret is `~/.crew/token`: 64 hex characters, created by the daemon on first start, readable by the user alone, and kept across restarts.

| Client | How it presents the secret |
| --- | --- |
| The lead's MCP server, the CLI, the wake and context hooks | `Authorization: Bearer <token>`, read from the file |
| The native app | The same header, on requests and on the event stream |
| The web board | A cookie. The board is opened at `http://127.0.0.1:47615/#token=<token>`; the page posts the token to `POST /api/session`, which answers with an `HttpOnly`, `SameSite=Strict` cookie named `crew_session`, and removes the fragment from the address |
| A worker's MCP server | Its own per-job token, on the worker routes only (section 11) |

| Open without the secret | Why |
| --- | --- |
| `GET /`, the board's assets, fonts, icons | The page has to load before it can sign in; it holds no data |
| `GET /api/health` | Clients use it to find the daemon and compare versions; it names no job |
| `POST /api/hooks/claude` | Claude Code's HTTP hooks cannot read a file; the route only records session activity |
| `POST /api/session` | It is how the secret is presented |
| The worker routes | They take the job token instead |

Everything else answers `401` with `{ "error": "unauthorized" }` when the secret is missing or wrong. A board that gets `401` says how to open it signed in: `crew board`, or Open Web Board in the app.

Workers are kept from the file. A Codex job that is read-only or has the network open runs under a permissions profile that denies it; a Codex job with neither can read it but has no network to use it with. Antigravity's read of the file is refused by the bridge's policy, and its commands need the user's approval.

Checked on 2026-11-13. A headless browser against a real daemon: with no token and with a wrong one the board showed the sign-in screen after a single API request; with the right one it loaded, the fragment was gone from the address, the cookie was `HttpOnly` and `SameSite=Strict`, and web storage was empty. A real Codex job with the network open (Codex CLI 0.167.0) was refused the token file by its permissions profile, while a local server in its worktree, writing there, and a question to the lead all worked. Not exercised: the native app against a live daemon beyond the packaged smoke test.

Sessions that were already open when the daemon gained authentication hold an MCP server started from the old code, which sends no secret. Their Crew tools answer with an error until the session is restarted.

## 13. What a job's tokens are made of

Where the agent reports it (Codex), a job carries `tokenUse`: total input, how much of it was cached input, output, and what the latest turn added. The lead's status output and both boards show it. A follow-up turn that looks expensive is mostly input the worker had already sent once; the cached share says how much.

## 14. What a worker is told

A job's instructions are its role, the rules for sharing the machine, how to ask the lead, and what its sandbox allows. A worker that cannot run commands (Antigravity as reviewer, editor, or question responder) can start nothing on the machine, so it is not given the machine rules. `test/prompts.test.ts` fixes the instructions for every combination of role, agent, `runs_app`, `exclusive`, and scratch directory in a snapshot, and checks that no two parts contradict each other, such as a role that may write nothing next to a note on where to write. Regenerate the snapshot with `node --test --test-update-snapshots test/prompts.test.ts` and read its diff as a wording change.

Codex adds the user's own setup to every thread: the skills under `~/.agents/skills` and those of installed plugins, app connectors, and recommended plugins. No Crew job uses them, so each thread is started with `skills.include_instructions = false` and `features.apps`, `features.plugins`, and `features.tool_suggest` off. The lead can give one job some of the user's own skills back: `delegate`, `review`, and `polish` take `skills`, a list of names from `~/.agents/skills` (the same skills the lead has). The bridge refuses a name that is not installed, and adds the chosen skills' names, descriptions, and SKILL.md paths to the job's instructions; the worker reads them itself. This works for Antigravity too, which reads files in every role. Plugin skills and app connectors stay off for every job. MCP servers the user configured in `~/.codex/config.toml` are kept: they are named by the user, and each is one line in the deferred tool list.

Measured on 2026-11-13 with Codex CLI 0.167.0 on an isolated daemon, with a question that runs nothing and answers "OK":

| | Input tokens | Cached input |
| --- | --- | --- |
| Before | 23,052 | 13,312 |
| After | 14,723 | 12,032 |

What left the context: a list of 123 skills (design, Figma, Adobe, data analysis, Google Drive, Notion), 22 app connectors in the deferred tool list (Apple Music, Adobe, and others), the list of recommended plugins, and the computer-use REPL's tools.

