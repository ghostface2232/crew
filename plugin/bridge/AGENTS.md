# plugin/bridge

The bridge is everything in Crew that is not a user interface: the daemon, the MCP server the lead talks to, the MCP server workers talk to, the Codex and Antigravity adapters, the Claude Code hooks, and the `crew` CLI. How the pieces fit is in [docs/architecture.md](../../docs/architecture.md).

## Rules

- Node 22.18+ runs these files as written, by stripping types: there is no build step. Use only erasable TypeScript (`erasableSyntaxOnly`: no enums, namespaces, or parameter properties), and import with the `.ts` extension. A desktop app carries a compiled copy and points the plugin's commands at its `.js` files (`scripts/bundle-plugin.mjs`).
- No runtime dependencies, including the MCP SDK: the protocol subset Crew needs is implemented in `mcp.ts`, `worker-mcp.ts`, and `rpc.ts`.
- Every path works on macOS and Windows. Windows needs its own handling for processes (`SIGTERM` is a hard kill there), file locks during removal, junctions in place of symlinks, and shell commands.
- The daemon listens on a port any local process can reach. Every route checks the secret in `~/.crew/token` or a scoped board credential (`auth.ts`); new routes follow the same rules ([docs/daemon-api.md](../../docs/daemon-api.md)).
- A daemon replaces itself once idle when the bridge files on disk differ from what it runs, so edits here reach a daemon started from this checkout without a version bump. Set `CREW_HOME` (and `CREW_PORT` if needed) to a temporary directory to run a daemon that leaves the user's own alone.
- Text a lead or worker reads (tool descriptions, results, and the prompts in `prompts.ts` and `plugin/roles/`) is part of the behavior. Keep it short and exact, and update its snapshot (`test/prompts.test.ts.snapshot`) on purpose.

## Where things are

| Area | Files |
| --- | --- |
| Daemon: HTTP routes, SSE, state, and lifecycle | `daemon.ts`, `client.ts` (`ensureDaemon`, version negotiation), `auth.ts`, `assets.ts` (board files) |
| Lead MCP server and its responses | `mcp.ts`, `render.ts`, `delivery.ts` (news, receipts, and response bounds) |
| Worker MCP server (`ask_lead`, `siblings`, `search`, `rate`, …) | `worker-mcp.ts` |
| Jobs, missions, and pull request watches | `jobs.ts`, `missions.ts`, `pulls.ts`, `runbook.ts` |
| Agent adapters | `adapters/codex.ts` (`codex app-server`), `adapters/antigravity.ts` (`agy acp`), `rpc.ts` |
| Worktrees, includes, transport commits, and cleanup | `git.ts`, `gc.ts` |
| What a worker is told | `prompts.ts`, `instructions.ts`, `skills.ts`, `../roles/*.md` |
| Sandboxed checks and the macOS browser | `check.ts`, `browser.ts` |
| Claude Code hooks | `report.ts` (activity), `context.ts` (shared instructions), `wake.ts` (wake-ups), `claude.ts` (session state) |
| Configuration, roles, presets, and tiers | `config.ts`, `settings.ts` (board settings writes), `tiers.ts` |
| Usage and routing | `usage.ts` |
| Evidence, model notes, and peer ratings | `evidence.ts`, `notes.ts` |
| Notifications | `toast.ts` (Windows); macOS uses `osascript` in `daemon.ts` |
| Plugin registration and the first-run checklist | `setup.ts` |
| `crew` command | `cli.ts` |

## Tests

Tests in `test/` are named by topic rather than by module (`worktrees.test.ts` covers `git.ts`, `questions.test.ts` the worker questions); run one with `node --test test/<file>.test.ts` and the whole suite with `npm test`. Agent CLIs are faked (`test/fake-bin.ts` and protocol stubs inside the tests), so no test spends real usage.
