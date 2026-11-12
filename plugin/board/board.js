// Live status board. State arrives over one SSE stream; cards are keyed by id
// and patched in place so timers, focus, and anything being typed survive updates.
//
// The board is organized by command, not by agent: each command is a track of stops, and the jobs
// started under it sit at the stop they belong to. Color and shape mean state, never agent. Time is
// only ever a label on the thing it describes; nothing is laid out along a time axis.

const jobs = new Map();
const sessions = new Map();
/** Commands the lead is carrying out, each with the jobs started under it. */
const missions = new Map();
let limits = { codex: null };
/** Worker agents and the roles assigned to them, as configured on the server. */
let agents = {};
let roles = {};
/** Recent events, oldest first; the feed is a filtered view of these. */
let events = [];
/** The job shown in the drawer, with its full prompt, and that job's own events. */
let openJob = null;
let openEvents = [];
/** Project directory the board is narrowed to, or '' for all. */
let project = '';
try {
  project = localStorage.getItem('crew.project') ?? '';
} catch {
  // Storage can be unavailable (private window, embedded pane); the filter then lasts for this page only.
}
/** Server clock minus local clock, so timers are right even if the two drift. */
let clockSkew = 0;

const FINISHED_SHOWN = 4;
const FEED_SHOWN = 60;
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
/**
 * Each agent's own mark, from optional files beside the plugin like the fonts. A mark is shown only once
 * its file has loaded, so without the files the board shows names alone and leaves no gap.
 */
const AGENT_ICONS = { claude: 'ClaudeCode', codex: 'Codex', antigravity: 'Antigravity' };
if (typeof Image === 'function') {
  for (const [agent, file] of Object.entries(AGENT_ICONS)) {
    const img = new Image();
    img.onload = () => document.documentElement.classList.add(`icon-${agent}`);
    img.src = `/icons/${file}.svg`;
  }
}
const agentIcon = (agent) => (AGENT_ICONS[agent] ? `<i class="agent-icon" data-agent="${agent}" aria-hidden="true"></i>` : '');
const KIND_NAMES = { delegate: 'Implementation', review: 'Review', polish: 'Polish' };
const ROLE_NAMES = { delegate: 'Engineer', review: 'Cross-review', polish: 'UX writing · docs' };
const ROLE_HINTS = { delegate: 'Builds separable pieces', review: 'Reviews the change', polish: 'Tidies wording only' };
/** Claude Code hands a session a file path instead of the text past this length. */
const CLAUDE_CONTEXT_LIMIT = 9000;
const STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'];
const STAGE_NAMES = { plan: 'Planning', implement: 'Implementing', 'self-review': 'Self-review', 'cross-review': 'Cross-review', fix: 'Fixing', polish: 'Polish', final: 'Final check' };
const MISSIONS_FINISHED_SHOWN = 2;
/** Stops on a command's track. The lead reports seven stages; the two reviews share one stop. */
const STOPS = ['Plan', 'Build', 'Review', 'Fix', 'Polish', 'Final'];
const STOP_OF_STAGE = { plan: 0, implement: 1, 'self-review': 2, 'cross-review': 2, fix: 3, polish: 4, final: 5 };
const STOP_OF_KIND = { delegate: 1, review: 2, polish: 4 };
/** What is happening at each stop, for someone who has not seen the pipeline before. */
const STOP_NOTES = [
  'Claude is working out what needs to be done and splitting it into pieces.',
  'The agents are writing the code, each in its own copy of the project.',
  'The work is being checked for mistakes, first by Claude and then by a second agent.',
  'Claude is fixing what the review found.',
  'Wording, comments, and docs are being tidied up.',
  'Everything is being tested one last time before it comes back to you.',
];
/** Commands the user folded or unfolded by hand; without an entry, an open command is unfolded and an ended one folded. */
const folded = new Map();
const EVENT_TONES = { waiting: 'waiting', stalled: 'waiting', error: 'failed', limit: 'failed', done: 'done' };

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** A duration as a label: coarse, because it is read at a glance and not compared. */
function brief(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function compact(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  return n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n);
}

/** The last two segments identify a project; the full path is in the tooltip. */
function shortPath(dir) {
  const parts = String(dir ?? '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}

function jobLabel(job) {
  if (job.state === 'waiting') return job.waiting.type === 'approval' ? 'Needs approval' : 'Has a question';
  if (job.stalled) return 'May be stuck';
  if (job.state === 'failed') return job.error?.limit ? 'Usage limit reached' : 'Failed';
  return { running: 'Working', done: 'Done', cancelled: 'Cancelled' }[job.state];
}

/** Identity of a control across re-renders: what it does and to what, not where it sits. */
const controlKey = (node) => node.matches?.('button, [data-keep], summary') ? `${node.tagName}|${JSON.stringify(node.dataset)}|${Object.keys(node.dataset).length ? '' : node.textContent}` : null;

/** Field an input method is composing in. Replacing it mid-composition would break the character being typed. */
let composing = null;
const deferred = new Map();
document.addEventListener('compositionstart', (e) => { composing = e.target; });
document.addEventListener('compositionend', () => {
  composing = null;
  for (const [el, html] of deferred) patch(el, html);
  deferred.clear();
});

/**
 * Replaces an element's markup only when it changed, carrying over what the user has typed into
 * fields marked data-keep, the outcome shown in a named data-status line, which control has focus,
 * and whether a <details> is open. A job update must never eat a half-written answer, the error
 * from sending one, or the user's place on the page.
 */
function patch(el, html) {
  if (el.dataset.html === html) return;
  if (composing && el.contains(composing)) {
    deferred.set(el, html);
    return;
  }
  const focused = el.contains(document.activeElement) ? document.activeElement : null;
  const focusedKey = focused && controlKey(focused);
  const kept = new Map([...el.querySelectorAll('[data-keep]')].map((field) => [
    field.dataset.keep,
    { value: field.value, start: field.selectionStart, end: field.selectionEnd },
  ]));
  const said = new Map([...el.querySelectorAll('[data-status]')].filter((line) => line.dataset.status && line.textContent).map((line) => [line.dataset.status, { text: line.textContent, tone: line.dataset.tone }]));
  const open = new Set([...el.querySelectorAll('details[open]')].map((d) => d.dataset.details));
  el.innerHTML = html;
  el.dataset.html = html;
  // Looping animations in the new markup start at the point a never-replaced one would have reached.
  el.style?.setProperty('--clock', `${-Math.round(performance.now())}ms`);
  for (const line of el.querySelectorAll('[data-status]')) {
    const was = said.get(line.dataset.status);
    if (!was) continue;
    line.textContent = was.text;
    if (was.tone) line.dataset.tone = was.tone;
  }
  for (const details of el.querySelectorAll('details')) details.open = open.has(details.dataset.details);
  for (const field of el.querySelectorAll('[data-keep]')) {
    const was = kept.get(field.dataset.keep);
    if (!was) continue;
    field.value = was.value;
    if (focusedKey === controlKey(field)) field.setSelectionRange(was.start, was.end);
  }
  if (focusedKey) [...el.querySelectorAll('button, [data-keep], summary')].find((node) => controlKey(node) === focusedKey)?.focus();
}

/** Says briefly, where it will be seen and read out, that something the user asked for did not happen. */
function notice(message) {
  const el = document.getElementById('notice');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { el.hidden = true; }, 8000);
}

/**
 * Every message to an agent is typed the same way, like a chat: one bar that grows with the text and holds
 * its send button at the end. `keep` names the draft so a redraw keeps it; `extra` is markup for the form.
 */
function composer(form, keep, label, placeholder, sendLabel, extra = '') {
  return `<form class="composer" data-form="${form}"${extra}>
      <div class="composer-bar"><textarea data-keep="${esc(keep)}" rows="1" aria-label="${esc(label)}" placeholder="${esc(placeholder)}"></textarea><button class="primary" type="submit" aria-label="${esc(sendLabel)}">Send</button></div>
      <span class="status" role="status" data-status="${esc(keep)}"></span>
    </form>`;
}

// In a composer, Enter sends and Shift+Enter starts a new line; text being composed by an input method is left alone.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing || !e.target.closest?.('.composer-bar')) return;
  e.preventDefault();
  e.target.form.requestSubmit();
});

