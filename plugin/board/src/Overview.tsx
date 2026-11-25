import { Children, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  AddRegular, ArrowRight16Filled, ArrowUpRight16Filled, ChatMultipleRegular, CheckmarkCircle16Regular,
  CheckmarkCircleRegular, ChevronDown16Regular, ChevronUp16Regular, CircleMultipleConcentric16Regular,
  DismissRegular, ErrorCircle16Regular, ErrorCircleRegular, LayerRegular, SearchRegular, StackRegular, TaskListLtrRegular,
} from '@fluentui/react-icons';
import type { ProviderUsage } from '../../bridge/usage.ts';
import type { Holder } from '../../bridge/config.ts';
import type { BoardJob, CrewEvent, IssueList, Mission, SetupState, Snapshot, WorkerAgent } from './types.ts';
import { formatDate, longDay, shortDateTime, shortDay, shortMonth, timeOfDay } from './dates.ts';
import { request } from './api.ts';
import {
  dailyCounts, elapsed, endedPerHour, holdersOf, jobLabel, leadMission, limitWindowLabel, NAMES, projectOf, relativeDuration, rolesOf, runningPerHour,
  sessionAgent, usageWindowName, unsettled,
} from './model.ts';
import { AgentMark, Chip, CopyButton, EmptyState, Icon, RollingNumber, StatusIcon, tNodes, useFade, useClock, useLanguage, useStableItems } from './ui.tsx';
import { JobRow, jobKind, jobStatusState, MissionPanel, SessionRow } from './Missions.tsx';
import { t, translated } from './i18n.ts';

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

/** The page width past which cards pair up, where the overview's side column also appears (`.dash` in board.css). */
const PAIR_WIDTH = 1040;
/**
 * A page's cards in two columns on a wide page, each stacked on its own, so a card that grows moves only the cards
 * below it in its own column. Cards alternate left and right in order and keep their column, as in the app's
 * masonry. A lone card keeps the full width.
 */
function Columns({ children }: { children: ReactNode }) {
  const cards = Children.toArray(children);
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = root.current!;
    const fit = () => setWide(element.clientWidth > PAIR_WIDTH);
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    fit();
    return () => observer.disconnect();
  }, []);
  // Cards rise in with the page. One that mounts again later, having changed column as a filter or a new mission moves
  // the ones before it, appears in place instead of rising again; the first frame is the line, after the layout above.
  const entered = useRef(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => { entered.current = true; });
    return () => cancelAnimationFrame(frame);
  }, []);
  // A column's wrapper stays mounted in both layouts, so only the cards that change column mount again.
  const columns = wide && cards.length > 1 ? [0, 1].map((side) => cards.filter((_, index) => index % 2 === side)) : [cards];
  return (
    <div className="columns" ref={root}>
      {columns.map((column, index) => (
        <div className="column" key={index}>
          {column.map((card) => <Placed key={(card as { key: string }).key} still={entered.current}>{card}</Placed>)}
        </div>
      ))}
    </div>
  );
}

/** Holds whether its card mounted after the page came in, which no later render changes. */
function Placed({ still, children }: { still: boolean; children: ReactNode }) {
  const [settled] = useState(still);
  return <div className="placed" data-still={settled || undefined}>{children}</div>;
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
          {values.length - 1 - at === 0
            ? t('{count} {label} · this hour', { count: values[at], label })
            : t('{count} {label} · {hours}h ago', { count: values[at], label, hours: values.length - 1 - at })}
        </span>
      )}
    </div>
  );
}

function kpiClock(jobs: BoardJob[]) {
  let sparks: [number[], number[], number[]];
  return (now: number) => {
    const next: typeof sparks = [runningPerHour(jobs, now), endedPerHour(jobs, 'done', now), endedPerHour(jobs, 'failed', now)];
    if (!sparks || next.some((values, index) => values.some((value, at) => value !== sparks[index][at]))) sparks = next;
    return sparks;
  };
}

