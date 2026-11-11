# 03. AgentGauge Integration Plan

Written 2026-11-11. Covers requirement R8 ([01-requirements.md](01-requirements.md)). The current state of AgentGauge was verified by reading the code and documentation at commit `a52141f` on the `main` branch of `ghostface2232/AgentGauge` (2026-11-11). Builds and tests were not run.

## 1. Purpose

Agents check their own remaining quota and that of the other services, and route work accordingly. When all services have room to spare, work follows the original role assignments ([02-implementation-plan.md](02-implementation-plan.md) section 4). AgentGauge handles two things in this setup:

- Usage measurement: replaces the error-string heuristics from document 02 section 5 with measured quota data.
- Routing decisions: supplies the inputs to a deterministic routing policy (`route`).

It does not display live session status (who is doing what right now).

## 2. Current state of AgentGauge

| Area | Status |
| --- | --- |
| Version | Tag 0.7.7 (2026-11-10), plus PR #53 (daily breakdown of weekly bars) and PR #54 (manual refresh fix) merged to `main` |
| Platforms | Windows (WinUI 3, .NET 10) and macOS (SwiftUI, macOS 14+) ship at the same version |
| Providers | Claude, Codex, Antigravity, and GitHub Copilot on both platforms; Cursor on macOS only |
| Claude | Reads 5-hour, weekly, and per-model weekly limits (such as Fable) |
| Codex | Reads 5-hour, weekly, named extra limits, and remaining reset credits |
| Antigravity | Attaches to a running engine or briefly delegates to a spawned engine to read Gemini and Claude/GPT buckets |
| Multi-account | Separate per-account cards and history for Claude, Codex, and Copilot |
| Size | ~18,600 lines with 649 test methods on Windows; ~12,200 lines with 346 test methods on macOS (counted from source) |
| External surface | None: no CLI JSON output, IPC, HTTP, or MCP |

## 3. Existing assets usable for integration

### 3.1 Normalized snapshots

Every provider normalizes into a single `UsageSnapshot` representing one tool at one point in time:

- Snapshot: tool name, plan, list of windows, reset credits, capture timestamp (`CapturedAt`)
- Window (`UsageWindow`): kind (5-hour, weekly, billing cycle), stable identifier (`Id`), group (`GroupLabel`, model or family), usage ratio (`UsedRatio`, 0–1), reset time, duration, optional token counts

### 3.2 Files on disk

| File | Windows | macOS | Notes |
| --- | --- | --- | --- |
| Latest snapshot cache | `%APPDATA%\Gauge\usage-cache.json` | `$HOME/Library/Application Support/AgentGauge/usage-cache.json` | Document shape differs by platform: Windows uses version 4 with a `Tools` array; macOS uses version 1 with a `snapshots` array |
| History | `%APPDATA%\Gauge\usage-history.db` | `$HOME/Library/Application Support/AgentGauge/usage-history.db` | SQLite WAL, 90-day retention. The `samples` table schema is identical on both platforms |

Columns in `samples`: `tool`, `window_key`, `group_label`, `captured_at`, `used_ratio`, `reset_time`, `used_tokens`, `limit_tokens`, `reset_credits`, `reset_credit_expiry`. Only fresh measured reads are written; tokens and credentials are never stored.

### 3.3 Existing calculations

- Projected exhaustion time (`UsageEtaClassifier`): fits a least-squares slope over roughly the last 90 minutes of samples. Emits a projection only when at least 3 measured reads span 30 minutes or more, the slope is positive, and projected exhaustion falls before the window reset. Exposed as `projectExhaustion(samples:now:)` in `GaugeCore` on macOS, and under `ViewModels` on Windows.
- Cycle boundary detection (`UsageCycleBoundary`), pace model, and threshold notification evaluator (`UsageNotificationEvaluator`, firing at 70% and 90%, or 90% only for 5-hour windows).

### 3.4 Refresh intervals

- Base intervals (identical on both platforms): Codex 3 min, Claude 5 min, Antigravity 10 min, Copilot 15 min, and Cursor 5 min on macOS.
- Adaptive multiplier: 1x within 5 minutes of the last popover open, 2x within 1 hour, 4x under 4 hours, and 10x beyond that or during sleep/screen lock, capped at 30 minutes.
- Because the Claude endpoint returns HTTP 429 after roughly 3 reads in a short window, a hard 5-minute floor is enforced even across manual refreshes.
- Antigravity enforces a 2-minute floor on popover-triggered reads because of the cost of spawning the engine.

## 4. What is missing for integration