/** The request a waiting job has for the user, with the controls that answer it. Shared by the card and the drawer. */
function callout(job) {
  if (job.state !== 'waiting') return '';
  const { id, type, reason, since } = job.waiting;
  const request = esc(id);
  // Keyed by request, so text typed for one question is never sent as the answer to the next.
  const answer = type === 'question'
    ? composer('answer', `answer:${request}`, 'Your answer', 'Type an answer', 'Send answer', ` data-request="${request}"`)
    : '';
  const quick = type === 'approval' ? ['Approve', 'Deny'] : ['Yes', 'No'];
  return `<div class="callout"><p>${esc(reason)}</p>${answer}<div class="actions">
      <button${type === 'approval' ? ' class="primary"' : ''} data-act="approve" data-request="${request}">${quick[0]}</button>
      <button data-act="deny" data-request="${request}">${quick[1]}</button>
      <span class="timer" data-from="${esc(since)}" data-suffix=" waiting"></span></div></div>`;
}

function resumeButton(job) {
  if (!job.sessionId || !agents[job.agent]) return '';
  const command = `${agents[job.agent].resume} ${job.sessionId}`;
  return `<button class="quiet" data-act="copy" data-copy="${esc(command)}" title="Copies the command that reopens this session in its own CLI">Copy resume command</button>`;
}

/** How a job reads on a track. The state decides both the color and the shape of its mark. */
function jobMark(job) {
  if (job.state === 'waiting') return 'waiting';
  if (job.stalled) return 'stalled';
  if (job.state === 'running') return 'working';
  if (job.state === 'done') return 'done';
  return job.state === 'failed' ? 'failed' : 'idle';
}

/** How long a job took, or how long it has been in the state it is in. */
function timeLabel(job) {
  const live = (from, attrs) => `<span class="time" data-from="${esc(from)}" data-brief ${attrs}></span>`;
  if (job.state === 'waiting') return live(job.waiting.since, 'data-prefix="waiting "');
  if (job.stalled) return live(job.activeAt, 'data-prefix="quiet for "');
  if (job.state === 'running') return live(job.createdAt, 'data-suffix=" so far"');
  const took = brief(job.endedAt - job.createdAt);
  return job.state === 'failed' ? `stopped after ${took}` : job.state === 'cancelled' ? `cancelled after ${took}` : took;
}

/** One job on a track. The whole item opens its details. */
function item(job) {
  const agent = agents[job.agent]?.name ?? AGENT_NAMES[job.agent];
  const flags = [job.runsApp && 'runs the app', job.exclusive && 'runs alone'].filter(Boolean).map((flag) => `<span class="flag">${flag}</span>`).join('');
  // One line under the title: what the job is doing, or why it is not doing anything.
  const now = job.state === 'waiting' ? jobLabel(job)
    : job.stalled ? `May be stuck · ${job.phase}`
    : job.state === 'running' ? job.phase
    : job.state === 'failed' ? job.error?.message : '';
  return `<li><button class="item" data-state="${jobMark(job)}" data-act="open" data-job="${esc(job.id)}" title="${esc(jobLabel(job))}">
      <span class="mark"></span><span class="what">${esc(job.title)}${flags}</span>
      ${now ? `<span class="now" title="${esc(now)}">${esc(now)}</span>` : ''}
      <span class="at">${STOPS[STOP_OF_KIND[job.kind]]}</span><span class="who">${esc(agent)}</span><span class="sub">${timeLabel(job)}</span>
    </button></li>`;
}

const SESSION_STATES = { working: 'working', waiting: 'waiting', error: 'failed', idle: 'idle' };
const SESSION_LABELS = { working: 'Working', waiting: 'Needs input', idle: 'Idle', error: 'Stopped on an error' };
const sessionMark = (s) => (s.stalled ? 'stalled' : SESSION_STATES[s.state]);
const sessionLabel = (s) => (s.stalled ? 'May be stuck' : SESSION_LABELS[s.state]);

/** Reconciles a list against the wanted items: reuse by key, patch changed markup, keep the given order, drop the rest. */
function reconcile(list, items, create) {
  const existing = new Map([...list.children].map((el) => [el.dataset.key, el]));
  // Gone ones leave first, so the rest are already in order and are not re-inserted: a moved element
  // would lose its running transition and replay its entrance.
  const wanted = new Set(items.map((item) => item.key));
  for (const [key, el] of existing) if (!wanted.has(key)) el.remove();
  items.forEach((item, index) => {
    let el = existing.get(item.key);
    if (!el) {
      el = create();
      el.dataset.key = item.key;
    }
    existing.delete(item.key);
    item.update(el);
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null);
  });
}

function renderCards(list, cards) {
  reconcile(list, cards.map((card) => ({
    key: card.key,
    update: (el) => {
      patch(el, card.html);
      el.toggleAttribute('data-quiet', Boolean(card.quiet));
      el.toggleAttribute('data-closed', Boolean(card.closed));
      el.style.viewTransitionName = cardName(card.key);
    },
  })), () => Object.assign(document.createElement('li'), { className: document.body.classList.contains('ready') ? 'card enter' : 'card' }));
}

const cardNames = new Map();
/** A name for a card that is valid in CSS, whatever its key holds. */
function cardName(key) {
  if (!cardNames.has(key)) cardNames.set(key, `card-${cardNames.size + 1}`);
  return cardNames.get(key);
}

/** Applies a change the user asked for so that what moves is seen moving, where the browser can do that. */
function smooth(change) {
  if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(change);
  else change();
}

/** Short, distinct names for projects: the folder name, or more of the path when two share one. */
function projectNames(dirs) {
  const last = (dir) => dir.split('/').filter(Boolean).pop() ?? dir;
  return new Map(dirs.map((dir) => [dir, dirs.filter((other) => last(other) === last(dir)).length > 1 ? shortPath(dir) : last(dir)]));
}

/**
 * The project a job or session belongs to: the repository's main working tree, so work started
 * from a subfolder or a worktree sits with the rest of its project. Older daemons send no root.
 */
const projectOf = (item) => item.root ?? item.project ?? item.cwd ?? '';
const isWaiting = (item) => item.state === 'waiting';

/**
 * Every project with something on the board. A mission counts even when its jobs and its session are gone:
 * an open one could otherwise be neither seen nor dismissed, and the ended ones the daemon keeps are there to be shown.
 */
function knownProjects() {
  return [...new Set([...jobs.values(), ...sessions.values(), ...missions.values()].map(projectOf).filter(Boolean))].sort();
}

/** The filter in effect: a saved project that is no longer on the board filters nothing. */
function activeProject() {
  return knownProjects().includes(project) ? project : '';
}

/**
 * The projects as a panel down the side, one row each, since there may come to be many. A row says what
 * waits on the user there, or else how much is running. With one project there is nothing to choose between.
 */
function renderProjects(dirs, names) {
  document.getElementById('side').hidden = dirs.length < 2;
  const current = activeProject();
  const mine = (dir) => (item) => !dir || projectOf(item) === dir;
  const waiting = (dir) => [...jobs.values(), ...sessions.values()].filter((item) => isWaiting(item) && mine(dir)(item)).length;
  const running = (dir) => [...jobs.values()].filter((job) => !job.endedAt && mine(dir)(job)).length + [...sessions.values()].filter((s) => s.state !== 'idle' && mine(dir)(s)).length;
  patch(document.getElementById('projects'), [['', 'All projects'], ...dirs.map((dir) => [dir, names.get(dir)])]
    .map(([dir, name]) => {
      const count = waiting(dir);
      const busy = running(dir);
      const tail = count ? `<span class="count" title="${count} waiting on you">${count}</span>` : busy ? `<span class="busy" title="${busy} running">${busy}</span>` : '';
      return `<button data-project="${esc(dir)}" aria-pressed="${dir === current}" title="${esc(dir || 'Every project')}"><span class="name">${esc(name)}</span>${tail}</button>`;
    })
    .join(''));
}

const WORKERS_SHOWN = ['codex', 'antigravity'];
const SESSION_ORDER = { waiting: 0, working: 1, error: 2, idle: 3 };
const URGENCY = ['waiting', 'failed', 'stalled', 'working'];

/** The state a group of things shows as one: the most urgent among them, done when all are over, else nothing. */
function together(marks) {
  return URGENCY.find((mark) => marks.includes(mark)) ?? (marks.length && marks.every((mark) => mark === 'done' || mark === 'idle') ? 'done' : '');
}

