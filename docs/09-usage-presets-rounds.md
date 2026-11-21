# 09. Usage, presets, rounds, and intents

Contract between the Crew daemon (`plugin/bridge/`), the React web board (`plugin/board/src/`), and the native macOS app (`native/Sources/Crew/`) for AgentGauge usage and routing, presets, tiers, rounds, intents, worker tools, authentication, roles, model scores, and peer ratings.

## 1. State and events

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
| `modelScores` | `ModelScore[]` (`notes.ts`) | Per-model scores and item breakdowns |
| `pulls` | `PullWatch[]` (`pulls.ts`) | Watched pull requests linked to missions (without internal delivery fields) |

Server-sent events on `GET /api/stream` (in addition to `job`, `mission`, `event`, `claude`, `limits`, and `desktopLease`):

| Event | Data | Sent when |
| --- | --- | --- |
| `usage` | `Usage` | AgentGauge's cache changes, a live Codex limit updates, a limit error is reported, or status changes with time |
| `preset` | `{ preset, presets }` | `config.json` changes or `POST /api/preset` saves |
| `roles` / `roleSettings` | `Record<Role, RoleAssignment>` / `RoleSettings` | `config.json` changes or `POST /api/roles` saves |
| `peerRatings` | `boolean` | `config.json` changes or `POST /api/peer-ratings` saves (followed by `modelScores`) |
| `modelScores` | `ModelScore[]` | Notes, peer ratings, or the `peerRatings` switch change |
| `pull` | `PullWatch` (view) | A watched pull request is linked, changes, or is polled |

Jobs also carry `rounds?: Round[]`, `ask?: boolean`, `role?: Role`, and `preset?: PresetName | null` (`jobs.ts`); missions carry `notes?: MissionNote[]`, `preset?: PresetName`, and `tasks?: MissionTask[]` (`missions.ts`).

## 2. Endpoints

| Request | Body | Result |
| --- | --- | --- |
| `GET /api/usage` | | `Usage` |
| `GET /api/route?kind=<role>\|lead&mission=<id>` | | `RouteDecision`, plus `preset` and `policy` (the mission's preset or global preset). `mission` is optional; an unknown id is refused |
| `GET /api/missions/:id/runbook` | | `{ text }`; Markdown runbook for `crew export` |
| `GET /api/notes?agents=&evidence=` | | `{ scores, text }`; model scores and rendered summaries/lines for the lead |
| `POST /api/gc` | `{ "apply": false, "branches": false }` (both optional) | `{ text }`; user secret required; dry run unless `apply`; branches deleted only with both flags |
| `POST /api/preset` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | `{ preset, presets }`; writes `preset` in `~/.crew/config.json` |
| `POST /api/peer-ratings` | `{ "enabled": true \| false }` | `{ peerRatings }`; writes `peerRatings: false` or removes the key to turn on |
| `POST /api/notes` | Evidence line or `{ "model", "summary" }` | `ModelScore`; user secret required (sections 16–17) |
| `POST /api/jobs/:id/rating` | `{ "correctness"?, "report"?, "findings"?, "fact", "token" }` | `{ kept }`; worker token required, only for jobs asked to rate (section 17) |
| `POST /api/missions` | `{ "title", "project", "stages"?, "preset"?, "tasks"?, ... }` | New (or matching open) mission |
| `POST /api/missions/:id` | `{ "note": "text" }` | Mission with note appended; refused if not active |
| `POST /api/missions/:id` | `{ "preset": "economy" \| "balanced" \| "best" \| null }` | Mission with preset set or cleared (`null`); refused if not active; applies to its next jobs |
| `POST /api/missions/:id/pulls` | `{ "pr": "<number or URL>" }` | `{ watch, resumed, summary }`; user secret required |
| `POST /api/roles` | `{ "roles": <raw table> }` | `{ roles, roleSettings }`: resolved and stored tables (section 15) |
| `POST /api/instructions` | `{ "append": "text", "project": path \| null }` | `{ file, text }`; appends a paragraph to shared instructions (`text` replaces instead) |
| `POST /api/jobs` | `{ "kind": "delegate", "ask": true, "task": "question", "cwd": path }` | Read-only question job whose report is the answer. Any job may add `"skills": [names]` (section 14) |
| `POST /api/jobs/:id/rounds/:turn` | `{ "undo": true }` or `{ "keep": true }` | Updated job; `undo` reverts that round's commit on the job branch, `keep` reverts the revert |

A round can be undone or kept only when the job is idle (terminal), its worktree exists as its own directory on the job branch, no `cleanupPending`/sync/discard/gc is active, and the revert applies cleanly; otherwise the request fails with the reason and changes nothing. Round states replay from branch reverts before each change so pre-stop reverts survive.

Undoing a round changes files only, not the worker's conversation. The next follow-up turn lists rounds whose state changed since the worker last heard (`Round.toldWorker`) and tells it not to redo undone edits unless asked; an undo followed by a keep before the next turn says nothing. This works for every agent (Codex's `thread/revert` was skipped because it drops later turns, cannot undo a middle round, and cannot restore a kept round).

