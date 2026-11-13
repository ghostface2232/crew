---
name: board
description: Open the Crew status board, which shows live what Claude, Codex, and Antigravity are each doing. Use when the user asks to see the board, the crew's status, or what the other agents are doing.
---

# Open the status board

The board is served by the Crew daemon at http://127.0.0.1:47615.

1. Call the `crew` MCP `status` tool once. This starts the daemon if needed and tells you what is running.
2. Show the board. It signs in with a secret carried in the address, so take the address from `crew board --url`, which prints it without opening anything; do not repeat that address to the user or write it anywhere.
   - If you have Browser pane tools (in the Claude desktop app), open that address there so it sits beside the conversation.
   - Otherwise run `crew board` to use the default browser.
3. Tell the user in one line what is active right now. Do not describe the page.
