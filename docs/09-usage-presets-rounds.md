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
| `POST /api/jobs` | `{ "kind": "delegate", "ask": true, "task": "question", "cwd": path }` | A read-only job whose report is the answer |
| `POST /api/jobs/:id/rounds/:turn` | `{ "undo": true }` or `{ "keep": true }` | The job. `undo` reverts that round's commit on the job branch; `keep` reverts the revert |

A round can be undone or kept only while the job is not running or waiting, its worktree still exists, and the revert applies cleanly; otherwise the request fails with the reason and nothing changes.

## 3. Usage status

| Status | Means |
| --- | --- |
| `ok` | Room to spare |
| `tight` | At the recent pace the window runs out before it resets, or little is left |
| `exhausted` | Nothing left, or a job just failed on this agent's usage limit |
| `stale` | AgentGauge's reading is too old to act on |
| `unknown` | No reading: AgentGauge is not installed, or its file has a format this version does not know |

A provider's status is that of its tightest account-wide window. Windows scoped to one model (`group` set) are listed with their own status and do not decide it.

## 4. Intents on the board

The board's New Job form sends one of three things:

| Intent | What the board calls |
| --- | --- |
| Command | `POST /api/jobs`, as before |
| Question | `POST /api/jobs` with `kind: "delegate"` and `ask: true` |
| Information | `POST /api/missions/:id` with `note` when a mission is chosen, else `POST /api/instructions` with `append` |

## 5. Progress roll-up

Computed by each client from data it already has, so the two boards agree:

- A job counts `1` when done, `0.5` while running or waiting, and `0` when failed or cancelled.
- A stage of an active mission is complete when the mission has moved past it. The current stage is worth the mean of its jobs' counts, or `0.5` when it has none; jobs belong to the stage that was current when they were created (`createdAt` against the mission's `updatedAt` is not recorded, so all of a mission's unfinished jobs count toward the current stage and finished ones toward earlier stages).
- Mission progress = (completed stages + current stage's share) / 7, shown as a percentage on the collapsed card. A done mission is 100%.