/** The counts that matter most, each with its last day by the hour, and their shares as one bar. */
export const Kpis = memo(function Kpis({ state, project }: { state: Snapshot; project: string }) {
  useLanguage();
  const jobs = useMemo(() => state.jobs.filter((job) => inProject(project, job)), [state.jobs, project]);
  const sessions = state.claude.filter((session) => inProject(project, session));
  const waiting = jobs.filter((job) => job.state === 'waiting');
  const waitingSessions = sessions.filter((session) => session.state === 'waiting');
  const waitingCount = waiting.length + waitingSessions.length;
  const oldest = Math.min(...waiting.map((job) => job.waiting?.since ?? Infinity), ...waitingSessions.map((session) => session.activeAt));
  const missingSince = waiting.some((job) => job.waiting?.since == null);
  const waitingFoot = useClock((now) =>
    waitingCount ? t('Oldest waiting {time}', { time: elapsed(now - (missingSince ? Math.min(oldest, now) : oldest)) }) : t('Nothing waiting'),
  Boolean(waitingCount));
  const sparkJobs = useStableItems(jobs, (a, b) => a.state === b.state && a.createdAt === b.createdAt && a.endedAt === b.endedAt);
  const getSparks = useMemo(() => kpiClock(sparkJobs), [sparkJobs]);
  const [runningSpark, doneSpark, failedSpark] = useClock(getSparks, jobs.length > 0);
  const workingSessions = sessions.filter((session) => session.state === 'working').length;
  const metrics = [
    // Lead sessions count like jobs, as they already do under Needs you.
    { label: t('In progress'), state: 'working', count: jobs.filter((job) => job.state === 'running').length + workingSessions,
      spark: runningSpark, unit: t('running'), foot: workingSessions === 1 ? t('1 lead session') : t('{count} lead sessions', { count: workingSessions }) },
    { label: t('Needs you'), state: 'waiting', count: waitingCount, foot: waitingFoot },
    // Settled jobs stay in the list but leave the totals, which would otherwise only grow.
    { label: t('Finished'), state: 'done', count: jobs.filter((job) => job.state === 'done' && unsettled(job)).length,
      spark: doneSpark, unit: t('finished'), foot: t('{count} in all', { count: jobs.filter((job) => job.state === 'done').length }) },
    { label: t('Failed'), state: 'failed', count: jobs.filter((job) => job.state === 'failed' && unsettled(job)).length,
      spark: failedSpark, unit: t('failed'), foot: t('{count} in all', { count: jobs.filter((job) => job.state === 'failed').length }) },
  ];
  const total = metrics.reduce((sum, metric) => sum + metric.count, 0);
  const tokenJobs = useMemo(() => jobs.filter((job) => job.tokens), [jobs]);
  const tokens = useClock((now) => tokenJobs.reduce((sum, job) =>
    now - job.createdAt < 86_400_000 ? sum + job.tokens! : sum, 0), tokenJobs.length > 0);
  return (
    <section className="kpis" aria-label={t('Jobs by state')}>
      <ul className="kpi-row">
        {metrics.map((metric, index) => (
          <li className="kpi" key={metric.label} data-state={metric.state} data-zero={metric.count === 0 || undefined} style={{ '--i': index } as CSSProperties}>
            <span className="label">{metric.label}</span>
            <div className="kpi-figure">
              <RollingNumber value={metric.count} className="kpi-number" />
              {metric.spark && <Spark values={metric.spark} label={metric.unit!} />}
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
          {tokens > 0 && <span className="share-tokens digits">{t('{tokens} tokens in 24h', { tokens: tokens.toLocaleString() })}</span>}
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
}, (a, b) => a.project === b.project && a.state.jobs === b.state.jobs && a.state.claude === b.state.claude);

/** Orange from 70% used and red from 90% or at the limit, as the app colors usage. */
const usageLevel = (ratio: number, status?: string) => (status === 'exhausted' || ratio >= 0.9 ? 'high' : ratio >= 0.7 || status === 'tight' ? 'mid' : undefined);

function UsageReset({ time }: { time: number }) {
  const text = useClock((now) => time <= now ? t('Reset due') : t('Resets in {time}', { time: relativeDuration(time - now) }));
  return <span className="usage-reset">{text}</span>;
}

function AgentUsage({ state, agent }: { state: Snapshot; agent: string }) {
  const usage = state.usage;
  if (usage && usage.source !== 'none') {
    const provider = usage.providers.find((item) => item.agent === agent);
    if (!provider) return <p className="usage">{t('Usage unknown')}</p>;
    const account = provider.windows.filter((window) => window.group == null);
    const scoped = provider.windows.filter((window) => window.group != null);
    return (
      <div
        className="usage"
        aria-label={t('{agent} usage', { agent: NAMES[agent as WorkerAgent] ?? agent })}
        title={[provider.reason, ...scoped.map((window) => `${window.group}: ${usageWindowName(window.kind)}, ${Math.round(window.usedRatio * 100)}%, ${statusWord(window.status)}`)].join('\n')}
      >
        {!account.length && <p>{capitalized(statusWord(provider.status))}</p>}
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
                  <span>{status === 'exhausted' ? t('limit reached') : statusWord(status)}</span>
                )}
                {window.resetTime != null && (
                  <UsageReset time={window.resetTime} />
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
      title={windows.map(limitWindowLabel).join('\n')}
    >
      {t('{percent}% of limit', { percent: used })}
    </span>
  );
}
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** A usage status as the daemon names it, lowercase in English. */
const statusWord = (status: string) =>
  ({ ok: t('ok'), tight: t('tight'), exhausted: t('exhausted'), stale: t('stale'), unknown: t('unknown') } as Record<string, string>)[status] ?? status;
function shownStatus(provider: ProviderUsage, status: ProviderUsage['windows'][number]['status']) {
  return ['stale', 'unknown', 'exhausted'].includes(provider.status) ? provider.status : status;
}

function agentActivity(state: Snapshot, project: string, agent: string) {
  const jobs = state.jobs.filter((job) => job.agent === agent && job.endedAt == null && inProject(project, job));
  const sessions = state.claude.filter((session) => sessionAgent(session) === agent && inProject(project, session));
  const open = sessions.filter((session) => session.state !== 'idle');
  const idle = sessions.length - open.length;
  const items: { state: string; stalled: boolean }[] = [...open, ...jobs];
  const mark = items.some((item) => item.state === 'waiting') ? 'waiting' : items.some((item) => item.stalled) ? 'stalled' : items.length ? 'working' : 'idle';
  const title = mark === 'waiting' ? t('Needs you') : mark === 'stalled' ? t('May be stuck') : mark === 'working' ? t('Working')
    : state.agents[agent as WorkerAgent]?.enabled === false ? t('Disabled') : t('Ready');
  // Busy agents say what they have open, lead sessions and jobs apart, and count their idle lead sessions.
  const line = [
    open.length ? (open.length === 1 ? t('1 active session') : t('{count} active sessions', { count: open.length })) : null,
    jobs.length ? (jobs.length === 1 ? t('1 active job') : t('{count} active jobs', { count: jobs.length })) : null,
    // Beside active sessions alone "idle" is clear; beside jobs it must say sessions.
    idle ? (open.length && !jobs.length ? t('{count} idle', { count: idle }) : idle === 1 ? t('1 idle session') : t('{count} idle sessions', { count: idle })) : null,
  ].filter(Boolean).join(' · ');
  return { line, mark, title, leads: sessions.length > 0 };
}

/** A table cell's text, fading at its end when the column is too narrow for it. */
function FadeText({ text }: { text: string }) {
  const fade = useFade<HTMLSpanElement>(text);
  return <span className="fade-line" ref={fade} title={text}>{text}</span>;
}

function FadeCaption({ text }: { text: string }) {
  const fade = useFade<HTMLParagraphElement>(text);
  return <p className="caption fade-line" ref={fade} title={text}>{text}</p>;
}

export const AgentPanel = memo(function AgentPanel({ state, project }: { state: Snapshot; project: string }) {
  useLanguage();
  const agents = ['claude', ...(['codex', 'antigravity'] as const).filter((agent) => state.agents[agent])];
  const measured = state.usage != null && state.usage.source !== 'none';
  return (
    <Panel label={t('Agents')} className="agents">
      <ul className="agent-cards">
        {agents.map((agent, index) => {
          const { line, mark, title, leads } = agentActivity(state, project, agent);
          // A role that follows its parent to the same holders adds nothing to say, unless it names its own.
          const held = rolesOf(state)
            .filter(({ role, parent }) => {
              const holders = holdersOf(state.roles[role]);
              if (!holders.includes(agent as Holder)) return false;
              const parentHolders = parent ? holdersOf(state.roles[parent]) : [];
              const same = Boolean(parent) && parentHolders.length === holders.length && holders.every((holder) => parentHolders.includes(holder));
              return !(same && !state.roleSettings?.[role]?.agents);
            })
            .map(({ label }) => t(label));
          // Claude and Codex alike say Lead while one of their sessions is open here.
          const role = [...(leads ? [t('Lead')] : []), ...held].join(' · ');
          return (
            <li className="agent-card" key={agent} data-agent={agent} style={{ '--i': index } as CSSProperties}>
              <div className="agent-card-head">
                <span className="agent-avatar" data-state={mark}><AgentMark agent={agent} size={26} /></span>
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
}, (a, b) => a.project === b.project &&
  a.state.jobs === b.state.jobs && a.state.claude === b.state.claude &&
  a.state.agents === b.state.agents && a.state.usage === b.state.usage &&
  a.state.limits === b.state.limits && a.state.roles === b.state.roles &&
  a.state.roleSettings === b.state.roleSettings && a.state.roleInfo === b.state.roleInfo);

/** Days as squares, weeks as columns; the darker, the more work started. One tooltip glides between squares. */
/**
 * Days as squares, weeks as columns, as many recent weeks as fit the card up to `most`; the darker, the more work
 * started. Its title row carries the total, and one tooltip glides between squares.
 */
export const Heatmap = memo(function Heatmap({ title, times, most, label, one }: { title: string; times: number[]; most: number; label: string; one: string }) {
  useLanguage();
  const day = useClock((now) => new Date(now).setHours(0, 0, 0, 0));
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
  const days = useMemo(() => dailyCounts(times, day, weeks), [times, day, weeks]);
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
    .map(({ index, date }) => ({ column: index / 7, name: formatDate(shortMonth, date) }));
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
        <p className="heatmap-sum">{tNodes('{count} {noun} · {weeks} weeks', { count: <b className="digits">{total.toLocaleString()}</b>, noun: total === 1 ? one : label, weeks })}</p>
      </header>
      <div className="heatmap-frame" ref={frame}>
      <div className="heatmap-months" aria-hidden="true">
        {months.map((month) => <span key={month.column} style={{ '--col': month.column } as CSSProperties}>{month.name}</span>)}
      </div>
      <div className="heatmap-body">
        <div className="heatmap-days" aria-hidden="true"><span>{t('Mon')}</span><span>{t('Wed')}</span><span>{t('Fri')}</span></div>
        <div className="heatmap-grid" ref={grid} role="img" aria-label={t('{count} {noun} in the last {weeks} weeks', { count: total, noun: label, weeks })} onPointerLeave={() => setAt(null)}>
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
          {tNodes('{count} {noun} · {date}', { count: <b>{days[at].count}</b>, noun: days[at].count === 1 ? one : label, date: formatDate(shortDay, new Date(days[at].day)) })}
        </span>
      )}
    </div>
  );
});

/** Without openJob, as in a job's own details, events carry no link to the job. */
export const EventList = memo(function EventList({ events, openJob, limit }: { events: CrewEvent[]; openJob?: (id: string) => void; limit?: number }) {
  useLanguage();
  const shown = events.slice().reverse().slice(0, limit);
  return (
    <ol className="events">
      {shown.map((event, index) => (
        <EventRow key={event.seq} event={event} index={Math.min(index, 12)} openJob={openJob} />
      ))}
    </ol>
  );
}, (a, b) => {
  if (a.openJob !== b.openJob || a.limit !== b.limit) return false;
  if (a.events === b.events) return true;
  const length = Math.min(a.events.length, a.limit ?? Infinity);
  if (length !== Math.min(b.events.length, b.limit ?? Infinity)) return false;
  for (let offset = 1; offset <= length; offset++) {
    if (a.events.at(-offset) !== b.events.at(-offset)) return false;
  }
  return true;
});

const EventRow = memo(function EventRow({ event, index, openJob }: { event: CrewEvent; index: number; openJob?: (id: string) => void }) {
  useLanguage();
  return (
    <li className="event" data-kind={event.kind} style={{ '--i': index } as CSSProperties}>
      <span className="event-mark"><Icon icon={event.kind === 'error' ? ErrorCircle16Regular : event.kind === 'done' ? CheckmarkCircle16Regular : CircleMultipleConcentric16Regular} /></span>
      <div>
        <p className="event-head">
          <b>{NAMES[event.agent as keyof typeof NAMES] ?? event.agent}</b>
          <time dateTime={event.ts}>{formatDate(timeOfDay, new Date(event.ts))}</time>
          {event.job_id && openJob && (
            <button className="icon small" data-opens-panel="" aria-label={t('Show job')} title={t('Show job')} onClick={() => openJob(event.job_id!)}>
              <Icon icon={ArrowUpRight16Filled} />
            </button>
          )}
        </p>
        <p className="selectable">{event.detail}</p>
      </div>
    </li>
  );
});

const AGENT_FILTERS = translated((): [string, string][] => [['', t('Everyone')], ['claude', 'Claude'], ['codex', 'Codex'], ['antigravity', 'Antigravity']]);
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

export const Activity = memo(function Activity({ events, jobs, missions, openJob }: Pick<Snapshot, 'events' | 'jobs' | 'missions'> & Pick<Scope, 'openJob'>) {
  useLanguage();
  const [agent, setAgent] = useState('');
  // Days, newest first, each under its own sticky heading.
  const { days, counts } = useMemo(() => {
    const days = new Map<string, CrewEvent[]>();
    const counts = new Map<string, number>();
    for (const event of events) {
      counts.set(event.agent, (counts.get(event.agent) ?? 0) + 1);
      if (agent && event.agent !== agent) continue;
      const day = formatDate(longDay, new Date(event.ts));
      const list = days.get(day);
      if (list) list.push(event);
      else days.set(day, [event]);
    }
    return { days, counts };
  }, [events, agent]);
  const times = useStableItems(useMemo(() => [...jobs.map((job) => job.createdAt), ...missions.map((mission) => mission.createdAt)], [jobs, missions]));
  return (
    <Columns>
      <section className="card panel activity-map" aria-label={t('Work started')} style={{ '--i': 0 } as CSSProperties}>
        <Heatmap title={t('Work started')} times={times} most={53} label={t('jobs and missions')} one={t('job or mission')} />
      </section>
      <Panel
        label={t('Events')}
        action={<Pills label={t('Agent')} value={agent} options={AGENT_FILTERS().map(([id, name]) => [id, name, id ? counts.get(id) ?? 0 : events.length])} onChange={setAgent} />}
      >
        {!days.size && <p className="secondary">{t('No activity yet.')}</p>}
        {[...days].reverse().map(([day, list]) => (
          <div className="event-day" key={day}>
            <h3 className="event-day-name">{day}</h3>
            <EventList events={list} openJob={openJob} />
          </div>
        ))}
      </Panel>
    </Columns>
  );
});

/** What Crew still needs, from the same checks as `crew doctor`; hidden once everything is in place. */
function Setup() {
  const [setup, setSetup] = useState<SetupState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    const load = () => request<SetupState>('/api/setup').then((next) => live && setSetup(next), () => {});
    load();
    const timer = setInterval(load, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const act = async (route: string, body?: unknown) => {
    setBusy(true);
    setError('');
    try { setSetup(await request<SetupState>(route, body)); }
    catch (err) { setError((err as Error).message); }
    finally { setBusy(false); }
  };
  if (!setup || setup.items.every((item) => item.ok)) return null;
  const repairable = setup.items.some((item) => !item.ok && item.repairable);
  const trustable = setup.items.some((item) => !item.ok && item.trustable);
  return (
    <Panel label={t('Set up Crew')}>
      <ul className="setup-list">
        {setup.items.map((item) => (
          <li key={item.id} data-ok={item.ok || undefined}>
            <Icon icon={item.ok ? CheckmarkCircleRegular : ErrorCircleRegular} size={14} />
            <span>{withCode(t(item.label))}</span>
            <span className="secondary caption selectable" title={item.summary && item.detail ? item.detail : undefined}>
              {withCode(t(item.summary ?? item.detail))}
            </span>
          </li>
        ))}
      </ul>
      {(error || (setup.registration && !setup.registration.ok)) && (
        <p className="callout error selectable setup-error" role="status"><Icon icon={ErrorCircleRegular} size={13} />{error || setup.registration?.detail}</p>
      )}
      {/* The card's actions end it at the trailing edge, as a section's do, and as in the app. */}
      <div className="setup-actions">
        <button disabled={busy} onClick={() => act('/api/setup?refresh')}>{t('Check Again')}</button>
        {repairable && <button className="prominent" disabled={busy || setup.registering} onClick={() => act('/api/setup/repair', {})}>{busy ? t('Installing…') : t('Install')}</button>}
        {trustable && <button className={repairable ? undefined : 'prominent'} disabled={busy || setup.registering} onClick={() => act('/api/setup/trust-hooks', {})}>{t('Trust Hooks')}</button>}
      </div>
    </Panel>
  );
}

/** How many suggestions a project shows at once; the next one takes the place of one the user dismisses. */
const SHOWN_ISSUES = 3;

/**
 * Open issues of the project's repository that are the user's to start: assigned to them, or to no one. Each can be
 * copied as a /crew:run command or dismissed for good. Says nothing when there are none or gh cannot list them, as in the app.
 */
function IssueSuggestions({ project, command, live }: { project: string; command: string; live: boolean }) {
  const [found, setFound] = useState<IssueList | null>(null);
  const [error, setError] = useState('');
  const [dismissing, setDismissing] = useState<string | null>(null);
  useEffect(() => {
    if (!live) return;
    let current = true;
    const load = () => request<IssueList>(`/api/issues?project=${encodeURIComponent(project)}`).then((next) => current && setFound(next), () => {});
    load();
    // The daemon keeps each answer ten minutes, so asking more often only reads its cache. A reconnect reads again, as in the app.
    const timer = setInterval(load, 10 * 60_000);
    return () => { current = false; clearInterval(timer); };
  }, [project, live]);
  // Another project's issues never show under this one while its own are read.
  const shown = found?.project === project ? found.issues.slice(0, SHOWN_ISSUES) : [];
  if (!shown.length) return null;
  const dismiss = async (url: string) => {
    setError('');
    setDismissing(url);
    try {
      await request('/api/issues/dismiss', { url });
      setFound((current) => current && { ...current, issues: current.issues.filter((issue) => issue.url !== url) });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDismissing(null);
    }
  };
  return (
    <Panel label={t('Start from an issue')} className="issue-suggestions" action={<Icon icon={TaskListLtrRegular} />}>
      <ul className="issue-list">
        {shown.map((issue) => (
          <li key={issue.url}>
            <a className="issue-title selectable" href={issue.url} target="_blank" rel="noreferrer" title={issue.title}>
              <span className="digits secondary">#{issue.number}</span> {issue.title}
            </a>
            {issue.labels.length > 0 && <span className="caption secondary issue-labels">{issue.labels.slice(0, 3).join(' · ')}</span>}
            <CopyButton text={`${command} ${issue.url}`} short={t('Copy')} name={t('Copy the command for #{number}', { number: issue.number })}>{t('Copy Command')}</CopyButton>
            <button
              className="icon"
              disabled={!live || dismissing !== null}
              aria-label={t('Dismiss #{number}', { number: issue.number })}
              title={t('Dismiss. This issue is not suggested again.')}
              onClick={() => void dismiss(issue.url)}
            >
              <Icon icon={DismissRegular} />
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="callout error selectable" role="status"><Icon icon={ErrorCircleRegular} size={13} />{error}</p>}
    </Panel>
  );
}

/** Shows the `backticked` names in a setup item as code. */
const withCode = (text: string) => text.split('`').map((part, index) => (index % 2 ? <code key={index}>{part}</code> : part));

const noJobs: BoardJob[] = [];

function useMissionPanels({ jobs, pulls, claude, missions }: Snapshot) {
  const byMission = useMemo(() => {
    const groups = new Map<string, BoardJob[]>();
    for (const job of jobs) {
      if (!job.mission) continue;
      const group = groups.get(job.mission);
      if (group) group.push(job);
      else groups.set(job.mission, [job]);
    }
    return groups;
  }, [jobs]);
  const pullsByMission = useMemo(() => {
    const groups = new Map<string, NonNullable<Snapshot['pulls']>>();
    for (const pull of pulls ?? []) {
      const group = groups.get(pull.mission);
      if (group) group.push(pull);
      else groups.set(pull.mission, [pull]);
    }
    return groups;
  }, [pulls]);
  const sessions = useMemo(() => new Map(claude.map((session) => [session.id, session])), [claude]);
  return (mission: Mission, project = '') => {
    const missionJobs = byMission.get(mission.id) ?? noJobs;
    const owner = mission.owner ? sessions.get(mission.owner) : undefined;
    return {
      jobs: project ? missionJobs.filter((job) => inProject(project, job)) : missionJobs,
      missionJobs,
      owner,
      lead: mission.state === 'active' && owner && leadMission(owner, missions)?.id === mission.id ? owner : undefined,
      pulls: pullsByMission.get(mission.id),
    };
  };
}

/** The overview or a project: what is going on now, with the agents and the crew's rhythm beside it. */
export function Workspace({ state, project, names, selected, openJob, openSession, newJob, openPage }: Scope & {
  newJob: (origin?: Element | null) => void;
  openPage: (selection: string) => void;
}) {
  const jobs = useMemo(() => project ? state.jobs.filter((job) => inProject(project, job)) : state.jobs, [state.jobs, project]);
  const times = useStableItems(useMemo(() => jobs.map((job) => job.createdAt), [jobs]));
  const missionPanel = useMissionPanels(state);
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
      {...missionPanel(mission, project)}
      projectName={project ? undefined : names.get(projectOf(mission))}
      selected={selected}
      openJob={openJob}
      openSession={openSession}
      index={index}
    />
  );
  const row = (job: BoardJob, index: number) => <JobRow key={job.id} job={job} selected={selected === job.id} openJob={openJob} kind={jobKind(job, state)} index={index} />;
  const empty = !jobs.length && !missions.length && !sessions.length;
  const jobIds = useMemo(() => new Set(jobs.map((job) => job.id)), [jobs]);
  const events = useMemo(() => project ? state.events.filter((event) => !event.job_id || jobIds.has(event.job_id)) : state.events, [state.events, project, jobIds]);
  return (
    <>
      <Kpis state={state} project={project} />
      <div className="dash">
        <div className="dash-main">
          {!project && <Setup />}
          {/* Codex names a plugin skill with $, so the command is copied in the form the project's latest lead takes. */}
          {project && <IssueSuggestions project={project} live={state.connection === 'live'} command={sessions.toSorted((a, b) => b.activeAt - a.activeAt)[0]?.host === 'codex' ? '$crew:run' : '/crew:run'} />}
          {active.map(panel)}
          {loose.length > 0 && (
            <Panel label={t('Other jobs')} style={{ '--i': active.length } as CSSProperties} action={<Icon icon={StackRegular} />}>
              <div className="rows">{loose.map(row)}</div>
            </Panel>
          )}
          {recent.map((mission, index) => panel(mission, active.length + 1 + index))}
          {recentJobs.length > 0 && (
            <Panel label={t('Recently finished')} action={<button className="link" onClick={() => openPage('history')}>{t('History')} <Icon icon={ArrowRight16Filled} size={12} /></button>}>
              <div className="rows">{recentJobs.map(row)}</div>
            </Panel>
          )}
          {sessions.length > 0 && (
            <Panel label={t('Lead sessions')} action={<Icon icon={ChatMultipleRegular} />}>
              <div className="rows">
                {sessions.map((session) => (
                  <SessionRow key={session.id} session={session} selected={selected === `session:${session.id}`} openSession={openSession} />
                ))}
              </div>
            </Panel>
          )}
          {empty && (
            <EmptyState title={t('Ready when you are')} icon={LayerRegular} detail={t('Hand a task to an agent, or run /crew:run in Claude Code or $crew:run in Codex.')}>
              <button className="prominent" disabled={state.connection !== 'live'} onClick={(event) => newJob(event.currentTarget)}>
                <Icon icon={AddRegular} />
                {t('New Job')}
              </button>
            </EmptyState>
          )}
        </div>
        <aside className="dash-side" aria-label={t('Agents and activity')}>
          <AgentPanel state={state} project={project} />
          <section className="card panel" aria-label={t('Rhythm')} style={{ '--i': 1 } as CSSProperties}>
            <Heatmap title={t('Rhythm')} times={times} most={26} label={t('jobs')} one={t('job')} />
          </section>
          <Panel label={t('Live feed')} action={<button className="link" onClick={() => openPage('activity')}>{t('All')} <Icon icon={ArrowRight16Filled} size={12} /></button>}>
            {events.length ? <EventList events={events} openJob={openJob} limit={6} /> : <p className="secondary caption">{t('No activity yet.')}</p>}
          </Panel>
        </aside>
      </div>
    </>
  );
}

type SortKey = 'title' | 'agent' | 'project' | 'state' | 'duration' | 'ended';
/** Finished work: ended missions, then every ended job in a table to filter and sort. */
export const History = memo(function History({ state, project, names, selected, openJob, openSession }: Scope) {
  const locale = useLanguage();
  const [filter, setFilter] = useState<'' | 'done' | 'failed' | 'cancelled'>('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; up: boolean }>({ key: 'ended', up: false });
  const { roleInfo } = state;
  const missionPanel = useMissionPanels(state);
  const ended = useStableItems(useMemo(() => state.jobs.filter((job) => inProject(project, job) && job.endedAt != null), [state.jobs, project]));
  const missions = useMemo(() => state.missions
    .filter((mission) => inProject(project, mission) && mission.state !== 'active' && matches(search, mission.title))
    .sort((a, b) => b.createdAt - a.createdAt), [state.missions, project, search]);
  const rows = useMemo(() => {
    const value = (job: BoardJob): string | number =>
      sort.key === 'title' ? job.title.toLowerCase() : sort.key === 'agent' ? NAMES[job.agent] : sort.key === 'project' ? names.get(projectOf(job)) ?? projectOf(job)
        : sort.key === 'state' ? job.state : sort.key === 'duration' ? (job.endedAt ?? 0) - job.createdAt : job.endedAt ?? 0;
    return ended
      .filter((job) => (!filter || job.state === filter) && matches(search, `${job.title} ${projectOf(job)} ${NAMES[job.agent]} ${jobKind(job, { roleInfo })}`))
      .sort((a, b) => {
        const [x, y] = [value(a), value(b)];
        return (x < y ? -1 : x > y ? 1 : 0) * (sort.up ? 1 : -1);
      });
  }, [ended, filter, locale, names, roleInfo, search, sort]);
  const column = (key: SortKey, text: string, className?: string) => (
    <th className={className} aria-sort={sort.key === key ? (sort.up ? 'ascending' : 'descending') : undefined}>
      <button className="sort" onClick={() => setSort({ key, up: sort.key === key ? !sort.up : key === 'title' || key === 'agent' || key === 'project' })}>
        {text}
        {sort.key === key && <Icon icon={sort.up ? ChevronUp16Regular : ChevronDown16Regular} size={12} />}
      </button>
    </th>
  );
  return (
    <>
      <div className="toolbar-row">
        <Pills
          label={t('State')}
          value={filter}
          options={[['', t('All'), ended.length], ['done', t('Done'), ended.filter((job) => job.state === 'done').length], ['failed', t('Failed'), ended.filter((job) => job.state === 'failed').length], ['cancelled', t('Cancelled'), ended.filter((job) => job.state === 'cancelled').length]]}
          onChange={setFilter}
        />
        <label className="filter">
          <Icon icon={SearchRegular} />
          <input type="search" aria-label={t('Filter history')} placeholder={t('Filter by title, agent, project')} value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
      </div>
      {/* The table below keeps the page's width, which its columns need. */}
      {missions.length > 0 && (
        <Columns>
          {missions.map((mission, index) => (
            <MissionPanel
              key={mission.id}
              mission={mission}
              {...missionPanel(mission)}
              projectName={project ? undefined : names.get(projectOf(mission))}
              selected={selected}
              openJob={openJob}
              openSession={openSession}
              index={index}
            />
          ))}
        </Columns>
      )}
      {rows.length > 0 ? (
        <Panel label={t('Jobs')} className="table-panel">
          <div className="table-scroll">
            <table className="jobs-table">
              <thead>
                <tr>
                  {column('title', t('Job'))}
                  {column('agent', t('Agent'), 'narrow-hide')}
                  {!project && column('project', t('Project'), 'narrow-hide')}
                  {column('state', t('Status'))}
                  {column('duration', t('Duration'), 'num')}
                  {column('ended', t('Ended'), 'num narrow-hide')}
                </tr>
              </thead>
              <tbody>
                {rows.map((job, index) => (
                  <HistoryRow key={job.id} job={job} kind={jobKind(job, state)} projectName={project ? undefined : names.get(projectOf(job)) ?? projectOf(job)} selected={selected === job.id} index={Math.min(index, 16)} openJob={openJob} />
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      ) : (
        !missions.length && <EmptyState title={search || filter ? t('No matching work') : t('No completed work yet')} icon={search || filter ? SearchRegular : LayerRegular} />
      )}
    </>
  );
}, (a, b) =>
  a.project === b.project && a.names === b.names && a.selected === b.selected &&
  a.openJob === b.openJob && a.openSession === b.openSession &&
  a.state.jobs === b.state.jobs && a.state.missions === b.state.missions &&
  a.state.roleInfo === b.state.roleInfo && a.state.pulls === b.state.pulls);

const HistoryRow = memo(function HistoryRow({ job, kind, projectName, selected, index, openJob }: {
  job: BoardJob;
  kind: string;
  projectName?: string;
  selected: boolean;
  index: number;
  openJob: Scope['openJob'];
}) {
  useLanguage();
  return (
    <tr data-opens-panel="" aria-current={selected || undefined} style={{ '--i': index } as CSSProperties} onClick={() => openJob(job.id)}>
      <td>
        <button className="cell-title" data-job={job.id} data-opens-panel="" onClick={(event) => { event.stopPropagation(); openJob(job.id); }}>
          <b>{job.title}</b>
          <span>{kind}</span>
        </button>
      </td>
      <td className="narrow-hide"><span className="cell-agent"><AgentMark agent={job.agent} size={14} />{NAMES[job.agent]}</span></td>
      {projectName !== undefined && <td className="narrow-hide cell-muted cell-project"><FadeText text={projectName} /></td>}
      <td><StatusIcon state={jobStatusState(job)} label={jobLabel(job)} /></td>
      <td className="num cell-muted">{elapsed((job.endedAt ?? 0) - job.createdAt)}</td>
      <td className="num cell-muted narrow-hide">{formatDate(shortDateTime, new Date(job.endedAt!))}</td>
    </tr>
  );
});
