import readline from 'node:readline';
import { clipped, jsonBytes, LEAD_BYTES, LEAD_TEXT_BYTES, REPORT_PAGE_BYTES, textPage, unread } from './delivery.ts';
import { api, ensureDaemon } from './client.ts';
import { assignHint, baseUrl, canonicalPath, DEFAULT_ROLES, defaultHolder, disabledAgents, LEAD, loadConfig, MAX_DEBATE_ROUNDS, PRESET_NAMES, ROLE_INFO, ROLES, VERSION, WORKERS } from './config.ts';
import { listSkills } from './skills.ts';
import { describeUsage } from './usage.ts';
import type { RouteDecision, Usage } from './usage.ts';
import type { Holder, Preset, PresetName, Role, RoleAssignment, WorkerAgent } from './config.ts';
import type { CrewEvent, JobSpec } from './jobs.ts';
import { followUpTitle, MAX_LABEL, missionDetail, missionHead, NAME_THE_MISSION, normalizeTitle, STAGES, TASK_STATES } from './missions.ts';
import type { Mission } from './missions.ts';
import type { PullWatch } from './pulls.ts';
import { imageContent, isImage } from './evidence.ts';
import type { Evidence } from './evidence.ts';
import { describe, needsLead, summarize } from './render.ts';
import type { JobView } from './render.ts';
import { TIERS } from './tiers.ts';
import { RATING_ITEMS } from './notes.ts';
import { clip } from './text.ts';

/**
 * Stdio MCP server the lead Claude session talks to. It holds no state: every
 * tool call is forwarded to the Crew daemon, which owns the workers.
 *
 * The protocol subset needed here (lifecycle, tools, progress, cancellation) is
 * small, so it is implemented directly; that keeps the plugin free of
 * dependencies and a build step.
 */

/**
 * Who holds each role, as configured when this session started. Tool text is fixed for the session,
 * so a later change shows up in `status` and in each job's result, which name the agent that ran.
 */
const started = (() => {
  try {
    return loadConfig();
  } catch {
    return null;
  }
})();
const roles = started?.roles ?? DEFAULT_ROLES;
// A daemon of another version may name a holder this session does not know.
const holderName = (agent: Holder) => (agent === LEAD ? 'you, Claude' : WORKERS[agent]?.name ?? String(agent));
/** A role's holders, any of whom the lead may pick for a job. */
const holder = (role: Role, table: Record<Role, RoleAssignment> = roles) => table[role].agents.map(holderName).join(' or ');

/** What a preset asks of the lead and its workers, said wherever the preset in effect is reported. */
function presetPolicy(name: PresetName | null, preset: Preset | undefined, whose: string): string {
  if (!name || !preset) return `No preset is in effect${whose}: workers use their configured models, and your own subagents stay on your model.`;
  const subagents = preset.subagentModel && preset.subagentModel !== 'inherit'
    ? `Start your own subagents (including crew:self-reviewer) with model "${preset.subagentModel}"${preset.subagentMax ? `, or "${preset.subagentMax}" when the work needs more, and never a larger model,` : ''} unless the user asks otherwise.`
    : 'Your own subagents stay on your model.';
  const cap = preset.maxTier ? ` Worker models are capped at the ${preset.maxTier} tier: a higher tier or a larger model you name is lowered to it. Leave effort out to keep the preset's, or name one when a job needs it.` : '';
  return `The "${name}" preset is in effect${whose}. Workers get its model and effort when their job starts. ${subagents}${cap}`;
}

/** The preset policy as the config on disk has it now; the session's starting copy may be out of date. */
function currentPolicy(name: PresetName | null, whose: string): string {
  let presets: Record<PresetName, Preset> | undefined;
  try {
    presets = loadConfig().presets;
  } catch {
    presets = started?.presets;
  }
  return presetPolicy(name, name ? presets?.[name] : undefined, whose);
}

const PRESET_LINE = `- Presets set command cost. The global one is ${started?.preset ? `"${started.preset}"` : 'not set'}. If the user names one (${PRESET_NAMES.join(', ')}), pass \`preset\` on mission start; never pick one yourself. \`mission\` and \`route\` state the active preset and its subagent rule; the latest holds. Role settings override any preset.`;

/** One line per role: who holds it now, as of this session's start. The tool descriptions say what each role does. */
const ROLE_LINES = ROLE_INFO.map((info) => `- ${info.label} (\`${info.role}\`): ${holder(info.role)}`).join('\n');

/**
 * What a lead needs in every session, whether or not it runs the pipeline. Claude Code cuts a server's
 * instructions at 4,096 characters (seen 2026-11-20), so this holds only what no tool description, job
 * result or skill says at the moment it is needed; test/mcp.test.ts holds it under that length.
 */
const INSTRUCTIONS = `Crew connects this session to background coding agents. You lead: plan, do the main implementation, review, and decide what merges.

The user assigns roles (settings or ~/.crew/config.json); jobs go to an agent holding the role. At session start:
${ROLE_LINES}
\`delegate\` takes role delegate, refactor, release, or fix; \`review\` uses review, or verify with runs_app. With multiple holders, pick one with \`agent\`. Picking yourself (\`claude\`) starts no worker: do it here or in a subagent.

Rules:
- A delegate or polish job runs in its own git worktree and branch (crew-<job id>) from HEAD: commit what it needs first; gitignored files are copied only if in .worktreeinclude. Read its diff, then merge or reject (reject work beyond the task). Nothing reaches your branch unless you merge it.
- Job calls return at once. Do your part and end your turn: you are woken when a job ends, needs a decision, or asks a question. Do not sit in \`wait\` on a running job; the user cannot talk to you then.
- Acknowledge a receipt only by passing its id as \`ack\` on your next Crew call.
- Approval is the user's; never approve on your own. Decline requests clearly outside the task or role with \`reply\`; otherwise call \`wait\` so the user is asked, or relay their prior answer. A result with a REFUSED action says how to send it back if the user's request covers it; never run it yourself. Answer worker questions (ask_lead) yourself with \`answer\`.
- Workers do not see this conversation: give only what they need (goal, decisions, how it is judged), accurately and briefly.
- Omit \`tier\` and \`effort\` for ordinary work so role or preset settings apply; pass one only when a job clearly needs another, as it overrides them.
- If a job hits a usage limit, do it yourself and say what was skipped. If Crew cannot start a job, retry once, then tell the user the error and do it yourself.
- /crew:run sets when to review; outside it, review only if the user asks (never hold a commit or push for one). After a review and its fix, record the result with \`note\`: facts only, no impressions.
- Report multi-step user commands with \`mission\` (title and stages first; done once work finishes); skip for a single delegated job. Open a new mission before further work after done; a command while one is open gets its own beside it. \`tasks\` saves the split for resumed sessions; \`pr\` links a pull request.
- Add worker-reported machine or project workarounds to .crew/instructions.md (given to every later job).
- \`route\` says who should take a kind of work from remaining usage. /crew:run calls it each stage; outside it, follow roles unless a job hits a limit.
${PRESET_LINE}

The status board (/crew:board) shows every agent live.`;

