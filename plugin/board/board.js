// Live status board. State arrives over one SSE stream; cards are keyed by id
// and patched in place so timers, focus, and anything being typed survive updates.

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
const KIND_NAMES = { delegate: 'Implementation', review: 'Review', polish: 'Polish' };
const ROLE_NAMES = { delegate: 'Engineer', review: 'Cross-review', polish: 'UX writing · docs' };
const ROLE_HINTS = { delegate: 'Builds separable pieces', review: 'Reviews the change', polish: 'Tidies wording only' };
/** Claude Code hands a session a file path instead of the text past this length. */
const CLAUDE_CONTEXT_LIMIT = 9000;
const STAGES = ['plan', 'implement', 'self-review', 'cross-review', 'fix', 'polish', 'final'];
const STAGE_NAMES = { plan: 'Planning', implement: 'Implementing', 'self-review': 'Self-review', 'cross-review': 'Cross-review', fix: 'Fixing', polish: 'Polish', final: 'Final check' };
const MISSIONS_FINISHED_SHOWN = 2;
const EVENT_TONES = { waiting: 'waiting', stalled: 'waiting', error: 'failed', limit: 'failed', done: 'done' };

const esc = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function elapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

/** The last two segments identify a project; the full path is in the tooltip. */
function shortPath(dir) {
  const parts = String(dir ?? '').split('/').filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : dir;
}

