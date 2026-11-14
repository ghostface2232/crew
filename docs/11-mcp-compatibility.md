# 11. MCP host compatibility

Tested 2026-11-14 on this Mac (arm64). Follows [P2-7](../research/crew-evolution-synthesis.md). These are installed-host observations, not claims about every release or configuration.

## 1. Tested hosts

| Host | Installed version | Method | First MCP request | Legacy negotiation | Tasks extension advertised |
| --- | --- | --- | --- | --- | --- |
| Claude Code (`claude`) | 2.1.323 | Live isolated stdio probe | `server/discover`, `2026-07-28` | After `-32601`, sends `initialize`, `2025-11-25`; reaches `tools/list` | No, in either captured capability object |
| Codex CLI (`codex exec`) | 0.167.0 | Live isolated stdio probe | `initialize`, `2025-06-18` | Reaches `tools/list` | No |
| Codex app-server (`codex app-server`) | 0.167.0 | Live isolated stdio probe, triggered by `thread/start` | `initialize`, `2025-06-18` | Reaches `tools/list`; same MCP messages as CLI | No |

Version evidence: `claude --version` printed `2.1.323 (Claude Code)`; `codex --version` printed `codex-cli 0.167.0`. Executables resolved through `/Users/baemingwan/.local/bin/claude` and `/Users/baemingwan/.local/bin/codex`. The app-server is the latter executable's subcommand; a separately bundled desktop app binary was **not tested**.

## 2. Probe method and evidence

A temporary Python stdio server logged each incoming newline-delimited JSON-RPC message before replying. It echoed the requested version on `initialize`, returned `capabilities: {"tools":{}}` and `serverInfo: {"name":"compat-probe","version":"1"}`, returned `{"tools":[]}` on `tools/list`, and ignored notifications. For unsupported requests, including `server/discover`, it returned:

```json
{"jsonrpc":"2.0","id":"server-discover-probe-1","error":{"code":-32601,"message":"Method not found: server/discover"}}
```

This matches Crew's unsupported-method behavior. An initial exploratory run returned an empty result for discovery and also observed Claude falling back; the evidence below is from the repeat with the explicit error.

Each host ran in its own temporary working directory with temporary `HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`, and host config directories. Inherited `CLAUDE*`, `CODEX*`, and `CREW*` variables were removed. No credentials or existing configs were copied. No real user or project config was edited.

Claude used temporary `CLAUDE_CONFIG_DIR` and this temporary MCP JSON (`<python>`, `<server>`, and `<log>` were absolute paths):

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

Codex used a new temporary `CODEX_HOME` containing only this minimal `config.toml` before launch:

```toml
[mcp_servers.probe]
command = "<python>"
args = ["<server>", "<log>"]
```

The CLI ran `codex exec --skip-git-repo-check 'Reply OK.'`. A separate isolated home was used for `codex app-server`; its stdin received app-server `initialize` with `clientInfo: {"name":"compat-probe","version":"1"}` and `capabilities: null`, then `initialized`, then `thread/start` with the temporary cwd, `approvalPolicy: "never"`, and `sandbox: "read-only"`. This outer app-server initialization is distinct from the MCP initialization captured below.

Both Codex runs produced these same incoming MCP messages:

```jsonl
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":{"codex/auth-change":{}},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.167.0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}
```

No `server/discover` appeared in either Codex capture. No tasks capability or extension appeared in any captured host capabilities. This does not prove that the binaries lack optional Tasks support.

Claude exited with `Not logged in · Please run /login` after MCP startup. Codex CLI reached MCP listing but model requests failed with network/DNS errors; it was terminated after 25 seconds. The app-server returned a successful `thread/start` and MCP listing without starting a model turn, then was terminated. Codex also warned that it could not create PATH helper aliases in a temporary home; this did not prevent MCP startup. Probe process groups were stopped and temporary scripts, configs, state, and raw logs removed after embedding the evidence here. No binary-inspection fallback was needed.

## 3. Crew today and impact

Both [lead MCP transport](../plugin/bridge/mcp.ts) (`PROTOCOL_VERSIONS`, `handle`) and [worker MCP transport](../plugin/bridge/worker-mcp.ts) advertise, through `initialize`, these accepted revisions: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`. They echo a recognized requested version; otherwise they return `2025-06-18`. Both advertise only `capabilities: { tools: {} }`. Neither implements `server/discover`, the Tasks extension, or MRTR. Unknown requests receive `-32601`.

The lead transport additionally checks the client's elicitation capability and can send `elicitation/create` as a server-initiated request. That remains a legacy-protocol path.

No startup incompatibility was observed with the tested host requests: Claude's discovery receives an error but falls back to a revision Crew accepts, and Codex requests a supported revision directly. The probe reproduced Crew's version response and unsupported-discovery behavior, rather than launching Crew or its daemon. Real Crew tool execution, elicitation, cancellation, and a successful 2026-07-28 discovery/MRTR exchange are **unverified** by this probe. A future discovery-only client would receive `-32601` and could fail; today's Claude fallback must not be assumed permanent.

## 4. Recommendation

**Wait** on implementing the 2026-07-28 transport migration, Tasks, and MRTR. Claude already probes the new revision, but its verified legacy fallback and Codex's legacy request leave no demonstrated startup blocker. Do not merely add `2026-07-28` to the accepted version array: the current dispatcher and server-initiated elicitation path do not implement that protocol.

Repeat this isolated probe after host upgrades or a reported connection failure. Implement the new discovery and request model when a supported host requires it or when a concrete Crew feature needs the Tasks extension, while retaining legacy negotiation for the tested Codex client.