/**
 * A track: the stops in order, each with the jobs that belong to it. `at` is the stop the command has
 * reached, or -1 for jobs that belong to no command, which have no position to show.
 */
function trackOf(list, at, active, finished, lead = '') {
  const byStop = STOPS.map((_, stop) => list.filter((job) => STOP_OF_KIND[job.kind] === stop));
  const pos = (stop) => (finished || stop < at ? 'past' : stop === at && active ? 'now' : 'todo');
  const note = active && at >= 0 ? `<p class="step-note"><b>${STOPS[at]}.</b> ${STOP_NOTES[at]}</p>` : '';
  const html = `${note}<ol class="track">${STOPS.map((name, stop) => {
    const rows = (stop === at ? lead : '') + byStop[stop].map(item).join('');
    return `<li class="stop" data-pos="${pos(stop)}"><p class="stop-name"><i class="node"></i><span title="${name}">${name}</span></p>${rows ? `<ul class="items">${rows}</ul>` : ''}</li>`;
  }).join('')}</ol>`;
  // Folded, each stop is one square: its jobs' state if it has any, else whether the command has passed it.
  const mini = `<span class="mini" aria-hidden="true">${STOPS.map((_, stop) =>
    `<i data-state="${together(byStop[stop].map(jobMark)) || { past: 'done', now: 'working', todo: '' }[pos(stop)]}"></i>`).join('')}</span>`;
  return { html, mini };
}

/** A ring filled to `part` of `whole`. */
function ring(part, whole) {
  const around = 2 * Math.PI * 42;
  const left = around * (1 - (whole ? Math.min(part / whole, 1) : 0));
  return `<svg class="ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="ring-rail" cx="50" cy="50" r="42"/><circle class="ring-fill" cx="50" cy="50" r="42" stroke-dasharray="${around.toFixed(1)}" style="stroke-dashoffset:${left.toFixed(1)}"/></svg>`;
}

/** The steps as a ring of arcs, one per stop, marked as the track marks its stops: passed, reached, or to come. */
function stepRing(positions) {
  const around = 2 * Math.PI * 42;
  const arc = around / positions.length;
  // Arcs have round ends, which reach half the stroke (4) past the dash; 13 units leaves a visible gap of 5,
  // centered on each boundary so the first gap sits at twelve o'clock.
  const cut = 13;
  return `<svg class="ring steps" viewBox="0 0 100 100" aria-hidden="true">${positions.map((pos, i) =>
    `<circle data-pos="${pos}" cx="50" cy="50" r="42" stroke-dasharray="${(arc - cut).toFixed(2)} ${(around - arc + cut).toFixed(2)}" stroke-dashoffset="${(-i * arc - cut / 2).toFixed(2)}"/>`).join('')}</svg>`;
}

/** Changes a figure so the old value rolls out and the new one rolls in. The first value just appears. */
function roll(el, text) {
  const was = el.dataset.value;
  if (was === text) return;
  el.dataset.value = text;
  el.innerHTML = was === undefined ? `<span>${esc(text)}</span>` : `<span class="roll-out" aria-hidden="true">${esc(was)}</span><span class="roll-in">${esc(text)}</span>`;
}

function commandHead(key, title, closed, mini, meta, action = '') {
  return `<div class="cmd-head">
      <button class="cmd-toggle" data-act="toggle" data-command="${esc(key)}" aria-expanded="${!closed}"><i class="chev"></i><span class="cmd-title" title="${esc(title)}">${esc(title)}</span></button>
      ${mini}<span class="cmd-meta">${meta}</span>${action}
    </div>`;
}

/** One command as a unit: the stop the lead has reached, and each job started under it at the stop it belongs to. */
function commandCard(mission) {
  const mine = [...jobs.values()].filter((job) => job.mission === mission.id).sort((a, b) => a.createdAt - b.createdAt);
  const active = mission.state === 'active';
  const at = STOP_OF_STAGE[mission.stage];
  // The lead's own work is not a job. It is shown when the session that opened the command is known.
  const session = active ? sessions.get(mission.owner) : null;
  const lead = session
    ? `<li><div class="item" data-state="${sessionMark(session)}" title="${esc(sessionLabel(session))}">
        <span class="mark"></span><span class="what">${STAGE_NAMES[mission.stage]}</span>
        ${session.state === 'waiting' && session.waitingFor ? `<span class="now">${esc(session.waitingFor)}</span>` : session.phase ? `<span class="now">${esc(session.phase)}</span>` : ''}
        <span class="at">${STOPS[at]}</span><span class="who">Claude</span><span class="sub">Lead</span>
      </div></li>`
    : '';
  const { html, mini } = trackOf(mine, at, active, mission.state === 'done', lead);
  const tokens = mine.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  // The most urgent thing under the command decides the chip's state; the stop it has reached is its label.
  const mood = together([...mine.filter((job) => !job.endedAt).map(jobMark), ...(session ? [sessionMark(session)] : [])].filter((mark) => mark !== 'idle')) || 'working';
  const chip = active
    ? `<span class="chip" data-state="${mood}"><span class="mark"></span>${{ waiting: 'Needs you', stalled: 'Gone quiet', failed: 'A job failed' }[mood] ?? `Step ${at + 1} of ${STOPS.length} · ${STOPS[at]}`}</span>`
    : `<span class="chip" data-state="${mission.state === 'done' ? 'done' : 'idle'}"><span class="mark"></span>${mission.state === 'done' ? 'Done' : 'Abandoned'}</span>`;
  const meta = [
    `<span class="time" data-from="${esc(mission.createdAt)}" data-to="${esc(mission.endedAt ?? '')}" data-brief ${active ? 'data-suffix=" so far"' : 'data-prefix="took "'}></span>`,
    tokens ? `<span title="How much AI usage this has taken">${compact(tokens)} tokens</span>` : '',
  ].filter(Boolean).join(' · ');
  const ended = mission.state === 'done' ? 'done' : active ? '' : 'abandoned';
  // The one figure to read at a glance: how far along the six steps this task is.
  const stage = `<div class="stage"${ended ? ` data-ended="${ended}"` : ''}>
      <div class="stage-ring">${stepRing(STOPS.map((_, stop) => (ended === 'done' || stop < at ? 'past' : stop === at && active ? 'now' : 'todo')))}<b>${ended === 'done' ? '<i class="tick"></i>' : `${at + 1}<small>/${STOPS.length}</small>`}</b></div>
      <p class="stage-label">${active ? 'Now at step' : ended === 'done' ? 'Finished' : 'Stopped at step'}</p>
      <p class="stage-name">${ended === 'done' ? 'All done' : STOPS[at]}</p>
    </div>`;
  const closed = folded.get(mission.id) ?? !active;
  const dismiss = active ? `<button class="quiet" data-act="dismiss" data-mission="${esc(mission.id)}" title="Closes this command on the board. Its jobs keep running.">Dismiss</button>` : '';
  return {
    key: mission.id,
    quiet: !active,
    closed,
    html: `${commandHead(mission.id, mission.title, closed, mini + chip, meta, dismiss)}
      <div class="cmd-body">${stage}<div class="cmd-main">${html}${mission.outcome ? `<p class="outcome">${esc(mission.outcome)}</p>` : ''}</div></div>`,
  };
}

/** Jobs started outside any command, kept together so they are not lost between the commands. */
function looseCard(dir, list) {
  const running = list.filter((job) => !job.endedAt);
  const shown = [...running, ...list.filter((job) => job.endedAt).sort((a, b) => b.endedAt - a.endedAt).slice(0, FINISHED_SHOWN)].sort((a, b) => a.createdAt - b.createdAt);
  const key = `loose:${dir}`;
  const { html, mini } = trackOf(shown, -1, false, false);
  const closed = folded.get(key) ?? running.length === 0;
  return { key, quiet: running.length === 0, closed, html: `${commandHead(key, 'Other jobs', closed, mini, running.length ? `${running.length} running` : 'Nothing running')}<div class="cmd-body" data-plain><div class="cmd-main">${html}</div></div>` };
}