const common = {
  cwd: { type: 'string', description: 'Project directory. Defaults to this session\'s project.' },
  mission: { type: 'string', description: 'The id of the mission this job is for. Needed only while this session has more than one mission open; otherwise the job goes to its one open mission.' },
  task_id: { type: 'string', description: 'The id of the mission task this job is done for, as you named it in the mission\'s tasks. The task then shows this job\'s state and check.' },
  background: { type: 'boolean', description: 'Default true: return at once with the job id; you are woken when the job ends or needs you. Pass false to block until then.' },
};
const worktreeProps = {
  base: { type: 'string', description: 'Git ref the worker\'s worktree starts from. Defaults to HEAD.' },
  isolation: { type: 'string', enum: ['worktree', 'in_place'], description: 'worktree (default): separate worktree and branch. in_place: edit the project directory directly; only for directories that are not git repositories.' },
};
const aloneProp = {
  exclusive: { type: 'boolean', description: 'The job measures performance (benchmark, profile, load test) and must have the machine to itself. It is refused while any other job runs, and no other job can start until it ends: wait for running jobs first, and start nothing alongside it.' },
};
const runsAppProp = (what: string) => ({
  runs_app: { type: 'boolean', description: `The job has to start the app (a server, a headless browser) to ${what}. Its sandbox gets network access for that; without this a worker cannot bind a port. Codex gets computer-use plugins by default and can operate the real, shared screen, so do not run two such jobs at once. Pass it when running the app is needed: always for work whose result only shows while it runs (UI, interaction, traffic between processes, startup, concurrency) or whose checks start a server or browser.` },
  plugins: { type: 'array', items: { type: 'string' }, description: 'Additional Codex plugin names beyond configured defaults (by default the browser, for web research and docs): documents/pdf/spreadsheets/presentations when reading or producing those files; figma/github when working with them. Personal accounts (mail/calendar/drive/notes) and the user\'s own Chrome need an explicit request in the task, and only a task that names an action in the user\'s app lets the worker act there, never with credentials, payments, messages, or settings. Plugin tools act outside the sandbox. Ignored for other agents.' },
});
const installedSkills = listSkills();
const skillsProp = installedSkills.length ? {
  skills: { type: 'array', items: { type: 'string', enum: installedSkills }, description: 'Skills from ~/.agents/skills that would help with this particular job, such as a design or writing skill for UI work. The worker is not shown the user\'s skills otherwise; it is told to read the ones you pick. Pick only those that fit the task.' },
} : {};
const attachmentsProp = {
  attachments: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Absolute paths of images or recordings (PNG, JPEG, GIF, WebP, WebM, MP4) the worker should see, such as a design or a screenshot of the problem. They are copied into the job\'s evidence and shown on the board.' },
};
const agentProp = {
  agent: { type: 'string', enum: [...Object.keys(WORKERS), LEAD], description: 'Which of the role\'s holders takes this job; the roles in your instructions list them. Without it, Antigravity for wording and Codex for other work, among the holders that can take it. claude starts no worker: you do it.' },
};
const modelProps = {
  tier: { type: 'string', enum: [...TIERS], description: 'How demanding the job is; Crew picks the model from it. Leave it out for ordinary work, so the model the user set for the role or preset applies (standard without one); naming one overrides it. standard: most work, including most UI changes. frontier: especially hard or complex work, or a UI rebuilt from scratch. light: simple, well-specified tasks. fast: plain searches and lookups. Codex runs Sol, Astra, Terra and Luna for these; Antigravity runs Neon for frontier (literary or very complex documents) and Hydrogen otherwise. Newer models of each family are picked up automatically.' },
  model: { type: 'string', description: 'Exact model ID for this job, as the notes list it, overriding tier. Rarely needed; prefer tier. When the user names a family such as Astra, pass its tier; a family name passed here is taken as that tier.' },
  effort: { type: 'string', description: 'Leave it out to keep the effort the user set for the role or preset; an effort named here overrides it. With none set, Codex runs at medium, or high at the frontier tier. Antigravity sets its thinking level only when an effort is named, using the nearest lower offered level if needed and keeping the session default if no level fits.' },
};

