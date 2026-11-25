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

**Windows, later the same day.** With `codex-cli 0.170.0`:
- **Stop hooks.** Codex runs hook commands under `pwsh.exe`, which exits 1 when the command `node x.js` exits 2. A Stop hook that exits 2 with a reason on stderr shows "Stop Failed", and the turn does not continue. A Stop hook that prints `{"decision":"block","reason":"…"}` and exits 0 shows "Stop Blocked", and the turn continues with the reason.
- **Subagents.** A subagent's tool calls carry its own `threadId` but the parent's `sessionId`, with `parent_thread_id`, `subagent_kind`, and `thread_source: "subagent"` in `x-codex-turn-metadata`. Each subagent thread starts its own MCP server process.
- **Turning plugins off.** With a stand-in plugin installed and on, `features.plugins=false` kept its hooks and MCP server from starting. So did `plugins={"<id>"={enabled=false}}`. But `plugins={_default={enabled=false}}` did not, nor did the dotted form `-c 'plugins."<id>".enabled=false'`. That is why a Crew worker turns `crew@crew` off by its id.
- **The app's hook shim.** Under pwsh, `& '<…>\hook.cmd' wake stop-json; exit $LASTEXITCODE` passed stdin to node and brought back stdout and stderr. With the explicit `exit` it kept exit code 2. Renaming a new file over a `.cmd` or its script while it ran succeeded.
- **Reading a thread's folder.** App-server `thread/read` (`includeTurns: false`) on the daemon's own `codex app-server` returned the `cwd` of a thread another Codex process held. It answered "thread not loaded" for an ephemeral thread.
- **End to end.** Crew's own bridge ran from this checkout with an isolated `CREW_HOME` and an interactive TUI lead. Its hooks and MCP server were passed by `-c` and run with `--dangerously-bypass-hook-trust`, so this run did not exercise the shipped `.codex-plugin` manifest, `codex.mcp.json` or `hooks/codex.json` as installed by `crew install`, nor a Stop hook continuing a turn through Crew's own `stop-json`. A stand-in Stop hook printing the same JSON did continue a turn. The lead's `delegate` call registered its thread as Codex-hosted, and the job's lead was that thread. When the worker finished, the daemon's `codex queue` note woke the idle TUI, which read the news with `status` and acknowledged its receipt.

**Windows, installed plugin.** With `codex-cli 0.172.0`, Crew was installed in the real `~/.codex` from a source checkout (`codex plugin marketplace add`, `codex plugin add crew@crew`) and its hooks trusted in `/hooks`. The daemon ran the same code.
- **Trust keys.** They were recorded as `crew@crew:hooks/codex.json:session_start:0:0`, `…:session_start:0:1`, `…:user_prompt_submit:0:0` and `…:stop:0:0`, with a forward slash as on macOS.
- **The lead's first turn.** The MCP server ran from Codex's cache copy and said hello: the daemon recorded the thread as Codex-hosted with the right project. The lead's `delegate` job finished, and the daemon's note was queued.
- **Background server update.** CLI 0.172 runs TUIs through a shared background app-server. When a 0.172 `codex` was started while a 0.170 background server ran, it first updated the npm package, which failed with `EPERM` on a file in use. It then hung at "Updating the local background server…" and shut down the open lead TUI mid-turn. `codex app-server daemon stop`, then `codex app-server daemon update`, finished the update.
- **A queue after an interrupted turn.** The resumed thread's last turn showed "Conversation interrupted". Neither resuming it nor queueing further messages ran its queued items. The first turn the user typed did: once that turn ended, the queued Crew note ran as the next turn, and the lead read the news with `status` and acknowledged it. So an interrupted turn holds the queue until the user's next turn, and Crew's news waits until then. The UserPromptSubmit hook's context also names the news on that turn.
- **The lead's next step.** The lead went on to squash-merge the job's branch into its checkout without committing, as a lead may; for this check it was undone.

**Hook schemas in 0.172.** Read from the JSON schemas inside the Windows `codex.exe`, not run:
- **Events.** `PreToolUse`, `PermissionRequest`, `PostToolUse`, `PreCompact`, `PostCompact`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `SubagentStart`, `SubagentStop`, `Stop` and `Interrupt`, plus `PreModelRequest` and `PostModelRequest`.
- **Fields.** The inputs use Claude Code's names: `session_id`, `cwd`, `transcript_path`, `hook_event_name`, `turn_id`, `model`, `permission_mode`, and `agent_id` and `agent_type` on the events a sub-agent raises. `PermissionRequest` carries `tool_name` and `tool_input`, `SubagentStop` carries `last_assistant_message`, and `UserPromptSubmit` may carry `agent_id`. This is why Crew's `report.ts` reads them as it reads Claude Code's.
- **Sub-agent models.** The multi-agent config has `expose_spawn_agent_model_overrides`. So by default a Codex lead cannot choose its sub-agents' model, and a preset keeps them on the lead's model.

