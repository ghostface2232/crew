import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  ArrowRight, ArrowUpRight, ChevronDown, ChevronUp, CircleAlert, CircleCheck, CircleDot, Layers, MessagesSquare, Plus, Search,
  SquareStack,
} from 'lucide-react';
import type { ProviderUsage } from '../../bridge/usage.ts';
import type { Holder } from '../../bridge/config.ts';
import type { BoardJob, CrewEvent, Mission, Snapshot, WorkerAgent } from './types.ts';
import {
  dailyCounts, elapsed, endedPerHour, holdersOf, jobLabel, NAMES, projectOf, relativeDuration, rolesOf, runningPerHour,
  usageWindowName, unsettled,
} from './model.ts';
import { AgentMark, Chip, EmptyState, Icon, RollingNumber, useFade, useNow } from './ui.tsx';
import { JobRow, jobKind, jobStatusState, MissionPanel, SessionRow } from './Missions.tsx';

export interface Scope {
  state: Snapshot;
  project: string;
  names: Map<string, string>;
  /** The open detail panel: a job id, or `session:<id>`. */
  selected: string;
  openJob: (id: string) => void;
  openSession: (id: string) => void;
}
export const matches = (search: string, text: string) => !search || text.toLowerCase().includes(search.toLowerCase());
const inProject = (project: string, item: Parameters<typeof projectOf>[0]) => !project || projectOf(item) === project;