const TOOLS = [
  {
    name: 'delegate',
    title: 'Delegate work',
    description: `Hand a separable piece of work to the agent holding its role: implementation (${holder('delegate')}), refactoring (${holder('refactor')}), release preparation (${holder('release')}), or fixing review findings (${holder('fix')}). It works in its own git worktree and reports back; its changes land on a crew-<job id> branch for you to review and merge.`,
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', enum: ['delegate', 'refactor', 'release', 'fix'], description: 'delegate (default): implementation. refactor: restructure code without changing behavior, with the checks run before and after. release: prepare a release (version, changelog, build, checks, and written steps to publish); it publishes, pushes, and deploys nothing. fix: fix the review findings you accepted in your own code or a merged result; give the findings with their reasons and your decisions. A worker\'s own change goes back to it with reply instead.' },
        task: { type: 'string', description: 'What to build, for an engineer who has not seen this conversation and follows every line literally: the goal, the relevant files and interfaces, which files it may edit when others work nearby, the choices already made that it must follow, and what you assumed without checking. Give the context it needs and no more. If the result must match something (a design, screenshots, another implementation), name it by file path and commit, pass images in attachments, and ask what still differs. Shared instructions reach it already.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        done_when: { type: 'string', description: 'Concrete completion criteria the engineer can check, e.g. tests that must pass, or what must be true on screen and at which widths.' },
        check: { type: 'string', description: 'A shell command (e.g. "npm test") the bridge itself runs in the worktree after every turn, so the result shows an observed exit status instead of the worker\'s word. Pick one that fails without the change. Runs with the worker\'s file limits, up to 10 minutes. Needs a worktree.' },
        ...worktreeProps,
        ...modelProps,
        ...agentProp,
        ...runsAppProp('do or verify the work'),
        ...attachmentsProp,
        ...aloneProp,
        ...skillsProp,
        ...common,
      },
      required: ['task'],
    },
  },
  {
    name: 'review',
    title: 'Cross-review',
    description: `Ask the cross-reviewer (${holder('review')}; with runs_app, the verify role, ${holder('verify')}) for a review of changes in this repository, or of files as they stand; it changes nothing in your tree. By default it is static and read-only: the worker reads the change and runs checks that end by themselves.`,
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['uncommitted', 'branch', 'commit', 'files'], description: 'uncommitted (default): staged, unstaged and untracked changes. branch: current branch against `base`. commit: a single commit. files: the files or directories in `paths` as they stand, for an audit of code rather than of a change; there is no diff, so say in focus what to look for.' },
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50, description: 'For target "files": the files or directories to audit, relative to the project.' },
        base: { type: 'string', description: 'For target "branch": the branch or commit to compare against, e.g. main, or the commit before your first one when you work on main itself.' },
        commit: { type: 'string', description: 'Commit SHA for target "commit".' },
        focus: { type: 'string', description: 'What to scrutinize: the design decisions, assumptions or risks you are least sure about, with a short factual map of which file holds what and what the tests mock or fake. Do not assert that the change is right.' },
        mode: { type: 'string', enum: ['adversarial', 'standard'], description: 'adversarial (default): challenges design and assumptions. standard: Codex\'s built-in code review, which is given no focus or done_when; other agents run the adversarial review instead.' },
        done_when: { type: 'string', description: 'Acceptance criteria to verify in adversarial mode.' },
        ...runsAppProp('judge the change. It then goes to the verify role and runs in a snapshot worktree holding the change; your own self-review must stay static'),
        ...attachmentsProp,
        ...modelProps,
        ...agentProp,
        ...skillsProp,
        ...common,
      },
    },
  },
  {
    name: 'polish',
    title: 'Polish wording',
    description: `Have the editor (${holder('polish')}) improve UI strings, comments, and documentation in the given files, in its own worktree. It may not change logic or structure. Not a merge gate: run it after the code is settled. Antigravity as editor runs no commands, so name the files and lines to polish rather than a command such as git diff.`,
    inputSchema: {
      type: 'object',
      properties: {
        targets: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Files or directories it may edit, relative to the project. Changes elsewhere are reported as out of scope.' },
        guidance: { type: 'string', description: 'Tone, terminology, audience, or what to leave alone.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        ...worktreeProps,
        tier: { ...modelProps.tier, description: 'standard (the default, Hydrogen for Antigravity) for nearly all wording work; frontier (Neon) only for literary or very complex, difficult documents.' },
        model: modelProps.model,
        ...agentProp,
        ...skillsProp,
        ...common,
      },
      required: ['targets'],
    },
  },
  {
    name: 'debate',
    title: 'Debate a decision',
    description: `Debate a hard, tricky, or important decision with the agent holding the debate role (${holder('debate')}) before acting on it: a design, a risky change, a diagnosis you are unsure of. It reads the code and docs, tests your position, and answers point by point, changing nothing. Continue with reply (a message) for each further round, up to the round limit; the last round ends with a conclusion. Use it only where a second view is worth several turns; routine work does not need it. Record what was decided in the mission's record.`,
    inputSchema: {
      type: 'object',
      properties: {
        topic: { type: 'string', description: 'The decision to debate and its context: the problem, constraints, files and docs involved. It has not seen this conversation. Antigravity runs no commands in a debate, so point it at files to read, not commands to run.' },
        position: { type: 'string', description: 'Your current position and reasoning, for it to test.' },
        rounds: { type: 'integer', minimum: 1, maximum: MAX_DEBATE_ROUNDS, description: 'How many exchanges at most, counting the first. Default 3.' },
        title: { type: 'string', description: 'Short label shown on the status board.' },
        ...modelProps,
        ...agentProp,
        ...common,
      },
      required: ['topic', 'position'],
    },
  },
  {
    name: 'mission',
    title: 'Report the mission',
    description: 'Report one user command and its jobs. Start with title and stages in the intended order, pass stages again with what remains to add or drop future steps at any time, report stage as you move on, and call done as soon as the work is finished at any stage. tasks keeps the split of the work, and what was verified, where a resumed or compacted session reads it again. pr links a pull request so you hear of its failed checks, reviews and conflicts. With no argument it shows what this session has open. It starts no work.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The user\'s command in a few words. Pass it once, to start the mission; later calls pass stage or stages without it. Passing the same title again resumes the mission and ignores stages. A different title starts another mission beside the open one, which stays open until you finish it: the user may give a new command while an earlier one is still under way.' },
        id: { type: 'string', description: 'The mission this call is for, as its replies name it (m-…). Needed only while this session has more than one mission open; a call that would change one without it is refused, and changes nothing.' },
        stages: { type: 'array', items: { type: 'string' }, description: `Ordered stages, with repeats allowed, each one of: ${STAGES.join(', ')}. To say what a step is for, add a colon and a short name (at most ${MAX_LABEL} characters), which the board shows in place of the stage's: "implement: Sample", "implement: The rest". With title: a nonempty whole plan. Later: replace only the remainder to add, drop or reorder steps ([] drops all future steps); passed and current steps stay.` },
        stage: { type: 'string', description: `One of: ${STAGES.join(', ')}. Advance to the next occurrence of this stage, or insert it after the current step. Reporting the current step again changes nothing, so to move between two steps of one stage, add the next one's name ("implement: The rest"); a name the plan does not have is inserted as a new step.` },
        tasks: {
          type: 'array',
          description: 'The pieces you split the work into, added or updated by id; tasks you leave out stay as they are. How you split and order them is yours to decide. Give after for a task that must wait for others; tasks that wait for nothing and touch different files can go at the same time. Set state as you go, and result when a task is done: one line on how it was verified. Start a job for a task with its task_id rather than copying the job\'s state here.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Your short name for the task, e.g. "api" or "t2".' },
              title: { type: 'string', description: 'What the task is, in a few words. Needed for a new id.' },
              after: { type: 'array', items: { type: 'string' }, description: 'Ids of the tasks this one waits for. [] clears it. A dropped task never counts as done, so take it out of after.' },
              state: { type: 'string', enum: [...TASK_STATES], description: 'todo (the default), doing, done, or dropped.' },
              result: { type: 'string', description: 'One line: how it was verified, or why it was dropped.' },
            },
            required: ['id'],
          },
        },
        pr: { type: 'string', description: 'A pull request of this work, as its number or URL. Crew then reads it with the GitHub CLI while this session is open and wakes you only when something new needs you: a failed check, review feedback, a merge conflict, or checks passing after a failure it told you of. You judge the cause and hand the fix to an agent with delegate or reply; Crew never merges, closes or deploys. Passing a linked one again resumes check news that was held back after three failing heads.' },
        done: { type: 'boolean', description: 'The command is finished.' },
        abandoned: { type: 'boolean', description: 'The command was dropped before it finished.' },
        outcome: { type: 'string', description: 'With done or abandoned: one line on how it ended.' },
        record: { type: 'string', description: 'Optional, with done: the decisions taken and why, approaches that failed, and prerequisites the next person would need. A few short lines; `crew export <mission>` turns it and the jobs into a runbook.' },
        preset: { type: ['string', 'null'], enum: [...PRESET_NAMES, null], description: 'Only when the user names a preset for this command: the mission\'s new jobs run under it instead of the global one. null returns to the global one; leave it out to keep what is set. Never choose one yourself.' },
      },
    },
  },
  {
    name: 'route',
    title: 'Route by usage',
    description: 'Ask who should take a kind of work now, given each agent\'s remaining usage as AgentGauge measured it. Returns the assignee (the role\'s holder, or you), the reason, and whether the result is degraded or should wait. Call it at stage boundaries in the pipeline, not on every turn. With no kind, shows every agent\'s usage.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['lead', ...ROLES], description: 'The role you are about to hand out (verify for a review with runs_app, refactor, release or fix for those delegate roles). lead asks whether you yourself should carry on.' },
        mission: { type: 'string', description: 'The id of the mission the work is for, whose preset then applies. Needed only while this session has more than one mission open.' },
      },
    },
  },
  {
    name: 'note',
    title: 'Note a review result',
    description: 'Record one line of evidence in a model\'s notes after a review and its fix: who built, fixed or reviewed, the findings you accepted, and how the fix went. The notes score each model from these lines and the peer ratings, and \`route\` shows them. Give job_id or model. To rewrite a model\'s summary, use note_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string', description: 'The job whose work was reviewed or that did the fix, or for role review the review job itself; its model, agent, tier and effort are read from it.' },
        model: { type: 'string', description: 'Without job_id: the exact model of work done in this session or your subagent (yours, e.g. your own model id).' },
        role: { type: 'string', enum: ['build', 'fix', 'review'], description: 'build (default; fix for a fix-role job, review for a review job): the model built the change under review. fix: the model fixed the accepted findings. review: the model reviewed the change.' },
        reviewer: { type: 'string', enum: [...Object.keys(WORKERS), LEAD], description: 'Required for build and fix: who reviewed the work (for a fix, who checked it): the cross-reviewer\'s agent, or claude for your crew:self-reviewer. A review job\'s line takes it from the job.' },
        of_job: { type: 'string', description: 'For review: the job that built the work the review covered. Its reviewer\'s rating of that work, and that job\'s rating of the review, are then counted.' },
        of_model: { type: 'string', description: 'For review, without of_job: the exact model that built the work, for work done in this session or your subagent.' },
        audit: { type: 'boolean', description: 'For review, in place of of_job and of_model, one of which a review line otherwise needs: true when the review covered code as it stands, by several builders (a review with target "files"), so there is no one job or model to name. Its reviewer\'s rating of the code then counts for no one.' },
        size: { type: 'string', enum: ['small', 'medium', 'large', 'xlarge'], description: 'Size of the change: small (a few lines or one function), medium (a feature in a few files), large (many files or a new subsystem), xlarge (several subsystems at once, roughly 1,500 changed lines or more).' },
        tier: { type: 'string', enum: [...TIERS], description: 'Without job_id: how demanding the work was, as you would have given it a tier.' },
        findings: {
          type: 'object',
          properties: { high: { type: 'integer', minimum: 0 }, medium: { type: 'integer', minimum: 0 }, low: { type: 'integer', minimum: 0 } },
          description: 'For build: the findings you accepted, by severity (high: wrong behavior, data loss, security; medium: a real bug in an edge case; low: minor; these are the blocker, major and minor of a review report). When several reviews covered the work, one line with every accepted finding counted once, naming as reviewer one from another agent if any ran. For fix: the findings the check of the fix raised. For review: the findings of this review that you accepted.',
        },
        declined: {
          type: 'object',
          properties: { high: { type: 'integer', minimum: 0 }, medium: { type: 'integer', minimum: 0 }, low: { type: 'integer', minimum: 0 } },
          description: 'The findings you declined, by the severity the reviewer gave. For build: not scored; kept so your triage can be checked. For review: this review\'s, weighed against the ones you accepted.',
        },
        adoption: { type: 'string', enum: ['as-is', 'after-reply', 'partly', 'rejected'], description: 'For a delegated job\'s build line: how you took its work. as-is (merged as delivered), after-reply (merged after you sent it back), partly (merged in part), rejected. Its follow-up rounds are read from the job. Noting the job again replaces its line, so give adoption again.' },
        outcome: { type: 'string', enum: ['root-cause', 'patch', 'another-review'], description: 'Required for fix: root-cause (fixed the cause), patch (handled the case without the cause), another-review (the fix needed another round).' },
        rating: {
          type: 'object',
          properties: Object.fromEntries(RATING_ITEMS.map((item) => [item, { type: 'integer', minimum: 1, maximum: 5 }])),
          description: 'With job_id only: your rating of the job\'s work as you saw it, 1 to 5 per item, resting on text. For build: correctness, brief (how it followed your brief), report (how well its report matched the work). For fix: brief and report. For review: findings (how useful they were). Noting the job again without one keeps the rating it had.',
        },
        text: { type: 'string', description: 'One line of facts from the review, e.g. "Markdown parser, no findings, one follow-up on underscore boundaries". No impressions.' },
      },
      required: ['size', 'text'],
    },
  },
  {
    name: 'note_summary',
    title: 'Rewrite a model\'s summary',
    description: 'Rewrite a model\'s summary in its notes from its evidence lines, when a note says the summary is due.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The exact model whose summary to rewrite, as the notes list it.' },
        summary: { type: 'string', description: 'The model\'s new summary, three to five lines on what it does well, where it is weak, and what to give it. Every claim must trace back to its evidence lines.' },
      },
      required: ['model', 'summary'],
    },
  },
  {
    name: 'status',
    title: 'Crew status',
    description: 'Show a bounded job summary or report page, or list recent jobs with what each worker is doing now and each agent\'s usage. A list also brings every news item this session has not acknowledged, under one receipt.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {
      job_id: { type: 'string' },
      report_offset: { type: 'integer', minimum: 0, description: 'Read a page of the worker report, starting at this character offset. The response gives the next offset.' },
      turn: { type: 'integer', minimum: 1, description: 'Report turn to read; defaults to the latest. Older turns use the saved exchange.' },
    } },
  },
  {
    name: 'wait',
    title: 'Wait for workers',
    description: 'Collect results of jobs that ended, or have the user asked about a waiting job. Blocks until one of the given jobs finishes, fails, or asks a lead question; for a job still running, end your turn instead, since you are woken when it ends. If a job needs an approval or a user answer meanwhile, the user is asked and the wait continues. With no ids, waits on every active job this session started in this project.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object',
      properties: {
        job_ids: { type: 'array', items: { type: 'string' } },
        timeout_seconds: { type: 'number', description: 'Give up waiting after this long (default 1800). The jobs keep running.' },
      },
    },
  },
  {
    name: 'answer',
    title: 'Answer a worker question',
    description: 'Answer a lead question without ending or restarting the worker turn: the decision and the fact it rests on, in a few lines. Then end your turn: you are woken when the worker ends or needs you.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, question_id: { type: 'string' }, answer: { type: 'string' }, ...attachmentsProp },
      required: ['job_id', 'question_id', 'answer'],
    },
  },
  {
    name: 'reply',
    title: 'Reply to a worker',
    description: 'Continue the same worker session, pass on the user\'s answer, or decline an approval clearly outside the task or role with a reason. Never approve on your own. Call wait if the user still needs to decide. With approved_by_user it sends back an action the worker\'s automatic reviewer refused.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        message: { type: 'string', description: 'Follow-up instruction, the user\'s answer, or, with decline, why you declined and what to do instead. For a correction, name what is wrong, where, and what is approved so it stays. From the second correction on, restate the whole brief as it now stands and say it replaces your earlier messages.' },
        decision: { type: 'string', enum: ['approve', 'deny', 'allow_for_job', 'decline'], description: 'Use decline with a reason in message only for a waiting approval clearly outside the task or role. Approve, deny, and allow_for_job relay the user\'s decision. Use allow_for_job only when offered and the user allowed later requests on the same target. Otherwise call wait.' },
        request_id: { type: 'string', description: 'Required to settle a waiting request. Use the request ID shown in the job status.' },
        sync: { type: 'boolean', description: 'For a finished delegate or polish job: first merge your current HEAD into the worker\'s branch, so the next turn sees what you committed since it started (a fix it was waiting for, an interface you changed). Commit first. If the merge conflicts, it is aborted; the message is still sent, naming the conflicting files, and the job\'s result notes the failed sync.' },
        ...attachmentsProp,
        approved_by_user: { type: 'string', description: 'For a finished job whose result lists a REFUSED action: the user\'s own words from this conversation that cover it. The worker runs the action again and the automatic reviewer judges it with that approval. Use it without asking the user when their request clearly covers the action. A second use on the same job sends each request to the user to answer.' },
        background: common.background,
      },
      required: ['job_id'],
    },
  },
  {
    name: 'cancel',
    title: 'Cancel a job',
    description: 'Stop a running job. With discard: true, also remove a finished job\'s worktree and branch, after merging or rejecting its changes: work on the branch that was not merged is lost.',
    inputSchema: {
      type: 'object',
      properties: { job_id: { type: 'string' }, discard: { type: 'boolean' } },
      required: ['job_id'],
    },
  },
];