1. No external surface. A second instance exits silently, and command-line flags exist only for demo mode and updates.
2. On Windows, the app is a single `WinExe` project with no `Core` library separated from the UI. On macOS, `GaugeCore` is already a Foundation-only library and only needs a CLI executable target.
3. Threshold notifications go only to system toasts. With no outbound event channel, nothing can trigger a pre-exhaustion handoff from the lead.
4. Adaptive polling works against this use case: agents burn through quota fastest while the user is away and not opening the popover, which is exactly when the polling interval stretches to its maximum.
5. Cache file formats differ by platform and are internal implementation details with no contract for external consumers.

## 5. Alignment with existing decisions in the AgentGauge repository

This integration plan follows the decisions already recorded in the AgentGauge repository:

| Recorded decision | Source | Constraint on this plan |
| --- | --- | --- |
| Extracting `Gauge.Core` and adding one-shot `--json` output with a generic schema is a P2 / L backlog item; a resident server (`serve`) is overkill | `doc/codexbar-reference.md` sections 3.10 and 4.I | Do not embed a resident HTTP server in the app; use `--json` with a stdio MCP server on top |
| Start with a generic schema from day one so provider-specific keys do not break later | Same doc, section 3.10 | Design `get_usage` without provider-specific keys |
| Do not scan local processes to detect running agents | Same doc, section 5; `AGENTS.md` adaptive refresh notes | AgentGauge does not detect session state on its own; it only accepts signals pushed by consumers |
| Depth over provider count | Same doc, section 5 | Keep AgentGauge scoped strictly to usage measurement and routing decisions |
| Credentials belong to each CLI; AgentGauge is read-only with no developer server | `AGENTS.md`, `PRIVACY.md` | The MCP surface exposes snapshots only and never exposes tokens through any path |
| Decouple data collection from UI; UI depends only on `UsageSnapshot` | `AGENTS.md` core rules | Attach the MCP surface as another consumer of `UsageSnapshot` |

## 6. Phased integration plan

### G1. Read-only MCP server without modifying AgentGauge

- Place a stdio MCP server on the Crew side that only reads the cache file and history database.
- No token access and no network listener. Open the history database in read-only mode.
- Provide two platform-specific cache adapters for the differing file shapes, returning `unknown` if the version field is unrecognized.
- Recompute projected exhaustion from the `samples` table using the same rules as section 3.3.
- Limitations: breaks if the internal cache format changes, and snapshots can be up to 30 minutes stale because polling cannot be nudged.
- Done when: the lead session calls `get_usage` and `route` and receives values for all three services.

### G2. `--json` output (work in the AgentGauge repository)

- Implement item I from `doc/codexbar-reference.md` section 4: one-shot `--json` output using a generic schema.
- Start on macOS, which only requires adding an executable target over `GaugeCore`. Windows requires extracting `Core` first.
- Include per-account entries in the output to support multi-account setups.
- Switch the G1 MCP server from reading files to reading `--json` output, insulating it from cache format changes.
- Done when: the same MCP tools run on top of `--json` and direct cache file reads are removed.

### G3. Freshness and events

- Consumer activity signal: count MCP calls as user interaction alongside popover opens so the adaptive multiplier does not back off while agents are active. Because the consumer signals directly without process scanning, this respects the constraint in section 5.
- Threshold hook: run a configured external command or append a line to an event file when a window crosses a threshold. This triggers the pre-exhaustion lead handoff.
- Immediate limit reporting: when a worker or the bridge hits a quota error and calls `report_limit`, mark that service exhausted immediately without waiting for the next poll.
- Done when: an automatic handoff is reproduced once when the lead's 5-hour window crosses the threshold.

## 7. Proposed MCP tool specification

Limit the surface to three tools, since tool definitions consume context in every agent session.

### 7.1 `get_usage`

No input. Returns the list of windows per service and account. Values below illustrate the shape:

```json
{
  "generated_at": "2026-11-11T13:20:00Z",
  "providers": [
    {
      "tool": "Claude",
      "account": "default",
      "plan": "Max 5x",
      "captured_at": "2026-11-11T13:17:40Z",
      "snapshot_age_sec": 140,
      "status": "ok",
      "windows": [
        {
          "key": "FiveHour",
          "group": null,
          "used_ratio": 0.42,
          "reset_time": "2026-11-11T15:00:00Z",
          "duration_sec": 18000,
          "projected_exhaustion": null
        }
      ]
    }
  ]
}
```

- `status`: `ok`, `tight`, `exhausted`, `stale`, or `unknown`.
- Does not poll providers on each call. Returns the cached snapshot with its capture age, leaving AgentGauge's polling rate limits intact.

### 7.2 `route`

Input: `task_kind` (`lead`, `implement`, `review`, `copy_polish`). Returns the assignee, rationale, fallback order, and whether quality is degraded:

```json
{
  "assignee": "codex",
  "reason": "all providers ok; default role",
  "fallback": ["claude"],
  "degraded": false,
  "defer_until": null
}
```

