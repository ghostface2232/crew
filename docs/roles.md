# Roles, shared instructions, and model scores

Roles define the kinds of work Crew can assign and who can hold them. Shared instructions apply across agents, and model notes and peer ratings record evidence about the work.

**Key files:** `plugin/bridge/config.ts`, `jobs.ts`, `context.ts`, `instructions.ts`, `notes.ts`, `worker-mcp.ts`, and `plugin/roles/`. See [usage-and-presets.md](usage-and-presets.md) for routing, presets, and tiers, [sandbox.md](sandbox.md) for role permissions, and [daemon-api.md](daemon-api.md) for the state fields and HTTP routes.

## Role registry

A role is a kind of work the user assigns to one or more holders (`ROLE_INFO` in `config.ts`). Its job kind (`delegate`, `review`, or `polish`) determines the sandbox, workspace, and base prompt.

| Role | Kind | Follows | What it is |
| --- | --- | --- | --- |
| `delegate` | `delegate` | | Implementation |
| `refactor` | `delegate` | `delegate` | Restructuring without changing behavior (`engineer.md` + `refactor.md`) |
| `release` | `delegate` | `delegate` | Release preparation: version, changelog, build, checks, publish steps (`engineer.md` + `release.md`); pushes/publishes/deploys nothing |
| `debate` | `delegate` (read-only) | `delegate` | Tests the lead's position on a hard decision (`debater.md`) |
| `review` | `review` | | Static cross-review |
| `verify` | `review` | `review` | Review that runs the app in a snapshot of the change (`unable: ["antigravity"]`) |
| `fix` | `delegate` | | Fixing accepted review findings in the lead's code or a merged result (`engineer.md` + `fix.md`); held by Claude by default |
| `polish` | `polish` | | Wording (`polisher.md`) |

## Role assignments

Each tool maps to one or more roles, and `roles` in `~/.crew/config.json` names which agents hold each role. Without `roles`, defaults apply (implementation/review/refactor/release/debate/verify to Codex, fixing to Claude, wording to Antigravity).

```json
{
  "roles": {
    "delegate": { "agents": ["codex"] },
    "review": { "agents": ["codex"], "codex": { "effort": "high" } },
    "polish": { "agents": ["antigravity"] }
  }
}
```

Unassigned roles and roles without `agents` inherit their parent's holders with their own per-agent settings overlaid. Listing `agents` starts fresh. Settings stay scoped per agent (`codex`, `antigravity`), and unused agents' settings are omitted. A role may have several holders, including `claude` (all have the same status in the assignment).

```json
{ "roles": { "review": { "agents": ["codex", "claude"], "codex": { "effort": "high" } }, "polish": { "agents": ["claude"] } } }
```