const ackProperty = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 }],
  description: 'Receipt id(s) received earlier. Acknowledges only those snapshots, never the result of this call.',
};
for (const tool of TOOLS) Object.assign(tool.inputSchema.properties, { ack: ackProperty });

const DEFAULT_WAIT_SECONDS = 1800;
/** Listings use the project; argument-less wait further filters to this lead's jobs. */
// Canonical, so it matches the project keys the daemon stores.
const PROJECT = canonicalPath(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

/** Set from the client's initialize request: whether it can show the user a form on our behalf. */
let canElicit = false;
/**
 * Waiting requests that go back to the lead instead of being asked again:
 * those the user dismissed, and those the app failed to show (with the error).
 */
const dismissed = new Set<string>();
const failed = new Map<string, string>();

const approvalForm = (grant?: string) => ({
  type: 'object',
  // A plain enum is the one choice schema every protocol version with elicitation accepts.
  properties: { decision: { type: 'string', title: 'Decision', enum: grant ? ['approve', 'deny', 'allow_for_job'] : ['approve', 'deny'] } },
  required: ['decision'],
});
const ANSWER_FORM = { type: 'object', properties: { answer: { type: 'string', title: 'Answer' } }, required: ['answer'] };

let promptQueue: Promise<unknown> = Promise.resolve();

/** Several jobs can wait at once; ask about them one after another rather than stacking prompts in the app. */
function oneAtATime<T>(ask: () => Promise<T>): Promise<T> {
  const turn = promptQueue.then(ask, ask);
  promptQueue = turn.catch(() => {});
  return turn;
}

/**
 * Puts a worker's approval request or question to the user through MCP
 * elicitation, which the app renders as its own prompt, and forwards the
 * answer to the worker.
 */
async function askUser(job: JobView, signal: AbortSignal): Promise<'settled' | 'dismissed' | 'failed'> {
  const waiting = job.waiting!;
  // While queued behind another prompt, this request may have been answered on the board, or the call cancelled.
  const current: JobView = await api('GET', `/api/jobs/${job.id}`);
  if (signal.aborted || current.waiting?.id !== waiting.id) return 'settled';

  const approval = waiting.type === 'approval';
  const prompt = request('elicitation/create', {
    message: `${WORKERS[job.agent].name} (${job.title}) ${approval ? 'requests approval' : 'asks a question'}\n\n${waiting.reason}${approval && waiting.grant ? `\n\nallow_for_job also allows its later requests for ${waiting.grant} in this job.` : ''}`,
    requestedSchema: approval ? approvalForm(waiting.grant) : ANSWER_FORM,
  });

  // The same request can be answered on the status board, or the call can be cancelled; then the prompt is moot.
  let open = true;
  const moot = (async () => {
    let latest = current;
    while (open && !signal.aborted && latest.waiting?.id === waiting.id) {
      latest = (await api('GET', `/api/jobs/${job.id}/wait?after=${latest.seq}&timeout=5`)).job;
    }
  })().then(
    () => null,
    // An unreachable bridge is not the app's failure; the next poll reports it.
    () => null,
  );
  // The tool call returning, for any reason, withdraws the prompt at once.
  const withdrawn = new Promise<null>((resolve) => signal.addEventListener('abort', () => resolve(null), { once: true }));
  let result: any;
  try {
    result = await Promise.race([prompt.response, moot, withdrawn]);
  } catch (err) {
    failed.set(waiting.id, String((err as Error).message ?? err));
    return 'failed';
  } finally {
    open = false;
  }
  if (result === null) {
    prompt.cancel();
    return 'settled';
  }
  const answer = result.action === 'accept' ? result.content : null;
  const body = approval
    ? (answer?.decision === 'approve' || answer?.decision === 'deny' || (answer?.decision === 'allow_for_job' && waiting.grant)) && { decision: answer.decision }
    : typeof answer?.answer === 'string' && answer.answer.trim() && { message: answer.answer };
  if (!body) return 'dismissed';
  // Already answered elsewhere in the meantime is fine: the worker has its decision.
  await api('POST', `/api/jobs/${job.id}/reply`, { ...body, request_id: waiting.id }).catch(() => {});
  return 'settled';
}

/**
 * Follows jobs until one needs the lead (finished, failed, asking the lead, or
 * waiting with no way to ask the user), the time budget runs out, or the call is cancelled.
 */
async function follow(ids: string[], seconds: number, onEvent: (e: CrewEvent) => void, signal: AbortSignal): Promise<JobView[]> {
  const latest = new Map<string, JobView>();
  let stop = false;
  const deadline = Date.now() + seconds * 1000;
  // Ends when the call is cancelled or this follow returns, so no prompt outlives the call.
  const done = new AbortController();
  const quit = () => {
    stop = true;
    done.abort();
  };
  signal.addEventListener('abort', quit, { once: true });

  const watch = async (id: string) => {
    let job: JobView = await api('GET', `/api/jobs/${id}`);
    latest.set(id, job);
    // Start from the present: earlier events were already reported by a previous call.
    let after = needsLead(job) ? job.seq : Math.max(job.seq - 1, 0);
    while (!stop && Date.now() < deadline) {
      const key = job.waiting?.id;
      if (key && canElicit && !dismissed.has(key) && !failed.has(key)) {
        const asked = job;
        if ((await oneAtATime(() => askUser(asked, done.signal))) === 'dismissed') dismissed.add(key);
        job = await api('GET', `/api/jobs/${id}`);
        latest.set(id, job);
        continue;
      }
      if (needsLead(job)) break;
      const res = await api('GET', `/api/jobs/${id}/wait?after=${after}&timeout=${Math.min(25, Math.max(0, (deadline - Date.now()) / 1000))}`);
      job = res.job;
      latest.set(id, job);
      for (const event of res.events as CrewEvent[]) if (!stop) onEvent(event);
      // Advance even when the event buffer no longer holds these events, so the poll cannot spin.
      after = Math.max(after, job.seq);
    }
  };
  // Resolves as soon as any one job needs the lead; the other watchers wind down on their next poll.
  await Promise.race(ids.map(watch));
  quit();

  const jobs = ids.map((id) => latest.get(id)).filter((j): j is JobView => Boolean(j));
  return jobs;
}

interface CallContext {
  progress(message: string): void;
  signal: AbortSignal;
  /** Evidence images to show with the text result. */
  images: Evidence[];
  jobs: JobView[];
  pullIds?: string[];
  /** False for a listing: it shows jobs without acting on them, so it offers their news but takes none over. */
  adopt?: boolean;
  /** Offer every unacknowledged item this session owns, not only those of the jobs shown: a listing is where the lead catches up. */
  allNews?: boolean;
}

/** The latest turn's screenshots and the open questions' attachments: what the lead needs to see now, not the whole history. */
function showEvidence(ctx: CallContext, job: JobView): void {
  const open = new Set((job.questions ?? []).filter((q) => q.answer === undefined).flatMap((q) => q.attachments ?? []));
  for (const item of job.evidence ?? []) {
    if (item.from === 'worker' && isImage(item.file) && (item.turn === job.turns || open.has(item.file))) ctx.images.push(item);
  }
}


/** The Claude session this server belongs to; it outlives a restart of the server. Unset in clients that do not pass it on. */
const SESSION = process.env.CLAUDE_CODE_SESSION_ID || undefined;
/** How a mission ended when this session's next one replaced it, before a session could hold several. Such a mission carries no work on. */
const SUPERSEDED = 'Superseded by a new mission.';
/**
 * The mission this session last reported on. A session may have several open, so this decides nothing about where
 * a call goes: it only lets the lead be told, once, that the mission was closed from outside.
 */
let missionId: string | null = null;
/**
 * The mission whose preset this session's jobs run under while it has none open. It outlives tracking: when the
 * user closes the mission on the board, the remaining work keeps the preset they chose for it. Cleared when this
 * session finishes the mission; never moved to another open mission by guessing.
 */
let costMission: string | null = null;
/** The mission this session last finished as done, until work after it opens a follow-up mission or the lead opens one. */
let lastDone: Mission | null = null;
/** Set when this session's mission was closed from outside (dismissed on the board, or left too long), until the lead has been told. */
let closedElsewhere: Mission | null = null;
/**
 * True until this server has dealt with a mission. Only then can a closed mission of this session be one it lost
 * track of in a restart; afterwards a closed one is one this server saw end.
 */
let fresh = true;
/** The missions this server opened, for a client that passes no session id: the daemon cannot then say whose a mission is. */
const openedHere = new Set<string>();

/** The global preset as the config on disk has it; null when it cannot be read, as jobs would then fail anyway. */
function globalPreset(): PresetName | null {
  try {
    return loadConfig().preset;
  } catch {
    return started?.preset ?? null;
  }
}

/** This session's missions in this project, the open ones oldest first, with the jobs and pull requests their tasks are shown with. */
interface Standing { all: Mission[]; open: Mission[]; jobs: JobView[]; pulls: PullWatch[] }

/** Read from the daemon for each call and never remembered, so a restart of this server loses nothing. */
async function standing(): Promise<Standing> {
  const state = await api('GET', '/api/state');
  const all = ((state.missions ?? []) as Mission[]).filter((m) => m.project === PROJECT && (SESSION ? m.owner === SESSION : openedHere.has(m.id)));
  return { all, open: all.filter((m) => m.state === 'active').sort((a, b) => a.createdAt - b.createdAt), jobs: state.jobs ?? [], pulls: state.pulls ?? [] };
}

function sessionPulls(pulls: PullWatch[]): PullWatch[] {
  return SESSION ? pulls.filter((pull) => pull.lead === SESSION) : [];
}

const listed = (missions: Mission[]) => missions.map((m) => `${m.id} "${m.title}" (${m.stage})`).join(', ');

/**
 * With several missions open, a call that names none is refused: a guess could advance, close or bill the wrong
 * one, and none of that can be undone.
 */
function unnamed(open: Mission[], arg: 'id' | 'mission'): Error {
  return new Error(`This session has ${open.length} missions open: ${listed(open)}. Pass ${arg} to say which one this call is for. Nothing was changed or started.`);
}

/** The mission a call names, which must be one this session opened in this project. */
function named(now: Standing, id: unknown, arg: 'id' | 'mission'): Mission {
  const mission = now.all.find((m) => m.id === id);
  if (!mission) throw new Error(`${arg} ${JSON.stringify(id)} is not a mission this session opened in this project.${now.open.length ? ` Open: ${listed(now.open)}.` : ''}`);
  return mission;
}

function track(mission: Mission): void {
  missionId = mission.id;
  costMission = mission.id;
}

/** The daemon no longer knows the mission a job or route call went to: say so once, then go on without it. */
async function withMission<T>(id: string | undefined, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!id || !/is known any more/.test((err as Error).message)) throw err;
    if (costMission === id) costMission = null;
    if (missionId === id) missionId = null;
    throw new Error(`Mission ${id} is no longer known to Crew, so its preset cannot be applied. Try again to run under the global preset, or start a new mission with the preset the user named.`);
  }
}

