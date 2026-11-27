import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN_ROOT } from './config.ts';
import type { Mission, Stage } from './missions.ts';
import type { JobView } from './render.ts';

/**
 * The progress card a lead's chat shows beside a `mission` or `status` result, on hosts that render MCP Apps
 * (docs/mcp-compatibility.md#6-mcp-apps-inline-cards). The text result stays the same, so hosts without cards lose nothing.
 */

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const CARD_URI = 'ui://crew/progress.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

/** The board's six stops (plugin/board/src/model.ts), which the card names in the viewer's language. */
const STOP_OF_STAGE: Record<Stage, number> = { plan: 0, implement: 1, 'self-review': 2, 'cross-review': 2, fix: 3, polish: 4, final: 5 };
/** Missions opened before plans show the board's six stops, one per stop. */
const ORIGINAL_TRACK: Stage[] = ['plan', 'implement', 'self-review', 'fix', 'polish', 'final'];
/** A card is a glance, not the board. */
const MAX_MISSIONS = 3;
const MAX_JOBS = 6;

export interface CardJob { agent: string; title: string; state: JobView['state']; startedAt: number; endedAt: number | null }
export interface CardMission {
  id: string;
  title: string;
  state: Mission['state'];
  steps: { stop: number; label: string | null }[];
  /** The current step's index; every step before it is passed. */
  at: number;
  jobs: CardJob[];
}
export interface CardView { asOf: number; missions: CardMission[]; jobs: CardJob[] }

const cardJob = (job: JobView): CardJob => ({ agent: job.agent, title: job.title ?? '', state: job.state, startedAt: job.createdAt, endedAt: job.endedAt });

/** Jobs under way first, then the latest that ended. */
function shown(jobs: JobView[]): CardJob[] {
  const live = jobs.filter((job) => !job.endedAt).sort((a, b) => a.createdAt - b.createdAt);
  const ended = jobs.filter((job) => job.endedAt).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...live, ...ended].slice(0, MAX_JOBS).map(cardJob);
}

/**
 * What the card draws: the given missions with their jobs, or, when there is none, the project's jobs under way.
 * `missions` are the lead's, newest first.
 */
export function cardView(missions: Mission[], jobs: JobView[], now = Date.now()): CardView {
  const picked = missions.slice(0, MAX_MISSIONS).map((mission): CardMission => {
    const stages = mission.stages ?? ORIGINAL_TRACK;
    const at = mission.stages ? mission.stageIndex ?? Math.max(0, stages.indexOf(mission.stage)) : STOP_OF_STAGE[mission.stage];
    return {
      id: mission.id,
      title: mission.title,
      state: mission.state,
      steps: stages.map((stage, index) => ({ stop: STOP_OF_STAGE[stage], label: mission.labels?.[index] ?? null })),
      at: mission.state === 'done' ? stages.length : at,
      jobs: shown(jobs.filter((job) => job.mission === mission.id)),
    };
  });
  return { asOf: now, missions: picked, jobs: picked.length ? [] : shown(jobs.filter((job) => !job.endedAt)) };
}

const MARKS: Record<string, string> = { claude: 'ClaudeCode', codex: 'Codex', antigravity: 'Antigravity' };

/**
 * The board's agent marks as SVG symbols drawn in the text color, as the board draws them. A card cannot load files, so
 * they go inline. A mark whose file is missing is left out, and its rows show no logo.
 */
function marks(): string {
  const symbols = Object.entries(MARKS).flatMap(([agent, file]) => {
    try {
      const svg = fs.readFileSync(path.join(PLUGIN_ROOT, 'board', 'src', 'icons', `${file}.svg`), 'utf8');
      const viewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
      const body = /<svg[^>]*>([\s\S]*)<\/svg>/.exec(svg)?.[1];
      if (!viewBox || !body) return [];
      return [`<symbol id="mark-${agent}" viewBox="${viewBox}">${body.replace(/fill="(?!none)[^"]*"/g, 'fill="currentColor"').trim()}</symbol>`];
    } catch {
      return [];
    }
  });
  return symbols.length ? `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${symbols.join('')}</defs></svg>` : '';
}

