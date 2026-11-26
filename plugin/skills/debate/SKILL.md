---
name: debate
description: Debate a hard, tricky, or important decision with the other agent (Codex under a Claude Code lead or Claude under a Codex lead by default) before acting on it, in a few read-only rounds that end with a conclusion. Use when the user invokes /crew:debate or asks to debate, argue through, or stress-test a design or decision with Codex or Claude.
argument-hint: <decision to debate>
---

# Debate a decision

Topic: $ARGUMENTS

1. Read the code and docs the decision touches, and form your own position. If the topic is unclear, ask the user one question before starting.
2. Call `route` with `debate` and follow its assignee. Then call `debate` with `topic` and `position` (setting `tier` to `frontier` only when the decision is especially hard), and end your turn.
3. In each round, concede what holds up, push back with evidence where you disagree, and continue with `reply`.
4. Tell the user what was agreed, what disagreement remains and what would settle it, and anything that needs their decision. When closing an open mission, save the decision in `record`.

Implement the outcome only if the user asked for it.
