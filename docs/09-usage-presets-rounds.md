# 09. Usage, presets, rounds, and intents

Written 2026-11-13. Delivers roadmap items C1 (AgentGauge, phase G1), A3 (presets), and the open parts of B2 (intent, per-round keep or undo, progress roll-up). This file is the contract between the daemon, the web board, and the native app; the types named here are in `plugin/bridge/`.

## 1. State and events

`GET /api/state` and the first frame of `GET /api/stream` gain three fields, all optional because older daemons omit them.

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
| `peerRatings` | `boolean` | `config.json` changes, or the switch is saved; a `modelScores` event follows, since the scores change with it |

Jobs gain `rounds?: Round[]` and `ask?: boolean` (`jobs.ts`); missions gain `notes?: MissionNote[]` (`missions.ts`). Both arrive through the existing `job` and `mission` events.

Added 2026-11-15 for roles and mission presets (sections 8 and 15): state gains `roleSettings` and `roleInfo`, a `roleSettings` event carries the raw table whenever `roles` is sent, missions gain `preset?`, and jobs gain `role?` and `preset?`.

## 2. Endpoints

| Request | Body | Result |
| --- | --- | --- |
| `GET /api/usage` | | `Usage` |
| `GET /api/route?kind=<role>\|lead&mission=<id>` | | `RouteDecision`, plus `preset` and `policy`: the preset the next job of that mission (or the global preset, if no mission is given) would run under, and what it sets. `mission` is optional; an unknown id is refused |
| `POST /api/gc` | `{ "apply": false, "branches": false }` (both optional) | `{ text }`; user secret required; dry run unless `apply`, branches deleted only with both flags |
| `POST /api/preset` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | `{ preset, presets }`; writes `preset` in `~/.crew/config.json` |
| `POST /api/peer-ratings` | `{ "enabled": true \| false }` | `{ peerRatings }`; writes `peerRatings: false` in `~/.crew/config.json`, or removes the key to turn them on |
| `POST /api/jobs/:id/rating` | `{ "correctness"?, "report"?, "findings"?, "fact", "token" }` | `{ kept }`; the worker's own token, and only from a job that was asked to rate (section 17) |
| `POST /api/missions/:id` | `{ "note": "text" }` | The mission, with the note appended. Refused for a mission that is not active |
| `POST /api/missions/:id` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | The mission. A name sets its preset, `null` clears it, and leaving it out changes nothing. Refused for a mission that is not active. Applies to the mission's next jobs |
| `POST /api/missions` | adds `"preset"` | A new mission may start with a preset |
| `POST /api/roles` | `{ "roles": <raw table> }` | `{ roles, roleSettings }`: the resolved and the stored table (section 15) |
| `POST /api/instructions` | `{ "append": "text", "project": path \| null }` | `{ file, text }`; adds the text as a new paragraph to the shared instructions |
| `POST /api/jobs` | `{ "kind": "delegate", "ask": true, "task": "question", "cwd": path }` | A read-only job whose report is the answer. Any job may add `"skills": [names]` (section 14) |
| `POST /api/jobs/:id/rounds/:turn` | `{ "undo": true }` or `{ "keep": true }` | The job. `undo` reverts that round's commit on the job branch; `keep` reverts the revert |

A round can be undone or kept only when the job is idle (not running or waiting), its worktree exists as its own directory on the job branch, and the revert applies cleanly; otherwise the request fails with the reason and changes nothing. Round states are replayed from branch reverts before each change so pre-stop reverts are preserved.

Undoing a round changes files only, not the worker's conversation. The next follow-up turn lists rounds changed since the worker last heard (undone, or restored after an undo) and tells it not to redo undone edits unless asked; `Round.toldWorker` tracks this, so an undo then keep before the next turn says nothing. This works for every agent; Codex's `thread/revert` was skipped because it drops the turn and later ones, cannot undo a middle round, and cannot restore a kept round.

Question jobs are read-only: Codex runs without approval prompts and the bridge declines writes; Antigravity edits and commands are refused.

## 3. Usage status

| Status | Means |
| --- | --- |
| `ok` | Room to spare |
| `tight` | 15% or less of the window is left; it is `ok` again once 30% is left |
| `exhausted` | Nothing left, or a job just failed on this agent's usage limit |
| `stale` | AgentGauge's reading is too old to act on |
| `unknown` | No reading: AgentGauge is not installed, or its file has a format this version does not know |

A provider's status equals its tightest account-wide window; single-model windows (`group` set) report their own status without deciding the provider's. Antigravity checks both account-wide windows (when present) and the configured model's family: every word of a family name must appear in the model name (`/` separates alternatives, such as `Claude/GPT`), so non-Argon Gemini matches `Gemini` over `Gemini 4 Argon`. Without a configured model, account-wide windows decide if present; otherwise, or if no family matches, the tightest family decides because jobs cannot switch models.