Question jobs (`ask: true`) are read-only: Codex runs without approval prompts and declines writes; Antigravity refuses edits and commands.

## 3. Usage status

| Status | Means |
| --- | --- |
| `ok` | Room to spare |
| `tight` | 15% or less of the window is left; returns to `ok` once 30% is left (hysteresis prevents flapping) |
| `exhausted` | Nothing left (`usedRatio >= 0.999`), or a job just failed on this agent's usage limit |
| `stale` | AgentGauge's reading is older than 45 minutes |
| `unknown` | No reading: AgentGauge is absent, signed out, or uses an unknown cache format |

A provider's status equals its tightest account-wide window; single-model windows (`group` set) report their own status without deciding the provider's. Antigravity checks both account-wide windows (when present) and the configured model's family: every word of a family name must appear in the model name (`/` separates alternatives, such as `Claude/GPT`), so non-Argon Gemini matches `Gemini` over `Gemini 4 Argon`. Without a configured model, account-wide windows decide if present; otherwise, or if no family matches, the tightest family decides because jobs cannot switch models.

Status uses remaining quota rather than projected exhaustion. Pace projections often misjudged real usage (marking Codex `tight` with 57% of its weekly window left), so routing ignores them. Each window still carries `projectedExhaustion` in usage readings, but neither board shows it.

On the board, a provider that is `stale`, `unknown`, or `exhausted` by a reported limit shows that status on its account-wide gauges instead of each window's own.

## 4. Intents on the board

The board's New Job form sends one of three intents:

| Intent | What the board calls |
| --- | --- |
| Command | `POST /api/jobs` for the chosen role (except `debate`) |
| Question | `POST /api/jobs` with `kind: "delegate"` and `ask: true` |
| Information | `POST /api/missions/:id` with `note` when a mission is chosen, else `POST /api/instructions` with `append` |

## 5. Progress roll-up

Both the React board (`plugin/board/src/model.ts`) and the native macOS app (`native/Sources/Crew/Models.swift`) compute mission progress from state using the same rule:

- A `done` mission is `1` (100%).
- Otherwise progress is `(index + share) / stages.length`:
  - For a mission with a custom `stages` plan, `stages` is that plan and `index` is `mission.stageIndex` (falling back to `stages.indexOf(mission.stage)`).
  - For a legacy mission without `stages`, `stages` is the 7 standard stages (`plan`, `implement`, `self-review`, `cross-review`, `fix`, `polish`, `final`) and `index` is the current stage's position.
- `share` is the mean across the mission's unfinished jobs (`endedAt == null`) of `0.5` for `running` or `waiting` jobs and `0` for other unfinished jobs, or `0.5` when there are no unfinished jobs.

## 6. Where usage comes from

| Source | Used for | Freshness |
| --- | --- | --- |
| AgentGauge's `usage-cache.json` | Every agent's windows | As AgentGauge polls: 3 to 10 minutes, stretching to 30 while the user is away |
| AgentGauge's `usage-history.db` | Last 90 minutes of samples per window, for `projectedExhaustion` | Same |
| Codex's own rate limits (`account/rateLimits/*` on `app-server`) | Codex, whenever newer than AgentGauge's reading | Live while a Codex job runs |
| A job failing on a usage limit | Marks that agent `exhausted` immediately | Lifted by a newer reading showing room in all deciding windows (section 3), or after 5 hours |

Both AgentGauge files open read-only; Crew holds no credentials and makes no provider requests. Two cache formats are supported: macOS (version 1 in `~/Library/Application Support/AgentGauge`, checked against AgentGauge 0.8.2) and Windows (version 4 in `%APPDATA%\Gauge`, checked against a live install). Windows PascalCase tool names and Id-less window names (`Claude`, `Weekly`) normalize to macOS spelling, and SQLite history queries ignore case (`COLLATE NOCASE`) so Codex readings match on both platforms. Signed-out tools are skipped. On unsupported platforms or unknown versions, agents report `unknown` and roles run as assigned.

Readings older than 45 minutes are `stale`. Stale and unknown readings never move work: `route` keeps the assigned holder and notes that usage is unknown.

Open in [03-agentgauge-integration.md](03-agentgauge-integration.md): G2 (`--json` output) and G3 (activity signal and threshold hook) live in AgentGauge. Until G3 lands, AgentGauge slows polling during unattended runs, so Claude usage can go `stale`; Codex has its live supplement, and Claude and Antigravity fall back to limit failures.