/**
 * The mission a new job or a route question belongs to: the one it names, else this session's only open one, else
 * the one whose preset still holds. After a restart this server remembers none of it; the daemon's list is enough.
 */
async function jobMission(wanted: unknown): Promise<string | undefined> {
  if (SESSION) fresh = false;
  if (wanted === undefined && !SESSION && !openedHere.size) return costMission ?? undefined;
  const now = await standing();
  if (wanted !== undefined) return named(now, wanted, 'mission').id;
  if (now.open.length > 1) throw unnamed(now.open, 'mission');
  if (now.open.length === 1) track(now.open[0]);
  return costMission ?? undefined;
}

function describeMission(mission: Mission, now?: Pick<Standing, 'jobs' | 'pulls'>): string {
  const policy = mission.preset ? currentPolicy(mission.preset, ' for this mission') : currentPolicy(globalPreset(), ' (the global preset; the mission sets none)');
  return [missionHead(mission), now ? missionDetail(mission, now.jobs, now.pulls) : '', policy].filter(Boolean).join('\n');
}

let missionReports = Promise.resolve();

function reportMission(args: any, ctx?: CallContext): Promise<string> {
  const report = missionReports.then(() => updateMission(args, ctx));
  missionReports = report.then(() => {}, () => {});
  return report;
}

async function updateMission(args: any, ctx?: CallContext): Promise<string> {
  const now = await standing();
  if (ctx) ctx.pullIds = sessionPulls(now.pulls).map((pull) => pull.id);
  if (args.done && args.abandoned) throw new Error('Pass done or abandoned, not both.');
  if (args.abandoned && args.pr !== undefined) throw new Error('An abandoned mission\'s pull request is not watched. Leave pr out, or pass done if the work is finished.');
  const restarted = fresh;
  fresh = false;
  const ending = Boolean(args.done || args.abandoned);
  const changing = Boolean(args.stage) || args.stages !== undefined || args.preset !== undefined || args.tasks !== undefined;
  // Links a pull request and says what stands on it now; what is already there is not sent again as news.
  const link = async (mission: Mission): Promise<string> => {
    if (args.pr === undefined) return '';
    const linked: { watch: PullWatch; resumed: boolean; summary: string } = await api('POST', `/api/missions/${mission.id}/pulls`, { pr: args.pr });
    now.pulls = [...now.pulls.filter((pull) => pull.id !== linked.watch.id), linked.watch];
    return `\n${linked.resumed ? 'Check failures of this pull request are sent again. ' : ''}Linked ${linked.summary}. Crew reads it while this session is open and wakes you only for a newly failed check, new review feedback, a conflict, or checks passing after a failure it told you of. Judge the cause yourself and hand the fix to an agent; never merge, close or deploy on such news.`;
  };

  if (args.title && !ending && args.id === undefined) {
    const title = normalizeTitle(args.title);
    if (!title) throw new Error('A mission needs a title: the command it carries out.');
    // The same title again is the same command: report the step, do not open a second card for it.
    // A resumed lead may resend its whole starting call; its plan is not a revision, so stages are ignored here.
    const same = now.open.find((m) => m.title === title);
    if (same) {
      track(same);
      const mission = args.stage || args.preset !== undefined || args.tasks !== undefined ? await api('POST', `/api/missions/${same.id}`, { stage: args.stage, preset: args.preset, tasks: args.tasks, lead: SESSION }) : same;
      const linked = await link(mission);
      return describeMission(mission, now) + linked;
    }
    // Closed while this server was down, as on the board: the work goes on under the preset the user chose for it.
    const closed = restarted && !costMission && !now.open.length && now.all.filter((m) => m.title === title && m.state === 'abandoned' && m.outcome !== SUPERSEDED).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (closed) {
      costMission = closed.id;
      return `Mission ${closed.id} was closed outside this session (${closed.outcome || closed.state}). Carry on with the work and do not open a new mission for it.\n${describeMission(closed)}`;
    }
    // A mission already open stays open: the user often gives a second command while the first is still under way.
    const opened: Mission = await api('POST', '/api/missions', { title: args.title, project: PROJECT, stage: args.stage, stages: args.stages, owner: SESSION, preset: args.preset ?? undefined, tasks: args.tasks });
    openedHere.add(opened.id);
    track(opened);
    closedElsewhere = null;
    lastDone = null;
    const linked = await link(opened);
    const others = now.open.filter((m) => m.id !== opened.id);
    return `${describeMission(opened, now)}${linked}\nJobs you start now are shown under it. Report each step with stage (no title needed), and finish with done.${others.length
      ? `\nStill open in this session: ${listed(others)}. ${NAME_THE_MISSION} Finish each by its id when its work ends: done, or abandoned if this command replaces it.` : ''}`;
  }

  let current: Mission | null;
  // On a call that ends a mission, a title says which one: the call must never end another under that title.
  const titled = ending && now.open.length ? normalizeTitle(args.title) : '';
  if (args.id !== undefined) {
    current = named(now, args.id, 'id');
    // A done mission's pull request is still watched, and check news held back after three failing heads resumes only by linking it again.
    if (current.state === 'done' && args.pr !== undefined && !ending && !changing) {
      const linked = await link(current);
      return describeMission(current, now) + linked;
    }
    if (current.state !== 'active') throw new Error(`Mission ${current.id} is already ${current.state}${current.outcome ? ` (${current.outcome})` : ''}. ${now.open.length ? `Open: ${listed(now.open)}.` : 'Start a new one by passing title.'}`);
  } else if (titled) {
    const matches = now.open.filter((m) => m.title === titled);
    if (!matches.length) throw new Error(`No open mission is titled ${JSON.stringify(titled)}. Open: ${listed(now.open)}. Pass id to say which one this call ends. Nothing was changed or started.`);
    // Renamed on the board, two can share a title.
    if (matches.length > 1) throw unnamed(matches, 'id');
    current = matches[0];
  } else if (now.open.length > 1) {
    if (ending || changing || args.pr !== undefined) throw unnamed(now.open, 'id');
    return `This session has ${now.open.length} missions open. ${NAME_THE_MISSION}\n\n${now.open.map((m) => describeMission(m, now)).join('\n\n')}`;
  } else current = now.open[0] ?? null;

  if (!current) {
    // The one this session last reported on is no longer open, and the lead did not close it.
    const gone = missionId ? now.all.find((m) => m.id === missionId && m.state !== 'active') : undefined;
    if (missionId) {
      missionId = null;
      closedElsewhere = gone ?? null;
    }
    if (closedElsewhere) {
      const closed = closedElsewhere;
      closedElsewhere = null;
      // Reopening it would bring back a card the user closed. The work goes on; only the reporting stops.
      return `Mission ${closed.id} was closed outside this session (${closed.outcome || closed.state}). Carry on with the work and do not open a new mission for it.\n${describeMission(closed)}`;
    }
    if (args.preset !== undefined && costMission) throw new Error('This session\'s mission was closed outside it, so its preset can no longer change. Carry on under it, or start a new mission with the preset the user named.');
    throw new Error('This session has no open mission. Start one by passing title; if the work is already under way without one, carry on without reporting.');
  }
  track(current);
  if (ending) {
    // An ended mission takes no later call, so the tasks and the pull request this one carries go in first. If either is refused, the mission stays open.
    if (args.tasks !== undefined) await api('POST', `/api/missions/${current.id}`, { tasks: args.tasks, lead: SESSION });
    const linked = await link(current);
    const ended: Mission = await api('POST', `/api/missions/${current.id}`, { done: Boolean(args.done), abandoned: Boolean(args.abandoned), outcome: args.outcome, record: args.record, by: 'lead' });
    missionId = null;
    costMission = null;
    lastDone = args.done ? ended : null;
    const others = now.open.filter((m) => m.id !== ended.id);
    return `${describeMission(ended, now)}${linked}${others.length ? `\nStill open in this session: ${listed(others)}.${others.length === 1 ? ' Calls that name no mission now go to it; work that follows up the one just finished gets a mission of its own first.' : ''}` : ''}`;
  }
  const mission: Mission = changing ? await api('POST', `/api/missions/${current.id}`, { stage: args.stage, stages: args.stages, preset: args.preset, tasks: args.tasks, lead: SESSION }) : current;
  const linked = await link(mission);
  return describeMission(mission, now) + linked;
}