Status uses remaining quota, not projected exhaustion. Pace projections often misjudged real usage (on 2026-11-13 it marked Codex `tight` with 57% of its weekly window left), so the web board displays it while routing ignores it.

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
| AgentGauge's `usage-history.db` | The last 90 minutes of samples per window, for the projection the web board shows | Same |
| Codex's own rate limits (`account/rateLimits/*` on its app-server) | Codex, whenever newer than AgentGauge's reading | Live while a Codex job runs |
| A job failing on a usage limit | Marks that agent exhausted at once | Immediate; lifted by a later reading that shows room in the applicable windows from section 3, or after 5 hours |

Both files open read-only; Crew holds no credentials and makes no provider requests. Two cache formats are supported: macOS (version 1 in `~/Library/Application Support/AgentGauge`, checked against AgentGauge 0.8.2) and Windows (version 4 in `%APPDATA%\Gauge`, checked against a real install on 2026-11-16). Windows PascalCase tool and Id-less window names (`Claude`, `Weekly`) are normalized to macOS spelling, and history lookups ignore case so Codex readings match on both. Signed-out tools have no reading. On other platforms or unknown versions, agents report `unknown` and roles run as assigned.

A reading older than 45 minutes is `stale`. Stale and unknown readings never move work: routing then answers with the role's holder and says that usage is not known.

Open in [03-agentgauge-integration.md](03-agentgauge-integration.md): G2 (`--json` output) and G3 (activity signal and threshold hook) live in AgentGauge. Until G3 lands, AgentGauge slows polling during unattended runs, so Claude usage can go `stale`; Codex has its own channel, and Claude and Antigravity fall back to limit failures.

## 7. Routing

