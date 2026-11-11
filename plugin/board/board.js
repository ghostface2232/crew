// Live status board. State arrives over one SSE stream; cards are keyed by id
// and patched in place so timers and focus survive updates.

const jobs = new Map();
const sessions = new Map();
let limits = { codex: null };
/** Server clock minus local clock, so timers are right even if the two drift. */
let clockSkew = 0;

const FINISHED_SHOWN = 4;
const FEED_SHOWN = 60;
const AGENT_NAMES = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const KIND_NAMES = { delegate: 'Implementation', review: 'Review', polish: 'Polish' };
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
  const callout = job.state === 'waiting'
    ? `<div class="callout"><p>${esc(job.waiting.reason)}</p><div class="actions">
        <button class="primary" data-act="approve" data-request="${esc(job.waiting.id)}">${job.waiting.type === 'approval' ? 'Approve' : 'Yes'}</button>
        <button data-act="deny" data-request="${esc(job.waiting.id)}">${job.waiting.type === 'approval' ? 'Deny' : 'No'}</button>
        <span class="timer" data-from="${job.waiting.since}" data-suffix=" waiting"></span></div></div>`
    : '';
  const command = `${job.agent === 'codex' ? 'codex resume' : 'agy --conversation'} ${job.sessionId}`;
  const resume = job.sessionId && !active
    ? `<button class="quiet" data-act="copy" data-copy="${esc(command)}" title="Copies the command that reopens this session in its own CLI">Copy resume command</button>`
    : '';
  const cancel = active ? '<button class="quiet" data-act="cancel">Cancel</button>' : '';
  return {
    key: job.id,
    quiet: !active,
    html: `
      <div class="row">
        <span class="pill" data-tone="${tone}">${esc(jobLabel(job))}</span>
        <span class="kind">${KIND_NAMES[job.kind]}</span>
        <span class="timer" data-from="${job.createdAt}" data-to="${job.endedAt ?? ''}"></span>
      </div>
      <p class="title">${esc(job.title)}</p>
      ${detail}${callout}
      <div class="row foot">
        <span class="id">${esc(job.id)}</span>
        ${!active && job.tokens != null ? `<span>${job.tokens.toLocaleString()} tokens</span>` : ''}
        ${job.project ? `<span class="branch" title="${esc(job.project)}">${esc(shortPath(job.project))}</span>` : ''}
        <span class="actions">${resume}${cancel}</span>
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
        <span class="timer" data-from="${s.activeAt}" data-suffix=" ago"></span>
      </div>
      <p class="title">${esc(s.title)}</p>
      ${detail ? `<p class="detail"${s.state === 'waiting' ? ' data-wrap' : ''}>${esc(detail)}</p>` : ''}
      <div class="row foot"><span class="branch" title="${esc(s.cwd)}">${esc(shortPath(s.cwd))}</span></div>`,
  };
}

/** Reconciles a lane's list against the wanted cards: reuse by key, patch changed markup, drop the rest. */
function renderLane(agent, cards, meta) {
  const lane = document.querySelector(`.lane[data-agent="${agent}"]`);
  const list = lane.querySelector('[data-cards]');
  const existing = new Map([...list.children].map((el) => [el.dataset.key, el]));
  cards.forEach((card, index) => {
    let el = existing.get(card.key);
    if (!el) {
      el = document.createElement('li');
      el.className = 'card enter';
      el.dataset.key = card.key;
    }
    existing.delete(card.key);
    if (el.dataset.html !== card.html) {
      el.innerHTML = card.html;
      el.dataset.html = card.html;
    }
    el.toggleAttribute('data-quiet', card.quiet);
    if (list.children[index] !== el) list.insertBefore(el, list.children[index] ?? null);
  });
  for (const el of existing.values()) el.remove();
  lane.querySelector('[data-meta]').innerHTML = meta;
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

function render() {
  const order = { waiting: 0, working: 1, error: 2, idle: 3 };
  const claude = [...sessions.values()].sort((a, b) => order[a.state] - order[b.state] || b.startedAt - a.startedAt || a.id.localeCompare(b.id));
  renderLane('claude', claude.map(sessionCard), countMeta(claude.filter((s) => s.state !== 'idle').length));

  for (const agent of ['codex', 'antigravity']) {
    const mine = [...jobs.values()].filter((j) => j.agent === agent).sort((a, b) => b.createdAt - a.createdAt);
    const active = mine.filter((j) => !j.endedAt).sort((a, b) => (a.state === 'waiting' ? -1 : 0) - (b.state === 'waiting' ? -1 : 0));
    const finished = mine.filter((j) => j.endedAt).slice(0, FINISHED_SHOWN);
    renderLane(agent, [...active, ...finished].map(jobCard), agent === 'codex' ? usageMeta() || countMeta(active.length) : countMeta(active.length));
  }
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

function addEvent(event, animate) {
  const feed = document.getElementById('feed');
  const li = document.createElement('li');
  if (animate) li.className = 'enter';
  const time = new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
  const tone = EVENT_TONES[event.kind];
  li.innerHTML = `<time datetime="${esc(event.ts)}">${time}</time><span class="who">${AGENT_NAMES[event.agent]}</span><span class="what"${tone ? ` data-tone="${tone}"` : ''} title="${esc(event.detail)}">${esc(event.detail)}</span>`;
  feed.prepend(li);
  while (feed.children.length > FEED_SHOWN) feed.lastElementChild.remove();
}

async function post(route, body) {
  const res = await fetch(route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  if (!res.ok) throw new Error((await res.json()).error ?? 'Request failed');
}

document.addEventListener('click', async (e) => {
  const button = e.target.closest('button[data-act]');
  if (!button) return;
  const id = button.closest('.card').dataset.key;
  const act = button.dataset.act;
  if (act === 'copy') {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = 'Copied';
    return;
  }
  button.disabled = true;
  try {
    if (act === 'cancel') await post(`/api/jobs/${id}/cancel`);
    else await post(`/api/jobs/${id}/reply`, { decision: act, request_id: button.dataset.request });
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
  jobs.clear();
  sessions.clear();
  for (const job of state.jobs) jobs.set(job.id, job);
  for (const s of state.claude) sessions.set(s.id, s);
  document.getElementById('feed').replaceChildren();
  for (const event of state.events) addEvent(event, false);
  render();
  connection.textContent = 'Live';
  connection.dataset.state = 'live';
  // Entrance animations are for cards that arrive later, not the first paint.
  requestAnimationFrame(() => document.body.classList.add('ready'));
});
stream.addEventListener('job', (e) => {
  const job = JSON.parse(e.data);
  jobs.set(job.id, job);
  render();
});
stream.addEventListener('claude', (e) => {
  const { session, removed } = JSON.parse(e.data);
  if (removed) sessions.delete(session.id);
  else sessions.set(session.id, session);
  render();
});
stream.addEventListener('limits', (e) => {
  limits = { ...limits, ...JSON.parse(e.data) };
  render();
});
stream.addEventListener('event', (e) => addEvent(JSON.parse(e.data), true));
stream.onerror = () => {
  connection.textContent = 'Disconnected — reconnecting…';
  connection.dataset.state = 'lost';
};