let html: string | undefined;

/** The card's page. It talks to the host over the MCP Apps postMessage protocol; see the script for the exchange. */
export function cardHtml(): string {
  return html ??= PAGE.replace('<!--marks-->', marks());
}

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root{--text:#1f1f1e;--muted:#6b6a66;--faint:#8a8984;--line:rgba(0,0,0,.09);--track:rgba(0,0,0,.08);--ok:#2f8a4e;--now:#2f6fd0;--ok-bg:rgba(47,138,78,.12);--ok-text:#256e3e;--now-bg:rgba(47,111,208,.12);--now-text:#2459a8;--warn-bg:rgba(214,160,20,.18);--warn-text:#8a5a00;--bad-bg:rgba(208,58,58,.12);--bad-text:#a52c2c;--off-bg:rgba(0,0,0,.06);color-scheme:light}
:root[data-theme=dark]{--text:#ecebe7;--muted:#a3a19b;--faint:#83817b;--line:rgba(255,255,255,.08);--track:rgba(255,255,255,.1);--ok:#4fb874;--now:#5d9bf0;--ok-bg:rgba(79,184,116,.16);--ok-text:#7fd39c;--now-bg:rgba(93,155,240,.16);--now-text:#94bdf6;--warn-bg:rgba(230,180,60,.18);--warn-text:#f0c768;--bad-bg:rgba(240,100,100,.16);--bad-text:#f49a9a;--off-bg:rgba(255,255,255,.08);color-scheme:dark}
*{box-sizing:border-box}
html,body{margin:0;background:transparent;font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--text)}
main{padding:14px 16px;min-height:100vh;display:flex;flex-direction:column}
.grow{flex:1}
section+section{margin-top:14px;padding-top:14px;border-top:1px solid var(--line)}
.head{display:flex;align-items:baseline;gap:8px;min-width:0}
.title{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.meta{color:var(--muted);font-size:12px;white-space:nowrap}
.track{display:grid;gap:6px;margin:12px 0 4px}
.bar{height:4px;border-radius:2px;background:var(--track)}
.past .bar{background:var(--ok)}.now .bar{background:var(--now)}
.stop{font-size:12px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.now .stop{color:var(--text)}
.row{display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--line)}
.track+.row{margin-top:8px}
.logo{width:16px;height:16px;flex:none;color:var(--muted)}
.name{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{font-size:11px;padding:2px 8px;border-radius:6px;white-space:nowrap}
.running{background:var(--now-bg);color:var(--now-text)}.waiting{background:var(--warn-bg);color:var(--warn-text)}
.done{background:var(--ok-bg);color:var(--ok-text)}.failed{background:var(--bad-bg);color:var(--bad-text)}.cancelled{background:var(--off-bg);color:var(--muted)}
.time{font-size:12px;color:var(--faint);font-variant-numeric:tabular-nums;min-width:44px;text-align:right}
.empty{color:var(--muted)}
footer{display:flex;align-items:center;gap:8px;margin-top:10px;font-size:12px;color:var(--faint)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--ok)}
.spacer{flex:1}
button{font:inherit;color:var(--now-text);background:none;border:0;padding:0;cursor:pointer}
button:hover{text-decoration:underline}
</style></head>
<body><!--marks--><main id="card" aria-live="polite"></main>
<script>
(() => {
  const POLL_MS = 4000;
  const TEXT = {
    en: { stops: ['Plan', 'Build', 'Review', 'Fix', 'Polish', 'Final'], of: (n, m) => 'Step ' + n + ' of ' + m, done: 'Done', abandoned: 'Stopped',
      states: { running: 'Working', waiting: 'Needs you', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' },
      asOf: (t) => 'As of ' + t, live: 'Live', board: 'Open board', ask: 'Open the Crew board.', jobs: 'Jobs', none: 'No jobs under way' },
    ko: { stops: ['계획', '구현', '리뷰', '수정', '다듬기', '마무리'], of: (n, m) => m + '단계 중 ' + n + '단계', done: '완료', abandoned: '중단됨',
      states: { running: '작업 중', waiting: '확인 필요', done: '완료', failed: '실패', cancelled: '취소됨' },
      asOf: (t) => t + ' 기준', live: '실시간', board: '보드 열기', ask: 'Crew 보드를 열어 줘.', jobs: '작업', none: '진행 중인 작업 없음' },
  };
  let text = TEXT.en, locale = undefined, view = null, live = false, canAsk = false, polling = false, seen = true, grow = null, timer = 0, next = 1;
  const pending = new Map();
  const card = document.getElementById('card');
  const post = (message) => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    post({ id, method, params });
  });
  const el = (tag, cls, content) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const elapsed = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' + String(s % 60).padStart(2, '0') + 's' : Math.floor(s / 3600) + 'h' + String(Math.floor(s / 60) % 60).padStart(2, '0') + 'm';
  };
  const logo = (agent) => {
    if (!document.getElementById('mark-' + agent)) return null;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'logo');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#mark-' + agent);
    svg.appendChild(use);
    return svg;
  };
  const row = (job, now) => {
    const line = el('div', 'row');
    const mark = logo(job.agent);
    if (mark) line.appendChild(mark);
    line.appendChild(el('span', 'name', job.title || job.agent));
    line.appendChild(el('span', 'pill ' + job.state, text.states[job.state] || job.state));
    line.appendChild(el('span', 'time', elapsed((job.endedAt || now) - job.startedAt)));
    return line;
  };
  const stopNames = (steps) => {
    const rounds = {};
    return steps.map((step) => {
      if (step.label) return step.label;
      rounds[step.stop] = (rounds[step.stop] || 0) + 1;
      return text.stops[step.stop] + (rounds[step.stop] > 1 ? ' ' + rounds[step.stop] : '');
    });
  };
  const active = () => view && (view.missions.some((m) => m.state === 'active') || view.jobs.length > 0);
  // Where the missions stood when this card was made. A newer card is shown once a step moves, so this one then stays as it was.
  const stepsOf = (v) => v.missions.map((m) => m.id + ':' + m.at + ':' + m.state).join(' ');
  let made = null;
  function render() {
    if (!view) return;
    // A live card counts time as it goes; a snapshot stops at the moment it was taken.
    const now = live ? Date.now() : view.asOf;
    card.replaceChildren();
    for (const mission of view.missions) {
      const part = el('section');
      const head = el('div', 'head');
      head.appendChild(el('span', 'title', mission.title));
      head.appendChild(el('span', 'meta', mission.state === 'abandoned' ? text.abandoned : mission.state === 'done' ? text.done : text.of(mission.at + 1, mission.steps.length)));
      part.appendChild(head);
      const track = el('div', 'track');
      track.style.gridTemplateColumns = 'repeat(' + mission.steps.length + ', minmax(0, 1fr))';
      stopNames(mission.steps).forEach((name, index) => {
        const stop = el('div', index < mission.at ? 'past' : index === mission.at && mission.state === 'active' ? 'now' : '');
        stop.appendChild(el('div', 'bar'));
        stop.appendChild(el('div', 'stop', name));
        track.appendChild(stop);
      });
      part.appendChild(track);
      for (const job of mission.jobs) part.appendChild(row(job, now));
      card.appendChild(part);
    }
    if (!view.missions.length) {
      const part = el('section');
      part.appendChild(el('div', 'title', text.jobs));
      if (!view.jobs.length) part.appendChild(el('div', 'empty', text.none));
      for (const job of view.jobs) part.appendChild(row(job, now));
      card.appendChild(part);
    }
    // Takes up what a host's minimum height leaves (ChatGPT's is 200px), so the footer stays at the bottom.
    grow = el('div', 'grow');
    card.appendChild(grow);
    const foot = el('footer');
    if (live && active()) {
      foot.appendChild(el('span', 'dot'));
      foot.appendChild(el('span', '', text.live));
    } else {
      foot.appendChild(el('span', '', text.asOf(new Date(view.asOf).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }))));
    }
    // The board signs in with a one-time ticket that only the lead's board skill can mint, so the card asks the lead.
    if (canAsk) {
      foot.appendChild(el('span', 'spacer'));
      const open = el('button', '', text.board);
      open.type = 'button';
      open.addEventListener('click', () => request('ui/message', { role: 'user', content: [{ type: 'text', text: text.ask }] }).catch(() => {}));
      foot.appendChild(open);
    }
    card.appendChild(foot);
    requestAnimationFrame(size);
  }
  const usable = (result) => Boolean(result && !result.isError && result.structuredContent && Array.isArray(result.structuredContent.missions));
  const show = (result) => {
    if (!usable(result)) return;
    view = result.structuredContent;
    if (made === null) made = stepsOf(view);
    render();
  };
  const stop = () => { polling = false; clearTimeout(timer); timer = 0; };
  // One request at a time, and only while the card is on screen: a long chat holds many cards.
  function tick() {
    timer = 0;
    if (!polling) return;
    if (!seen || document.hidden) return void (timer = setTimeout(tick, POLL_MS));
    request('tools/call', { name: 'progress', arguments: {} }).then((result) => {
      if (!usable(result)) throw new Error('no card');
      if (stepsOf(result.structuredContent) !== made) {
        stop();
        live = false;
        return render();
      }
      show(result);
      if (!active()) stop();
      else if (polling) timer = setTimeout(tick, POLL_MS);
    }).catch(() => {
      // Crew could not answer: the card stays as it last was and says when that was.
      stop();
      live = false;
      render();
    });
  }
  function poll() {
    if (polling || !live) return;
    polling = true;
    timer = setTimeout(tick, POLL_MS);
  }
  new IntersectionObserver((entries) => { seen = entries.some((entry) => entry.isIntersecting); }).observe(document.body);
  function context(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'dark' || ctx.theme === 'light') document.documentElement.dataset.theme = ctx.theme;
    if (typeof ctx.locale === 'string') {
      locale = ctx.locale;
      text = /^ko\\b/i.test(ctx.locale) ? TEXT.ko : TEXT.en;
    }
  }
  if (!document.documentElement.dataset.theme && window.matchMedia('(prefers-color-scheme: dark)').matches) document.documentElement.dataset.theme = 'dark';
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && pending.has(message.id) && !message.method) {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      return message.error ? waiter.reject(message.error) : waiter.resolve(message.result);
    }
    if (message.method === 'ui/notifications/tool-result') {
      show(message.params);
      if (active()) poll();
    } else if (message.method === 'ui/notifications/host-context-changed') {
      context(message.params);
      render();
    } else if (message.method === 'ui/resource-teardown') {
      stop();
      if (message.id !== undefined) post({ id: message.id, result: {} });
    }
  });
  // The content's height, without the room the frame adds: reporting the frame's own height would keep it from ever shrinking.
  // Sent once there is content, and after every render, since content shorter than the frame leaves the card's box unchanged.
  const size = () => {
    if (grow) post({ method: 'ui/notifications/size-changed', params: { height: Math.ceil(card.getBoundingClientRect().height - grow.getBoundingClientRect().height) } });
  };
  new ResizeObserver(size).observe(card);
  request('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'crew-progress', version: '1' }, appCapabilities: {} }).then((result) => {
    const can = (result && result.hostCapabilities) || {};
    live = Boolean(can.serverTools);
    canAsk = Boolean(can.message);
    context(result && result.hostContext);
    post({ method: 'ui/notifications/initialized', params: {} });
    render();
    if (active()) poll();
  }).catch(() => {});
})();
</script></body></html>`;