**macOS, Crew's report hooks and a Claude worker.** Checked 2026-11-24 with `codex-cli 0.172.0`: an interactive TUI lead on the real account, Crew's bridge from this checkout with an isolated `CREW_HOME` and `CREW_PORT`, and `hooks/codex.json` and the MCP server passed by `-c` with `--dangerously-bypass-hook-trust` (`features.plugins=false`, `approvals_reviewer="user"`). A logging hook beside Crew's recorded each payload. `~/.codex/config.toml` was the same afterwards.
- **The session on the board.** `SessionStart` registered the thread as `host: "codex"`, and `PreToolUse` set its phase (`Bash mkdir probe-dir`). `SessionEnd` removed it when the TUI quit.
- **Approvals.** `PermissionRequest` arrived with `tool_name` and `tool_input` (a command, and for an MCP tool its arguments), and the session showed as waiting with `ask: {tool, input}`. Crew's hook printed nothing, and Codex showed its own prompt unchanged ("Would you like to run the following command?"). Answering it cleared the wait. With the account's own `approvals_reviewer` (`guardian_subagent`) the automatic reviewer answered instead, and the wait cleared the same way.
- **Interrupt.** Esc during `sleep 40` ran `Interrupt` with the turn's id, and the session went idle ("turn interrupted").
- **Sub-agents.** A `spawn_agent` sub-agent's `SubagentStart`, `PreToolUse`, `PostToolUse` and `SubagentStop` carried the parent's `session_id`, the sub-agent's own `turn_id`, and `agent_id` and `agent_type` (`default`). The board listed it under the lead while it ran. The lead's own tool names read `collaborationspawn_agent` and `collaborationwait_agent`.
- **Claude worker.** The lead delegated a two-step task with `agent: "claude"` (job `cl-367c8e`). The worker wrote `hello.txt` in its worktree without asking, asked before `touch made-by-shell.txt`, ran it once approved from the board's route, and finished with a report. The daemon's queued note woke the idle lead, which read the news with `status`. Its later `reply` to the already-answered request was refused ("That request is no longer pending").
- **A built copy's registration.** With a bundle built from this branch, `writeCodexPlugin` and `codex plugin add` in an isolated `CODEX_HOME`, read with app-server `hooks/list`. The 4 hooks trusted under the previous `hooks/codex.json` kept their keys (`session_start:0:0`, `session_start:0:1`, `user_prompt_submit:0:0`, `stop:0:0`), and the 11 new ones were added after them. But all 4 then showed `modified`, not trusted. `currentHash` is `<definition>/<content>`, and the content part is shared by every hook of the plugin: it changed when only a skill's text changed, and not when only a compiled bridge script did, nor on a re-registration of the same files. So the user trusts the hooks again after any update that changes the files Codex copies.

**Windows, trust, elicitation and process lifetime.** Checked 2026-11-25 with `codex-cli 0.172.0` in isolated `CODEX_HOME` directories, with stand-in plugins, stand-in MCP servers and Crew's own MCP server from this checkout on an isolated `CREW_HOME` and port.
- **Where trust is kept.** `trusted_hash` in `config.toml` is the definition half of `hooks/list`'s `currentHash`. Codex keeps the content half apart, in `CODEX_HOME/.hook-trust/<id>`, recorded when it first finds the hook trusted. So a change to the plugin's other files makes the hook `modified` even though the config is unchanged.
- **Hooks in the user's hooks file.** A hook in `CODEX_HOME/hooks.json` is keyed `<file>:<event>:<group>:<index>`, `source: "user"`, and its `currentHash` is the definition alone: a client's `config/batchWrite` of that hash to `hooks.state."<key>".trusted_hash` made it `trusted`, and it stayed `trusted` after the script its command ran was rewritten. The engine computes a plugin content hash only for plugin hooks (`plugin_content_hash` in `codex-rs/hooks/src/engine/discovery.rs`). A plugin whose manifest points at a hooks file with no hooks loads none, without a warning, and does not fall back to `hooks/hooks.json`.
- **A `modified` hook does not run.** A trusted `UserPromptSubmit` hook ran under `codex exec`; after only a skill's text changed and the plugin was added again, `hooks/list` reported it `modified` and the next `codex exec` did not run it.
- **Elicitation.** Codex declares `elicitation: {form, url}` to MCP servers. Under `codex app-server` it forwards a server's `elicitation/create` to its client as the server request `mcpServer/elicitation/request` (`mode: "form"`, with `message` and `requestedSchema`), and the client's `{action, content}` reaches the server as sent. Codex's own approval of an MCP tool call comes the same way, marked by `_meta.codex_approval_kind`. With the approval policy `never`, Codex declines a server's elicitation itself within a millisecond and shows nothing; `codex exec` always runs with `never`. Crew takes a declined prompt as dismissed, so `wait` hands the request back to the lead to ask in chat.
- **Process lifetime.** Each MCP server runs in a job object that ends every process in it when Codex exits, normally or not: a detached child and an orphaned grandchild of a stand-in server both ended, while a process it created through WMI lived on. A process a hook started outlived `codex app-server`, but not `codex exec`. A daemon Crew's MCP server started reported `partialEnv`, and a `crew status` from a shell replaced it while Codex ran ([delivery.md](delivery.md#codex-leads)).