/** Who is asking, large, with the job it is about under it. */
const needHead = (title, about) => `<div class="need-head"><span class="need-icon" data-state="waiting"><span class="mark"></span></span><div><p class="need-title">${esc(title)}</p><p class="need-who" title="${esc(about)}">${esc(about)}</p></div></div>`;

/** Whether the requests are laid out or tucked into a pill. A request that arrives lays them out again, except on a phone. */
let dockOpen = true;
let dockCount = 0;

/**
 * Everything waiting on the user, floating over the board so it is seen wherever the page is scrolled.
 * The oldest request is in front with the controls that answer it; the rest wait behind it.
 */
function renderNeeds() {
  const names = projectNames(knownProjects());
  const where = (it) => (names.size > 1 ? ` · ${names.get(projectOf(it)) ?? ''}` : '');
  const cards = [
    ...[...jobs.values()].filter(isWaiting).sort((a, b) => a.waiting.since - b.waiting.since).map((job) => ({
      key: job.id,
      html: `${needHead(`${agents[job.agent]?.name ?? AGENT_NAMES[job.agent]} ${job.waiting.type === 'approval' ? 'needs your permission' : 'has a question'}`, job.title + where(job))}${callout(job)}
        <p class="hint">This job is paused until you answer.</p>`,
    })),
    ...[...sessions.values()].filter(isWaiting).map((s) => ({
      key: `session:${s.id}`,
      html: `${needHead('Claude needs your input', s.title + where(s))}<div class="callout"><p>${esc(s.waitingFor || 'Answer it in the Claude app.')}</p></div>
        <p class="hint">Answer in the Claude app, in the session that asked.</p>`,
    })),
  ];
  const total = cards.length;
  // On a phone a laid-out request would cover most of the board; there it arrives as the pill, and the
  // headline's Answer button or the pill lays it out.
  if (total > dockCount) dockOpen = !matchMedia('(max-width: 760px)').matches;
  dockCount = total;
  const dock = document.getElementById('dock');
  dock.hidden = total === 0;
  dock.toggleAttribute('data-collapsed', !dockOpen);
  patch(document.getElementById('dock-pill'), `<span class="mark"></span>${total === 1 ? '1 request waiting on you' : `${total} requests waiting on you`}<b>Answer</b>`);
  reconcile(document.getElementById('needs'), cards.map((card, index) => ({
    key: card.key,
    update: (li) => patch(li, `<div class="need-bar"><span class="chip" data-state="waiting"><span class="mark"></span>${total > 1 ? `Request ${index + 1} of ${total}` : 'Needs you'}</span>
        <button class="quiet" data-act="later" title="Tucks the request away. The job stays paused until you answer.">Later</button></div>${card.html}`),
  })), () => Object.assign(document.createElement('li'), { className: 'card need' }));
}

// The page and the feed leave room for the dock, however tall the request in front is, so nothing stays under it.
if (window.ResizeObserver) {
  const dock = document.getElementById('dock');
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock', `${dock.offsetHeight}px`)).observe(dock);
}

/** Position in the "right now" list of the line shown largest; it moves on by itself. */
let nowAt = 0;
let nowVisible = () => true;

/**
 * What every agent is doing this moment, one line each, as a wheel that turns by itself: the line in
 * the middle is the one to read, its neighbors recede. Lines keep their element, so they glide when the wheel turns.
 */
function renderNow(visible) {
  if (visible) nowVisible = visible;
  const lines = [
    ...[...sessions.values()].filter((s) => nowVisible(s) && s.state !== 'idle').map((s) => ({
      key: `session:${s.id}`, state: sessionMark(s), who: 'Claude', about: s.title,
      text: s.state === 'waiting' ? s.waitingFor || 'Needs your input' : s.phase || sessionLabel(s),
    })),
    ...[...jobs.values()].filter((job) => nowVisible(job) && !job.endedAt).map((job) => ({
      key: job.id, state: jobMark(job), who: agents[job.agent]?.name ?? AGENT_NAMES[job.agent], about: job.title,
      text: job.state === 'waiting' ? jobLabel(job) : job.stalled ? 'May be stuck' : job.phase || 'Working',
    })),
  ];
  const count = lines.length;
  if (count) nowAt = ((nowAt % count) + count) % count;
  reconcile(document.getElementById('now'), lines.map((line, index) => ({
    key: line.key,
    update: (li) => {
      // The shortest way round the wheel from the middle line to this one.
      let offset = index - nowAt;
      if (offset > count / 2) offset -= count;
      if (offset < -count / 2) offset += count;
      // A line that goes round the back is not seen crossing the front: it jumps to its new place and fades in there.
      const wrapped = li.dataset.offset !== undefined && Math.abs(offset - Number(li.dataset.offset)) > 1;
      if (wrapped) {
        li.dataset.wrap = li.dataset.wrap === 'a' ? 'b' : 'a';
        li.style.transition = 'none';
      }
      li.dataset.offset = offset;
      li.dataset.state = line.state;
      li.toggleAttribute('data-center', offset === 0);
      li.style.setProperty('--o', offset);
      li.style.setProperty('--a', Math.abs(offset));
      if (wrapped) {
        li.getBoundingClientRect();
        li.style.transition = '';
      }
      patch(li, `<span class="dot"></span><span class="now-text" title="${esc(line.text)}">${esc(line.text)}</span><span class="now-who" title="${esc(line.who)} · ${esc(line.about)}">${esc(line.who)} · ${esc(line.about)}</span>`);
    },
  })), () => Object.assign(document.createElement('li'), { className: 'now-line' }));
}
setInterval(() => {
  // It holds still while the pointer is on it, so a line can be read to the end.
  if (document.hidden || document.querySelector('.wheel:hover')) return;
  nowAt += 1;
  renderNow();
}, 2800);

