---
name: debate
description: Debate a hard, tricky, or important decision with the supporting engineer (Codex by default) before acting on it, in a few read-only rounds that end with a conclusion. Use when the user invokes /crew:debate or asks to debate, argue through, or stress-test a design or decision with Codex.
argument-hint: <decision to debate>
---

# Debate a decision

Topic: $ARGUMENTS

1. Understand the decision first: read the code and docs it touches, and form your own position. If the topic is unclear, ask the user one question before starting.
2. Call the `crew` MCP `debate` tool with:
   - `topic`: the decision and everything the engineer needs without this conversation: the problem, constraints, files, and docs.
   - `position`: your current position and why.
   - `rounds`: 3 unless the user asks otherwise (at most 6).
   - `tier` `standard` and effort `high`; `frontier` only when the decision is especially hard.
   Then end your turn; you are woken when it answers.
3. For each answer, take every point seriously: concede what holds up, push back with evidence where you disagree, and answer with `reply` (a message) for the next round. The last round ends with its conclusion.
4. Tell the user what was agreed, what disagreement remains and what would settle it, and anything that needs their decision. If a mission is open, pass the decision as its `record` when you finish it.

A debate changes nothing. Implement the outcome only if the user asked for that.