**macOS, process lifetime and elicitation.** Checked 2026-11-25 with `codex-cli 0.172.0` in isolated `CODEX_HOME` directories, with Crew's MCP server from this checkout on an isolated `CREW_HOME` and port, and a stand-in MCP server.
- **Process lifetime.** `codex app-server` started Crew's MCP server on `thread/start`, and the daemon it started reported `partialEnv`. The daemon outlived Codex whether its stdin was closed or it got `SIGTERM` or `SIGKILL`. On a normal exit Codex sent `SIGTERM` to the stand-in server's process group, which ended a child the server spawned plainly but not one it spawned `detached`; when Codex was killed, nothing was signalled and the server saw its stdin end.
- **Elicitation in the TUI.** The TUI drew a stand-in server's form `elicitation/create` as its own prompt ("Field 1/1 (1 required unanswered)", the message, and the enum's values as numbered choices), after Codex's own approval of the tool call in the same form. Choosing a value sent `{action: "accept", content: {color: "blue"}}` to the server.

**Desktop app, elicitation.** Checked 2026-11-25 on Windows with the Codex desktop app and a stand-in MCP server registered by `codex mcp add`: a tool call's form elicitation (`enum` choice) was drawn in the thread as its own prompt, with the message as its title, the field's title, numbered choices and a decline button.

**Windows, the queue API and the desktop app.** Checked 2026-11-25 with `codex-cli 0.172.0` and the Codex desktop app 26.1120 on the real account, against a lead thread whose queue was held after an interrupted turn.
- **Where the queue lives.** `codex queue` stores its message in `CODEX_HOME/queue_1.sqlite` (`queued_items`, one row per message with a `payload_json` of `{"UserInput": …}`). Codex accepts only user input there: the binary logs "discarding non-user queued input" for anything else. So no queued item can reach a thread as a system message, the way Claude Code's `asyncRewake` does.
- **Who serves desktop threads.** The desktop app runs its own `codex app-server` over stdio, apart from the CLI's background server (`app-server --listen unix:// --managed-daemon`). No other process can reach the desktop's server, so a turn cannot be started on a desktop thread from outside except through the shared queue.
- **The queue API.** App-server has `thread/queue/add`, `list`, `update`, `delete`, `reorder` and `start`, and a `thread/queue/changed` notification. They need the experimental API: with `capabilities: null` the server answers "thread/queue/list requires experimentalApi capability". With `experimentalApi: true`, a separate `codex app-server` on the same `CODEX_HOME` listed, added and deleted a desktop thread's queued items without loading the thread. `add` returned the item as `queuedSubmission` with its `id`, and `delete` returned `{"deleted": true}`. An archived thread refuses them ("session … is archived").
- **The desktop app follows.** An item `thread/queue/add` put in showed in the thread's composer as a pending message, under the app's "queue paused after an interruption" bar, and `thread/queue/delete` removed it from the composer without a reload.
- **Injecting items.** `thread/inject_items` appends raw Responses API items to a loaded thread's model-visible history. It starts no turn, and only the process that has the thread loaded can call it.

**Not verified:** a queued note to a session that is simply closed (not interrupted) on 0.172, and the TUI's queue handling on 0.172 in general, beyond the interrupted case above.