/** The agents as resources: what each is doing and how much of its allowance is used. They are not what the board is organized by. */
function renderAgents(visible) {
  const windows = limits.codex?.windows ?? [];
  const top = windows.reduce((max, w) => Math.max(max, Math.round(w.usedPercent)), 0);
  const usage = windows.length
    ? `<span class="meter"${top >= 90 ? ' data-high' : ''} style="--used:${top}"><i></i></span><span class="pct">${top}% of limit used</span>`
    : '';
  const usageTitle = windows.map((w) => `${Math.round(w.usedPercent)}% of the ${w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}-day` : `${Math.round(w.minutes / 60)}-hour`} limit`).join(', ');
  const chips = [
    { agent: 'claude', marks: [...sessions.values()].filter(visible).map(sessionMark), role: 'Lead', hint: 'Plans the work, checks it, and puts it together' },
    ...WORKERS_SHOWN.map((agent) => ({
      agent,
      marks: [...jobs.values()].filter((job) => job.agent === agent && !job.endedAt && visible(job)).map(jobMark),
      role: Object.keys(ROLE_NAMES).filter((role) => roles[role]?.agent === agent).map((role) => ROLE_NAMES[role]).join(' · ') || 'No role',
      hint: Object.keys(ROLE_HINTS).filter((role) => roles[role]?.agent === agent).map((role) => ROLE_HINTS[role]).join(' · ') || 'Not given any kind of job',
    })),
  ];
  patch(document.getElementById('agents'), chips.map(({ agent, marks, role, hint }) => {
    const busy = marks.filter((mark) => mark !== 'idle' && mark !== 'done').length;
    const state = URGENCY.find((mark) => marks.includes(mark)) ?? 'idle';
    const label = { waiting: 'Needs you', failed: 'Failed', stalled: 'May be stuck', working: busy > 1 ? `${busy} working` : 'Working', idle: 'Idle' }[state];
    const name = agents[agent]?.name ?? AGENT_NAMES[agent];
    const extra = agent === 'codex' && usage ? `<p class="usage" title="${esc(usageTitle)}">${usage}</p>` : '';
    return `<li class="tile">
        <div class="tile-head">
          <span class="agent-well" data-agent="${agent}">${agentIcon(agent)}<b aria-hidden="true">${esc(name[0])}</b></span>
          <div class="tile-id"><p class="tile-label" title="${esc(role)}">${esc(role)}</p><p class="tile-value" title="${esc(name)}">${esc(name)}</p></div>
          <span class="chip" data-state="${state}"><span class="mark"></span>${label}</span>
        </div>
        <p class="tile-hint">${esc(hint)}</p>
        ${extra}
      </li>`;
  }).join(''));
}

const SUMMARY_STATES = [
  ['working', 'In progress', 'Jobs an agent is working on right now'],
  ['waiting', 'Needs you', 'Paused until you approve something or answer a question'],
  ['stalled', 'Gone quiet', 'Still running, but silent for a while. It may be stuck.'],
  ['failed', 'Failed', 'Jobs that stopped on an error'],
  ['done', 'Finished', 'Jobs that are complete'],
];

/**
 * The board in one sentence, a figure for each state, and one ring: how much of the work in hand is finished.
 * Work in hand is every unfinished job, and the finished ones of commands that are still open.
 */
function renderSummary(visible) {
  const open = [...missions.values()].filter((m) => m.state === 'active' && visible(m));
  const live = [...jobs.values()].filter((job) => visible(job) && (!job.endedAt || missions.get(job.mission)?.state === 'active'));
  const asking = [...sessions.values()].filter((s) => visible(s) && isWaiting(s)).length;
  const marks = live.map(jobMark);
  const stats = SUMMARY_STATES.map(([state, label, hint]) => ({ state, label, hint, n: marks.filter((mark) => mark === state).length + (state === 'waiting' ? asking : 0) }));
  const n = Object.fromEntries(stats.map((stat) => [stat.state, stat.n]));
  const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
  const headline = n.waiting ? (n.waiting === 1 ? 'One thing needs your answer' : `${n.waiting} things need your answer`)
    : open.length ? `Working on ${plural(open.length, 'task')}`
    : n.working + n.stalled ? `${plural(n.working + n.stalled, 'job')} running` : 'All quiet';
  const lede = n.waiting ? (n.waiting === 1 ? 'That job is paused until you reply.' : 'Those jobs are paused until you reply.')
    : n.failed ? `${plural(n.failed, 'job')} stopped on an error. Open it to see what went wrong.`
    : n.stalled ? `${plural(n.stalled, 'job')} has gone quiet and may be stuck. Open it to check.`
    : open.length || n.working ? 'Nothing needs you right now. You can leave this open and check back.'
    : 'Start a task with /crew:run in a Claude session and it will show up here.';
  const tokens = live.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  patch(document.getElementById('summary'), `<p class="eyebrow">${[open.length && plural(open.length, 'task'), plural(live.length, 'job'), `${compact(tokens)} tokens used`].filter(Boolean).join(' · ')}</p>
    <h2>${headline}</h2><p class="lede">${lede}</p>${n.waiting ? '<div class="actions"><button class="primary" data-act="answer">Answer</button></div>' : ''}`);
  // The tiles keep their elements, so a figure that changes rolls instead of blinking.
  reconcile(document.getElementById('stats'), stats.map((stat) => ({
    key: stat.state,
    update: (li) => {
      if (!li.firstChild) li.innerHTML = `<span class="stat-label"><span class="mark"></span>${stat.label}</span><b class="roll"></b>`;
      li.dataset.state = stat.state;
      li.title = stat.hint;
      li.toggleAttribute('data-none', !stat.n);
      roll(li.querySelector('.roll'), String(stat.n));
    },
  })), () => Object.assign(document.createElement('li'), { className: 'stat' }));
  const gauge = document.getElementById('gauge');
  if (!gauge.firstChild) gauge.innerHTML = `<div class="gauge-ring">${ring(0, 1)}<b><span class="roll"></span><small></small></b></div><p class="gauge-label"></p>`;
  const fill = gauge.querySelector('.ring-fill');
  fill.style.strokeDashoffset = (2 * Math.PI * 42 * (1 - (live.length ? n.done / live.length : 0))).toFixed(1);
  // A round cap on an empty arc still draws a dot at twelve o'clock.
  fill.style.opacity = n.done ? '' : '0';
  roll(gauge.querySelector('.roll'), String(n.done));
  gauge.querySelector('.gauge-ring small').textContent = live.length ? `/${live.length}` : '';
  gauge.querySelector('.gauge-label').textContent = !live.length ? 'No jobs yet' : n.done === live.length ? 'Every job is finished' : 'jobs finished';
}

function groupElement() {
  const el = document.createElement('section');
  el.className = 'group';
  el.innerHTML = '<header class="group-head"></header><ul class="sessions" data-sessions></ul><ul class="commands" data-commands></ul><p class="empty">Nothing here yet. Start a task with /crew:run in a Claude session and it will show up here.</p>';
  return el;
}

function render() {
  const dirs = knownProjects();
  const names = projectNames(dirs);
  const only = activeProject();
  // With nothing on the board there is still one group, so there is somewhere to say so.
  const shown = only ? [only] : dirs.length ? dirs : [''];
  const groups = document.getElementById('groups');
  // Alphabetical and fixed: a project must not change place because one of its agents did something.
  reconcile(groups, shown.map((dir) => ({
    key: dir,
    update: (el) => {
      const mine = (it) => !dir || projectOf(it) === dir;
      const own = { sessions: [...sessions.values()].filter(mine), jobs: [...jobs.values()].filter(mine), missions: [...missions.values()].filter(mine) };
      const active = own.sessions.filter((s) => s.state !== 'idle').length + own.jobs.filter((job) => !job.endedAt).length;
      const waiting = [...own.jobs, ...own.sessions].filter(isWaiting).length;
      const summary = [active && `<span>${active} active</span>`, waiting && `<span class="waiting">${waiting} waiting on you</span>`].filter(Boolean).join('') || 'Nothing running';
      const head = el.querySelector('.group-head');
      // The empty board still has a heading, so its card lines up with the activity column beside it.
      patch(head, dir ? `<h2><button class="link" data-project="${esc(dir)}" title="Show only ${esc(names.get(dir) ?? 'this project')}">${esc(names.get(dir) ?? '')}</button></h2>
        <span class="path" title="${esc(dir)}">${esc(shortPath(dir))}</span><span class="group-meta">${summary}</span>` : '<h2>Projects</h2>');

      own.sessions.sort((a, b) => SESSION_ORDER[a.state] - SESSION_ORDER[b.state] || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
      reconcile(el.querySelector('[data-sessions]'), own.sessions.map((s) => ({
        key: s.id,
        update: (li) => {
          const detail = s.state === 'waiting' ? s.waitingFor : s.phase;
          li.dataset.state = sessionMark(s);
          li.title = s.cwd;
          patch(li, `<span class="mark"></span><span class="what">${esc(s.title)}</span><span class="sub">Claude · ${esc(sessionLabel(s))}${detail ? ` · ${esc(detail)}` : ''}</span>`);
        },
      })), () => Object.assign(document.createElement('li'), { className: 'session' }));

      const open = own.missions.filter((m) => m.state === 'active').sort((a, b) => b.createdAt - a.createdAt);
      // The ones that ended last, whenever they began: a long command must not vanish the moment it finishes.
      const ended = own.missions.filter((m) => m.state !== 'active').sort((a, b) => b.endedAt - a.endedAt).slice(0, MISSIONS_FINISHED_SHOWN);
      const loose = own.jobs.filter((job) => !missions.has(job.mission));
      renderCards(el.querySelector('[data-commands]'), [...open.map(commandCard), ...(loose.length ? [looseCard(dir, loose)] : []), ...ended.map(commandCard)]);
    },
  })), groupElement);

  const visible = (it) => !only || projectOf(it) === only;
  renderAgents(visible);
  renderSummary(visible);
  renderNow(visible);
  renderProjects(dirs, names);
  renderNeeds();
  // Counted across every project: the tab title is what is seen when the board is not.
  const pending = [...jobs.values(), ...sessions.values()].filter(isWaiting).length;
  document.title = pending ? `(${pending}) Crew` : 'Crew';
  tick();
}

function tick() {
  const now = Date.now() + clockSkew;
  for (const el of document.querySelectorAll('[data-from]')) {
    const span = (el.dataset.to ? Number(el.dataset.to) : now) - Number(el.dataset.from);
    el.textContent = (el.dataset.prefix ?? '') + ('brief' in el.dataset ? brief(span) : elapsed(span)) + (el.dataset.suffix ?? '');
  }
}
setInterval(tick, 1000);

function eventRow(event) {
  const time = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const tone = EVENT_TONES[event.kind];
  const job = jobs.get(event.job_id);
  // Names the job, so two jobs of one agent can be told apart, and opens it.
  const tag = job ? `<button class="tag" data-act="open" data-job="${esc(job.id)}" title="Open ${esc(job.title)}">${esc(job.title)}</button>` : '';
  // With several projects on the board at once, each row says which one it belongs to.
  const dir = eventProject(event);
  const dirs = knownProjects();
  const where = dir && dirs.length > 1 && !activeProject() ? `<span class="where" title="${esc(dir)}">${esc(projectNames(dirs).get(dir) ?? shortPath(dir))}</span>` : '';
  return `<time datetime="${esc(event.ts)}">${time}</time><span class="who">${agentIcon(event.agent)}${AGENT_NAMES[event.agent]}${tag}${where}</span><span class="what"${tone ? ` data-tone="${tone}"` : ''} title="${esc(event.detail)}">${esc(event.detail)}</span>`;
}

function eventProject(event) {
  const owner = jobs.get(event.job_id) ?? sessions.get(event.session_id);
  return owner ? projectOf(owner) : '';
}

/** An event with no known job or session cannot be placed in a project, so it is always shown. */
function inProject(event) {
  const only = activeProject();
  const dir = eventProject(event);
  return !only || !dir || dir === only;
}

function renderFeed() {
  const feed = document.getElementById('feed');
  feed.replaceChildren(...events.filter(inProject).slice(-FEED_SHOWN).reverse().map((event) => {
    const li = document.createElement('li');
    li.innerHTML = eventRow(event);
    return li;
  }));
  renderPulse();
}

const PULSE_BINS = 12;
const PULSE_SPAN = 5 * 60_000;
let pulseBins = [];

/**
 * The last hour of activity as twelve five-minute bars beside the feed's heading. The heading's own
 * line is the readout: pointing at a bar says that stretch's count there, instead of in a tooltip.
 */
function renderPulse() {
  const end = Date.now() + clockSkew;
  pulseBins = Array.from({ length: PULSE_BINS }, (_, i) => ({ from: end - (PULSE_BINS - i) * PULSE_SPAN, n: 0 }));
  for (const event of events) {
    if (!inProject(event)) continue;
    const i = PULSE_BINS - 1 - Math.floor((end - Date.parse(event.ts)) / PULSE_SPAN);
    if (i >= 0 && i < PULSE_BINS) pulseBins[i].n += 1;
  }
  const top = Math.max(1, ...pulseBins.map((bin) => bin.n));
  const el = document.getElementById('pulse');
  if (el.children.length !== PULSE_BINS) el.innerHTML = pulseBins.map((_, i) => `<i data-bin="${i}"></i>`).join('');
  pulseBins.forEach((bin, i) => {
    el.children[i].style.setProperty('--h', bin.n / top);
    el.children[i].toggleAttribute('data-empty', !bin.n);
  });
  pulseRead();
}

function pulseRead(i) {
  const read = document.getElementById('pulse-read');
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const total = pulseBins.reduce((sum, bin) => sum + bin.n, 0);
  read.textContent = i === undefined
    ? `${total} in the last hour`
    : `${pulseBins[i].n} at ${clock(pulseBins[i].from)}–${clock(pulseBins[i].from + PULSE_SPAN)}`;
  read.toggleAttribute('data-pointed', i !== undefined);
}
document.addEventListener('pointerover', (e) => {
  const bar = e.target.closest?.('#pulse i');
  if (bar) pulseRead(Number(bar.dataset.bin));
});
document.addEventListener('pointerout', (e) => {
  if (e.target.closest?.('#pulse') && !e.relatedTarget?.closest?.('#pulse')) pulseRead();
});
setInterval(() => { if (!document.hidden) renderPulse(); }, 60_000);

function addEvent(event) {
  events.push(event);
  if (events.length > 400) events.splice(0, events.length - 400);
  if (event.job_id && event.job_id === openJob?.id) {
    openEvents.push(event);
    renderDrawer();
  }
  if (!inProject(event)) return;
  const feed = document.getElementById('feed');
  const li = document.createElement('li');
  li.className = 'enter';
  li.innerHTML = eventRow(event);
  feed.prepend(li);
  while (feed.children.length > FEED_SHOWN) feed.lastElementChild.remove();
  renderPulse();
}

async function call(route, body) {
  const res = await fetch(route, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Request failed');
  return data;
}

// --- Job drawer ---

const drawer = document.getElementById('drawer');

/** The drawer's sections, rendered and patched one by one so that an update to one leaves the others, and what is typed or opened in them, alone. */
const DRAWER_PARTS = ['head', 'state', 'facts', 'result', 'followup', 'task', 'log', 'foot'];

function drawerParts(job) {
  const active = !job.endedAt;
  const agent = agents[job.agent]?.name ?? AGENT_NAMES[job.agent];
  const facts = [
    ['Agent', [agent, job.model, job.effort && `${job.effort} effort`].filter(Boolean).join(' · ')],
    ['Project', shortPath(projectOf(job)), projectOf(job)],
    job.worktree && ['Branch', `${job.worktree.branch} (from ${job.worktree.base.slice(0, 8)})`],
    job.tokens != null && ['Tokens', job.tokens.toLocaleString()],
    job.turns > 1 && ['Turns', job.turns],
    job.shared?.length && ['Shared instructions', job.shared.map(shortPath).join('\n'), job.shared.join('\n')],
  ].filter(Boolean).map(([name, value, full]) => `<div><dt>${name}</dt><dd${full ? ` title="${esc(full)}"` : ''}>${esc(value)}</dd></div>`).join('');

  const outside = new Set(job.result?.outOfScope ?? []);
  const files = job.result?.files ?? [];
  const result = job.result
    ? `<section class="section"><h3>Changes</h3>
        <p class="detail" data-wrap>${esc(job.result.stat || 'No files changed')}${job.result.commit ? ` · commit ${esc(job.result.commit)}` : ''}</p>
        ${files.length ? `<ul class="files">${files.map((f) => `<li${outside.has(f) ? ' data-tone="failed"' : ''}>${esc(f)}${outside.has(f) ? ' — outside the allowed targets' : ''}</li>`).join('')}</ul>` : ''}
        ${[...outside].filter((f) => !files.includes(f)).map((f) => `<p class="detail" data-wrap data-tone="failed">${esc(f)} — outside the workspace</p>`).join('')}
        ${job.worktree && files.length ? `<div class="actions"><button data-act="copy" data-copy="git diff ${esc(job.worktree.base.slice(0, 8))}..${esc(job.worktree.branch)}">Copy diff command</button></div>` : ''}
      </section>`
    : '';
  const notes = job.notes?.length ? `<section class="section"><h3>Notes</h3><ul class="notes">${job.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul></section>` : '';
  const refusals = (job.refusals ?? []).filter((r) => r.turn === job.turns);
  const refused = refusals.length ? `<section class="section"><h3>Refused by the automatic reviewer</h3><ul class="notes">${refusals.map((r) => `<li data-tone="failed"><code>${esc(r.action)}</code> — ${esc(r.reason)}</li>`).join('')}</ul>${job.retrying ? '<p class="hint">Sent back once with your approval.</p>' : ''}</section>` : '';
  const report = job.report ? `<section class="section"><h3>Report</h3><pre class="prose">${esc(job.report)}</pre></section>` : '';
  const key = esc(job.id);

  return {
    head: `<header class="sheet-head">
        <div class="row">
          <span class="chip" data-state="${jobMark(job)}"><span class="mark"></span>${esc(jobLabel(job))}</span>
          <span class="kind">${KIND_NAMES[job.kind]}</span>
          <span class="timer" data-from="${esc(job.createdAt)}" data-to="${esc(job.endedAt ?? '')}"></span>
        </div>
        <button class="quiet" data-close aria-label="Close details">Close</button>
      </header>
      <h2 id="drawer-title">${esc(job.title)}</h2>`,
    state: `${job.state === 'running' ? `<p class="detail" data-wrap>${esc(job.phase)}</p>` : ''}${job.error ? `<p class="detail" data-wrap data-tone="failed">${esc(job.error.message)}</p>` : ''}${callout(job)}`,
    facts: `<dl class="facts">${facts}</dl>`,
    result: `${result}${refused}${notes}${report}`,
    // A waiting job is answered through its request above; a follow-up would be refused.
    // Keyed by job, so what is typed for one job cannot be sent to another.
    followup: job.sessionId && job.state !== 'waiting'
      ? `<section class="section"><h3>${active ? 'Steer' : 'Follow up'}</h3>${composer('followup', `followup:${key}`, `Message to ${agent}`,
          active ? 'Add a note to the work in progress' : 'Ask for a fix or a change; the same session continues', `Send to ${agent}`)}</section>`
      : '',
    task: job.prompt ? `<details class="section" data-details="task"><summary>Task given to ${esc(agent)}</summary><pre class="prose">${esc(job.prompt)}</pre></details>` : '',
    log: openEvents.length
      ? `<section class="section"><h3>Activity</h3><ol class="feed-list">${openEvents.slice(-80).reverse().map((e) => {
          const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
          const tone = EVENT_TONES[e.kind];
          return `<li><time datetime="${esc(e.ts)}">${time}</time><span class="what" data-wrap${tone ? ` data-tone="${tone}"` : ''}>${esc(e.detail)}</span></li>`;
        }).join('')}</ol></section>`
      : '',
    foot: `<footer class="row foot">
        <span class="id">${key}</span>
        <span class="actions">${resumeButton(job)}${active ? '<button class="quiet" data-act="cancel">Cancel job</button>' : ''}</span>
      </footer>`,
  };
}

const drawerBody = document.getElementById('drawer-body');
drawerBody.innerHTML = DRAWER_PARTS.map((part) => `<div data-part="${part}"></div>`).join('');

function renderDrawer() {
  if (!openJob) return;
  drawerBody.dataset.key = openJob.id;
  const parts = drawerParts(openJob);
  for (const part of DRAWER_PARTS) patch(drawerBody.querySelector(`[data-part="${part}"]`), parts[part]);
  tick();
}

/** Counts attempts to open the drawer, so a slow fetch for one job cannot replace a job opened after it. */
let opening = 0;

/** With `refresh`, only brings an already open drawer up to date: it must not reopen one the user has closed meanwhile. */
async function openDrawer(id, refresh = false) {
  const attempt = ++opening;
  try {
    // The stream's copy of a job leaves out its prompt; the drawer shows it, so fetch the whole job.
    // A daemon from before this drawer has no events route; what the page already holds will do.
    const [job, log] = await Promise.all([call(`/api/jobs/${id}`), call(`/api/jobs/${id}/events`).catch(() => [])]);
    if (attempt !== opening || (refresh && !drawer.open)) return;
    // Whatever arrived over the stream while the fetch was in flight is newer than the fetch.
    openJob = { ...job, ...jobs.get(id) };
    openEvents = [...new Map([...log, ...events.filter((e) => e.job_id === id)].map((e) => [e.seq, e])).values()].sort((a, b) => a.seq - b.seq);
    renderDrawer();
    if (!drawer.open) drawer.showModal();
    if (location.hash !== `#${id}`) history.replaceState(null, '', `#${id}`);
  } catch (err) {
    if (attempt === opening) notice(`Could not open ${id}: ${err.message}`);
  }
}