function describeJob(job: JobView, ctx: CallContext): string {
  ctx.jobs.push(job);
  // First, so it survives when the response is cut to its bound; only a report too long for one page needs it.
  const paged = job.report && jsonBytes(job.report) > REPORT_PAGE_BYTES;
  return `${paged ? `Read the full report with status: job_id "${job.id}", report_offset: 0.\n` : ''}${describe(job)}`;
}

/** The follow-up mission being opened, which a job started meanwhile waits for. */
let opening: Promise<string> | null = null;
/**
 * Work the lead starts after finishing its mission, without opening another, gets a follow-up mission, so it shows on
 * the board under a mission rather than among loose jobs. The lead reports it like any other.
 */
async function followUp(): Promise<string> {
  // Jobs started together share one follow-up; only the call that opened it says so.
  if (opening) return opening.then(() => '');
  if (costMission || !lastDone || !SESSION) return '';
  const after = lastDone;
  opening = api('POST', '/api/missions', { title: followUpTitle(after.title), project: PROJECT, owner: SESSION, stages: ['implement', 'final'] }).then((opened: Mission) => {
    openedHere.add(opened.id);
    track(opened);
    lastDone = null;
    return `Opened mission ${opened.id} "${opened.title}" for this work, since "${after.title}" was done. Report its stage and done as usual, and pass stages to change its plan.\n`;
  });
  try {
    return await opening;
  } finally {
    opening = null;
  }
}

/** `wanted`: the mission the call named for this job, if any. */
async function runJob(spec: JobSpec, background: boolean, ctx: CallContext, wanted?: unknown): Promise<string> {
  // Settled before anything is started and fixed for the whole request, whatever other calls do meanwhile.
  let mission = await jobMission(wanted);
  if (!mission && spec.taskId !== undefined) throw new Error('task_id must be the id of a task of the job\'s mission');
  const opened = mission ? '' : await followUp();
  mission ??= costMission ?? undefined;
  try {
    // The id is sent as it is known: the daemon applies the mission's preset, and lets the job stand on its own if the mission has ended.
    const job: JobView = await withMission(mission, () => api('POST', '/api/jobs', { ...spec, lead: SESSION, project: PROJECT, mission }));
    return opened + await (background ? describeJob(job, ctx) : followOne(job.id, ctx));
  } catch (err) {
    // The mission is open either way, so the lead hears of it even when the job fails.
    if (opened) throw new Error(`${opened}${(err as Error).message}`, { cause: err });
    throw err;
  }
}

async function followOne(id: string, ctx: CallContext): Promise<string> {
  const [job] = await follow([id], DEFAULT_WAIT_SECONDS, (e) => ctx.progress(e.detail), ctx.signal);
  showEvidence(ctx, job);
  ctx.jobs.push(job);
  return render(job);
}

/** `describe`, plus what the lead should do about a waiting job that could not be settled in the app. */
function render(job: JobView): string {
  if (job.state !== 'waiting') return describe(job);
  const key = job.waiting!.id;
  const error = failed.get(key);
  let hint: string | undefined;
  if (error !== undefined) hint = `The app could not show the prompt to the user (${error}). Ask them in the conversation, then pass their decision on with reply.`;
  else if (dismissed.has(key)) hint = 'The user dismissed the prompt in the app. Ask what they want, then pass it on with reply.';
  else if (!canElicit) hint = 'This client cannot show the prompt itself. Ask the user in the conversation, then pass their decision on with reply.';
  return describe(job, hint);
}

/** What the lead does with a role it holds itself, by the kind of work. */
const YOURS: Partial<Record<Role, string>> = {
  delegate: 'Do it in this session, or hand it to a subagent if it is large and separable.',
  refactor: 'Do it in this session or a subagent, keeping behavior unchanged and running the checks before and after.',
  release: 'Prepare the release in this session or a subagent; publish, push, and deploy nothing.',
  debate: 'Test your position with a fresh-context subagent told to argue against it, then decide.',
  review: 'Run the crew:self-reviewer subagent on the change.',
  verify: 'Run the crew:self-reviewer subagent, telling it that it may run the app in its own isolated instance.',
  fix: 'Fix the accepted findings yourself, at their cause.',
  polish: 'Make the wording changes yourself, changing no logic or structure.',
};

/**
 * Settles which holder takes a job: the lead's pick, else the role's default (defaultHolder). A role the lead holds itself starts no
 * worker, so the answer is what to do instead; a worker pick goes on to the daemon, which checks it again.
 */
function pickHolder(role: Role, wanted: unknown): { agent?: Holder; yours?: string } {
  let table = roles;
  let disabled: WorkerAgent[] = [];
  try {
    const config = loadConfig();
    table = config.roles;
    disabled = disabledAgents(config);
  } catch {
    /* The daemon reports an unreadable config when the job starts. */
  }
  // An unknown role is the daemon's to refuse, with its own message.
  if (!table[role]) return { agent: wanted as Holder | undefined };
  const holders = table[role].agents;
  const agent = (wanted ?? defaultHolder(role, table[role], disabled)) as Holder;
  if (!holders.includes(agent)) throw new Error(`${String(wanted)} does not hold ${role}; its holders are ${holder(role, table)}. ${assignHint(role)}`);
  if (agent !== LEAD) return { agent };
  return { yours: `${role} is yours: no worker was started. ${YOURS[role]} Its other holders: ${holders.filter((h) => h !== LEAD).map(holderName).join(', ') || 'none'}.` };
}

/**
 * Appends the notes of these holders' most recently noted models, so the lead sees how they did before it picks a tier or holder.
 * Notes are advice: a daemon without them, or one that fails to read them, leaves the answer as it was.
 */
