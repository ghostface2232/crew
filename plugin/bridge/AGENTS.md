# plugin/bridge

The bridge is everything in Crew that is not a user interface: the daemon, the MCP server the lead talks to, the MCP server workers talk to, the Codex and Antigravity adapters, the Claude Code hooks, and the `crew` CLI. How the pieces fit is in [docs/architecture.md](../../docs/architecture.md).

## Rules

- Node 22.18+ runs these files as written, by stripping types: there is no build step. Use only erasable TypeScript (`erasableSyntaxOnly`: no enums, namespaces, or parameter properties), and import with the `.ts` extension. A desktop app carries a compiled copy and points the plugin's commands at its `.js` files (`scripts/bundle-plugin.mjs`).
- No runtime dependencies, including the MCP SDK: the protocol subset Crew needs is implemented in `mcp.ts` and `worker-mcp.ts`. `rpc.ts` is the JSON-RPC peer the adapters use to talk to `codex app-server` and `agy acp`.
- Every path works on macOS and Windows. Windows needs its own handling for processes (`SIGTERM` is a hard kill there), file locks during removal, junctions in place of symlinks, and shell commands.
- The daemon listens on a port any local process can reach, so its routes need the secret in `~/.crew/token`, a scoped board credential, or a worker's job token (`auth.ts`, `WORKER_ROUTE` in `daemon.ts`). Only the routes `isOpen` in `daemon.ts` allows answer without one (`/api/health`, `POST /api/session`, and any `GET` outside `/api/`), so any new `GET` route belongs under `/api/` ([docs/daemon-api.md](../../docs/daemon-api.md#authentication)).
- A daemon replaces itself when idle if the bridge files on disk differ from what it is running, so edits here reach a daemon started from this checkout without a version bump. To run a daemon that leaves the user's daemon alone, set `CREW_HOME` to a temporary directory and `CREW_PORT` to a free port; with `CREW_HOME` alone, clients find the user's daemon on the default port.
- Text a lead or worker reads (tool descriptions, results, and the prompts in `prompts.ts` and `plugin/roles/`) is part of the behavior. Keep it short and exact. Worker instructions are snapshotted in `test/prompts.test.ts.snapshot`; update it on purpose with `node --test --test-update-snapshots test/prompts.test.ts`.

## Where things are

| Area | Files |
| --- | --- |
| Daemon: HTTP routes, SSE, state, and lifecycle | `daemon.ts`, `client.ts` (`ensureDaemon`, version negotiation), `auth.ts`, `assets.ts` (board files) |
| Lead MCP server and its responses | `mcp.ts`, `render.ts`, `delivery.ts` (news, receipts, and response bounds) |
| Worker MCP server (`ask_lead`, `siblings`, `search`, `rate`, …) | `worker-mcp.ts` |
| Jobs, missions, and pull request watches | `jobs.ts`, `missions.ts`, `pulls.ts`, `runbook.ts` |
| Agent adapters | `adapters/codex.ts` (`codex app-server`), `adapters/antigravity.ts` (`agy acp`), `adapters/claude.ts` (`claude -p`, for a Codex lead), `rpc.ts` |
| Worktrees, includes, transport commits, and cleanup | `git.ts`, `gc.ts` |
| What a worker is told | `prompts.ts`, `instructions.ts`, `skills.ts`, `../roles/*.md` |
| Sandboxed checks and the macOS browser | `check.ts`, `browser.ts` |
| Lead hooks | `report.ts` (activity), `context.ts` (shared instructions), `wake.ts` (wake-ups), `claude.ts` (Claude session state); Codex runs the hooks in `../hooks/codex.json` |
| Waking Codex leads | `codex-lead.ts` (app-server queue API, `codex queue`) |
| Configuration, roles, presets, and tiers | `config.ts`, `settings.ts` (board settings writes), `tiers.ts` |
| Usage and routing | `usage.ts` |
| Evidence, model notes, and peer ratings | `evidence.ts`, `notes.ts` |
| Notifications | `toast.ts` (Windows); macOS uses `osascript` in `daemon.ts` |
| Plugin registration and the first-run checklist | `setup.ts` |
| `crew` command | `cli.ts` |
| Cutting text by length without splitting a surrogate pair | `text.ts` |

## Tests

Tests in `test/` are named by topic rather than by module (`worktrees.test.ts` covers `git.ts`, and `questions.test.ts` covers worker questions); run one with `node --test test/<file>.test.ts` and the whole suite with `npm test`. Agent CLIs are faked (`test/fake-bin.ts` and protocol stubs inside the tests), so no test spends real usage.