/** A card with a small caps label, the dashboard's one surface. */
function Panel({ label, action, className, children, style }: { label: string; action?: ReactNode; className?: string; children: ReactNode; style?: CSSProperties }) {
  return (
    <section className={`card panel ${className ?? ''}`} aria-label={label} style={style}>
      <header className="panel-head">
        <h2 className="label">{label}</h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/** Bars of hourly counts; the pointer reads one off. */
function Spark({ values, label }: { values: number[]; label: string }) {
  const [at, setAt] = useState<number | null>(null);
  const max = Math.max(1, ...values);
  return (
    <div className="spark" aria-hidden="true" onPointerLeave={() => setAt(null)}>
      {values.map((value, index) => (
        <i
          key={index}
          data-on={value > 0 || undefined}
          data-at={at === index || undefined}
          style={{ '--h': value / max } as CSSProperties}
          onPointerEnter={() => setAt(index)}
        />
      ))}
      {at !== null && (
        <span className="spark-tip" style={{ '--x': (at + 0.5) / values.length } as CSSProperties}>
          {values[at]} {label} · {values.length - 1 - at === 0 ? 'this hour' : `${values.length - 1 - at}h ago`}
        </span>
      )}
    </div>
  );
}

/** The counts that matter most, each with its last day by the hour, and their shares as one bar. */
export function Kpis({ state, project }: { state: Snapshot; project: string }) {
  const now = useNow();
  const jobs = state.jobs.filter((job) => inProject(project, job));
  const sessions = state.claude.filter((session) => inProject(project, session));
  const waiting = [...jobs.filter((job) => job.state === 'waiting').map((job) => job.waiting?.since ?? now), ...sessions.filter((session) => session.state === 'waiting').map((session) => session.activeAt)];
  const metrics = [
    // Lead sessions count like jobs, as they already do under Needs you.
    { label: 'In progress', state: 'working', count: jobs.filter((job) => job.state === 'running').length + sessions.filter((session) => session.state === 'working').length,
      spark: runningPerHour(jobs, now), unit: 'running', foot: `${sessions.filter((session) => session.state === 'working').length} lead sessions` },
    { label: 'Needs you', state: 'waiting', count: waiting.length, marks: [...jobs.filter((job) => job.state === 'waiting').map((job) => job.agent), ...sessions.filter((session) => session.state === 'waiting').map(() => 'claude')], foot: waiting.length ? `Oldest waiting ${elapsed(now - Math.min(...waiting))}` : 'Nothing waiting' },
    // Settled jobs stay in the list but leave the totals, which would otherwise only grow.
    { label: 'Finished', state: 'done', count: jobs.filter((job) => job.state === 'done' && unsettled(job)).length,
      spark: endedPerHour(jobs, 'done', now), unit: 'finished', foot: `${jobs.filter((job) => job.state === 'done').length} in all` },
    { label: 'Failed', state: 'failed', count: jobs.filter((job) => job.state === 'failed' && unsettled(job)).length,
      spark: endedPerHour(jobs, 'failed', now), unit: 'failed', foot: `${jobs.filter((job) => job.state === 'failed').length} in all` },
  ];
  const total = metrics.reduce((sum, metric) => sum + metric.count, 0);
  const tokens = jobs.filter((job) => now - job.createdAt < 86_400_000).reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  return (
    <section className="kpis" aria-label="Jobs by state">
      <ul className="kpi-row">
        {metrics.map((metric, index) => (
          <li className="kpi" key={metric.label} data-state={metric.state} data-zero={metric.count === 0 || undefined} style={{ '--i': index } as CSSProperties}>
            <span className="label">{metric.label}</span>
            <div className="kpi-figure">
              <RollingNumber value={metric.count} className="kpi-number" />
              {metric.spark ? <Spark values={metric.spark} label={metric.unit!} /> : (
                // Who is waiting, one mark per request.
                <span className="kpi-marks" aria-hidden="true">
                  {metric.marks!.slice(0, 4).map((agent, index) => <span key={index} style={{ '--i': index } as CSSProperties}><AgentMark agent={agent} size={14} /></span>)}
                  {metric.marks!.length > 4 && <span className="kpi-more">+{metric.marks!.length - 4}</span>}
                </span>
              )}
            </div>
            <span className="kpi-foot">{metric.foot}</span>
          </li>
        ))}
      </ul>
      <div className="share">
        <div className="share-legend">
          {metrics.map((metric) => (
            <span key={metric.label} data-state={metric.state} data-zero={metric.count === 0 || undefined}>
              <i />{metric.label}
              <b className="digits">{total ? Math.round((metric.count / total) * 100) : 0}%</b>
            </span>
          ))}
          {tokens > 0 && <span className="share-tokens digits">{tokens.toLocaleString()} tokens in 24h</span>}
        </div>
        {/* A bare track only when there is nothing to count, as in the app. */}
        <div className="share-bar" aria-hidden="true" data-empty={total === 0 || undefined}>
          {metrics.map((metric) =>
            metric.count > 0 ? <i key={metric.label} data-state={metric.state} style={{ flexGrow: metric.count }} /> : null,
          )}
        </div>
      </div>
    </section>
  );
}

/** Orange from 70% used and red from 90% or at the limit, as the app colors usage. */
const usageLevel = (ratio: number, status?: string) => (status === 'exhausted' || ratio >= 0.9 ? 'high' : ratio >= 0.7 || status === 'tight' ? 'mid' : undefined);

function AgentUsage({ state, agent }: { state: Snapshot; agent: string }) {
  const now = useNow();
  const usage = state.usage;
  if (usage && usage.source !== 'none') {
    const provider = usage.providers.find((item) => item.agent === agent);
    if (!provider) return <p className="usage">Usage unknown</p>;
    const account = provider.windows.filter((window) => window.group == null);
    const scoped = provider.windows.filter((window) => window.group != null);
    return (
      <div
        className="usage"
        aria-label={`${NAMES[agent as WorkerAgent] ?? agent} usage`}
        title={[provider.reason, ...scoped.map((window) => `${window.group}: ${usageWindowName(window.kind)}, ${Math.round(window.usedRatio * 100)}%, ${window.status}`)].join('\n')}
      >
        {!account.length && <p>{capitalized(provider.status)}</p>}
        {account.map((window) => {
          // The provider's status overrides a window's when the reading is old or a job just hit the limit.
          const status = shownStatus(provider, window.status);
          const ratio = Math.max(0, Math.min(1, window.usedRatio));
          return (
            <div className="usage-window" data-status={status} data-level={usageLevel(ratio, status)} key={window.key}>
              <p className="usage-line">
                <span>{usageWindowName(window.kind)}</span>
                <span className="digits">{Math.round(window.usedRatio * 100)}%</span>
                {(status === 'stale' || status === 'unknown' || (status === 'exhausted' && window.status !== 'exhausted')) && (
                  <span>{status === 'exhausted' ? 'limit reached' : status}</span>
                )}
                {window.resetTime != null && (
                  <span className="usage-reset">{window.resetTime <= now ? 'Reset due' : `Resets in ${relativeDuration(window.resetTime - now)}`}</span>
                )}
              </p>
              <span className="usage-bar" aria-hidden="true">
                <i style={{ '--ratio': ratio } as CSSProperties} />
              </span>
            </div>
          );
        })}
      </div>
    );
  }
  const windows = agent === 'codex' ? (state.limits.codex?.windows ?? []) : [];
  if (!windows.length) return null;
  const used = Math.max(...windows.map((window) => Math.round(window.usedPercent)));
  return (
    <span
      className="usage-limit caption digits"
      data-level={usageLevel(used / 100)}
      title={windows.map((window) => `${Math.round(window.usedPercent)}% of ${window.minutes}-minute limit`).join('\n')}
    >
      {used}% of limit
    </span>
  );
}
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
function shownStatus(provider: ProviderUsage, status: ProviderUsage['windows'][number]['status']) {
  return ['stale', 'unknown', 'exhausted'].includes(provider.status) ? provider.status : status;
}

function agentActivity(state: Snapshot, project: string, agent: string) {
  const jobs = state.jobs.filter((job) => job.agent === agent && job.endedAt == null && inProject(project, job));
  const sessions = state.claude.filter((session) => inProject(project, session));
  const open = sessions.filter((session) => session.state !== 'idle');
  const idle = sessions.length - open.length;
  const items: { state: string; stalled: boolean }[] = agent === 'claude' ? open : jobs;
  const mark = items.some((item) => item.state === 'waiting') ? 'waiting' : items.some((item) => item.stalled) ? 'stalled' : items.length ? 'working' : 'idle';
  const title = mark === 'waiting' ? 'Needs you' : mark === 'stalled' ? 'May be stuck' : mark === 'working' ? 'Working'
    : state.agents[agent as WorkerAgent]?.enabled === false ? 'Disabled' : 'Ready';
  // Busy agents say what they have open; Claude also counts its idle sessions.
  const noun = agent === 'claude' ? 'session' : 'job';
  const line = [
    items.length ? `${items.length} active ${noun}${items.length === 1 ? '' : 's'}` : null,
    agent === 'claude' && idle ? `${idle} idle${items.length ? '' : ` session${idle === 1 ? '' : 's'}`}` : null,
  ].filter(Boolean).join(' · ');
  return { line, mark, title };
}

function FadeCaption({ text }: { text: string }) {
  const fade = useFade<HTMLParagraphElement>();
  return <p className="caption fade-line" ref={fade} title={text}>{text}</p>;
}

export function AgentPanel({ state, project }: { state: Snapshot; project: string }) {
  const agents = ['claude', ...(['codex', 'antigravity'] as const).filter((agent) => state.agents[agent])];
  const measured = state.usage != null && state.usage.source !== 'none';
  return (
    <Panel label="Agents" className="agents">
      <ul className="agent-cards">
        {agents.map((agent, index) => {
          const { line, mark, title } = agentActivity(state, project, agent);
          // A role that follows its parent to the same holders adds nothing to say, unless it names its own.
          const held = rolesOf(state)
            .filter(({ role, parent }) => {
              const holders = holdersOf(state.roles[role]);
              if (!holders.includes(agent as Holder)) return false;
              const parentHolders = parent ? holdersOf(state.roles[parent]) : [];
              const same = Boolean(parent) && parentHolders.length === holders.length && holders.every((holder) => parentHolders.includes(holder));
              return !(same && !state.roleSettings?.[role]?.agents);
            })
            .map(({ label }) => label);
          const role = [...(agent === 'claude' ? ['Lead'] : []), ...held].join(' · ');
          return (
            <li className="agent-card" key={agent} data-agent={agent} style={{ '--i': index } as CSSProperties}>
              <div className="agent-card-head">
                <span className="agent-avatar" data-state={mark}><AgentMark agent={agent} size={18} /></span>
                <div>
                  <h3 className="card-title">{NAMES[agent as keyof typeof NAMES]}</h3>
                  <FadeCaption text={role} />
                </div>
                <Chip state={mark}>{title}</Chip>
              </div>
              {(line || !measured) && (
                <div className="agent-card-row">
                  {line && <span className="agent-activity">{line}</span>}
                  {!measured && <AgentUsage state={state} agent={agent} />}
                </div>
              )}
              {measured && <AgentUsage state={state} agent={agent} />}
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Days as squares, weeks as columns; the darker, the more work started. One tooltip glides between squares. */
/**
 * Days as squares, weeks as columns, as many recent weeks as fit the card up to `most`; the darker, the more work
 * started. Its title row carries the total, and one tooltip glides between squares.
 */
export function Heatmap({ title, times, most, label, one }: { title: string; times: number[]; most: number; label: string; one: string }) {
  const now = useNow();
  const [weeks, setWeeks] = useState(most);
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current!;
    const fit = () => {
      const style = getComputedStyle(element);
      const cell = parseFloat(style.getPropertyValue('--cell')) || 11;
      const gap = parseFloat(style.getPropertyValue('--gap')) || 3;
      // Less the day names' column and its gap.
      const room = element.clientWidth - 28;
      setWeeks(Math.max(4, Math.min(most, Math.floor((room + gap) / (cell + gap)))));
    };
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, [most]);
  // Recounted when the local day turns, not the UTC hour, which some zones' midnight falls inside.
  const days = useMemo(() => dailyCounts(times, now, weeks), [times, new Date(now).toDateString(), weeks]);
  const [at, setAt] = useState<number | null>(null);
  // A narrower card shows fewer days; a square under the pointer may be gone.
  useEffect(() => setAt(null), [weeks]);
  const grid = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  // The newest weeks are the ones to see; a narrow card scrolls back for the older ones.
  useLayoutEffect(() => {
    if (frame.current) frame.current.scrollLeft = frame.current.scrollWidth;
  }, [weeks, days.length]);
  const max = Math.max(1, ...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const months = days
    .map((day, index) => ({ index, date: new Date(day.day) }))
    .filter(({ date, index }) => index % 7 === 0 && date.getDate() <= 7)
    .map(({ index, date }) => ({ column: index / 7, name: date.toLocaleDateString([], { month: 'short' }) }));
  const tip = useRef<HTMLSpanElement>(null);
  // The tooltip sits outside the scrolling frame so it is never cut off, kept within the heatmap's own width.
  useLayoutEffect(() => {
    const cell = at !== null ? grid.current?.children[at] : undefined;
    if (!cell || !tip.current || !root.current) return;
    const box = root.current.getBoundingClientRect();
    const square = cell.getBoundingClientRect();
    const width = tip.current.offsetWidth;
    const left = Math.max(0, Math.min(box.width - width, square.left + square.width / 2 - box.left - width / 2));
    tip.current.style.setProperty('--x', `${left}px`);
    tip.current.style.setProperty('--y', `${square.top - box.top}px`);
  }, [at]);
  return (
    <div className="heatmap" ref={root} style={{ '--weeks': weeks } as CSSProperties}>
      {/* No legend: a square's tooltip gives its count, and darker reads as more without one. */}
      <header className="panel-head">
        <h2 className="label">{title}</h2>
        <p className="heatmap-sum"><b className="digits">{total.toLocaleString()}</b> {total === 1 ? one : label} · {weeks} weeks</p>
      </header>
      <div className="heatmap-frame" ref={frame}>
      <div className="heatmap-months" aria-hidden="true">
        {months.map((month) => <span key={month.column} style={{ '--col': month.column } as CSSProperties}>{month.name}</span>)}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-days" aria-hidden="true"><span>Mon</span><span>Wed</span><span>Fri</span></div>
        <div className="heatmap-grid" ref={grid} role="img" aria-label={`${total} ${label} in the last ${weeks} weeks`} onPointerLeave={() => setAt(null)}>
          {days.map((day, index) => (
            <i
              key={day.day}
              data-level={day.count === 0 ? 0 : Math.ceil((day.count / max) * 4)}
              data-today={index === days.length - 1 || undefined}
              style={{ '--d': index } as CSSProperties}
              onPointerEnter={() => setAt(index)}
            />
          ))}
        </div>
      </div>
      </div>
      {at !== null && days[at] && (
        <span className="heatmap-tip" ref={tip}>
          <b>{days[at].count}</b> {days[at].count === 1 ? one : label} · {new Date(days[at].day).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}
        </span>
      )}
    </div>
  );
}

/** Without openJob, as in a job's own details, events carry no link to the job. */
export function EventList({ events, openJob, limit }: { events: CrewEvent[]; openJob?: (id: string) => void; limit?: number }) {
  const shown = events.slice().reverse().slice(0, limit);
  return (
    <ol className="events">
      {shown.map((event, index) => (
        <li className="event" key={event.seq} data-kind={event.kind} style={{ '--i': Math.min(index, 12) } as CSSProperties}>
          <span className="event-mark"><Icon icon={event.kind === 'error' ? CircleAlert : event.kind === 'done' ? CircleCheck : CircleDot} /></span>
          <div>
            <p className="event-head">
              <b>{NAMES[event.agent as keyof typeof NAMES] ?? event.agent}</b>
              <time dateTime={event.ts}>{new Date(event.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
              {event.job_id && openJob && (
                <button className="icon small" data-opens-panel="" aria-label="Show job" title="Show job" onClick={() => openJob(event.job_id!)}>
                  <Icon icon={ArrowUpRight} />
                </button>
              )}
            </p>
            <p className="selectable">{event.detail}</p>
          </div>
        </li>
      ))}
    </ol>
  );
}

const AGENT_FILTERS: [string, string][] = [['', 'Everyone'], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']];
/** Pills that filter a list, with each one's count, as the reference dashboards filter. */
function Pills<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string, number?][]; onChange: (value: T) => void }) {
  return (
    <div className="pills" role="radiogroup" aria-label={label}>
      {options.map(([option, text, count]) => (
        <button key={option} type="button" role="radio" aria-checked={value === option} onClick={() => onChange(option)}>
          {text}
          {count !== undefined && <span className="digits">{count}</span>}
        </button>
      ))}
    </div>
  );
}

export function Activity({ state, openJob }: Pick<Scope, 'state' | 'openJob'>) {
  const [agent, setAgent] = useState('');
  const events = state.events.filter((event) => !agent || event.agent === agent);
  // Days, newest first, each under its own sticky heading.
  const days = new Map<string, CrewEvent[]>();
  for (const event of events) {
    const day = new Date(event.ts).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
    days.set(day, [...(days.get(day) ?? []), event]);
  }
  const times = [...state.jobs.map((job) => job.createdAt), ...state.missions.map((mission) => mission.createdAt)];
  return (
    <>
      <section className="card panel activity-map" aria-label="Work started" style={{ '--i': 0 } as CSSProperties}>
        <Heatmap title="Work started" times={times} most={53} label="jobs and missions" one="job or mission" />
      </section>
      <Panel
        label="Events"
        action={<Pills label="Agent" value={agent} options={AGENT_FILTERS.map(([id, name]) => [id, name, state.events.filter((event) => !id || event.agent === id).length])} onChange={setAgent} />}
      >
        {!events.length && <p className="secondary">No activity yet.</p>}
        {[...days].reverse().map(([day, list]) => (
          <div className="event-day" key={day}>
            <h3 className="event-day-name">{day}</h3>
            <EventList events={list} openJob={openJob} />
          </div>
        ))}
      </Panel>
    </>
  );
}

/** The overview or a project: what is going on now, with the agents and the crew's rhythm beside it. */
export function Workspace({ state, project, names, selected, openJob, openSession, newJob, openPage }: Scope & {
  newJob: (origin?: Element | null) => void;
  openPage: (selection: string) => void;
}) {
  const jobs = state.jobs.filter((job) => inProject(project, job));
  const byMission = new Map<string, BoardJob[]>();
  for (const job of jobs) if (job.mission) byMission.set(job.mission, [...(byMission.get(job.mission) ?? []), job]);
  const missions = state.missions.filter((mission) => inProject(project, mission)).sort((a, b) => b.createdAt - a.createdAt);
  const active = missions.filter((mission) => mission.state === 'active');
  const recent = missions.filter((mission) => mission.state !== 'active').slice(0, 2);
  const panelIds = new Set([...active, ...recent].map((mission) => mission.id));
  const loose = jobs.filter((job) => !panelIds.has(job.mission ?? '') && job.endedAt == null).sort((a, b) => b.createdAt - a.createdAt);
  const recentJobs = jobs
    .filter((job) => job.endedAt != null && !job.mission)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 4);
  const sessions = state.claude.filter((session) => inProject(project, session));
  const panel = (mission: Mission, index: number) => (
    <MissionPanel
      key={mission.id}
      mission={mission}
      jobs={byMission.get(mission.id) ?? []}
      allJobs={state.jobs}
      lead={state.claude.find((session) => session.id === mission.owner)}
      projectName={project ? undefined : names.get(projectOf(mission))}
      selected={selected}
      openJob={openJob}
      openSession={openSession}
      index={index}
    />
  );
  const row = (job: BoardJob, index: number) => <JobRow key={job.id} job={job} selected={selected === job.id} openJob={openJob} index={index} />;
  const empty = !jobs.length && !missions.length && !sessions.length;
  const events = state.events.filter((event) => !project || !event.job_id || jobs.some((job) => job.id === event.job_id));
  return (
    <>
      <Kpis state={state} project={project} />
      <div className="dash">
        <div className="dash-main">
          {active.map(panel)}
          {loose.length > 0 && (
            <Panel label="Other jobs" style={{ '--i': active.length } as CSSProperties} action={<Icon icon={SquareStack} />}>
              <div className="rows">{loose.map(row)}</div>
            </Panel>
          )}
          {recent.map((mission, index) => panel(mission, active.length + 1 + index))}
          {recentJobs.length > 0 && (
            <Panel label="Recently finished" action={<button className="link" onClick={() => openPage('history')}>History <Icon icon={ArrowRight} size={12} /></button>}>
              <div className="rows">{recentJobs.map(row)}</div>
            </Panel>
          )}
          {sessions.length > 0 && (
            <Panel label="Claude sessions" action={<Icon icon={MessagesSquare} />}>
              <div className="rows">
                {sessions.map((session) => (
                  <SessionRow key={session.id} session={session} selected={selected === `session:${session.id}`} openSession={openSession} />
                ))}
              </div>
            </Panel>
          )}
          {empty && (
            <EmptyState title="Ready when you are" icon={Layers} detail="Start with New Job, or /crew:run in Claude.">
              <button className="prominent" disabled={state.connection !== 'live'} onClick={(event) => newJob(event.currentTarget)}>
                <Icon icon={Plus} />
                New Job
              </button>
            </EmptyState>
          )}
        </div>
        <aside className="dash-side" aria-label="Agents and activity">
          <AgentPanel state={state} project={project} />
          <section className="card panel" aria-label="Rhythm" style={{ '--i': 1 } as CSSProperties}>
            <Heatmap title="Rhythm" times={jobs.map((job) => job.createdAt)} most={26} label="jobs" one="job" />
          </section>
          <Panel label="Live feed" action={<button className="link" onClick={() => openPage('activity')}>All <Icon icon={ArrowRight} size={12} /></button>}>
            {events.length ? <EventList events={events} openJob={openJob} limit={6} /> : <p className="secondary caption">Nothing has happened yet.</p>}
          </Panel>
        </aside>
      </div>
    </>
  );
}

type SortKey = 'title' | 'agent' | 'project' | 'state' | 'duration' | 'ended';
/** Finished work: ended missions, then every ended job in a table to filter and sort. */
export function History({ state, project, names, selected, openJob, openSession }: Scope) {
  const [filter, setFilter] = useState<'' | 'done' | 'failed' | 'cancelled'>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: 'ended', up: false });
  const ended = state.jobs.filter((job) => inProject(project, job) && job.endedAt != null);
  const missions = state.missions.filter((mission) => inProject(project, mission) && mission.state !== 'active' && matches(search, mission.title)).sort((a, b) => b.createdAt - a.createdAt);
  const value = (job: BoardJob): string | number =>
    sort.key === 'title' ? job.title.toLowerCase() : sort.key === 'agent' ? NAMES[job.agent] : sort.key === 'project' ? names.get(projectOf(job)) ?? projectOf(job)
      : sort.key === 'state' ? job.state : sort.key === 'duration' ? (job.endedAt ?? 0) - job.createdAt : job.endedAt ?? 0;
  const rows = ended
    .filter((job) => (!filter || job.state === filter) && matches(search, `${job.title} ${projectOf(job)} ${NAMES[job.agent]} ${jobKind(job)}`))
    .sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      return (x < y ? -1 : x > y ? 1 : 0) * (sort.up ? 1 : -1);
    });
  const column = (key: SortKey, text: string, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.up ? 'ascending' : 'descending') : undefined}>
      <button className="sort" onClick={() => setSort({ key, up: sort.key === key ? !sort.up : key === 'title' || key === 'agent' || key === 'project' })}>
        {text}
        {sort.key === key && <Icon icon={sort.up ? ChevronUp : ChevronDown} size={12} />}
      </button>
    </th>
  );
  return (
    <>
      <div className="toolbar-row">
        <Pills
          label="State"
          value={filter}
          options={[['', 'All', ended.length], ['done', 'Done', ended.filter((job) => job.state === 'done').length], ['failed', 'Failed', ended.filter((job) => job.state === 'failed').length], ['cancelled', 'Cancelled', ended.filter((job) => job.state === 'cancelled').length]]}
          onChange={setFilter}
        />
        <label className="filter">
          <Icon icon={Search} />
          <input type="search" aria-label="Filter history" placeholder="Filter by title, agent, project" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>
      {missions.map((mission, index) => (
        <MissionPanel
          key={mission.id}
          mission={mission}
          jobs={state.jobs.filter((job) => job.mission === mission.id)}
          allJobs={state.jobs}
          lead={state.claude.find((session) => session.id === mission.owner)}
          projectName={project ? undefined : names.get(projectOf(mission))}
          selected={selected}
          openJob={openJob}
          openSession={openSession}
          index={index}
        />
      ))}
      {rows.length > 0 ? (
        <Panel label="Completed jobs" className="table-panel">
          <div className="table-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  {column('title', 'Job')}
                  {column('agent', 'Agent', 'narrow-hide')}
                  {!project && column('project', 'Project', 'narrow-hide')}
                  {column('state', 'Status')}
                  {column('duration', 'Took', 'num')}
                  {column('ended', 'Ended', 'num narrow-hide')}
                </tr>
              </thead>
              <tbody>
                {rows.map((job, index) => (
                  <tr key={job.id} data-opens-panel="" aria-current={selected === job.id || undefined} style={{ '--i': Math.min(index, 16) } as CSSProperties} onClick={() => openJob(job.id)}>
                    <td>
                      <button className="cell-title" data-job={job.id} data-opens-panel="" onClick={(event) => { event.stopPropagation(); openJob(job.id); }}>
                        <b>{job.title}</b>
                        <span>{jobKind(job)}</span>
                      </button>
                    </td>
                    <td className="narrow-hide"><span className="cell-agent"><AgentMark agent={job.agent} size={14} />{NAMES[job.agent]}</span></td>
                    {!project && <td className="narrow-hide cell-muted">{names.get(projectOf(job)) ?? projectOf(job)}</td>}
                    <td><Chip state={jobStatusState(job)}>{jobLabel(job)}</Chip></td>
                    <td className="num cell-muted">{elapsed((job.endedAt ?? 0) - job.createdAt)}</td>
                    <td className="num cell-muted narrow-hide">{new Date(job.endedAt!).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        !missions.length && <EmptyState title={search || filter ? 'No matching work' : 'No completed work yet'} icon={search || filter ? Search : Layers} />
      )}
    </>
  );
}