/**
 * Forgets the job once the drawer is shut. Called directly where the page closes it, and from the
 * close event for Escape. That event can arrive late, when another job is already open, so it is checked.
 */
function drawerClosed() {
  if (drawer.open || !openJob) return;
  openJob = null;
  openEvents = [];
  history.replaceState(null, '', location.pathname + location.search);
}
drawer.addEventListener('close', drawerClosed);
// A link to a job, followed while the board is already open.
window.addEventListener('hashchange', () => {
  const id = location.hash.slice(1);
  if (id && id !== openJob?.id && jobs.has(id)) openDrawer(id);
});

// --- Settings ---

const settings = document.getElementById('settings');
const scope = document.getElementById('instructions-scope');
const instructions = document.getElementById('instructions-text');
/** Text and roles as last loaded or saved, to tell whether the sheet holds unsaved changes. */
let savedInstructions = '';
let savedRoles = '';
let loadedScope = '';
/** Counts loads, so a slow answer for a scope the user has left cannot fill the editor. */
let loading = 0;

function rolesRows() {
  return Object.keys(ROLE_NAMES).map((role) => {
    const current = roles[role] ?? {};
    const options = Object.entries(agents).map(([id, agent]) => `<option value="${esc(id)}"${id === current.agent ? ' selected' : ''}>${esc(agent.name)}${agent.enabled ? '' : ' (disabled)'}</option>`).join('');
    return `<div class="role-row" data-role-row="${role}">
        <p><strong>${ROLE_NAMES[role]}</strong><span class="hint">${ROLE_HINTS[role]}</span></p>
        <label class="field"><span>Agent</span><select name="agent">${options}</select></label>
        <label class="field"><span>Model</span><input name="model" value="${esc(current.model ?? '')}" placeholder="Agent default" autocomplete="off" spellcheck="false"></label>
        <label class="field"><span>Effort</span><input name="effort" value="${esc(current.effort ?? '')}" placeholder="Agent default" autocomplete="off" spellcheck="false"></label>
      </div>`;
  }).join('');
}

