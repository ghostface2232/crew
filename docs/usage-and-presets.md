# Usage, presets, and tiers

Crew reads agent quota and uses it to advise the lead who should take a role. Presets set effort and model ceilings globally or per mission, and tiers select a model family for a job.

**Key files:** `plugin/bridge/usage.ts`, `config.ts`, `tiers.ts`, `jobs.ts`, and `mcp.ts`. See [roles.md](roles.md#role-assignments) for configured holders, [missions.md](missions.md) for mission state, and [daemon-api.md](daemon-api.md) for usage and preset routes.

## Usage status

| Status | Means |
| --- | --- |
| `ok` | Room to spare |
| `tight` | 15% or less of the window is left; returns to `ok` once 30% is left (hysteresis prevents flapping) |
| `exhausted` | Nothing left (`usedRatio >= 0.999`), or a job just failed on this agent's usage limit |
| `stale` | AgentGauge's reading is older than 45 minutes |
| `unknown` | No reading: AgentGauge is absent, signed out, or uses an unknown cache format |

A provider's status equals its tightest account-wide window. Single-model windows (`group` set) report their own status without deciding the provider's.

Antigravity checks both account-wide windows (when present) and the configured model's family: every word of a family name must appear in the model name (`/` separates alternatives, such as `Claude/GPT`), so non-Argon Gemini matches `Gemini` over `Gemini 4 Argon`. Without a configured model, account-wide windows decide if present. When neither a model nor account-wide windows are available, or if no family matches, the tightest family decides because jobs cannot switch models.

The board classifies each window by remaining quota. Routing also considers how soon quota resets. It ignores recent burn because a pace projection once marked Codex `tight` with 57% of its weekly quota left. Usage readings retain `projectedExhaustion` for compatibility.

On the board, a provider that is `stale`, `unknown`, or `exhausted` by a reported limit shows that status on its account-wide gauges instead of each window's own.

## Where usage comes from

| Source | Used for | Freshness |
| --- | --- | --- |
| AgentGauge's `usage-cache.json` | Every agent's windows | As AgentGauge polls: 3 to 10 minutes, stretching to 30 while the user is away |
| AgentGauge's `usage-history.db` | Last 90 minutes of samples per window, for `projectedExhaustion` | Same |
| Codex's own rate limits (`account/rateLimits/*` on `app-server`) | Codex, whenever newer than AgentGauge's reading | Live while a Codex job runs |
| A job failing on a usage limit | Marks that agent `exhausted` immediately | Lifted by a newer reading showing room in all deciding windows ([usage status](#usage-status)), or after 5 hours |

Codex's live `account/rateLimits/read` and `account/rateLimits/updated` readings display on the board and supplement AgentGauge for `route` whenever newer than AgentGauge's cache.

Both AgentGauge files open read-only. Crew holds no credentials and makes no provider requests. Two cache formats are supported: macOS (version 1 in `~/Library/Application Support/AgentGauge`) and Windows (version 4 in `%APPDATA%\Gauge`). Windows PascalCase tool names and ID-less window names (`Claude`, `Weekly`) normalize to macOS spelling, and SQLite history queries ignore case (`COLLATE NOCASE`) so Codex readings match on both platforms. Signed-out tools are skipped. On unsupported platforms or unknown versions, agents report `unknown` and roles run as assigned.

Stale and unknown readings never move work: `route` keeps the assigned holder and notes that usage is unknown.

G2 (`--json` output) and G3 (activity signal and threshold hook) remain open in AgentGauge. Until G3 lands, AgentGauge slows polling during unattended runs, so Claude usage can go `stale`. Codex has its live supplement, and Claude and Antigravity fall back to limit failures. See the [AgentGauge integration notes](../research/agentgauge-integration.md).

## Routing

`route` assigns work only to a role's configured holders or the lead. It treats a `tight` window as `ok` when its reset is within 15 minutes or 10% of the window's duration, whichever is longer (15 minutes if no duration is recorded). All applicable `tight` windows must meet their own threshold for the holder to count as `ok`, and the reason includes the reset time.

Among usable holders, routing prefers Antigravity for `polish` and Codex for other roles, placing Claude last among workers and the lead after the workers. Even when a role lists the lead's own agent, routing considers it only when no worker can take the work (because none is listed, enabled, or able to run the app). A `tight` or `exhausted` worker's row in the table below still applies. A holder with room takes precedence over a `tight` or `exhausted` one. Within the same usable status (`ok` or `tight`), a holder drops behind its peers if its longest applicable window has less than half the quota expected under even spending—for example, with 80% of the window's time left, the tie-breaker applies below 40% quota remaining. It never changes the holder's status, and an `unknown` or `stale` reading keeps its place in the preference order.

When the lead's own agent holds `fix` (the default, where both Codex and Claude hold it), routing keeps fixing with the lead to triage and decide whether to fix the findings itself or share them with a worker—considering sharing first when there is a lot to fix—and hands the fix to a worker with room only when the lead is short (if none has room, the lead fixes it itself); when only workers hold `fix`, the table below applies.

A `review`, `verify`, or `debate` goes to an available configured holder, including one with `tight` quota. If all usable holders are `exhausted` and every exhausted deciding window on the selected holder resets within 30 minutes, the lead runs the cross-check after the last reset: the holder keeps the work, `deferUntil` gives that reset time, and `degraded` stays `false` (otherwise the `exhausted` column below applies).

| Kind | Holder `tight` | Holder `exhausted` |
| --- | --- | --- |
| `delegate`, `refactor`, `fix` | Lead takes the work unless the lead is also short | Lead takes the work (`fix`: lead fixes findings itself) |
| `release` | As `delegate` | Lead prepares the release itself and publishes/deploys nothing |
| `review` | Still the holder, one round | Lead repeats its self-review; `degraded` |
| `verify` | Still the holder, one round | Lead runs the app in its own self-review; `degraded` |
| `debate` | Still the holder, one or two rounds | Lead decides alone and notes debate was skipped; `degraded` |
| `polish` | Deferred until reset; lead makes urgent wording fixes | Same |
| `lead` | The lead keeps to planning/merging and hands more implementation to the engineer | Still the lead (`degraded`): finish the current step if the engineer has room, else stop, and tell the user the lead is out of usage (no other agent can lead this session) |

Each role maps explicitly to a policy (`build`, `review`, `debate`, or `polish`) in `route()`, so a new role cannot fall through to another's.

A Codex lead asks with `lead=codex`. "The lead" in the table means that session, and an assignee or fallback that is the lead's own agent (`claude` for a Claude lead, `codex` for a Codex lead) means "you, the lead". A role the lead's own agent holds is the lead's own work ("Codex holds the role: do the work yourself"), and under a Codex lead `claude` is a worker judged by Claude's own usage.

## Presets

`preset` in `~/.crew/config.json` is `economy`, `balanced`, or `best` (unset by default). A role setting overrides the preset, and the preset overrides the agent's global config.

| Preset | Codex and Claude effort | Lead's subagents | Worker tier cap (`maxTier`) |
| --- | --- | --- | --- |
| `economy` | `low` | `haiku`, `sonnet` at most (`subagentMax`) | `standard` |
| `balanced` | `medium` | `sonnet` | none |
| `best` | `high` | lead's own model (`inherit`) | none |

`subagentModel` and `subagentMax` name Claude models, so a Codex lead is told to keep its subagents on its own model under every preset.

Under `economy`, `maxTier: "standard"` caps worker models at the `standard` tier (Sol for Codex, Hydrogen for Antigravity, Sonnet for Claude): a higher tier or larger named model is lowered to it, while the lead may still set a custom effort per job.

Built-in presets name no worker models because account availability differs. Customize a preset's `codex`, `claude`, or `antigravity` `model` and `effort` under `presets`:

```json
{
  "preset": "best",
  "presets": { "best": { "codex": { "model": "gpt-6.1-sol" } } }
}
```

### Presets per mission

A mission's `preset` overrides the global preset for jobs started under it. Role models and efforts still win. The lead passes `preset` to `mission` only when the user names one and never picks one itself. Users can also change it from the mission menu on the board or in the app. Changes apply to new jobs. Each job records `Job.preset` at start and keeps its preset and model across follow-ups.

The preset belongs to the work, not the card. Stopping tracking on the board keeps the mission ID (`costMission`) and preset on new jobs until the lead finishes the mission or opens another. A job naming an unknown mission fails once with no fallback to the global preset. After an MCP server restart, the next job or `route` reads the session's open mission from the daemon. If the mission closed while the MCP server was down, the lead keeps the preset and leaves the card closed. Because session instructions are fixed at start, `mission` and `route` replies state the active preset and subagent cap.

### Tiers

A job can name its difficulty via `tier` (`delegate`, `review`, `polish`, `debate`), and the bridge maps it to a model family ([tiers.ts](../plugin/bridge/tiers.ts)). Jobs without a tier use the default (`light` for read-only questions, `standard` otherwise).

| Tier | Use | Codex | Antigravity | Claude worker | Codex effort |
| --- | --- | --- | --- | --- | --- |
| `fast` | Plain searches and lookups | Luna | Hydrogen | `haiku` | `medium` |
| `light` | Simple, well-specified tasks; default for a question | Terra | Hydrogen | `haiku` | `medium` |
| `standard` | Most work, including most UI changes; the default | Sol | Hydrogen | `sonnet` | `medium` |
| `frontier` | Especially hard/complex work, a UI rebuilt from scratch, or literary/very complex documents | Astra | Neon | `opus` | `high` |

Tiers name model families, not versions. For Codex, Crew picks the newest unhidden model in that family from `$CODEX_HOME/models_cache.json` (falling back to Codex's default). For Antigravity, Crew matches the session's offered model list (skipping orchestrators) and falls back to the agent's default. Because Antigravity element names do not encode rank, families are mapped manually. `Neon` holds `frontier`. The displaced `Argon` stays recorded in `FORMER_FAMILIES` so explicit Argon models still run and preset caps still lower them.

- **Model precedence:** explicit job `model` (a versionless family name such as `"Astra"` resolves as its tier), job `tier`, configured model (role, preset, or `codex.model`/`antigravity.model`/`claude.model`), then default tier.
- **Effort precedence:** job `effort`, role or preset `effort`, then for Codex a named tier effort, `codex.effort`, or default tier effort, and for a Claude worker `claude.effort` when no tier is named. Under `economy`, jobs stay `low` unless the lead overrides `effort`. Antigravity accepts `effort` only from the job, role, or preset (mapped to `thought_level`).

## Tests

`test/usage.test.ts`, `test/settings.test.ts`, and `test/tiers.test.ts`. The macOS cache was checked against AgentGauge 0.8.2 and the Windows cache against a live install.

## History

- 2026-11-16: Added Windows Gauge usage files as part of bridge parity, verified on Windows 11 with Codex CLI 0.166.0 and Git for Windows 2.53.