`route` (the lead's tool, and `GET /api/route`) follows section 8.2 of document 03. It answers only with the role's holder or the lead. Reset advice uses only the windows that decided the provider's status, so another model family cannot extend the wait, and projected exhaustion never defers work.

| Kind | Holder tight | Holder exhausted |
| --- | --- | --- |
| `delegate`, `refactor` | The lead takes the work, unless the lead is short too | The lead takes the work |
| `release` | As `delegate` | The lead prepares the release itself and publishes nothing |
| `review` | Still the holder, one round | The lead repeats its self-review; `degraded` |
| `verify` | Still the holder, one round | The lead runs the app in its own self-review; `degraded` |
| `debate` | Still the holder, one or two rounds | The lead decides alone and says the debate was skipped; `degraded` |
| `polish` | Deferred until the reset; the lead makes urgent wording fixes | Same |
| `lead` | Claude keeps to planning and merging | Hand off to Codex if it is the engineer and has room; `degraded` |

Each role names its policy in `route()`, so a role added later cannot fall through to another's.

## 8. Presets

`preset` in `~/.crew/config.json` is `economy`, `balanced`, or `best`; absent by default. A setting on a role wins over the preset, and the preset over the agent's own configuration.

| Preset | Codex effort | Lead's subagents |
| --- | --- | --- |
| `economy` | low | haiku, sonnet at most |
| `balanced` | medium | sonnet |
| `best` | high | the lead's own model |

`economy` also caps worker models at the `standard` tier (Sol for Codex, Hydrogen for Antigravity): a higher tier, or a larger model the lead or the user names, is lowered to it. The lead may still name a different effort for a job. A preset sets the cap with `maxTier`, and the largest subagent model with `subagentMax`.

The built-in presets name no worker models, because which models an account has differs. Add them under `presets`:

```json
{
  "preset": "best",
  "presets": { "best": { "codex": { "model": "gpt-6.1-sol" } } }
}
```

### Presets per mission

Added 2026-11-15. A mission's `preset` replaces the global preset for jobs started under it; role models and efforts still win. The lead passes `preset` to `mission` only when the user names one ("this one is simple: economy") and never chooses one itself. Users can also switch it in the board's mission menu. Changes apply to new jobs; each job records `Job.preset` at start and keeps that preset and model across follow-up turns.

The preset belongs to the work, not the card. Stopping tracking on the board keeps the mission id and preset on new jobs until the lead finishes the mission or opens another. A job naming an unknown mission is refused once rather than falling back to the global preset; the next job uses the global preset. After an MCP server restart, the next job or `route` resumes the session's open mission, and resending the mission title reattaches to it; if closed while down, the lead keeps the preset without reopening the card.

Session instructions are fixed at start, so they state only the global preset and these rules. `mission` and `route` responses report the active preset and subagent cap, and the lead follows the latest one.

### Tiers

Added 2026-11-14. A job names how demanding it is, and the bridge turns that into a model ([tiers.ts](../plugin/bridge/tiers.ts)). The lead passes `tier` on `delegate`, `review`, and `polish`; jobs from the board and jobs with no tier use the default.

| Tier | Use | Codex | Antigravity | Codex effort |
| --- | --- | --- | --- | --- |
| `fast` | Plain searches and lookups | Luna | Hydrogen | medium |
| `light` | Simple, well-specified tasks; default for a question | Terra | Hydrogen | medium |
| `standard` | Most work, including most UI changes; the default | Sol | Hydrogen | medium |
| `frontier` | Especially hard or complex work, a UI rebuilt from scratch, literary or very complex documents | Astra | Neon | high |

A tier names a family, not a version. For Codex, the bridge picks the newest unhidden model in that family from `$CODEX_HOME/models_cache.json`, falling back to Codex's default. For Antigravity, it matches the session's model list (skipping orchestrators), falling back to the agent's default.

Antigravity element names do not encode rank, so families are placed manually. Neon replaced Argon at `frontier` on 2026-11-19 (agy 1.5.12 lists `gemini-4-neon` with `low` to `xhigh`). A displaced family keeps its tier: explicit models from it still run and preset caps still lower them.

Model precedence: job `model`, job `tier`, configured model (role, preset, or `codex.model` / `antigravity.model`), then default tier. A configured model holds unless the lead passes a `tier`. Effort precedence: job `effort`, role or preset effort, named tier effort, `codex.effort`, then default tier effort. Under `economy`, jobs stay `low` unless the lead sets an effort. Antigravity accepts effort only from the job, role, or preset; tiers and built-in presets set Codex's only.

## 9. Per-turn temporary files and read-only jobs

A static review or a question runs read-only, and a check that only reads is rare: tests make temporary files, tools write caches. Every Codex job, including writable workers and reviews with `runs_app`, gets one directory of its own, `~/.crew/scratch/<job id>`, for the length of a turn. For a static review or question, the permissions are:

| | |
| --- | --- |
| Writable (read-only jobs) | The scratch directory only. `TMPDIR`, `TMP`, and `TEMP` point to it |
| Readable | The whole disk, as before |
| Closed | The network, and listening on a port |
| Lifetime | Created when a turn starts and moved aside the moment it ends, then deleted; a follow-up turn gets a fresh, empty one |

Read-only jobs use a Codex permissions profile (`default_permissions` with a `filesystem` table) in thread config because `read-only` sandbox mode cannot exempt one directory. Verified 2026-11-13 with Codex CLI 0.167.0 on an isolated daemon: in a real review, `mktemp -d`, Node `mkdtemp`, and `git clone` plus commit in scratch succeeded while repo and home writes were refused. Verified again the same day with a real question after instruction updates: `mktemp -d`, `git clone` into `$TMPDIR`, and `node --test test/usage.test.ts` succeeded while `touch` in repo and home failed.

Writable Codex jobs keep workspace and standard temp-root write access plus the scratch path; `runs_app` reviews keep their writable snapshot, network access, and scratch directory. Each thread sets `TMPDIR`, `TMP`, and `TEMP` via `shell_environment_policy.set`; at turn end, the directory is moved aside and deleted, and a follow-up turn creates a new one at the same path.

When `.worktreeinclude` links a directory because cloning is unsupported, the job notes and worker instructions record it, and the Codex permissions profile marks both link and target read-only even under a writable temp root. Crew's Git commits and dirty checks (before sync or round changes) exclude shared links by pathspec, because directory-only ignore rules miss symlinks and Git's exclude file is shared with the main checkout. Workers are told to put tool caches in scratch and never install into or delete shared directories.

Before recursive filesystem cleanup (including scratch), Crew detaches links. On Windows, worktree and snapshot removal detaches all reparse points first and clears read-only attributes on the workspace and its validated Git admin directory. Codex threads are unsubscribed before removal; because app-server unloads lazily, Windows cleanup also retries transient failures. Failed discards keep their worktree record and list the remaining directory, metadata, and branch in a note and status line.

Antigravity jobs share one server process with no per-job environment, so their environment is unchanged. As a reviewer, Antigravity runs no commands, gets no scratch directory, and receives the saved diff.

Checked on macOS on 2026-11-14 with unit and temporary-repository tests covering per-turn scratch creation/cleanup, all three temp variables, read-only and `runs_app` profiles, read-only shared targets, and pre-deletion link detachment. A live writable Codex job (Codex CLI 0.167.0, `gpt-6.1-sol`) on an isolated daemon saw all three variables point to scratch, wrote there and in its worktree, and ran without approval prompts. Not exercised: live shared links (APFS clones) and Windows.

The job's instructions state upfront what it can run so it does not find out by failing, and the reviewer marks each finding as reproduced, read, or suspected.

## 10. Bringing a worker up to date

A worker's worktree starts from the lead's `HEAD` and does not follow later commits. `reply` with `sync: true` merges the lead's current `HEAD` into the worker's branch before the follow-up turn and advances the job's base so results still show only the worker's changes. On conflict, the merge aborts (leaving worktree, base, and result unchanged) and the follow-up still runs: the prompt names the lead commit and conflicting files, and a job note records the failed sync once the follow-up is accepted. Other sync failures still reject the reply. While syncing, discard and round changes are blocked. Rounds still replay from the job's initial commit so pre-sync undos survive.

A job whose worktree was discarded takes no further turn; ask a new question instead.

From a terminal, `crew gc` lists orphan worktree directories, stale Git admin directories, and unused `crew-cx-*`/`crew-ag-*` branches across known repositories without modifying anything, reporting whether each branch is merged into `HEAD`. `crew gc --apply` removes orphan directories and prunes metadata; adding `--branches` deletes branches merged into `HEAD`. Unmerged branches stay, with `git branch -D <name>` shown for manual removal. Active jobs, workspace operations, owned worktrees, and paths outside Crew's worktrees directory are protected. Jobs with incomplete cleanup refuse follow-ups, sync, and round changes until gc resolves leftovers; cleanup notes stay on failed discards until then. See [04](04-implementation.md) section 2 for Windows preparation and prune safety.

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

Worker routes require the job's in-memory token, passed to the worker's MCP server via environment and never written to disk or sent to a board.

Checked on 2026-11-13 with Codex CLI 0.167.0 on an isolated daemon (both read-only question and writable worktree job): `ask_lead` and `lead_answers` worked, and wrong tokens failed. Under approval policy `never`, Codex refuses MCP calls outright, so the server registers with `default_tools_approval_mode = "approve"` (its tools talk only to the bridge).

Antigravity CLI 1.5.5 passed the same check with a polish job via ACP `mcpServers`. Not exercised: restoring an Antigravity session with the server, and questions from a Codex sub-agent thread.

## 12. Who may talk to the daemon

The daemon listens on a local port, which every process on the machine can reach. Checking `Host` and `Origin` keeps web pages out, but not a local process, such as a worker whose sandbox has the network open for `runs_app`. So every request carries a secret.

The secret is `~/.crew/token`: 64 hex characters, created on first start by the daemon that holds the port, readable by the user alone, and kept across restarts. `~/.crew/token.version` beside it records that the secret was made after boards began signing in with tickets; a secret without it is replaced once, at the next start.

| Client | How it presents the secret |
| --- | --- |
| The lead's MCP server, the CLI, and every hook (wake, context, and the report of session activity) | `Authorization: Bearer <token>`, read from the file |
| The native app | The same header, on requests and on the event stream |
| The web board in a browser | A board credential, held in the page's memory and sent as `Authorization: Bearer`. `crew board` and the app's Open Web Board ask the daemon for a ticket and open `http://127.0.0.1:47615/#ticket=<ticket>`; the page removes the fragment and posts the ticket to `POST /api/session`, which answers with the credential |
| The web board in the Windows app | The same credential, made by the app's main process from the file and added to the board window's requests. The page holds nothing |
| A worker's MCP server | Its own per-job token, on the worker routes only (section 11) |

| Open without the secret | Why |
| --- | --- |
| `GET /`, the board's assets, fonts, icons | The page has to load before it can sign in; it holds no data |
| `GET /api/health` | Clients use it to find the daemon and compare versions; it names no job |
| `POST /api/session` | It takes a ticket, which only a holder of the secret can get |
| `GET /api/jobs/:id/evidence/:file` with that file's seal | An image or video element cannot send a header |
| The worker routes | They take the job token instead |

Everything else answers `401` with `{ "error": "unauthorized" }` when the secret is missing or wrong. A board that gets `401` says how to open it signed in: `crew board`, or Open Web Board in the app.

**The board never holds the secret.** Every worker profile can read the whole disk except the token file, and whatever a browser keeps is on that disk: Firefox stores cookie values in plaintext, Chromium stores web storage in plaintext and can keep a visited address with its fragment in its history, and an address printed by `crew board --url` lands in the transcript of the session that ran it. So nothing reusable is given to a browser to keep:

- **A ticket** signs one page in. `POST /api/session/ticket` takes the secret and answers with 64 random hex characters that the daemon holds in memory for a minute and gives up at the first use. A ticket found later in a history file or a transcript is worth nothing.
- **A board credential** is what the page gets for it: `board.<expiry>.<HMAC of it under the secret>`, valid for seven days. It is sealed rather than recorded, so an open board reconnects by itself after the daemon restarts, and it stops working when it lapses or the secret is replaced; a stream opened with it is ended at that moment. The page keeps it in a variable, so closing or reloading the tab signs it out. Nothing that survives a reload stays off the disk.
- **It is not the secret.** It may read, and it may send the ten requests the board's pages send (`BOARD_POSTS` in `daemon.ts`). Any other change answers `403`: getting a ticket, the hook and lead routes, answering a worker's question as the lead, discarding a job, `gc`, the desktop heartbeat, starting a mission, notes, shutdown. Within its own requests it may not send `approved_by_user`, `lead_session`, `lead`, `by`, `check` or `attachments`, which speak for the user or the lead, or have the daemon read a file or run a command (`LEAD_FIELDS`). A route added later is not the board's until it is listed; a field is, unless it is listed.
- **An evidence file's address carries a seal**, `sig`: an HMAC under the secret over the job, the file and its recorded modification time, which the daemon adds to each evidence item it sends. It opens that file as last recorded and nothing else, has no time limit, and stops working when the file is recorded again or the secret is replaced. A worker can read `~/.crew/evidence` directly, so a seal left in a history file opens nothing new.

Workers are kept from the file. A Codex job that is read-only or has the network open runs under a permissions profile that denies it; a Codex job with neither can read it but has no network to use it with. Antigravity's read of the file is refused by the bridge's policy, and its commands need the user's approval.

Checked on 2026-11-13, when the board signed in with a cookie. A real Codex job with the network open (Codex CLI 0.167.0) was refused the token file by its permissions profile, while a local server in its worktree, writing there, and a question to the lead all worked. Not exercised: the native app against a live daemon beyond the packaged smoke test.

Sessions that were already open when the daemon gained authentication hold an MCP server started from the old code, which sends no secret. Their Crew tools answer with an error until the session is restarted.

Revised 2026-11-20, after a review of the trust boundary:

- **`POST /api/hooks/claude` needs the secret.** It was open because Claude Code's HTTP hooks cannot read a file. Every hook is now a command hook (`report.ts`) that can, and the route does more than record activity: what a prompt hook reports is kept as the user's own words and shown to Codex's automatic reviewer when the lead sends back a refused action (04 section 5.1). A process without the secret, such as a worker with the network open, could have written those words. A hook from a plugin copy older than this change sends no secret and is refused; its session then does not appear on the board until the plugin is updated.
- **A worker cannot rewrite the repository pointer of its tree.** The bridge runs git in a worker's tree after each turn, outside any sandbox, so a `.git` a worker repointed or reconfigured would have the bridge run the worker's commands (a clean filter, a textconv driver). Antigravity's edits inside `.git` are refused, Codex's permissions profile makes it read-only, and a `check` already ran with it read-only.
- **The bridge's own sandbox denies starting other programs.** The profile for a job's browser server and for `check` allows by default and limits files; it now also denies LaunchServices, Apple Events and launchd jobs, through which a process inside it could have had something run outside every limit. Checked on macOS 27.2: `open` fails with -54 under the profile, and the job's Playwright server still starts and drives a page.

Revised again on 2026-11-20, after a debate with Codex and Antigravity:

- **The board's cookie is gone.** It held the secret itself and was sent to every port on its host, so a server a `runs_app` worker started received it when the user opened that server at `127.0.0.1`; and the secret could be read from disk with no such step (above). The cookie is no longer set or read, a browser that still sends it is told to drop it, and the secret is replaced once because an earlier one cannot be called back.
- **Rejected: keeping the secret, or anything reusable, in web storage.** It is scoped to the port, which a cookie is not, but it is plaintext in the browser's profile, so a worker would need no step from the user at all.
- **What it costs.** In a plain browser a reload, a bookmark or a week signs the board out, and it is opened again from `crew board` or the app. The native app and the Windows app are unchanged.
- **What it does not close.** A ticket is live from when it is issued until the page trades it in. `crew board --url` prints one into the transcript of the session that ran it, so for those seconds a worker that has the network open and reads that transcript can trade it in first; the lead's page then shows the sign-in screen, which is the only sign. `crew board` itself passes the ticket to the browser without printing it. A daemon or launcher from before this change, started beside the new one, reads the new secret and puts it in a cookie or an address again; a daemon is replaced only by a newer version, so the release that carries this change must raise the version. A launcher that meets an older daemon gets no ticket and opens the board signed out rather than fall back to the secret.

Checked on 2026-11-20: a real daemon gave one credential for two simultaneous uses of a ticket, refused a spent or wrong ticket, the cookie, and a credential with a changed expiry, and answered `403` to each route and field above; a sealed address served its file without a header and no other; a secret without its version file was replaced at the next start and the earlier secret and credential were then refused. Chromium against the fixture server: the fragment left the address, no cookie was set and web storage stayed empty, and a reload showed the sign-in screen. The Windows app's shell on macOS (Electron 45.3.3): the board loaded with no cookie and stayed signed in across a reload. Not exercised: a real browser's profile and a real transcript, the Windows app on Windows, and an older install beside the new one.

## 13. What a job's tokens are made of

Where the agent reports it (Codex), a job carries `tokenUse`: total input, how much of it was cached input, output, and what the latest turn added. The lead's status output and both boards show it. A follow-up turn that looks expensive is mostly input the worker had already sent once; the cached share says how much.

## 14. What a worker is told

Job instructions combine the role, machine-sharing rules, `ask_lead` usage, and sandbox limits; workers that cannot run commands (Antigravity as reviewer, editor, or question responder) omit machine rules. `test/prompts.test.ts` snapshots every valid combination of role, agent, `runs_app`, `exclusive`, and scratch directory and checks for contradictions (such as a read-only role told where to write). Regenerate snapshots with `node --test --test-update-snapshots test/prompts.test.ts` and review the diff as a wording change.

Codex injects user and plugin skills, app connectors, and recommended plugins into every thread, so Crew starts threads with `skills.include_instructions = false` and `features.apps`, `features.plugins`, and `features.tool_suggest` off. The lead can attach user skills via `skills` on `delegate`, `review`, and `polish`; the bridge validates names and adds each description and `SKILL.md` path to instructions (for Antigravity too). User MCP servers in `~/.codex/config.toml` are kept.

For plugins, `~/.crew/config.json` has two lists. Their defaults are:

```json
{
  "codex": {
    "plugins": [],
    "appPlugins": ["computer-use", "unified-computer-use"]
  }
}
```

`codex.plugins` defaults to `["browser"]` and applies only to writable Codex delegates and `runs_app` Codex reviews (silently skipped for ask jobs, static reviews, polish jobs, and other agents). Eligible jobs receive the union of `codex.plugins`, `appPlugins` (when `runs_app` is true), and the lead's per-job `plugins`. Missing or disabled defaults are silent; only explicitly requested names emit notes. Beyond `browser`, pick file plugins matching task formats and `figma`/`github` for those services; personal-account plugins and the user's own Chrome require an explicit request.

A `runs_app` Codex job enables computer use by default and can operate the real, shared screen. Because plugin tools act outside the sandbox, plugin jobs use a permissions profile denying the daemon token even without `runs_app`, while sandbox network access stays tied to `runs_app`. The bridge forwards tool approvals only when the thread enabled plugins. Installed, enabled plugins are selected by exact id, with other listed plugins and the default for unseen installs off. Plugin threads keep the automatic skill catalog because Codex 0.167.0's `skills.include_instructions` hides plugin skills along with user skills ([implementation](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/ext/skills/src/extension.rs)); apps and tool suggestions stay off.

Measured on 2026-11-13 with Codex CLI 0.167.0 on an isolated daemon, with a question that runs nothing and answers "OK":

| | Input tokens | Cached input |
| --- | --- | --- |
| Before | 23,052 | 13,312 |
| After | 14,723 | 12,032 |

What left the context: a list of 123 skills (design, Figma, Adobe, data analysis, Google Drive, Notion), 22 app connectors in the deferred tool list (Apple Music, Adobe, and others), the list of recommended plugins, and the computer-use REPL's tools.

## 15. Roles

Added 2026-11-15. A role is a kind of work the user assigns to an agent. Each runs as one of three job kinds, which set its sandbox, workspace, and base prompt (`ROLE_INFO` in `config.ts`):

| Role | Kind | Follows | What it is |
| --- | --- | --- | --- |
| `delegate` | delegate | | Implementation |
| `refactor` | delegate | `delegate` | Restructuring without changing behavior; the engineer's role text plus `roles/refactor.md` |
| `release` | delegate | `delegate` | Release preparation: version, changelog, build, checks, and written steps to publish; plus `roles/release.md`. It pushes, publishes, and deploys nothing |
| `debate` | delegate (read-only) | `delegate` | Tests the lead's position on a decision |
| `review` | review | | Static cross-review |
| `verify` | review | `review` | Review that runs the app in a snapshot of the change |
| `fix` | delegate | | Fixing the review findings the lead accepted, in its own code or a merged result; plus `roles/fix.md`. Held by Claude by default |
| `polish` | polish | | Wording |

Unassigned roles, or roles without `agents`, inherit their parent's holders with their own per-agent settings overlaid; roles listing `agents` start fresh. Settings stay scoped per agent and unused agents' settings are omitted, so configs written for the original three roles behave unchanged.

```json
{ "roles": { "review": { "agents": ["antigravity"] }, "verify": { "agents": ["codex"] } } }
```

Static reviews then go to Antigravity and reviews that run the app to Codex.

Added 2026-11-15: a role may have several holders, and Claude may be one of them. No holder is a default.

```json
{ "roles": { "review": { "agents": ["codex", "claude"], "codex": { "effort": "high" } }, "polish": { "agents": ["claude"] } } }
```

`agents` lists holders in fixed order: Codex, Antigravity, Claude. `codex` and `antigravity` hold per-role `model` and `effort` for worker jobs; `claude` means the lead runs the work in its session or a subagent. Unassigned child roles inherit their parent's holders.

The lead picks a holder via `agent` on `delegate`, `review`, `polish`, and `debate`. It gives screen or app-running work to Codex when Codex holds the role, and may run two holders at once when a second view is worth the usage. Picking `claude` starts no job and returns instructions instead (for reviews, the `crew:self-reviewer` subagent).

`route` checks workers first in the same order, skipping low-usage holders, and reports each holder's status. `POST /api/jobs` accepts `agent` (must be a worker holder); if omitted, wording goes to Antigravity and other work to Codex, skipping disabled or unable holders (`roleInfo[].unable`: Antigravity cannot run the app for `verify`). If no eligible worker remains, a Claude-held role is refused (board New Job notes it starts from a Claude session). Roles assigned only to an unable agent (`verify` on Antigravity, which runs no review commands) fail at start rather than falling back.

The older form (`agent` as default, `also` for others, and one `model` and `effort` for the default) is still read: holders become `agents`, and model and effort become that agent's settings.

The daemon sends both tables: `roles` resolved (every role, `agents` required) and `roleSettings` as written (`agents` optional, old form converted), with `roleInfo` describing roles in display order. Settings edits and saves `roleSettings`, preserving parent inheritance.

A job settles its role once at creation (`resolveRole` in `jobs.ts`). `POST /api/jobs` may send `role` without `kind`. `kind: "review"` with `runs_app` resolves to `verify`; passing `role: "review"` with `runs_app`, mismatched `role` and `kind`, or debate rounds outside `debate` are refused. Jobs saved before roles were recorded derive `debate`, `verify` (for `runs_app` reviews), or their `kind`.

The lead's tools map onto roles: `delegate` takes `role` (`delegate`, `refactor`, `release`, or `fix`), `review` is `review` or (`runs_app`) `verify`, and `debate` and `polish` are their own roles. The board's New Job offers every role except `debate`, which needs a lead to answer each round.

## 16. Model notes and scores

Added 2026-11-15 (roadmap D1 and D2). After a review and fix, the lead records one evidence line per model via `note`: builder/fixer, reviewer, change size, accepted and declined findings by severity, and for fixes whether it reached the cause. Job lines take model, agent, tier, and effort from the job record; the lead names a model only for in-session work (`POST /api/notes`). Only the daemon writes `~/.crew/model-notes.json` (`notes.ts`); the board and app show scores under Settings, Model Scores from `modelScores` in state and its event.

Revised 2026-11-16 after reviewing the first clamped-average method, whose reviewer calibration mistook assigned work for harshness, whose tier factor added a fixed per-Codex-model bonus (the tier picks the model), whose clamp equated three and ten high findings, and whose score rose with fix count. Each model now gets two scores out of 10, to one decimal:

- Build is a rate: accepted finding load (0.35 per high, 0.15 per medium, 0.05 per low) over change exposure (small 0.5, medium 1, large 2, xlarge 4—chosen units, not measured difficulty; xlarge covers multi-subsystem integrations). Displayed as 10·exp(−rate): rate 0 maps to 10 (before shrinkage below), one medium finding per medium change 8.6, one high 7.0, three highs 3.5, and further findings cost more. Tier is recorded and shown for within-tier routing comparisons, not scored.
- Fix is the mean quality of fix lines: 1 for a root-cause fix, 0.55 for a patch, 0.25 when another review was needed, times exp(−load) of findings raised when checking the fix.
- Both shrink toward a prior with weight 3 (three changes or fixes). The prior is the mean of other models' estimates (each counted once and first shrunk toward a reference: one high per medium change, 7.0, for build; 0.7 for fix, with the reference counted as one extra model). Thus a busy model cannot set everyone's prior, and a sole model starts at the reference.
- Self-reviews (same agent as builder) count half. Reviewers are not otherwise calibrated because uneven work mixes make harshness indistinguishable from worse assignments.
- Score, podium, and ranking use build only; fix appears beside it and is never pooled, so fixes neither raise nor lower rank. Status counts build reviews (self-reviews half): under 3 is too few samples, under 8 is on trial, 8+ is settled. Unranked models (<3 samples) sort after ranked ones under "Too early to rank". Display ties break by unrounded rate.
- Merged results get one line per job for its own findings; cross-piece findings go on the lead's line. Delegated lines also record adoption (merged as is, after a reply, in part, or rejected) and follow-up rounds from the job; totals appear in notes and settings. Adoption is unscored because findings already reflect it.
- Not modelled: time (model ids are exact versions and notes are sparse), measured diff size, and independent checks of the lead's triage (declined findings are logged beside accepted ones for inspection).

The lead also writes a short per-model prose summary via `note_summary` once ten new lines arrive. Revised 2026-11-16: sharing `note` previously prevented marking `size`, `reviewer`, and `text` required, so leads often omitted them; the two tools are now separate, `note` requires all three, and a refused line lists every missing or invalid field with allowed values. `route` adds summaries and the latest two lines for role holders' three most recently noted models. Re-noting the same job and role replaces its line (multiple reviews of one piece of work share one line, each accepted finding counted once); review and debate jobs cannot be noted because they built nothing. Unreadable notes files move to `model-notes.json.unreadable-<time>`, and incomplete entries are skipped. A model id belongs to one agent. Notes advise tier and holder choices; role assignments and presets never change automatically.

## 17. Peer ratings

Added 2026-11-18. Section 16 measures only accepted finding load per change size, missing brief adherence, reporting honesty, reviewer quality, and independent checks on the lead's own model. The user proposed end-of-mission peer scoring. Because LLM ratings run generous and unsteady, they layer over the evidence rather than replacing it, each rests on a fact, and raters submit them inside turns they already have.

**Who rates whom.** Only a pair where one saw the other's work, and never oneself. Each item is an integer from 1 to 5.

| Rater | Rated | When | Items |
| --- | --- | --- | --- |
| Reviewer | The work it reviewed | Before its report, with `crew.rate` | `correctness`, `report` |
| Lead | A job's builder or fixer | On that job's `note` line, as `rating` | `correctness` (a builder only), `brief`, `report` |
| Lead | A review job | On the review's `note` line, as `rating` | `findings` |
| Engineer | The review of its work | In the turn the findings come back, with `crew.rate` | `findings`, at half weight |

`brief` rates brief adherence, `report` how well the report matched the work, and `findings` review usefulness. Workers supply `fact` (one line from the work); the lead's rests on the note's `text`. Without a job, the lead cannot rate its own work, which only its reviewer rates.

**No extra turn.** Jobs created while `peerRatings` is on are marked `rates`, receive a `# Rating` section (`prompts.ts`), and expose `rate` on their worker MCP server with kind-specific items. Debates, questions, wording jobs, fixes, and release prep see no target work or start from another's review and are excluded. Both adapters allow `rate` like other worker Crew tools. Rating runs inside an existing turn, adding a few lines of output; pairs without such a turn get no rating.

**Review lines.** `note` takes a third role, `review`, for a review job: `job_id` is the review job, `of_job` or `of_model` the reviewed work, and `findings` and `declined` the lead's triaged findings. Noting a review job without a role defaults to `review` and can no longer be refused as "building nothing". Review lines give worker ratings their target: reviewer ratings go to `of` (the job's current build model or `of_model`), and engineer ratings go once per reviewing model on `of_job` regardless of review count. Unnoted review jobs keep engineer ratings inactive until noted.