## 7. Routing

`route` (the lead's tool and `GET /api/route`) implements section 8.2 of document 03 (`plugin/bridge/usage.ts`). It assigns work only to a role's configured holder or the lead (`claude`). Where a role has several usable holders, `route` checks them in preferred worker order (Antigravity first for `polish`, Codex first for all other roles, Claude last) and picks the first one that is not `tight` or `exhausted` before falling back to the first usable holder. Reset advice (`deferUntil`) uses only the windows that decided the provider's status, and projected exhaustion never defers work.

| Kind | Holder `tight` | Holder `exhausted` |
| --- | --- | --- |
| `delegate`, `refactor`, `fix` | Lead takes the work unless the lead is also short | Lead takes the work (`fix`: lead fixes findings itself) |
| `release` | As `delegate` | Lead prepares the release itself and publishes/deploys nothing |
| `review` | Still the holder, one round | Lead repeats its self-review; `degraded` |
| `verify` | Still the holder, one round | Lead runs the app in its own self-review; `degraded` |
| `debate` | Still the holder, one or two rounds | Lead decides alone and notes debate was skipped; `degraded` |
| `polish` | Deferred until reset; lead makes urgent wording fixes | Same |
| `lead` | Claude keeps to planning/merging and hands more implementation to the engineer | Still `claude` (`degraded`): finish the current step if Codex is the engineer with room, else stop, and tell the user Claude is out of usage (only Claude can lead) |

Each role maps explicitly to a policy (`build`, `review`, `debate`, or `polish`) in `route()`, so a new role cannot fall through to another's.

## 8. Presets

`preset` in `~/.crew/config.json` is `economy`, `balanced`, or `best` (unset by default). A role setting overrides the preset, and the preset overrides the agent's global config.

| Preset | Codex effort | Lead's subagents | Worker tier cap (`maxTier`) |
| --- | --- | --- | --- |
| `economy` | `low` | `haiku`, `sonnet` at most (`subagentMax`) | `standard` |
| `balanced` | `medium` | `sonnet` | none |
| `best` | `high` | lead's own model (`inherit`) | none |

Under `economy`, `maxTier: "standard"` caps worker models at the `standard` tier (Sol for Codex, Hydrogen for Antigravity): a higher tier or larger named model is lowered to it, while the lead may still set a custom effort per job.

Built-in presets name no worker models because account availability differs. Customize models under `presets`:

```json
{
  "preset": "best",
  "presets": { "best": { "codex": { "model": "gpt-6.1-sol" } } }
}
```

### Presets per mission

A mission's `preset` overrides the global preset for jobs started under it; role models and efforts still win. The lead passes `preset` to `mission` only when the user names one and never picks one itself; users can also change it from the mission menu on the board or in the app. Changes apply to new jobs; each job records `Job.preset` at start and keeps its preset and model across follow-ups.

The preset belongs to the work, not the card. Stopping tracking on the board keeps the mission ID (`costMission`) and preset on new jobs until the lead finishes the mission or opens another. A job naming an unknown mission fails once rather than falling back silently to the global preset. After an MCP server restart, the next job or `route` reads the session's open mission from the daemon; if closed while down, the lead keeps the preset without reopening the card. Because session instructions are fixed at start, `mission` and `route` replies state the active preset and subagent cap.

### Tiers

A job can name its difficulty via `tier` (`delegate`, `review`, `polish`, `debate`), and the bridge maps it to a model family ([tiers.ts](../plugin/bridge/tiers.ts)); jobs without a tier use the default (`light` for read-only questions, `standard` otherwise).

| Tier | Use | Codex | Antigravity | Codex effort |
| --- | --- | --- | --- | --- |
| `fast` | Plain searches and lookups | Luna | Hydrogen | `medium` |
| `light` | Simple, well-specified tasks; default for a question | Terra | Hydrogen | `medium` |
| `standard` | Most work, including most UI changes; the default | Sol | Hydrogen | `medium` |
| `frontier` | Especially hard/complex work, a UI rebuilt from scratch, or literary/very complex documents | Astra | Neon | `high` |

Tiers name families, not versions. For Codex, Crew picks the newest unhidden model in that family from `$CODEX_HOME/models_cache.json` (falling back to Codex's default). For Antigravity, Crew matches the session's offered model list (skipping orchestrators) and falls back to the agent's default. Because Antigravity element names do not encode rank, families are mapped manually (`Neon` holds `frontier`; displaced `Argon` stays recorded in `FORMER_FAMILIES` so explicit Argon models still run and preset caps still lower them).

- **Model precedence:** explicit job `model` (a versionless family name such as `"Astra"` resolves as its tier), job `tier`, configured model (role, preset, or `codex.model`/`antigravity.model`), then default tier.
- **Effort precedence:** job `effort`, role or preset `effort`, then (for Codex) named tier effort, `codex.effort`, or default tier effort. Under `economy`, jobs stay `low` unless the lead overrides `effort`. Antigravity accepts `effort` only from the job, role, or preset (mapped to `thought_level`).

## 9. Per-turn temporary files and read-only jobs

Static reviews and questions run read-only, yet checks still write temp files and caches. Every Codex job—writable delegates, `runs_app` reviews, static reviews, and questions—gets a fresh per-turn scratch directory at `~/.crew/scratch/<job id>` with `TMPDIR`, `TMP`, and `TEMP` set via `shell_environment_policy.set`.

For read-only Codex jobs (`crew_read_only` profile):

| | |
| --- | --- |
| Writable | The scratch directory (and the job's evidence directory, when created); `TMPDIR`, `TMP`, and `TEMP` point to scratch |
| Readable | The whole disk, except `~/.crew/token` (denied) |
| Closed | The network, and listening on a port |
| Lifetime | Created at turn start, moved aside and deleted at turn end; follow-up turns get a fresh empty directory |

Read-only jobs use a Codex permissions profile (`default_permissions`) because `read-only` sandbox mode cannot exempt one directory. Writable Codex jobs keep workspace and scratch access (`runs_app` reviews keep their writable snapshot and network access), while leaving the user's system temp directory out (see [04](04-implementation.md) section 2.1 for the Windows ACL timeout reason).

When `.worktreeinclude` links a directory because cloning is unsupported, Crew records the link, excludes unignored links from commits and dirty checks by pathspec, marks both link and target read-only in Codex's permissions profile, and detaches links before any recursive removal ([04](04-implementation.md) section 2).

Antigravity shares one server process with no per-job environment or scratch directory; as a reviewer it runs no commands and reads the saved diff file.

Verified on macOS with Codex CLI 0.167.0 (read-only reviews/questions writing to `$TMPDIR` while repo/home writes fail, and live writable jobs writing to scratch and worktree without prompts) and unit tests; live shared links on APFS (where cloning succeeds) were tested via injected failures.

Instructions state upfront what the worker can run, and reviewers mark findings as reproduced, read, or suspected.

## 10. Bringing a worker up to date

A worker's worktree starts from `HEAD` (or `base`) and does not follow later commits. `reply` with `sync: true` merges the lead's current `HEAD` into the worker's branch before the follow-up turn and advances `worktree.base` so results still show only the worker's changes. On conflict, the merge aborts (leaving worktree, base, and result unchanged) and the follow-up still runs, naming the lead commit and conflicting files in the prompt and adding a job note. Other sync failures reject the reply. Syncing blocks discard and round changes; rounds still replay from `roundsBase` so pre-sync undos survive.

A job whose worktree was discarded takes no further turn.

`crew gc [--apply] [--branches]` lists and cleans orphan worktree directories, stale Git admin directories, and unused `crew-cx-*`/`crew-ag-*` branches across known repositories; see [04](04-implementation.md) section 2 for full guards and Windows cleanup behavior.

## 11. Questions from a worker to the lead

Each job receives a small per-job MCP server (`plugin/bridge/worker-mcp.ts`) with six tools (plus `rate` when `CREW_JOB_RATES` is set for peer ratings):

| Tool | Does |
| --- | --- |
| `ask_lead` | Records a question (optional `blocks` and evidence `attachments`, max 20 questions per job) and returns at once so the worker keeps going |
| `lead_answers` | Returns newly arrived answers and open questions, waiting up to 600 seconds (`wait_seconds`) |
| `browser` | Starts a sandboxed headless Playwright server outside the worker's sandbox on macOS and returns its WebSocket endpoint |
| `siblings` | Lists other unfinished jobs in the same mission or project |
| `search` | Runs `git grep` inside the job's working tree (for workers that cannot run commands) |
| `recent_changes` | Shows the last 5 commits and latest diff for a path inside the working tree |
| `rate` | Offered only when `CREW_JOB_RATES` is set (`review` or `delegate`); submits the worker's peer rating (section 17) |

A new `ask_lead` question wakes the lead while the worker keeps running; the lead responds with `answer` (separate from user approvals and user questions).

| Request | Body | From |
| --- | --- | --- |
| `POST /api/jobs/:id/questions` | `{ text, blocks?, attachments?, token }` | Worker MCP server |
| `GET /api/jobs/:id/questions?token=&wait=` | | Worker MCP server |
| `GET /api/jobs/:id/siblings?token=` | | Worker MCP server |
| `POST /api/jobs/:id/browser` | `{ token }` | Worker MCP server |
| `POST /api/jobs/:id/rating` | `{ correctness?, report?, findings?, fact, token }` | Worker MCP server |
| `POST /api/jobs/:id/questions/:questionId` | `{ answer, attachments? }` | Lead |

Worker routes require the job's in-memory token, passed via environment and never written to disk or sent to boards. Codex registers the server with `default_tools_approval_mode = "approve"` so `approvalPolicy: "never"` jobs can call it.

Verified on Codex CLI 0.167.0 (read-only and writable jobs) and Antigravity CLI 1.5.5 (`polish` via ACP `mcpServers`). Not exercised live: restoring an Antigravity session with the server, and `ask_lead` from a Codex sub-agent thread.

## 12. Who may talk to the daemon

The daemon listens on localhost (`127.0.0.1`), which any local process can reach—including a `runs_app` worker whose sandbox allows network access. `Host` and `Origin` checks block web pages, so every API request also requires authentication.

The master secret lives in `~/.crew/token`: 64 hex characters, mode `0600`, created on first start by the daemon that wins the port, and kept across restarts. `~/.crew/token.version` (`2`) marks secrets created after ticket sign-in; older secrets without it are rotated once at the next start (because pre-ticket cookies or URLs could have exposed them).

| Client | How it authenticates |
| --- | --- |
| Lead MCP server, CLI, and all Claude hooks (`report.ts`, `wake.ts`, `context.ts`) | `Authorization: Bearer <token>`, read from `~/.crew/token` |
| Native macOS app | Same header on HTTP requests and SSE stream |
| Web board in a browser | A scoped board credential held only in page memory and sent as `Authorization: Bearer`. `crew board` and the app's Open Web Board request a single-use ticket (`POST /api/session/ticket`) and open `http://127.0.0.1:<port>/#ticket=<ticket>`; the page strips the fragment and trades it at `POST /api/session` |
| Web board in the Windows Electron app | A board credential minted by Electron's main process from `~/.crew/token` and injected into requests; the renderer holds nothing |
| Worker MCP server | Its per-job in-memory token on worker routes only (section 11) |

| Open without the secret | Why |
| --- | --- |
| `GET /`, board assets, `/fonts/*`, `/icons/*` | Static page assets needed before sign-in; hold no data |
| `GET /api/health` | Daemon discovery and version check; names no job |
| `POST /api/session` | Trades a one-minute, single-use ticket that only a secret holder can mint |
| `GET /api/jobs/:id/evidence/:file?sig=...` | `<img>`/`<video>` tags cannot send headers; requires that file's HMAC seal |
| Worker routes (`questions`, `siblings`, `browser`, `rating`) | Authenticated by the job's per-job token instead |

All other requests without valid credentials return `401` (`{ "error": "unauthorized" }`).

**Trust boundaries and design choices:**

- **No secret in browsers (no cookies, no web storage).** Workers can read most of the disk. Antigravity and Codex jobs using a permissions profile are denied access to `~/.crew/token`. Browser cookies are sent across ports on `127.0.0.1` (leaking to a `runs_app` worker's local server) and stored plaintext on disk; web storage is also plaintext on disk. Any legacy `crew_session` cookie is ignored and cleared via `Set-Cookie: Max-Age=0`. Keeping the board credential in memory means a reload, bookmark, or 7-day expiry signs the browser tab out; the desktop apps are unaffected.
- **Tickets and credentials.** `POST /api/session/ticket` returns a 64-hex single-use ticket valid for 60 seconds in memory. `POST /api/session` trades it atomically for `board.<expiry>.<HMAC>`, valid for 7 days. Because it is HMAC-sealed rather than stored, an open board reconnects across daemon restarts and stops working when it expires or the secret rotates (active SSE streams close at expiry).
- **Scoped board permissions.** A board credential may read and call only the 10 board routes (`BOARD_POSTS` in `daemon.ts`: `/api/jobs`, job `reply`/`cancel`/`rounds/:turn`, `/api/missions/:id`, `/api/instructions`, `/api/setup/repair`, `/api/peer-ratings`, `/api/preset`, `/api/roles`). All other POSTs (tickets, hooks, lead routes, `answer`, `discard`, `gc`, heartbeat, starting missions, `notes`, `pulls`, `shutdown`) return `403`. Within allowed routes, `LEAD_FIELDS` (`approved_by_user`, `lead_session`, `lead`, `by`, `check`, `attachments`) also return `403`.
- **Evidence seals.** `sig` is an HMAC over `(job, file, modified)`, allowing access only to that recorded file version; it stops working if the file changes or the secret rotates.
- **Authenticated hooks and sandbox hardening.** `POST /api/hooks/claude` requires `~/.crew/token` because user prompt hooks are recorded and passed to Codex's automatic reviewer on refusal retries (a `runs_app` worker without the secret must not forge them). Codex profiles (`crew_read_only`, `crew_app`, `crew_workspace`) deny `~/.crew/token` and mark `.git` read-only so workers cannot repoint git filters/hooks that the bridge runs outside the sandbox; Antigravity policy refuses reading `~/.crew/token` and editing `.git`. A writable Codex job with no enabled plugin, `runs_app`, or shared links uses plain `workspace-write` without a profile. It can read the token but has no network to use it with. On macOS, the bridge's `sandbox-exec` profile for `browser` and `check` denies `lsopen`, `appleevent-send`, and `job-creation`.
- **Residual window.** `crew board --url` prints a live ticket into the calling session's transcript for up to 60 seconds until traded (`crew board` opens the browser directly without printing). If a worker with network access trades it first, the user's tab lands on the sign-in screen.

Verified against a real daemon (ticket race, spent/wrong tickets, cookie rejection, 403 on non-board routes and `LEAD_FIELDS`, sealed evidence, token rotation), Chromium, Electron 45.3.3 on macOS, macOS `sandbox-exec` (`open` fails with `-54` while Playwright runs), and a live `runs_app` Codex job refused `~/.crew/token`. Not exercised: a live Windows Electron run, a real browser profile/transcript attack, or an older install beside a new one.

## 13. What a job's tokens are made of

Where reported (Codex), a job records `tokenUse`: total input, cached input, output, and what the latest turn added. `status`, the board, and the desktop apps display it so follow-up turns show how much input was cached.

## 14. What a worker is told

Job instructions combine the role, shared-machine rules (omitted for workers that cannot run commands: Antigravity as reviewer, editor, or question responder), `ask_lead` usage, sandbox/scratch limits, refused-action rules, optional rating/evidence/plugin/skill sections, and shared instructions ([prompts.ts](../plugin/bridge/prompts.ts)). `test/prompts.test.ts` snapshots every valid combination and checks for contradictions; regenerate with `node --test --test-update-snapshots test/prompts.test.ts`.

To avoid injecting the user's entire Codex skill/app catalog into every thread, Crew starts Codex threads with `skills.include_instructions = false` and `features.apps`, `features.plugins`, and `features.tool_suggest` off. The lead can attach specific skills from `~/.agents/skills` via `skills` on `delegate`, `review`, and `polish`; Crew validates names and adds each description and `SKILL.md` path (for Antigravity too). User MCP servers in `~/.codex/config.toml` remain available.

Codex plugin defaults in `~/.crew/config.json`:

```json
{
  "codex": {
    "plugins": ["browser"],
    "appPlugins": ["computer-use", "unified-computer-use"]
  }
}
```

Eligible Codex jobs (writable delegates and `runs_app` reviews; skipped for ask jobs, static reviews, polish, and other agents) receive the union of `codex.plugins`, `codex.appPlugins` (when `runs_app: true`), and per-job `plugins`. Missing or disabled defaults stay silent; only explicitly requested plugins emit notes.

Plugin threads deny `~/.crew/token` even without `runs_app` (network stays tied to `runs_app`), forward plugin tool approvals to the user, disable all other installed plugins (`plugins._default.enabled = false`), and keep the skill catalog on because Codex 0.167.0's `skills.include_instructions = false` hides plugin skills too.

Token savings measured on Codex CLI 0.167.0 for a no-op question (dropping 123 user skills, 22 app connectors, recommended plugins, and computer-use REPL tools):

| | Input tokens | Cached input |
| --- | --- | --- |
| Before | 23,052 | 13,312 |
| After | 14,723 | 12,032 |

## 15. Roles

A role is a kind of work the user assigns to one or more holders (`ROLE_INFO` in `config.ts`). Each runs as one of three job kinds (`delegate`, `review`, `polish`), which determine its sandbox, workspace, and base prompt:

| Role | Kind | Follows | What it is |
| --- | --- | --- | --- |
| `delegate` | `delegate` | | Implementation |
| `refactor` | `delegate` | `delegate` | Restructuring without changing behavior (`engineer.md` + `refactor.md`) |
| `release` | `delegate` | `delegate` | Release preparation: version, changelog, build, checks, publish steps (`engineer.md` + `release.md`); pushes/publishes/deploys nothing |
| `debate` | `delegate` (read-only) | `delegate` | Tests the lead's position on a hard decision (`debater.md`) |
| `review` | `review` | | Static cross-review |
| `verify` | `review` | `review` | Review that runs the app in a snapshot of the change (`unable: ["antigravity"]`) |
| `fix` | `delegate` | | Fixing accepted review findings in the lead's code or a merged result (`engineer.md` + `fix.md`); held by Claude by default |
| `polish` | `polish` | | Wording (`polisher.md`) |

Unassigned roles—or roles without `agents`—inherit their parent's holders with their own per-agent settings overlaid; listing `agents` starts fresh. Settings stay scoped per agent (`codex`, `antigravity`), and unused agents' settings are omitted. A role may have several holders, including `claude` (no holder is marked as a special default):

```json
{ "roles": { "review": { "agents": ["codex", "claude"], "codex": { "effort": "high" } }, "polish": { "agents": ["claude"] } } }
```

- `agents` is stored in fixed order (`codex`, `antigravity`, `claude`). The legacy config form (`agent`, `also`, `model`, `effort`) is still converted on read.
- The lead selects a holder with `agent` on `delegate`, `review`, `polish`, and `debate`. Picking `claude` starts no worker job and returns instructions for in-session or subagent execution (`crew:self-reviewer` for reviews).
- When `agent` is omitted (`POST /api/jobs` or tool call), Crew picks the first enabled, able worker in preferred order (`antigravity` first for `polish`, `codex` first for all other roles). `route` checks usable holders in that same preferred worker order (Claude last), skipping tight/exhausted holders when another has room. Roles held only by `claude` or an unable/disabled worker fail at start rather than falling back.
- The daemon sends both `roles` (resolved) and `roleSettings` (stored, preserving inheritance) plus `roleInfo`. Settings edits `roleSettings`.
- `resolveRole` in `jobs.ts` settles a job's role once at creation: `POST /api/jobs` may pass `role` without `kind`; `kind: "review"` with `runs_app` resolves to `verify`; contradictory `role`/`kind`/`runs_app`/`debate` combinations fail. The board's New Job offers every role except `debate`.

## 16. Model notes and scores

After a review and its fix, the lead records one evidence line per model via `note` (`POST /api/notes`), stored only by the daemon in `~/.crew/model-notes.json` (`plugin/bridge/notes.ts`) and displayed under Settings → Model Scores (`modelScores` in state and SSE). Job lines take model, agent, tier, and effort from the job record; the lead passes `model` only for in-session work.

Each model gets build and fix scores out of 10 (to one decimal), plus four item scores when peer ratings and review lines are present (section 17):

- **Build score:** A rate of accepted finding load (`0.35` high, `0.15` medium, `0.05` low) over change exposure (`small` 0.5, `medium` 1, `large` 2, `xlarge` 4—chosen units, not measured diff size), displayed as `10·exp(−rate)`. Rate 0 maps to 10 (before shrinkage), one medium per medium change to 8.6, one high to 7.0, three highs to 3.5, and more findings always cost more (unclamped). Tier is shown for within-tier comparison, not scored (for Codex, tier picks the model, so scoring tier acted as a fixed per-model bonus).
- **Fix score:** Mean quality of fix lines (`root-cause` 1, `patch` 0.55, `another-review` 0.25) multiplied by `exp(−load)` of any findings raised when checking the fix. Fix appears beside build and is never pooled into rank.
- **Shrinkage and weighting:** Both build and fix shrink toward a prior with weight 3. The prior is the mean of other models' estimates (each counted once and first shrunk toward a reference—`0.36` build rate ≈ 7.0, `0.7` fix quality—with the reference counted as one extra model), so one busy model cannot set everyone's prior. Self-reviews (same agent as builder) count half. Reviewers are not calibrated because uneven work mixes make harshness indistinguishable from harder assignments.
- **Ranking and status:** Status counts build reviews (self-reviews half): `< 3` is `too few samples`, `< 8` is `on trial`, `8+` is `settled`. Ranking and podium follow `score` (`items.correctness`, which equals `build` when peer ratings are off or below 3; section 17), breaking ties by unrounded rate. Models with `< 3` samples sort after ranked models under "Too early to rank".
- **Adoption and triage:** Merged multi-job results get one line per job for its own findings (cross-piece findings go on the lead's line). Delegated build lines record `adoption` (`as-is`, `after-reply`, `partly`, `rejected`) and follow-up rounds from the job; adoption does not affect `build` but feeds the `brief` item (section 17). Declined findings are logged beside accepted ones for triage inspection (and score reviewers on `review` lines).
- **Summaries and validation:** `note` requires `size` and `text` (plus `reviewer` for `build`/`fix`; `review` lines take `reviewer` from the job), returning all missing/invalid fields with allowed values in one error. `note_summary` rewrites a model's prose summary once 10 new lines arrive (`CONSOLIDATE_AFTER`). `route` returns summaries and recent lines for role holders' three most recently noted models. Re-noting the same job and role replaces its line. Debate jobs cannot be noted; review jobs default to `role: "review"` (section 17). Unreadable files move to `model-notes.json.unreadable-<time>`, incomplete entries are skipped (copied to `.dropped-<time>` before overwrite), and each model ID belongs to one agent. Notes are advisory only; roles and presets never change automatically.

Not modelled: time decay, measured diff size, and independent checks of lead triage.

## 17. Peer ratings

Peer ratings layer over review evidence so brief adherence, reporting honesty, reviewer usefulness, and independent checks on the lead's own work show up in scores without letting generous LLM ratings dominate.

**Who rates whom.** Only a pair where one saw the other's work, never oneself; each item is an integer `1`–`5`:

| Rater | Rated | When | Items |
| --- | --- | --- | --- |
| Reviewer | Reviewed work | Before its report, via `crew.rate` | `correctness`, `report` |
| Lead | Job's builder or fixer | On the job's `note` line (`rating`) | `correctness` (builder only), `brief`, `report` |
| Lead | Review job | On the review's `note` line (`rating`) | `findings` |
| Engineer | Review of its work | In the turn findings return, via `crew.rate` | `findings` (at half weight) |

Workers provide `fact` (one line from the work); the lead's rating rests on the note's `text`. Without a job, the lead cannot rate its own work (only its reviewer rates it).

**No extra turn.** Jobs created while `peerRatings` is on get `rates: true`, a `# Rating` prompt section, and the `rate` tool on `worker-mcp.ts`. Debates, questions, polish jobs, `fix` jobs, and `release` jobs are excluded.

**Review lines and storage.** `note` accepts `role: "review"` (the default when noting a review job) with `of_job` or `of_model` naming the reviewed work plus accepted `findings` and `declined`. Review lines bind worker ratings to their target: reviewer ratings go to `of` (the job's build model or `of_model`), and engineer ratings go once per reviewing model on `of_job` (staying inactive until the review job is noted). `~/.crew/model-notes.json` is version 2 (`ratings` holds worker ratings, one per job; lead ratings sit in `rating` on evidence lines, preserved when re-noted without `rating`). Version 1 files load directly and back up once to `model-notes.json.v1` on first save.

**Items and scoring.** Each model gets four items out of 10 (`ModelScore.items`), and `score` is `items.correctness`:

| Item | Observed evidence | Ratings from |
| --- | --- | --- |
| `correctness` | Build score (section 16); `null` without a build regardless of ratings | Reviewers, lead |
| `brief` | Delegated adoption (`as-is` 1, `after-reply` 0.7, `partly` 0.4, `rejected` 0), shrunk toward `0.7` with weight 3 | Lead |
| `report` | None yet; reference `0.7` stands in | Reviewers, lead |
| `findings` | Accepted finding load over raised load on review lines, shrunk toward `0.6` with weight `0.5` | Lead, engineers |

- **Minimum count and 50/50 blend:** Ratings move an item only from `MIN_RATINGS` (3) onward; 1 or 2 are ignored. Mean rating (`3` neutral) maps to a shift in `[−1, 1]`: neutral leaves the baseline unchanged, all fives pull toward 10, all ones toward 0. Half of the item moves with ratings and half stays with evidence (`PEER_SHARE = 0.5`), so good ratings never lower clean work and rated vs. unrated models stay comparable.
- **Rater centering:** Each rating is centered against that rater's mean on the item across *other* models (shrunk toward `3` by 1 rating), pulling only toward neutral and never past it. Excluding the rated model's own ratings ensures an extra five never hurts it or turns a three negative, and multi-target ratings count once per source so note order changes nothing.
- **Shrinkage, self-weight, and caps:** A model's mean rating shrinks toward `3` with weight 2; ratings from the rated model's own agent count half. Any `correctness` rating on work with an accepted high finding caps at `3` (including in its rater's mean), checked on the job's build line, any review line of that job, or (for jobless work) the rating reviewer's own line. `fix`-role work omits `correctness` (`of.fix`).
- **Ranking:** Status follows build reviews; ranking and podium follow `score` (ties broken by finding rate). Review-only models have `score: null` and sort apart under "Reviewers" by `findings`. `ModelScore.ratings` counts only ratings on items that reached `MIN_RATINGS`.

**Turning them off.** `peerRatings` in `~/.crew/config.json` defaults to `true`; toggling it off in Settings saves `peerRatings: false`. When off, new jobs skip rating, `note` ignores `rating` (flagging `ratingDropped`), and scores compute from evidence alone while preserving saved ratings if turned back on.

**Not modelled:** Comparing a worker's declared `Outcome` against lead adoption as observed evidence for `report`; worker ratings of the lead's brief; rating weight growing with rating count.