function rolesTable() {
  return Object.fromEntries([...document.querySelectorAll('[data-role-row]')].map((row) => [
    row.dataset.roleRow,
    Object.fromEntries(['agent', 'model', 'effort'].map((name) => [name, row.querySelector(`[name="${name}"]`).value.trim()])),
  ]));
}

const settingsDirty = () => instructions.value !== savedInstructions || JSON.stringify(rolesTable()) !== savedRoles;

function instructionsHint(file) {
  const over = instructions.value.length > CLAUDE_CONTEXT_LIMIT;
  const el = document.getElementById('instructions-file');
  if (file) el.dataset.file = file;
  el.textContent = `${el.dataset.file ?? ''}${over ? ` · Longer than ${CLAUDE_CONTEXT_LIMIT.toLocaleString()} characters: Claude sessions are pointed to this file instead of being given the text.` : ''}`;
  el.toggleAttribute('data-warn', over);
}

/** Loads the chosen scope into the editor. On failure the editor is emptied and locked: it must never offer to save one scope's text under another. */
async function loadInstructions() {
  const attempt = ++loading;
  const wanted = scope.value;
  const save = document.querySelector('#instructions-form button[type="submit"]');
  instructions.disabled = save.disabled = true;
  try {
    const { file, text } = await call(`/api/instructions${wanted ? `?project=${encodeURIComponent(wanted)}` : ''}`);
    if (attempt !== loading) return;
    instructions.value = savedInstructions = text;
    loadedScope = wanted;
    instructions.disabled = save.disabled = false;
    instructionsHint(file);
  } catch (err) {
    if (attempt !== loading) return;
    instructions.value = savedInstructions = '';
    const el = document.getElementById('instructions-file');
    el.textContent = `Could not load these instructions: ${err.message}`;
    el.setAttribute('data-warn', '');
  }
}

document.getElementById('open-settings').addEventListener('click', async () => {
  // Built when opened, not on every update, so a change elsewhere cannot overwrite a half-edited form.
  document.getElementById('roles-rows').innerHTML = rolesRows();
  savedRoles = JSON.stringify(rolesTable());
  const dirs = knownProjects();
  const names = projectNames(dirs);
  scope.innerHTML = `<option value="">Every project</option>${dirs.map((dir) => `<option value="${esc(dir)}">Only ${esc(names.get(dir))}</option>`).join('')}`;
  for (const status of settings.querySelectorAll('[data-status]')) status.textContent = '';
  instructions.value = savedInstructions = '';
  settings.showModal();
  await loadInstructions();
});

scope.addEventListener('change', async () => {
  if (instructions.value !== savedInstructions && !confirm('Discard the unsaved changes to these instructions?')) {
    scope.value = loadedScope;
    return;
  }
  await loadInstructions();
});
instructions.addEventListener('input', () => instructionsHint());
// Escape closes a dialog; unsaved settings get the same question as any other way out.
settings.addEventListener('cancel', (e) => {
  if (settingsDirty() && !confirm('Close without saving your changes?')) e.preventDefault();
});

/** Requests in flight, so a second press cannot send the same thing twice while the first is on its way. */
const sending = new Set();

/**
 * Runs a form's request and reports the outcome beside its button. `live` returns the form as it is
 * now, or nothing if it is gone: a job update can replace a card's markup while the request is in flight.
 */