- `agents` is stored in fixed order (`codex`, `antigravity`, `claude`). The legacy config form (`agent`, `also`, `model`, `effort`) is still converted on read.
- The lead selects a holder with `agent` on `delegate`, `review`, `polish`, and `debate`. Picking `claude` starts no worker job and returns instructions for in-session or subagent execution (`crew:self-reviewer` for reviews).
- When `agent` is omitted (`POST /api/jobs` or tool call), Crew picks the first enabled, able worker in preferred order (`antigravity` first for `polish`, `codex` first for all other roles). See [routing](usage-and-presets.md#routing) for the usage-aware choice. Roles held only by `claude` or an unable/disabled worker fail at start rather than falling back.
- Settings edits the stored `roleSettings` table. See [daemon state](daemon-api.md#state-and-events) for the fields the daemon sends.
- `resolveRole` in `jobs.ts` settles a job's role once at creation. `POST /api/jobs` may pass `role` without `kind`. A job with `kind: "review"` and `runs_app` resolves to `verify`. Contradictory `role`/`kind`/`runs_app`/`debate` combinations fail. The board's New Job offers every role except `debate`.

### Model and effort settings

- Per-role `codex` and `antigravity` entries (`model`, `effort`) override global agent settings, and per-job tool arguments override both. Antigravity's `effort` sets `thought_level` after selecting the model and steps down to the nearest lower supported level if needed. Omitted or unsupported levels keep the session default.
- Settings offer the models each agent lists for this account, with the efforts each accepts: Codex's from `$CODEX_HOME/models_cache.json`, Antigravity's from `agy models`, which the daemon asks at most hourly when a client reads its state (every five minutes after a failure). agy prints a line per model and thinking level (`gemini-4-neon-high`), so the lines are folded into the model a session takes (`gemini-4-neon`) with its levels as efforts. Until agy first answers, the tier families (Hydrogen, Neon) are offered; a later failure keeps the last list.
- `polish` accepts `model` like `delegate` and `review`, and results print `model:` right after the header. `resolvedModel` and `resolvedEffort` record what the session reported (falling back to configured values or `unknown (agent default)`). When Codex reroutes a turn to another model (`model/rerouted`), `resolvedModel` becomes the new model, so scores and ratings name the one that did the work, and the job gets a note naming both.

`roles` is read at job start so edits apply to the next job without a restart. An invalid table fails the job with the reason instead of falling back to defaults. The lead's tool titles and server instructions name the role holders as of session start.

## Role instruction files

Role instructions under `plugin/roles/` are agent-independent. The files are `engineer.md`, `reviewer.md`, `polisher.md`, `debater.md`, `question.md`, `machine.md`, `refactor.md`, `release.md`, and `fix.md`. Codex receives them in `developerInstructions`. Antigravity receives them via `_meta.antigravity.systemPrompt.append` when advertised, or as a prefix to the first prompt.

## Shared instructions

Instructions written once reach every agent (requirement R9):

| File | Applies to |
| --- | --- |
| `~/.crew/instructions.md` | Every project |
| `.crew/instructions.md` at the repository root | That project |

The project file is part of the repository and is trusted like its `AGENTS.md` or `CLAUDE.md`, even if someone other than the user wrote it. It can steer an agent within its role and is read last, so it can override the global file.

- **Workers:** Both files are read at job start from the repository's main working tree (including when launched from a linked worktree or subdirectory) and appended after the role text with a preface stating they do not widen the role. Outside a repository, Crew reads from the project directory. `status` lists which files a job received.
- **Claude:** A `SessionStart` and `SubagentStart` command hook (`bridge/context.ts`) prints them as `additionalContext`, including after compaction, noting that workers already receive them.
- Nothing is written to any service's own instruction files (`AGENTS.md`, `CLAUDE.md`, rules folders).
- Missing or empty files contribute no instructions. An unreadable file fails the job or surfaces an error in the Claude hook.
- Crew reads the project file only as a regular file. If it or its `.crew` folder is a symbolic link, the read fails the same way, because a link could point to a file the worker's sandbox denies (such as the daemon's token). The user's own `~/.crew/instructions.md` may be a symbolic link.
- Because Claude Code replaces hook context over 10,000 characters with a 2,000-character preview, any file that would push the hook output past 9,000 characters (`CONTEXT_LIMIT`) is shown only by its path. Workers have no such cap.
- Each section is headed by its source so the agent can distinguish user instructions from repository instructions. Role limits are enforced by the bridge and sandbox, not by prose.

## Model notes and scores

After a review and its fix, the lead records one evidence line per model via `note` (`POST /api/notes`), stored only by the daemon in `~/.crew/model-notes.json` (`plugin/bridge/notes.ts`) and displayed under Settings → Model Scores (`modelScores` in state and SSE). Job lines take model, agent, tier, and effort from the job record. The lead passes `model` only for in-session work.

Each model gets build and fix scores out of 10 (to one decimal), plus four item scores when peer ratings and review lines are present ([peer ratings](#peer-ratings)):

- **Build score:** A rate of accepted finding load (`0.35` high, `0.15` medium, `0.05` low) over change exposure (`small` 0.5, `medium` 1, `large` 2, `xlarge` 4—chosen units, not measured diff size), displayed as `10·exp(−rate)`. Rate 0 maps to 10 (before shrinkage), one medium per medium change to 8.6, one high to 7.0, three highs to 3.5, and more findings always cost more (unclamped). Tier is shown for within-tier comparison, not scored (for Codex, tier picks the model, so scoring tier acted as a fixed per-model bonus).
- **Fix score:** Mean quality of fix lines (`root-cause` 1, `patch` 0.55, `another-review` 0.25) multiplied by `exp(−load)` of any findings raised when checking the fix. Fix appears beside build and is never pooled into rank.
- **Shrinkage and weighting:** Both build and fix shrink toward a prior with weight 3. The prior is the mean of other models' estimates (each counted once and first shrunk toward a reference—`0.36` build rate ≈ 7.0, `0.7` fix quality—with the reference counted as one extra model), so one busy model cannot set everyone's prior. Self-reviews (same agent as builder) count half. Reviewers are not calibrated because uneven work mixes make harshness indistinguishable from harder assignments.
- **Ranking and status:** Status counts build reviews (self-reviews half): `< 3` is `too few samples`, `< 8` is `on trial`, `8+` is `settled`. Ranking and podium follow `score` (`items.correctness`, which equals `build` when peer ratings are off or below 3), breaking ties by unrounded rate. Models with `< 3` samples sort after ranked models under "Too early to rank".
- **Adoption and triage:** Merged multi-job results get one line per job for its own findings (cross-piece findings go on the lead's line). Delegated build lines record `adoption` (`as-is`, `after-reply`, `partly`, `rejected`) and follow-up rounds from the job. The `brief` item uses adoption. The `build` calculation is independent of adoption. See [peer ratings](#peer-ratings). Declined findings are logged beside accepted ones for triage inspection (and score reviewers on `review` lines).
- **Validation and storage:** `note` requires `size` and `text`, and also requires `reviewer` for `build` and `fix`. For `review` lines it takes `reviewer` from the job. Validation returns all missing or invalid fields with allowed values in one error. Re-noting the same job and role replaces its line. Debate jobs cannot be noted, and review jobs default to `role: "review"` ([peer ratings](#peer-ratings)). Unreadable files move to `model-notes.json.unreadable-<time>`, incomplete entries are skipped (copied to `.dropped-<time>` before overwrite), and each model ID belongs to one agent. Notes are advisory only; roles and presets never change automatically.
- **Summaries and routing:** `note_summary` rewrites a model's prose summary once 10 new lines arrive (`CONSOLIDATE_AFTER`). `route` returns summaries and recent lines for role holders' three most recently noted models.

Not modelled: time decay, measured diff size, and independent checks of lead triage.

## Peer ratings

Peer ratings layer over review evidence so brief adherence, reporting honesty, reviewer usefulness, and independent checks on the lead's own work show up in scores without letting generous LLM ratings dominate.

**Who rates whom.** A rater must have seen the other participant's work, and never rates itself. Every item takes an integer from `1` to `5`.

| Rater | Rated | When | Items |
| --- | --- | --- | --- |
| Reviewer | Reviewed work | Before its report, via `crew.rate` | `correctness`, `report` |
| Lead | Job's builder or fixer | On the job's `note` line (`rating`) | `correctness` (builder only), `brief`, `report` |
| Lead | Review job | On the review's `note` line (`rating`) | `findings` |
| Engineer | Review of its work | In the turn findings return, via `crew.rate` | `findings` (at half weight) |

Workers provide `fact` (one line from the work). The lead's rating rests on the note's `text`. Without a job, the lead cannot rate its own work (only its reviewer rates it).

**No extra turn.** Jobs created while `peerRatings` is on get `rates: true`, a `# Rating` prompt section, and the `rate` tool on `worker-mcp.ts`. Debates, questions, polish jobs, `fix` jobs, and `release` jobs are excluded.

**Review lines and storage.** `note` accepts `role: "review"` (the default when noting a review job) with `of_job` or `of_model` naming the reviewed work plus accepted `findings` and `declined`. A review of code as it stands, by several builders, has no such work to name: it is noted with `audit: true` in their place, its line shows as `audit`, and what its reviewer made of the code is a rating of no one. Leaving all three out is refused, so a builder forgotten by mistake is still asked for. Review lines bind worker ratings to their target: reviewer ratings go to `of` (the job's build model or `of_model`), and engineer ratings go once per reviewing model on `of_job` (staying inactive until the review job is noted).

`~/.crew/model-notes.json` is version 2. The `ratings` field holds worker ratings, one per job. Lead ratings sit in `rating` on evidence lines and are preserved when re-noted without `rating`. Version 1 files load directly and back up once to `model-notes.json.v1` on first save.

**Items and scoring.** Each model gets four items out of 10 (`ModelScore.items`), and `score` is `items.correctness`:

| Item | Observed evidence | Ratings from |
| --- | --- | --- |
| `correctness` | Build score ([model notes and scores](#model-notes-and-scores)); `null` without a build regardless of ratings | Reviewers, lead |
| `brief` | Delegated adoption (`as-is` 1, `after-reply` 0.7, `partly` 0.4, `rejected` 0), shrunk toward `0.7` with weight 3 | Lead |
| `report` | None yet; reference `0.7` stands in | Reviewers, lead |
| `findings` | Accepted finding load over raised load on review lines, shrunk toward `0.6` with weight `0.5` | Lead, engineers |

- **Minimum count and 50/50 blend:** Ratings move an item only from `MIN_RATINGS` (3) onward. The scorer ignores 1 or 2 ratings. Mean rating (`3` neutral) maps to a shift in `[−1, 1]`: neutral leaves the baseline unchanged, all fives pull toward 10, all ones toward 0. Half of the item moves with ratings and half stays with evidence (`PEER_SHARE = 0.5`), so good ratings never lower clean work and rated vs. unrated models stay comparable.
- **Rater centering:** Each rating is centered against that rater's mean on the item across *other* models (shrunk toward `3` by 1 rating), pulling only toward neutral and never past it. Excluding the rated model's own ratings ensures an extra five never hurts it or turns a three negative, and multi-target ratings count once per source so note order changes nothing.
- **Shrinkage, self-weight, and caps:** A model's mean rating shrinks toward `3` with weight 2. Ratings from the rated model's own agent count half. Any `correctness` rating on work with an accepted high finding caps at `3` (including in its rater's mean), checked on the job's build line, any review line of that job, or (for jobless work) the rating reviewer's own line. `fix`-role work omits `correctness` (`of.fix`).
- **Ranking:** Status follows build reviews. Ranking and podium follow `score` (ties broken by finding rate). Review-only models have `score: null` and sort apart under "Reviewers" by `findings`. `ModelScore.ratings` counts only ratings on items that reached `MIN_RATINGS`.

**Turning them off.** `peerRatings` in `~/.crew/config.json` defaults to `true`. Toggling it off in Settings saves `peerRatings: false`. When off, new jobs skip rating, `note` ignores `rating` (flagging `ratingDropped`), and scores compute from evidence alone while preserving saved ratings if turned back on.

**Not modelled.** The score omits comparisons of a worker's declared `Outcome` against lead adoption as observed evidence for `report`, worker ratings of the lead's brief, and rating weight that grows with rating count.

## Not verified

- Live `SubagentStart` delivery inside a real subagent.
- Whether Claude Code counts its 10,000-character cap per hook or per event.
- Whether Codex's built-in `standard` review honors `developerInstructions`.

## Tests

`test/settings.test.ts`, `test/jobs.test.ts`, `test/antigravity.test.ts`, `test/adapter-contracts.test.ts`, `test/notes.test.ts`, and `test/questions.test.ts`.

Verified with swapped roles (Antigravity as `delegate` and `review`, Codex as `polish`) on Codex CLI 0.167.0 and Antigravity CLI 1.5.5. The denied requests, missing `rawInput`, mode switches, and hex-suffixed Antigravity titles are covered by protocol stubs/fixtures.

Shared instructions were verified with markers across Codex, Antigravity, and headless Claude Code 2.1.321.

## History

- 2026-11-12–13: Added configurable roles and shared instructions.
