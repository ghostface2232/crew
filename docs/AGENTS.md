# docs

One file per topic, describing how that part of Crew works now and why. The map of which file covers what is in the root [AGENTS.md](../AGENTS.md#where-each-topic-is-documented); the README points there rather than keeping its own list.

## Rules

- **One topic, one place.** A rule, number, or reason is written in the doc that owns its topic. Other docs link to it (`file.md#heading`) instead of repeating it.
- **Form.** A topic doc opens with what the part is and does, then a **Key files** line, then sections by behavior with the reasons behind each rule, then `Not verified`, `Tests`, and `History`. [missions.md](missions.md) is the model. The app, distribution, design-token, and MCP docs keep their own sections; give one a `History` section when it first needs one.
- **Change it with the code.** A change to behavior updates the owning doc in the same commit. A new or renamed doc updates the map in the root `AGENTS.md`, and any code comment that names the doc.
- **Keep decisions.** When reversing a recorded decision, do not delete it: add the reason and date to that doc's `History` (the revision log in [roadmap.md](roadmap.md)).
- **Date external facts.** Attach a verification date to facts about Codex, Antigravity, Claude Code, and other outside tools. Their protocols and policies shift every few months, so re-verify the sources in [research/implementation-plan.md](../research/implementation-plan.md) section 12 before building on them.
- **Requirements are current.** [requirements.md](requirements.md) always states the current goals and is rewritten when they change; its history is in git.
- **Roadmap tracks status.** [roadmap.md](roadmap.md) keeps each plan item's status against the requirements, the open items, and the dated design turns. How finished work behaves is described in its topic doc, not there.
- **`research/` is a record.** Plans and surveys there are not updated to match the code; current behavior belongs here.