function jobTone(job) {
  if (job.state === 'waiting' || job.stalled) return 'waiting';
  if (job.state === 'running') return 'working';
  if (job.state === 'done') return 'done';
  return job.state === 'failed' ? 'failed' : 'idle';
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

/** The request a waiting job has for the user, with the controls that answer it. Shared by the card and the drawer. */
function callout(job) {
  if (job.state !== 'waiting') return '';
  const { id, type, reason, since } = job.waiting;
  const request = esc(id);
  // Keyed by request, so text typed for one question is never sent as the answer to the next.
  const answer = type === 'question'
    ? `<form class="answer" data-form="answer" data-request="${request}">
        <textarea data-keep="answer:${request}" rows="2" aria-label="Your answer" placeholder="Type an answer"></textarea>
        <div class="actions"><button class="primary" type="submit">Send answer</button><span class="status" role="status" data-status="answer:${request}"></span></div>
      </form>`
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

function jobCard(job) {
  const tone = jobTone(job);
  const active = !job.endedAt;
  let detail = '';
  if (job.state === 'running') detail = `<p class="detail">${esc(job.phase)}</p>`;
  else if (job.state === 'failed') detail = `<p class="detail" data-wrap data-tone="failed">${esc(job.error?.message)}</p>`;
  else if (job.state === 'done') {
    const scope = job.result?.outOfScope?.length ? ` · ${job.result.outOfScope.length} out of scope` : '';
    detail = `<p class="detail">${esc(job.result?.stat || 'Report ready for the lead')}${esc(scope)}</p>`;
  }
  // The resume command lives in the drawer; a finished card's footer has no room for it on a narrow lane.
  const cancel = active ? '<button class="quiet" data-act="cancel">Cancel</button>' : '';
  return {
    key: job.id,
    quiet: !active,
    html: `
      <div class="row">
        <span class="pill" data-tone="${tone}">${esc(jobLabel(job))}</span>
        <span class="kind">${KIND_NAMES[job.kind]}${job.runsApp ? ' · runs the app' : ''}${job.exclusive ? ' · runs alone' : ''}</span>
        <span class="timer" data-from="${esc(job.createdAt)}" data-to="${esc(job.endedAt ?? '')}"></span>
      </div>
      <p class="title"><button class="link" data-act="open" title="Open details">${esc(job.title)}</button></p>
      ${detail}${callout(job)}
      <div class="row foot">
        <span class="id">${esc(job.id)}</span>
        ${!active && job.tokens != null ? `<span>${job.tokens.toLocaleString()} tokens</span>` : ''}
        ${job.project ? `<span class="branch" title="${esc(job.project)}">${esc(shortPath(job.project))}</span>` : ''}
        <span class="actions">${cancel}</span>
      </div>`,
  };
}

function sessionCard(s) {
  const stuck = s.stalled;
  const tone = stuck || s.state === 'waiting' ? 'waiting' : s.state === 'working' ? 'working' : s.state === 'error' ? 'failed' : 'idle';
  const label = stuck ? 'May be stuck' : { working: 'Working', waiting: 'Needs input', idle: 'Idle', error: 'Stopped on an error' }[s.state];
  const detail = s.state === 'waiting' ? s.waitingFor : s.phase;
  return {
    key: s.id,
    quiet: s.state === 'idle',
    html: `
      <div class="row">
        <span class="pill" data-tone="${tone}">${esc(label)}</span>
        <span class="timer" data-from="${esc(s.activeAt)}" data-suffix=" ago"></span>
      </div>
      <p class="title">${esc(s.title)}</p>
      ${detail ? `<p class="detail"${s.state === 'waiting' ? ' data-wrap' : ''}>${esc(detail)}</p>` : ''}
      <div class="row foot"><span class="branch" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span></div>`,
  };
}

/** Reconciles a list against the wanted items: reuse by key, patch changed markup, keep the given order, drop the rest. */
function reconcile(list, items, create) {
  const existing = new Map([...list.children].map((el) => [el.dataset.key, el]));
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
  for (const el of existing.values()) el.remove();
}

function renderCards(list, cards) {
  reconcile(list, cards.map((card) => ({
    key: card.key,
    update: (el) => {
      patch(el, card.html);
      el.toggleAttribute('data-quiet', card.quiet);
    },
  })), () => Object.assign(document.createElement('li'), { className: 'card enter' }));
}

function usageMeta() {
  const windows = limits.codex?.windows ?? [];
  return windows
    .map((w) => {
      const name = w.minutes >= 1440 ? `${Math.round(w.minutes / 1440)}-day` : `${Math.round(w.minutes / 60)}-hour`;
      const used = Math.round(w.usedPercent);
      return `<span title="Codex ${name} limit"><span class="meter"${used >= 90 ? ' data-high' : ''} style="--used:${used}"><i></i></span>${used}% of ${name} limit</span>`;
    })
    .join('<br>');
}

function countMeta(active) {
  return active ? `${active} active` : '';
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

function renderProjects(dirs, names) {
  const el = document.getElementById('projects');
  // With one project there is nothing to choose between.
  el.hidden = dirs.length < 2;
  const current = activeProject();
  const waiting = (dir) => [...jobs.values(), ...sessions.values()].filter((item) => isWaiting(item) && (!dir || projectOf(item) === dir)).length;
  patch(el, [['', 'All'], ...dirs.map((dir) => [dir, names.get(dir)])]
    .map(([dir, name]) => {
      const count = waiting(dir);
      return `<button data-project="${esc(dir)}" aria-pressed="${dir === current}" title="${esc(dir || 'Every project')}">${esc(name)}${count ? `<span class="count" title="${count} waiting on you">${count}</span>` : ''}</button>`;
    })
    .join(''));
}

const WORKERS_SHOWN = ['codex', 'antigravity'];
const EMPTY = {
  claude: 'No Claude session is reporting yet. Sessions appear here once the Crew plugin is loaded.',
  codex: 'Idle. Jobs appear when the lead gives this agent work.',
  antigravity: 'Idle. Jobs appear when the lead gives this agent work.',
};
const SESSION_ORDER = { waiting: 0, working: 1, error: 2, idle: 3 };

/** The cards of one project, per agent. With `dir` empty, everything on the board. */
function groupCards(dir) {
  const mine = (item) => !dir || projectOf(item) === dir;
  const claude = [...sessions.values()].filter(mine).sort((a, b) => SESSION_ORDER[a.state] - SESSION_ORDER[b.state] || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  const cells = { claude: claude.map(sessionCard) };
  let active = claude.filter((s) => s.state !== 'idle').length;
  for (const agent of WORKERS_SHOWN) {
    const all = [...jobs.values()].filter((j) => j.agent === agent && mine(j)).sort((a, b) => b.createdAt - a.createdAt);
    const running = all.filter((j) => !j.endedAt).sort((a, b) => (isWaiting(a) ? -1 : 0) - (isWaiting(b) ? -1 : 0));
    cells[agent] = [...running, ...all.filter((j) => j.endedAt).slice(0, FINISHED_SHOWN)].map(jobCard);
    active += running.length;
  }
  const waiting = [...jobs.values(), ...sessions.values()].filter((item) => mine(item) && isWaiting(item)).length;
  return { cells, active, waiting };
}

/** One command as a unit: where the lead is in the pipeline, and each job started under it with its state. */
function missionCard(mission) {
  const mine = [...jobs.values()].filter((j) => j.mission === mission.id).sort((a, b) => a.createdAt - b.createdAt);
  const active = mission.state === 'active';
  const waiting = mine.some(isWaiting);
  const at = STAGES.indexOf(mission.stage);
  const label = active ? (waiting ? 'Waiting on you' : STAGE_NAMES[mission.stage]) : mission.state === 'done' ? 'Done' : 'Abandoned';
  const tone = !active ? (mission.state === 'done' ? 'done' : 'idle') : waiting ? 'waiting' : 'working';
  const finished = mine.filter((j) => j.endedAt).length;
  const progress = [active && `Step ${at + 1} of ${STAGES.length}`, mine.length && `${finished} of ${mine.length} job${mine.length === 1 ? '' : 's'} finished`].filter(Boolean).join(' · ');
  // A finished mission has passed every stage; an abandoned one stops where it was.
  const reached = mission.state === 'done' ? STAGES.length : at;
  const track = STAGES.map((stage, i) => `<li data-step="${i < reached ? 'done' : i === reached && active ? 'now' : 'todo'}" title="${STAGE_NAMES[stage]}"></li>`).join('');
  const strands = mine.map((job) => `<li>
      <span class="who">${esc(agents[job.agent]?.name ?? AGENT_NAMES[job.agent])}</span>
      <button class="link" data-act="open" data-job="${esc(job.id)}" title="Open details">${esc(job.title)}</button>
      <span class="pill" data-tone="${jobTone(job)}">${esc(jobLabel(job))}</span>
    </li>`).join('');
  return {
    key: mission.id,
    quiet: !active,
    html: `
      <div class="row">
        <span class="pill" data-tone="${tone}">${label}</span>
        <span class="kind">${progress}</span>
        <span class="timer" data-from="${esc(mission.createdAt)}" data-to="${esc(mission.endedAt ?? '')}"></span>
      </div>
      <p class="title">${esc(mission.title)}</p>
      <ol class="track" aria-label="${active ? `${STAGE_NAMES[mission.stage]}, step ${at + 1} of ${STAGES.length}` : label}">${track}</ol>
      ${strands ? `<ul class="strands">${strands}</ul>` : ''}
      ${mission.outcome ? `<p class="detail" data-wrap>${esc(mission.outcome)}</p>` : ''}
      ${active ? `<div class="row foot"><span class="id">${esc(mission.id)}</span><span class="actions"><button class="quiet" data-act="dismiss" data-mission="${esc(mission.id)}" title="Closes this command on the board. Its jobs keep running.">Dismiss</button></span></div>` : ''}`,
  };
}

/** Everything waiting on the user, in one line above the board, so it is found without scanning every project. */
function renderNeeds() {
  const el = document.getElementById('needs');
  const names = projectNames(knownProjects());
  const where = (item) => (names.size > 1 ? ` · ${esc(names.get(projectOf(item)) ?? '')}` : '');
  const items = [
    ...[...jobs.values()].filter(isWaiting).sort((a, b) => a.waiting.since - b.waiting.since).map((job) =>
      `<button data-act="open" data-job="${esc(job.id)}">${esc(agents[job.agent]?.name ?? AGENT_NAMES[job.agent])}${where(job)} — ${esc(job.title)}</button>`),
    ...[...sessions.values()].filter(isWaiting).map((s) => `<span>Claude${where(s)} — ${esc(s.waitingFor || s.title)}</span>`),
  ];
  el.hidden = items.length === 0;
  patch(el, items.length ? `<strong>Needs you</strong>${items.join('')}` : '');
}

function groupElement() {
  const el = document.createElement('section');
  el.className = 'group';
  el.innerHTML = `<header class="group-head"></header><ul class="missions" data-missions></ul><div class="cells">${['claude', ...WORKERS_SHOWN].map((agent) =>
    `<div class="cell" data-agent="${agent}"><p class="cell-label">${AGENT_NAMES[agent]}</p><ul class="cards" data-cards></ul><p class="empty">${EMPTY[agent]}</p></div>`).join('')}</div>`;
  return el;
}

function render() {
  const dirs = knownProjects();
  const names = projectNames(dirs);
  const only = activeProject();
  // One group per project when there are several; otherwise one unnamed group, which looks like plain lanes.
  // With nothing on the board there is still one group, so the columns have their empty states.
  const shown = only ? [only] : dirs.length ? dirs : [''];
  const groups = document.getElementById('groups');
  groups.toggleAttribute('data-multi', shown.length > 1);
  // Alphabetical and fixed: a project must not change place because one of its agents did something.
  reconcile(groups, shown.map((dir) => ({
    key: dir,
    update: (el) => {
      const { cells, active, waiting } = groupCards(dir);
      const summary = [active && `${active} active`, waiting && `${waiting} waiting on you`].filter(Boolean).join(' · ') || 'Nothing running';
      patch(el.querySelector('.group-head'), `<h3><button class="link" data-project="${esc(dir)}" title="Show only this project">${esc(names.get(dir) ?? '')}</button></h3>
        <span class="branch" title="${esc(dir)}">${esc(shortPath(dir))}</span><span class="group-meta"${waiting ? ' data-tone="waiting"' : ''}>${summary}</span>`);
      const own = [...missions.values()].filter((m) => projectOf(m) === dir);
      const open = own.filter((m) => m.state === 'active').sort((a, b) => b.createdAt - a.createdAt);
      // The ones that ended last, whenever they began: a long command must not vanish the moment it finishes.
      const ended = own.filter((m) => m.state !== 'active').sort((a, b) => b.endedAt - a.endedAt).slice(0, MISSIONS_FINISHED_SHOWN);
      renderCards(el.querySelector('[data-missions]'), [...open, ...ended].map(missionCard));
      for (const cell of el.querySelectorAll('.cell')) renderCards(cell.querySelector('[data-cards]'), cells[cell.dataset.agent]);
    },
  })), groupElement);

  const visible = (item) => !only || projectOf(item) === only;
  const activeJobs = (agent) => [...jobs.values()].filter((j) => j.agent === agent && !j.endedAt && visible(j)).length;
  const meta = {
    claude: countMeta([...sessions.values()].filter((s) => s.state !== 'idle' && visible(s)).length),
    codex: usageMeta() || countMeta(activeJobs('codex')),
    antigravity: countMeta(activeJobs('antigravity')),
  };
  for (const head of document.querySelectorAll('.lane-head')) {
    const agent = head.dataset.agent;
    head.querySelector('[data-meta]').innerHTML = meta[agent];
    const role = head.querySelector('[data-role]');
    if (role) role.textContent = Object.keys(ROLE_NAMES).filter((r) => roles[r]?.agent === agent).map((r) => ROLE_NAMES[r]).join(' · ') || 'No role assigned';
  }

  renderProjects(dirs, names);
  renderNeeds();
  // Counted across every project: the tab title is what is seen when the board is not.
  const pending = [...jobs.values(), ...sessions.values()].filter(isWaiting).length;
  document.title = pending ? `(${pending}) Crew` : 'Crew';
  tick();
}

function tick() {
  const now = Date.now() + clockSkew;
  for (const el of document.querySelectorAll('.timer')) {
    const to = el.dataset.to ? Number(el.dataset.to) : now;
    el.textContent = elapsed(to - Number(el.dataset.from)) + (el.dataset.suffix ?? '');
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
  return `<time datetime="${esc(event.ts)}">${time}</time><span class="who">${AGENT_NAMES[event.agent]}</span><span class="what"${tone ? ` data-tone="${tone}"` : ''} title="${esc(event.detail)}">${where}${tag}${esc(event.detail)}</span>`;
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
}

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
  ].filter(Boolean).map(([name, value, full]) => `<dt>${name}</dt><dd${full ? ` title="${esc(full)}"` : ''}>${esc(value)}</dd>`).join('');

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
  const report = job.report ? `<section class="section"><h3>Report</h3><pre class="prose">${esc(job.report)}</pre></section>` : '';
  const key = esc(job.id);

  return {
    head: `<header class="sheet-head">
        <div class="row">
          <span class="pill" data-tone="${jobTone(job)}">${esc(jobLabel(job))}</span>
          <span class="kind">${KIND_NAMES[job.kind]}</span>
          <span class="timer" data-from="${esc(job.createdAt)}" data-to="${esc(job.endedAt ?? '')}"></span>
        </div>
        <button class="quiet" data-close aria-label="Close details">Close</button>
      </header>
      <h2 id="drawer-title">${esc(job.title)}</h2>`,
    state: `${job.state === 'running' ? `<p class="detail" data-wrap>${esc(job.phase)}</p>` : ''}${job.error ? `<p class="detail" data-wrap data-tone="failed">${esc(job.error.message)}</p>` : ''}${callout(job)}`,
    facts: `<dl class="facts">${facts}</dl>`,
    result: `${result}${notes}${report}`,
    // A waiting job is answered through its request above; a follow-up would be refused.
    // Keyed by job, so what is typed for one job cannot be sent to another.
    followup: job.sessionId && job.state !== 'waiting'
      ? `<form class="section answer" data-form="followup">
          <h3>${active ? 'Steer' : 'Follow up'}</h3>
          <textarea data-keep="followup:${key}" rows="3" aria-label="Message to ${esc(agent)}" placeholder="${active ? 'Add a note to the work in progress' : 'Ask for a fix or a change; the same session continues'}"></textarea>
          <div class="actions"><button class="primary" type="submit">Send to ${esc(agent)}</button><span class="status" role="status" data-status="followup:${key}"></span></div>
        </form>`
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
  render();
  renderFeed();
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