**Storage.** `~/.crew/model-notes.json` is version 2: `ratings` holds worker ratings (`by`, `byModel`, `byJob`, `items`, `fact`), one per job, replaced when re-rated. Lead ratings sit in `rating` on evidence lines; re-noting with `rating` replaces it, and without keeps it. Version 1 files load directly and copy to `model-notes.json.v1` on first save, since older daemons treat version 2 as unreadable. Lines written before review lines name reviewer agents rather than models, so reviewers start without history.

**Items.** Each model gets four items out of 10 (`ModelScore.items`), and `score` is `correctness`:

| Item | Observed evidence | Ratings from |
| --- | --- | --- |
| `correctness` | The build score of section 16; empty without a build, whatever the ratings | Reviewers, the lead |
| `brief` | Adoption of delegated work: as is 1, after a reply 0.7, in part 0.4, rejected 0, drawn toward 0.7 with the weight of three | The lead |
| `report` | None yet; a reference of 0.7 stands in for it | Reviewers, the lead |
| `findings` | Accepted finding load over the load the reviewer raised, on its review lines, drawn toward 0.6 with the weight of 0.5 (one high and one medium) | The lead, engineers |

- Ratings move an item only from count 3+; 1 or 2 are anecdotes. Counts count ratings, not raters, so three lead-rated jobs suffice.
- Ratings shift an item from its evidence baseline. Mean rating (3 neutral) maps to a shift from −1 (all ones) to 1 (all fives): neutral leaves the baseline unchanged, all fives pull toward 10, all ones toward 0. Half the item moves with ratings and half stays (initially built 70/30; user chose equal shares the same day), so good ratings never lower a score and rated vs. unrated models stay comparable. (An earlier direct 0–10 mapping scored neutral 3 at 5.0 against clean 8.6 work, causing three fives to lower a clean model; self-review caught it.)
- Each rating is centered against the rater's mean for that item over other models (shrunk toward 3 by one rating), dampening generous raters. Centering pulls only toward neutral, never past it, and excludes the rated model's own ratings so another five never hurts it or turns a three negative. Raters key by model, with the lead as one rater. A rating reaching multiple reviewed models counts once in that mean and is excluded for each, so note order changes nothing (the second review found both inversions in a plain mean).
- A model's mean rating shrinks toward 3 with weight 2; ratings from the rated model's own agent count half, like a self-review.
- A `correctness` rating on work with an accepted high finding caps at 3 (including in its rater's mean), checking the job's build line, any review line of the job, or (for jobless work) the rating reviewer's own line. Jobless work lacks an id to join lines, so highs noted on its build line or by another review do not cap it.
- `correctness` belongs to building: fix lines omit it, and reviewer `correctness` ratings on `fix`-role jobs are omitted (`of.fix` on the review line).
- Status follows build reviews; ranking and podium follow `score`, breaking ties by finding rate. With no ratings, too few, or ratings off, `score` equals the build score. Review-only models have no `score` and list apart under "Reviewers" by `findings`. `ModelScore.ratings` counts only ratings for items that had enough to move.

**Turning them off.** `peerRatings` in `~/.crew/config.json` defaults on unless `false`; the board and app Model Scores switch saves at once. Off, new jobs skip rating, lead instructions omit it from the next session, `note` ignores `rating` (noted in its response), and all scores compute without ratings. Existing ratings stay in the file and count again when switched back on.

**Not modelled.** A worker's declared outcome against how the lead took the work, as observed evidence for `report`; a worker's rating of the lead's brief; a share of the weight that grows with the number of ratings.
