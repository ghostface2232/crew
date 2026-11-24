# MCP host compatibility

Tested 2026-11-14 on this Mac (arm64). Follows [P2-7](../research/crew-evolution-synthesis.md). These are installed-host observations, not claims about every release or configuration.

## 1. Tested hosts

| Host | Installed version | Method | First MCP request | Legacy negotiation | Tasks extension advertised |
| --- | --- | --- | --- | --- | --- |
| Claude Code (`claude`) | 2.1.323 | Live isolated stdio probe | `server/discover`, `2026-07-28` | After `-32601`, sends `initialize`, `2025-11-25`; reaches `tools/list` | No, in either captured capability object |
| Codex CLI (`codex exec`) | 0.167.0 | Live isolated stdio probe | `initialize`, `2025-06-18` | Reaches `tools/list` | No |
| Codex app-server (`codex app-server`) | 0.167.0 | Live isolated stdio probe, triggered by `thread/start` | `initialize`, `2025-06-18` | Reaches `tools/list`; same MCP messages as CLI | No |

Version evidence: `claude --version` printed `2.1.323 (Claude Code)`; `codex --version` printed `codex-cli 0.167.0`. Executables resolved through `/Users/baemingwan/.local/bin/claude` and `/Users/baemingwan/.local/bin/codex`. The app-server is the latter executable's subcommand; a separately bundled desktop app binary was **not tested**.

## 2. Probe method and evidence

The probe used a temporary Python stdio server that imitated Crew's replies. Crew and its daemon were never started. The stand-in logged each incoming newline-delimited JSON-RPC message, echoed the requested `protocolVersion` on `initialize`, returned `capabilities: {"tools":{}}` with `serverInfo: {"name":"compat-probe","version":"1"}`, returned `{"tools":[]}` on `tools/list`, ignored notifications, and returned `-32601` for unsupported requests (matching Crew's behavior):

```json
{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found: server/discover"}}
```

Each host ran in a fresh temporary working directory with isolated `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and host config directories, with inherited `CLAUDE*`, `CODEX*`, and `CREW*` variables removed and no real user or project config touched.

Claude used a temporary `CLAUDE_CONFIG_DIR` and MCP JSON (`<python>`, `<server>`, `<log>` were absolute paths):

```json
{"mcpServers":{"probe":{"command":"<python>","args":["<server>","<log>"]}}}
```

```sh
claude -p 'Reply OK.' --mcp-config <temp-json> --strict-mcp-config \
  --setting-sources '' --no-session-persistence --tools ''