async function submit(form, key, work, done = 'Saved', live = () => form) {
  if (sending.has(key)) return false;
  sending.add(key);
  form.querySelector('button[type="submit"]').disabled = true;
  let outcome = { text: done };
  try {
    await work();
  } catch (err) {
    outcome = { text: err.message, tone: 'failed' };
  }
  sending.delete(key);
  const now = live();
  if (now) {
    now.querySelector('button[type="submit"]').disabled = false;
    const status = now.querySelector('[data-status]');
    status.textContent = outcome.text;
    if (outcome.tone) status.dataset.tone = outcome.tone;
    else status.removeAttribute('data-tone');
  } else if (outcome.tone) {
    // The form is gone, so the failure is said where it will still be seen.
    notice(outcome.text);
  }
  return !outcome.tone;
}

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  if (form.id === 'roles-form') {
    const table = rolesTable();
    await submit(form, 'roles', async () => {
      roles = await call('/api/roles', { roles: table });
      savedRoles = JSON.stringify(table);
      render();
    });
    return;
  }
  if (form.id === 'instructions-form') {
    const wanted = scope.value;
    const draft = instructions.value;
    const attempt = loading;
    const current = () => scope.value === wanted && loading === attempt;
    await submit(form, 'instructions', async () => {
      const { file, text } = await call('/api/instructions', { project: wanted || null, text: draft });
      if (!current()) return;
      // Only normalize the submitted draft; later edits must stay visible and unsaved.
      if (instructions.value === draft) instructions.value = text;
      savedInstructions = text;
      instructionsHint(file);
    }, 'Saved', () => current() ? form : null);
    return;
  }
  const container = form.closest('[data-key]');
  const kind = form.dataset.form;
  const field = form.querySelector('textarea');
  const message = field.value.trim();
  if (!message) {
    field.focus();
    return;
  }
  const id = container.dataset.key;
  const request = form.dataset.request;
  const body = kind === 'answer' ? { message, request_id: request } : { message };
  // The same form for the same job and request, or nothing: an outcome must not land on the next question's form.
  const live = () => (container.dataset.key === id ? [...container.querySelectorAll(`form[data-form="${kind}"]`)].find((f) => f.dataset.request === request) : null);
  const sent = await submit(form, `${id}:${kind}:${request ?? ''}`, () => call(`/api/jobs/${id}/reply`, body), 'Sent', live);
  // Cleared only once accepted, so a refused message is still there to edit and resend.
  const now = live()?.querySelector('textarea');
  if (sent && now) now.value = '';
});

// --- Clicks ---

for (const sheet of [drawer, settings]) {
  // A click on the dialog element itself is a click on its backdrop. It closes only when the press
  // began there too, so dragging a text selection out of the sheet does not close it.
  let pressed = null;
  sheet.addEventListener('mousedown', (e) => { pressed = e.target; });
  sheet.addEventListener('click', (e) => {
    const backdrop = e.target === sheet && pressed === sheet;
    if (!backdrop && !e.target.closest('[data-close]')) return;
    if (sheet === settings && settingsDirty() && !confirm('Close without saving your changes?')) return;
    sheet.close();
    if (sheet === drawer) drawerClosed();
  });
}

document.addEventListener('click', (e) => {
  // The filter buttons in the top bar, and each project's name in its group heading.
  const button = e.target.closest('button[data-project]');
  if (!button) return;
  project = button.dataset.project;
  try {
    localStorage.setItem('crew.project', project);
  } catch {
    // See the read above.
  }
  smooth(() => {
    render();
    renderFeed();
  });
});

document.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-act]');
  const card = e.target.closest('[data-key]');
  if (!button) {
    // Anywhere on a job card that is not a control opens its details. Selecting text does not.
    const interactive = e.target.closest('button, a, input, textarea, select, summary, form');
    if (card?.matches('.card') && jobs.has(card.dataset.key) && !interactive && !String(getSelection())) await openDrawer(card.dataset.key);
    return;
  }
  const act = button.dataset.act;
  const id = button.dataset.job ?? card?.dataset.key;
  if (act === 'later' || act === 'answer') {
    dockOpen = act === 'answer';
    smooth(renderNeeds);
    // Answering from elsewhere on the page goes straight to the front request's first control.
    if (dockOpen && !button.closest('.dock')) document.querySelector('#needs > :first-child :is(textarea, button:not([data-act="later"]))')?.focus({ preventScroll: true });
    return;
  }
  if (act === 'toggle') {
    folded.set(button.dataset.command, button.getAttribute('aria-expanded') === 'true');
    smooth(render);
    return;
  }
  if (act === 'open') {
    await openDrawer(id);
    return;
  }
  if (act === 'copy') {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
    } catch {
      // Clipboard access can be refused (an embedded pane, no permission); show the text so it can be copied by hand.
      notice(`Could not copy. The command is: ${button.dataset.copy}`);
      return;
    }
    const label = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { if (button.textContent === 'Copied') button.textContent = label; }, 1500);
    return;
  }
  button.disabled = true;
  try {
    if (act === 'dismiss') await call(`/api/missions/${button.dataset.mission}`, { abandoned: true, outcome: 'Dismissed on the board.' });
    else if (act === 'cancel') await call(`/api/jobs/${id}/cancel`, {});
    else await call(`/api/jobs/${id}/reply`, { decision: act, request_id: button.dataset.request });
  } catch (err) {
    button.disabled = false;
    button.textContent = `${button.textContent} — ${err.message}`;
  }
});

const connection = document.getElementById('connection');
// Drawn empty once while the first snapshot is on its way, so the loading placeholders have the board's own shapes.
if (document.body?.hasAttribute('data-loading')) render();
const stream = new EventSource('/api/stream');

stream.addEventListener('state', (e) => {
  const state = JSON.parse(e.data);
  clockSkew = state.now - Date.now();
  limits = state.limits;
  // A daemon from before roles were configurable sends neither.
  agents = state.agents ?? {};
  roles = state.roles ?? {};
  jobs.clear();
  sessions.clear();
  missions.clear();
  // A daemon from before missions sends none.
  for (const mission of state.missions ?? []) missions.set(mission.id, mission);
  for (const job of state.jobs) jobs.set(job.id, job);
  for (const s of state.claude) sessions.set(s.id, s);
  events = state.events;
  render();
  renderFeed();
  if (document.body.hasAttribute('data-loading')) {
    // The placeholders give way to their figures in reading order, once.
    document.body.removeAttribute('data-loading');
    document.body.setAttribute('data-resolving', '');
    setTimeout(() => document.body.removeAttribute('data-resolving'), 900);
  }
  // After a reconnect the open job may have moved on; on first load the address may name one to open.
  const wanted = openJob?.id ?? location.hash.slice(1);
  if (wanted && jobs.has(wanted)) openDrawer(wanted, Boolean(openJob));
  connection.textContent = 'Live';
  connection.dataset.state = 'live';
  // Entrance animations are for cards that arrive later, not the first paint.
  requestAnimationFrame(() => document.body.classList.add('ready'));
});
stream.addEventListener('job', (e) => {
  const job = JSON.parse(e.data);
  const isNew = !jobs.has(job.id);
  jobs.set(job.id, job);
  render();
  // A job's first event arrives before the job itself; redraw the feed so that row gets its name and its project.
  if (isNew) renderFeed();
  if (job.id === openJob?.id) {
    // The stream's copy has no prompt; keep the one the drawer fetched.
    openJob = { ...openJob, ...job };
    renderDrawer();
  }
});
stream.addEventListener('claude', (e) => {
  const { session, removed } = JSON.parse(e.data);
  if (removed) sessions.delete(session.id);
  else sessions.set(session.id, session);
  render();
});
stream.addEventListener('mission', (e) => {
  const mission = JSON.parse(e.data);
  missions.set(mission.id, mission);
  render();
});
stream.addEventListener('roles', (e) => {
  roles = JSON.parse(e.data);
  render();
});
stream.addEventListener('limits', (e) => {
  limits = { ...limits, ...JSON.parse(e.data) };
  render();
});
stream.addEventListener('event', (e) => addEvent(JSON.parse(e.data)));
stream.onerror = () => {
  connection.textContent = 'Disconnected — reconnecting…';
  connection.dataset.state = 'lost';
};