async function withNotes(text: string, agents: Holder[], evidence: number, once = false): Promise<string> {
  if (once) agents = agents.filter((agent) => !noted.has(agent));
  if (!agents.length) return text;
  try {
    const notes: { text: string } = await api('GET', `/api/notes?agents=${agents.map(encodeURIComponent).join(',')}&evidence=${evidence}`);
    // Two jobs started at once both ask; only the first to hear back shows the notes.
    if (!notes.text || (once && agents.every((agent) => noted.has(agent)))) return text;
    for (const agent of agents) noted.add(agent);
    return `${text}\n\nModel notes (advice; the roles and presets stay the user's):\n${notes.text}`;
  } catch {
    return text;
  }
}

/** Holders whose notes this session has been shown. `route` shows them every time; a job's answer only the first time. */
const noted = new Set<Holder>();

async function callTool(name: string, args: any, ctx: CallContext): Promise<string> {
  const cwd: string = args.cwd ?? PROJECT;
  if (['delegate', 'review', 'polish', 'debate'].includes(name)) {
    const role: Role = name === 'debate' ? 'debate' : name === 'polish' ? 'polish' : name === 'review' ? (args.runs_app ? 'verify' : 'review') : (args.role ?? 'delegate');
    if (name === 'delegate' && !['delegate', 'refactor', 'release', 'fix'].includes(role)) throw new Error(`delegate takes role delegate, refactor, release or fix, not ${String(role)}.`);
    const picked = pickHolder(role, args.agent);
    if (picked.yours) return picked.yours;
    args = { ...args, agent: picked.agent };
  }
  switch (name) {
    case 'debate':
      return runJob({ kind: 'delegate', role: 'debate', cwd, title: args.title ?? `Debate: ${clip(String(args.topic).split('\n')[0], 60)}`, task: `${args.topic}\n\n# The lead's position\n${args.position}`, debate: { rounds: args.rounds ?? 3 }, agent: args.agent, tier: args.tier, model: args.model, effort: args.effort, taskId: args.task_id }, args.background !== false, ctx, args.mission);
    case 'delegate':
      return withNotes(await runJob({ kind: 'delegate', role: args.role ?? 'delegate', cwd, title: args.title, task: args.task, done_when: args.done_when, check: args.check, base: args.base, isolation: args.isolation, agent: args.agent, tier: args.tier, model: args.model, effort: args.effort, exclusive: Boolean(args.exclusive), runsApp: Boolean(args.runs_app), plugins: args.plugins, skills: args.skills, attachments: args.attachments, taskId: args.task_id }, args.background !== false, ctx, args.mission), [args.agent], 2, true);
    case 'review': {
      const kind = args.target ?? 'uncommitted';
      if (kind === 'branch' && !args.base) throw new Error('target "branch" needs base (the branch to compare against, e.g. main).');
      if (kind === 'commit' && !args.commit) throw new Error('target "commit" needs commit (the SHA to review).');
      const paths: string[] = Array.isArray(args.paths) ? args.paths : [];
      if (kind === 'files' && !paths.length) throw new Error('target "files" needs paths (the files or directories to audit, relative to the project).');
      if (kind !== 'files' && args.paths !== undefined) throw new Error('paths goes with target "files". Drop paths, or pass target: "files" to audit them as they stand.');
      const target = kind === 'branch' ? { type: 'baseBranch' as const, branch: args.base } : kind === 'commit' ? { type: 'commit' as const, sha: args.commit }
        : kind === 'files' ? { type: 'files' as const, paths } : { type: 'uncommittedChanges' as const };
      // The focus can be long; the board title only needs to say what is under review.
      const title = kind === 'files' ? `Audit of ${paths.slice(0, 3).join(', ')}${paths.length > 3 ? ` and ${paths.length - 3} more` : ''}`
        : `Review of ${kind === 'branch' ? `the branch against ${args.base}` : kind === 'commit' ? `commit ${args.commit.slice(0, 8)}` : 'uncommitted changes'}`;
      return runJob({ kind: 'review', role: args.runs_app ? 'verify' : 'review', cwd, title, task: args.focus, done_when: args.done_when, review: { target, mode: args.mode ?? 'adversarial' }, agent: args.agent, tier: args.tier, model: args.model, effort: args.effort, runsApp: Boolean(args.runs_app), plugins: args.plugins, skills: args.skills, attachments: args.attachments, taskId: args.task_id }, args.background !== false, ctx, args.mission);
    }
    case 'polish':
      if (args.exclusive) throw new Error('polish cannot run alone: an editor measures nothing. Drop exclusive.');
      return runJob({ kind: 'polish', role: 'polish', cwd, title: args.title ?? `Polish ${args.targets.join(', ')}`, task: args.guidance, targets: args.targets, base: args.base, isolation: args.isolation, agent: args.agent, tier: args.tier, model: args.model, skills: args.skills, taskId: args.task_id }, args.background !== false, ctx, args.mission);
    case 'mission':
      return reportMission(args, ctx);
    case 'route': {
      if (!args.kind) {
        const measured = describeUsage(await api('GET', '/api/usage'));
        return measured.length ? measured.join('\n') : 'AgentGauge has no usage data on this machine, so the roles are followed as assigned.';
      }
      const mission = await jobMission(args.mission);
      const query = `kind=${encodeURIComponent(args.kind)}${mission ? `&mission=${encodeURIComponent(mission)}` : ''}`;
      const decision: RouteDecision & { preset?: PresetName | null; policy?: Preset | null } = await withMission(mission, () => api('GET', `/api/route?${query}`));
      const who = decision.assignee === 'claude' ? 'you (the lead)' : WORKERS[decision.assignee].name;
      const lines = [`${args.kind} → ${who}`, decision.reason];
      if (decision.degraded) lines.push('Degraded: the usual cross-check is missing. Say so in your report.');
      if (decision.deferUntil) lines.push(`Can wait until ${new Date(decision.deferUntil).toISOString()}.`);
      if (decision.fallback.length) lines.push(`If that fails: ${decision.fallback.map((a) => (a === 'claude' ? 'you' : WORKERS[a].name)).join(', then ')}.`);
      // A daemon that predates holders lists none.
      // Without agent a job goes to the role's first worker, which route may have just skipped.
      if (decision.assignee !== 'claude' && decision.assignee !== decision.holders?.find((h) => h.agent !== 'claude')?.agent) lines.push(`Pass agent: ${decision.assignee}.`);
      if ((decision.holders?.length ?? 0) > 1) lines.push(`Holders you may pick with agent: ${decision.holders!.map((h) => `${h.agent} (${h.status})`).join(', ')}.`);
      // A daemon that predates mission presets sends none; the session's instructions then still hold.
      if (decision.preset !== undefined) lines.push(presetPolicy(decision.preset, decision.policy ?? undefined, ' for the next job'));
      return withNotes(lines.join('\n'), args.kind === 'lead' ? [] : decision.holders?.map((h) => h.agent) ?? roles[args.kind as Role]?.agents ?? [], 2);
    }
    case 'note':
    case 'note_summary': {
      const body = name === 'note_summary'
        ? { model: args.model, summary: args.summary }
        : { job: args.job_id, model: args.model, role: args.role, reviewer: args.reviewer, size: args.size, tier: args.tier, findings: args.findings, declined: args.declined, adoption: args.adoption, outcome: args.outcome, of_job: args.of_job, of_model: args.of_model, audit: args.audit, rating: args.rating, text: args.text };
      const score = await api('POST', '/api/notes', body);
      const shown = score.score === null ? '—' : score.score.toFixed(1);
      return `Noted. ${score.model} (${score.agent}): ${shown}/10, ${score.status}, ${score.buildSamples} build(s), ${score.fixSamples} fix(es)${score.reviewSamples ? `, ${score.reviewSamples} review(s)` : ''}.${score.ratingDropped ? ' The rating was not kept: the user turned peer ratings off.' : ''}${score.consolidate ? ' Its summary is due: rewrite it from the evidence with note_summary.' : ''}`;
    }
    case 'status': {
      if (args.job_id) {
        const job: JobView = await api('GET', `/api/jobs/${args.job_id}`);
        showEvidence(ctx, job);
        if (args.report_offset !== undefined || args.turn !== undefined) {
          const offset = args.report_offset ?? 0;
          if (!Number.isSafeInteger(offset) || offset < 0 || (args.turn !== undefined && (!Number.isSafeInteger(args.turn) || args.turn < 1))) throw new Error('Invalid report offset or turn.');
          const latest = job.exchange?.findLast((entry) => entry.from === 'worker');
          const latestTurn = latest?.turn ?? job.turns;
          const turn = args.turn ?? latestTurn;
          const report = turn === latestTurn ? job.report : job.exchange?.find((entry) => entry.turn === turn && entry.from === 'worker')?.text;
          if (report === undefined) throw new Error('That report turn is not retained.');
          const page = textPage(report, offset, REPORT_PAGE_BYTES);
          const next = offset + page.length;
          ctx.jobs.push(job);
          return `[${job.id}] report turn ${turn}, offset ${offset}:\n${page}\n${next < report.length ? `Next: status job_id "${job.id}", turn: ${turn}, report_offset: ${next}` : 'End of report.'}`;
        }
        return describeJob(job, ctx);
      }
      const state = await api('GET', '/api/state');
      const jobs: JobView[] = state.jobs.filter((j: JobView) => j.project === PROJECT);
      const active = jobs.filter((j) => !j.endedAt);
      const recent = jobs.filter((j) => j.endedAt).slice(0, 8);
      ctx.jobs.push(...active.slice(0, 8), ...recent);
      // Another lead session in this project may own these; a glance at the list must not take its news.
      ctx.adopt = false;
      ctx.allNews = true;
      const lines = [active.length ? 'Active:' : 'No active jobs.', ...active.slice(0, 8).map(summarize)];
      const elsewhere = state.jobs.filter((j: JobView) => j.project !== PROJECT && !j.endedAt).length;
      if (elsewhere) lines.push(`(${elsewhere} active job(s) belong to other projects; they are on the board.)`);
      if (recent.length) lines.push('', 'Recent:', ...recent.map(summarize));
      const pulls = sessionPulls(state.pulls ?? []);
      ctx.pullIds = pulls.map((pull) => pull.id);
      if (pulls.length) {
        lines.push('', 'Watched pull requests:', ...pulls.slice(0, 8).map((pull) => `[${pull.id}] ${pull.repo}#${pull.number} · ${pull.state}`));
        if (pulls.length > 8) lines.push(`(${pulls.length - 8} more.)`);
      }
      // A daemon that predates the role table reports none.
      if (state.roles) lines.push('', `Roles: ${(Object.keys(state.roles) as Role[]).map((role) => `${role} → ${holder(role, state.roles)}`).join(', ')}`);
      // A daemon that predates AgentGauge support reports no usage; Codex's own figures are then all there is.
      const measured = state.usage ? describeUsage(state.usage as Usage) : [];
      if (measured.length) lines.push('', 'Usage (AgentGauge):', ...measured);
      const windows = measured.length ? [] : (state.limits.codex?.windows ?? []);
      if (windows.length) lines.push('', `Codex usage: ${windows.map((w: any) => `${Math.round(w.usedPercent)}% of the ${w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}-day` : `${Math.round(w.minutes / 60)}-hour`} window`).join(', ')}`);
      lines.push('', `Board: ${baseUrl()}`);
      return lines.join('\n');
    }
    case 'wait': {
      let ids: string[] = args.job_ids ?? [];
      // Besides active jobs, pick up background jobs that ended without the lead having seen the result.
      if (!ids.length) ids = ((await api('GET', '/api/state')).jobs as JobView[]).filter((j) => j.project === PROJECT && j.lead === SESSION && (!j.endedAt || unread(j).length > 0)).map((j) => j.id);
      if (!ids.length) return 'No active jobs, and no finished job is waiting to be read.';
      const jobs = await follow(ids, args.timeout_seconds ?? DEFAULT_WAIT_SECONDS, (e) => ctx.progress(`${e.job_id}: ${e.detail}`), ctx.signal);
      ctx.jobs.push(...jobs);
      const ready = jobs.filter(needsLead);
      const running = jobs.filter((j) => !needsLead(j));
      for (const job of ready) showEvidence(ctx, job);
      const parts = ready.map(render);
      if (running.length) parts.push(`${ready.length ? 'Still running' : 'Timed out waiting; still running'}:\n${running.map(summarize).join('\n')}`);
      return parts.join('\n\n────────\n\n');
    }
    case 'answer':
      return describeJob(await api('POST', `/api/jobs/${args.job_id}/questions/${args.question_id}`, { answer: args.answer, attachments: args.attachments }), ctx);
    case 'reply': {
      await api('POST', `/api/jobs/${args.job_id}/reply`, { message: args.message, decision: args.decision, request_id: args.request_id, approved_by_user: args.approved_by_user, lead_session: SESSION, sync: args.sync ? true : undefined, attachments: args.attachments });
      return args.background !== false ? describeJob(await api('GET', `/api/jobs/${args.job_id}`), ctx) : followOne(args.job_id, ctx);
    }
    case 'cancel': {
      let job: JobView = await api('POST', `/api/jobs/${args.job_id}/cancel`, {});
      if (args.discard) job = await api('POST', `/api/jobs/${args.job_id}/discard`, {});
      return describeJob(job, ctx);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// --- MCP stdio transport -------------------------------------------------

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const inFlight = new Map<string | number, AbortController>();

function send(message: unknown): void {
  process.stdout.write(JSON.stringify(message) + '\n');
}

let nextRequest = 1;
const awaiting = new Map<string, { resolve: (result: any) => void; reject: (err: Error) => void }>();

/** Sends a request to the client. `cancel` withdraws it if it is still open. */
function request(method: string, params: unknown): { response: Promise<any>; cancel(): void } {
  const id = `crew-${nextRequest++}`;
  const response = new Promise<any>((resolve, reject) => awaiting.set(id, { resolve, reject }));
  send({ jsonrpc: '2.0', id, method, params });
  return {
    response,
    cancel: () => {
      if (awaiting.delete(id)) send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'no longer needed' } });
    },
  };
}

async function handle(msg: any): Promise<void> {
  const { id, method, params } = msg;
  const reply = (result: unknown) => send({ jsonrpc: '2.0', id, result });

  switch (method) {
    case 'initialize':
      canElicit = Boolean(params?.capabilities?.elicitation);
      return reply({
        protocolVersion: PROTOCOL_VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOL_VERSIONS[1],
        capabilities: { tools: {} },
        serverInfo: { name: 'crew', title: 'Crew', version: VERSION },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'notifications/cancelled':
      inFlight.get(params?.requestId)?.abort();
      return;
    case 'tools/call': {
      const controller = new AbortController();
      inFlight.set(id, controller);
      const token = params?._meta?.progressToken;
      let step = 0;
      const ctx: CallContext = {
        signal: controller.signal,
        images: [],
        jobs: [],
        progress: (message) => {
          if (token !== undefined) send({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: token, progress: ++step, message } });
        },
      };
      try {
        await ensureDaemon();
        const args = params.arguments ?? {};
        // Echoes refer to earlier responses. Process them before creating any new offer. A bad echo must not block
        // the call it rode on (a delegate, a reply): it is reported and the receipts stay unacknowledged.
        let ackNote = '';
        if (args.ack !== undefined) {
          await api('POST', '/api/lead/ack', { session: SESSION, ack: args.ack }).then(({ ignored }) => {
            if (ignored?.length) ackNote = clipped(`\n\nack not applied for ${ignored.join(', ')}: unknown, or for news this session no longer owns.`, 600);
          }, (err) => {
            ackNote = clipped(`\n\nack not applied: ${String((err as Error).message ?? err).split('\n')[0].replace(/\.$/, '')}. The news stays unacknowledged; read it with status.`, 600);
          });
        }
        let text: string;
        let isError: true | undefined;
        try {
          text = clipped(await callTool(params.name, args, ctx), LEAD_TEXT_BYTES) + ackNote;
        } catch (err) {
          if (!ctx.pullIds?.length) throw err;
          isError = true;
          text = clipped(String((err as Error).message ?? err), 7000);
        }
        if (SESSION && (ctx.jobs.length || ctx.pullIds?.length || ctx.allNews)) {
          // The call has already taken effect; failing it now over a missing offer would invite a duplicate retry.
          // The news stays in the ledger for the watcher, the Stop hook, or the next call.
          const ids = [...new Set(ctx.jobs.map((job) => job.id))];
          // Take over the jobs this response actually shows, as the wake hook would after this call, so it can carry their
          // news. A job cut off by the bound stays with its owner.
          const shown = ctx.adopt === false ? [] : ids.filter((jobId) => text.includes(`[${jobId}]`)).slice(0, 50);
          const offer = await (shown.length ? api('POST', '/api/lead/adopt', { session: SESSION, job_ids: shown }) : Promise.resolve())
            .then(() => api('POST', '/api/lead/offer', { session: SESSION, job_ids: ctx.allNews ? undefined : [...ids, ...(ctx.pullIds ?? [])], bytes: 4000 }))
            .then(({ offer }) => offer, () => null);
          if (offer) text += `\n\n${offer.text}`;
        }
        // The limit is on text, which is what grew without bound; evidence images keep their own path as before.
        if (jsonBytes(text) > LEAD_BYTES) throw new Error('Crew response exceeds its size limit. Read one job at a time.');
        reply({ content: [{ type: 'text', text }, ...imageContent(ctx.images)], isError });
      } catch (err) {
        reply({ content: [{ type: 'text', text: clipped(String((err as Error).message ?? err), 7000) }], isError: true });
      } finally {
        inFlight.delete(id);
      }
      return;
    }
    default:
      // Requests need an answer; unknown notifications are ignored.
      if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (typeof msg.method === 'string') return void handle(msg);
  // Otherwise it is the client's response to one of our requests.
  const waiter = awaiting.get(msg.id);
  if (!waiter) return;
  awaiting.delete(msg.id);
  if (msg.error) waiter.reject(new Error(msg.error.message ?? 'request failed'));
  else waiter.resolve(msg.result);
});

// Start the daemon with the session so the board and hooks work before the first tool call.
ensureDaemon().catch(() => {});
