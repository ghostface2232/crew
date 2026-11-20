---
name: debate
description: Debate a hard, tricky, or important decision with the supporting engineer (Codex by default) before acting on it, in a few read-only rounds that end with a conclusion. Use when the user invokes /crew:debate or asks to debate, argue through, or stress-test a design or decision with Codex.
argument-hint: <decision to debate>
---

# Debate a decision

Topic: $ARGUMENTS

1. Understand the decision first: read the code and docs it touches, and form your own position. If the topic is unclear, ask the user one question before starting.
2. Call `debate` with `topic`, `position`, effort `high` unless a preset is in effect, and `tier` `frontier` only when the decision is especially hard; then end your turn.
3. For each round, concede what holds up, push back with evidence where you disagree, and continue with `reply`.
4. Tell the user what was agreed, what disagreement remains and what would settle it, and anything that needs their decision; pass the decision as `record` when closing an open mission.

Implement the outcome only if the user asked for that.