```

Captured incoming Claude MCP messages (complete capability objects):

```jsonl
{"jsonrpc":"2.0","id":"server-discover-probe-1","method":"server/discover","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.323","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"},"io.modelcontextprotocol/clientCapabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}}}}}
{"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{"listChanged":true},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.323","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"method":"tools/list","jsonrpc":"2.0","id":1}
```

Codex used a temporary `CODEX_HOME` containing only this `config.toml`:

```toml
[mcp_servers.probe]
command = "<python>"
args = ["<server>", "<log>"]
```

The CLI ran `codex exec --skip-git-repo-check 'Reply OK.'`. A separate isolated home ran `codex app-server`, sending app-server `initialize` (`clientInfo: {"name":"compat-probe","version":"1"}`, `capabilities: null`), `initialized`, and `thread/start` (`approvalPolicy: "never"`, `sandbox: "read-only"`). That outer app-server handshake is separate from the MCP messages below.

Both Codex runs sent these incoming MCP messages:

```jsonl
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":{"codex/auth-change":{}},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.167.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
```

Neither Codex capture sent `server/discover`. No Tasks capability or extension appeared in any captured host capabilities, though this alone does not prove the binaries lack optional Tasks support.

No credentials were copied into the temporary homes, so after MCP listing Claude exited with `Not logged in · Please run /login`, Codex CLI hit network/DNS errors on model requests and was terminated after 25 seconds, and `codex app-server` returned `thread/start` and MCP listing before termination (Codex also warned it could not create PATH helper aliases in the temporary home). All probe processes and temporary files were removed afterwards.

## 3. Crew today and impact

Both [lead MCP transport](../plugin/bridge/mcp.ts) (`PROTOCOL_VERSIONS`, `handle`) and [worker MCP transport](../plugin/bridge/worker-mcp.ts) advertise accepted revisions `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05` in `initialize`, echoing a recognized request version or falling back to `2025-06-18`. Both advertise only `capabilities: { tools: {} }`, return `-32601` for unknown methods, and do not implement `server/discover`, the Tasks extension, or MRTR (which replaces server-initiated requests in `2026-07-28`).

The lead transport also checks `params?.capabilities?.elicitation` and can send `elicitation/create` as a server-initiated request (`request` in `mcp.ts`), which remains a legacy-protocol path.

The first run returned an empty discovery result. The evidence here comes from the repeat run with an explicit error. No startup incompatibility was observed: Claude falls back after `-32601` on `server/discover`, and Codex requests `2025-06-18` directly. Live Crew tool execution, elicitation, cancellation, and a `2026-07-28` discovery/MRTR exchange remain **unverified** by this probe. A future discovery-only client could fail on `-32601`, so Claude's fallback should not be assumed permanent.

## 4. Recommendation

**Wait** on migrating to the `2026-07-28` transport, Tasks, and MRTR. Do not add `2026-07-28` to `PROTOCOL_VERSIONS` alone: the current dispatcher and server-initiated elicitation path do not implement that protocol.

Re-run this isolated probe after host upgrades or connection failures, and migrate when a supported host requires `2026-07-28` or a Crew feature needs the Tasks extension (retaining legacy negotiation for Codex).

## 5. Codex as a lead host

Tested 2026-11-24 on Windows 11 with `codex-cli 0.170.0`, for [roadmap L1](roadmap.md#5-long-term-plan). Stand-in MCP servers and hook scripts logged what Codex passed them; Crew itself was not loaded. Hook and plugin loading ran in isolated `CODEX_HOME` directories; the tool-call and `codex queue` checks ran three short turns on the real account with `-c` overrides, leaving `~/.codex` files unchanged.

| Question | Observed |
| --- | --- |
| Session identity in an MCP server | Not in the environment: Codex starts stdio MCP servers with a filtered environment that has no thread variable (not even `CODEX_HOME`). Every `tools/call` carries it in `params._meta`: `threadId`, `sessionId`, and `x-codex-turn-metadata` (`thread_id`, `turn_id`, `model`, `sandbox_mode`, `thread_source`). Hook payloads carry the same value as `session_id`. |
| MCP server working directory | The session's working directory, when the server entry sets no `cwd`. |
| Hook events and payloads | `SessionStart` (`source: startup`), `UserPromptSubmit` (`prompt`, `turn_id`), `PreToolUse` and `PostToolUse` (`tool_name` such as `mcp__probe__whoami`, `tool_input`, `tool_use_id`, `tool_response`), `Stop` (`stop_hook_active`, `last_assistant_message`), and `SessionEnd`, all with `session_id`, `cwd`, `model`, and `permission_mode`. `SessionStart` `hookSpecificOutput.additionalContext` reached the model. Command hooks run under `pwsh.exe` on Windows and inherit the full environment. |
| Hook trust | Untrusted hooks are skipped without an error in `codex exec`. `--dangerously-bypass-hook-trust` runs them. Users trust hooks in `/hooks` (CLI) or Review hooks (desktop app); the docs say trust is recorded against the hook's hash, so changed hooks or bundled scripts need another review. |
| Claude plugin format | `codex plugin marketplace add <repo>` read `.claude-plugin/marketplace.json`; `codex plugin add` copied the plugin into `$CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/` and enabled it. Its `skills/` loaded as `<plugin>:<skill>`. Its `hooks/hooks.json` loaded in the CLI, with `PLUGIN_ROOT`, `CLAUDE_PLUGIN_ROOT`, and `PLUGIN_DATA` set. |
| Hook command form | A string command (`node "${CLAUDE_PLUGIN_ROOT}/bin/hook.cjs" tag`) ran. The `command` plus `args` form that Crew's `hooks.json` uses failed. |
| Plugin MCP servers | `.mcp.json` servers were listed, but `${CLAUDE_PLUGIN_ROOT}` and `${PLUGIN_ROOT}` in `args` were passed through unexpanded, and the server did not start. Only a relative path with `"cwd": "."` started, and then the server's working directory was the plugin cache rather than the session's. |
| Waking an idle session | `codex queue --thread <id> --message <text>` stores the message. An open interactive session (`codex` TUI) that was idle ran it as a new turn within seconds. With no open session the message stays queued; `--resume` warns that it needs a local app-server daemon or `--remote`. |

**macOS.** Checked 2026-11-24 on macOS with `codex-cli 0.171.0` (isolated `CODEX_HOME`, five short turns) and the Codex desktop app 26.1117, whose bundled `codex 0.171.0-alpha.13` serves every desktop thread from one app-server process. For the desktop checks the stand-in plugin was installed in `~/.codex` and removed afterwards. The Windows findings held, with these differences and additions:
- **Hook commands.** They run under the account's login shell, `/bin/zsh` here, not `/bin/sh`, and setting `SHELL` does not change that. `${PLUGIN_ROOT}` is set and expands.
- **Hook environment.** Hooks inherit Codex's full environment, so a Codex started from a Claude Code terminal passes `CLAUDE_CODE_SESSION_ID` and `CLAUDE_PLUGIN_ROOT` to its hooks.
- **Plugin manifest.** `.codex-plugin/plugin.json` pointers win over `.mcp.json` and `hooks/hooks.json`. A relative path with `"cwd": "."` starts the MCP server in the plugin cache, and a server without `cwd` starts in the session's folder.
- **Reinstalling and links.** `codex plugin add` at an unchanged version refreshes the cache from a local marketplace. Symbolic links inside the plugin are left out of the copy.
- **Trust.** Trusting hooks in the CLI's `/hooks` (`t` trusts all) writes `[hooks.state."<plugin>@<marketplace>:<hooks file>:<event>:<group>:<index>"] trusted_hash` to `~/.codex/config.toml`, and the desktop app honours it. Untrusted plugin hooks did not run in the desktop app either.
- **Desktop MCP servers.** The desktop client sends `server/discover` before `initialize`. A server that answers with an empty result fails the handshake, while a `-32601` error falls back to `initialize`. Each desktop thread starts its own plugin MCP server, a child of the shared app-server, and only once the thread needs the server's tools, not when the thread starts. `x-codex-turn-metadata` adds `client_type: "desktop_app"`.
- **Tool approval.** In the CLI's default approval mode, the first call to a plugin MCP tool asks the user to allow it. The desktop app on "Approve for me" did not ask.
- **Waking with `codex queue`.** It woke an idle TUI and an idle desktop thread within about four to seven seconds. A message queued while a turn was running waited for that turn to end, then ran as its own turn, in both the TUI and the desktop app.

**Not verified:** elicitation from a Crew tool call. MCP elicitation is advertised in `initialize` (section 1).