- Called by the lead at stage boundaries only, not on every turn.
- Never called by workers, preventing re-delegation loops.

### 7.3 `report_limit`

Input: `tool`, `account`, `detail` (error text), `observed_at`. Called immediately by the bridge or a worker when a quota error occurs. Held in memory by the MCP server in G1, and forwarded to AgentGauge in G3.

## 8. Routing policy

### 8.1 Classification rules

- Do not judge by remaining percentage alone. Mark a window `tight` if projected exhaustion comes before `reset_time`, and `exhausted` if remaining quota hits 0 or `report_limit` arrives. Ten percent remaining with a reset in 20 minutes is comfortable; forty percent remaining with four days until reset is tight.
- When samples are too sparse for a projection, fall back to remaining-quota thresholds with hysteresis so routing does not flap: switch away at 15% remaining and switch back at 30% remaining (initial values, tunable).
- When a service has multiple windows, follow the tightest applicable window. Model-specific windows (such as Fable) apply only to tasks using that model.
- If a snapshot is too old, mark it `stale`, keep default role assignments, and rely on `report_limit`.

### 8.2 Routing table

| State | Routing decision |
| --- | --- |
| All services `ok` | Follow default roles |
| Codex `tight` | Claude subagents take implementation slices; save remaining Codex quota for review |
| Codex `exhausted` | Replace cross-review with Claude's dedicated review subagent and flag the result as missing cross-review (`degraded: true`) |
| Antigravity `tight` or `exhausted` | Copy, comment, and doc cleanup is not a merge gate; defer until after `reset_time` (`defer_until`), or let Claude handle urgent wording fixes |
| Claude `tight` | Shift more implementation slices to Codex while Claude focuses on planning and merge decisions |
| Claude nearing exhaustion | Write a handoff note and run `/codex:transfer` to hand the session to a Codex thread, making Codex temporary lead |

Antigravity is never promoted to implementation or code review; R3 restricts it to wording and documentation cleanup.

### 8.3 Watchdog

An exhausted lead cannot reroute work on its own. Detecting near-exhaustion for Claude and triggering the handoff must happen outside the lead, which is the job of the G3 threshold hook. Until G3 is built, the user triggers the handoff manually upon seeing AgentGauge's existing toast notification (at 90% of the 5-hour window).

## 9. Supplemental data paths

Two official channels update faster than AgentGauge's polling interval and can bridge polling gaps alongside `report_limit`:

- Claude Code statusline: the JSON passed to a statusline script includes `used_percentage` and `resets_at` for `rate_limits.five_hour` and `rate_limits.seven_day`, updating live during a session without polling. Per-model weekly limits are not in this payload, so AgentGauge polling is still needed.
- Codex `app-server`: provides the `account/rateLimits/read` request and `account/rateLimits/updated` notification at zero extra cost since the bridge already holds `app-server`.
- Antigravity: no official usage channel was investigated; AgentGauge's provider remains the sole source.

## 10. Out of scope

- Adding session-status lanes to the AgentGauge popover (conflicts with the scope rules in section 5).
- Running a resident HTTP server inside the AgentGauge process.
- Automatic account rotation. Multi-account figures appear in `get_usage`, but whether rotating accounts to bypass rate limits complies with each vendor's terms of service has not been verified.

## 11. Open items

- Where to host the G1 MCP server (first choice: a standalone package inside the Crew repository).
- Finalizing the generic `--json` schema (section 7.1 is a proposal to be locked down in the AgentGauge repository).
- Shape and security boundary of the threshold hook (external command, event file, or both, and who is allowed to register the command).
- How AgentGauge receives consumer activity signals without a resident server (e.g., a file-based signal or treating `--json` invocations themselves as activity).
- Initial threshold values (15% / 30%) and the `stale` cutoff age.
- Schedule for extracting `Core` on Windows.

## 12. Revision log (2026-11-11)

- Proposed and withdrew adding loopback HTTP and MCP endpoints to the tray process; repository docs had already judged a resident server to be overkill.
- Proposed and withdrew merging the status board into the AgentGauge popover.
- Removed constraints written under the assumption that the macOS port and Antigravity provider did not yet exist; both ship in 0.7.7.

## 13. Verification sources

- AgentGauge repository: https://github.com/ghostface2232/AgentGauge (`README.md`, `AGENTS.md`, `PRIVACY.md`, `doc/codexbar-reference.md`, `Models/`, `Services/UsageCacheStore.cs`, `Services/UsageHistoryStore.cs`, `mac/Sources/GaugeCore/`)
- `rate_limits` field in Claude Code statusline: https://github.com/anthropics/claude-code/issues/45133
- Codex `app-server` rate limit methods: https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- `/codex:transfer` in the Codex plugin: https://github.com/openai/codex-plugin-cc
