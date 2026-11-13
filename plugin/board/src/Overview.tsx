import type { CSSProperties } from 'react';
import type { ProviderUsage, UsageWindow } from '../../bridge/usage.ts';
import type { CrewEvent, Snapshot } from './types.ts';
import type { Mark } from './model.ts';
import {
  compact, jobLabel, jobMark, NAMES, projectOf, relativeDuration, ROLE_NAMES,
  sessionMark, together, URGENCY, usageWindowName,
} from './model.ts';
import { Chip, MarkIcon, useNow } from './ui.tsx';

const stats: [Mark, string][] = [
  ['done', 'Finished'],
  ['working', 'In progress'],
  ['waiting', 'Needs you'],
  ['stalled', 'Gone quiet'],
  ['failed', 'Failed'],
];
function UsageGauge({ window, reason }: { window: UsageWindow; reason: string }) {
  const now = useNow();
  const percent = Math.round(Math.max(0, Math.min(1, window.usedRatio)) * 100);
  const name = [window.group, usageWindowName(window.kind)].filter(Boolean).join(' · ');
  return (
    <div className="usage-window" data-status={window.status} title={reason}>
      <span>
        {name} · {percent}% used{window.status !== 'ok' && ` · ${window.status}`}
      </span>
      <progress aria-label={name} max={100} value={percent} />
      <span>
        {window.resetTime == null
          ? 'Reset time unknown'
          : window.resetTime <= now
            ? 'Reset due'
            : `Resets in ${relativeDuration(window.resetTime - now)}`}
        {window.projectedExhaustion != null &&
          ` · runs out in about ${relativeDuration(window.projectedExhaustion - now)}`}
      </span>
    </div>
  );
}
function UsageGauges({ provider }: { provider: ProviderUsage }) {
  const scoped = provider.windows.filter((window) => window.group != null);
  return (
    <div className="usage-windows" aria-label={`${NAMES[provider.agent]} usage`}>
      {provider.windows
        .filter((window) => window.group == null)
        .map((window) => <UsageGauge key={window.key} window={window} reason={provider.reason} />)}
      {!provider.windows.length && (
        <p className="hint" title={provider.reason}>{provider.status}</p>
      )}
      {scoped.length > 0 && (
        <details>
          <summary>Model limits ({scoped.length})</summary>
          {scoped.map((window) => (
            <UsageGauge key={window.key} window={window} reason={provider.reason} />
          ))}
        </details>
      )}
    </div>
  );
}
export function Overview({
  state,
  project,
  openJob,
}: {
  state: Snapshot;
  project: string;
  openJob: (id: string) => void;
}) {
  const visible = (item: Parameters<typeof projectOf>[0]) => !project || projectOf(item) === project;
  const missions = state.missions.filter((mission) => mission.state === 'active' && visible(mission));
  const jobs = state.jobs.filter(
    (job) => visible(job) && (!job.endedAt || missions.some((mission) => mission.id === job.mission)),
  );
  const sessions = state.claude.filter(visible);
  const marks = [...jobs.map(jobMark), ...sessions.filter((session) => session.state === 'waiting').map(sessionMark)];
  const counts = Object.fromEntries(stats.map(([mark]) => [mark, marks.filter((value) => value === mark).length]));
  const headline = counts.waiting
    ? counts.waiting === 1
      ? 'One thing needs your answer'
      : `${counts.waiting} things need your answer`
    : missions.length
      ? `Working on ${missions.length} task${missions.length === 1 ? '' : 's'}`
      : counts.working + counts.stalled
        ? `${counts.working + counts.stalled} jobs running`
        : 'All quiet';
  const lede = counts.waiting
    ? 'Those jobs are paused until you reply.'
    : counts.failed
      ? 'A job stopped on an error. Open it to see what went wrong.'
      : counts.stalled
        ? 'A job has gone quiet. Open it to check.'
        : missions.length || counts.working
          ? 'Nothing needs you right now. You can leave this open and check back.'
          : 'Start a task in Claude, or send work directly from this board.';
  return (
    <section className="hero" aria-label="Overview">
      <div className="summary">
        <p className="eyebrow">
          {missions.length} tasks · {jobs.length} jobs ·{' '}
          {compact(jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0))} tokens used
        </p>
        <h2>{state.connection === 'connecting' ? 'Connecting to your crew' : headline}</h2>
        <p className="lede">{lede}</p>
      </div>
      <div className="stats" role="group" aria-label="Jobs by state">
        <ul className="stats-legend">
          {stats.map(([mark, label]) => (
            <li className="stat" key={mark} data-state={mark} data-none={!counts[mark] ? '' : undefined}>
              <span className="stat-label">
                <MarkIcon state={mark} />
                {label}
              </span>
              <b>{counts[mark]}</b>
            </li>
          ))}
        </ul>
        <div className="stats-bar" aria-hidden="true">
          {stats.map(([mark]) => (
            <i
              key={mark}
              data-state={mark}
              data-zero={!counts[mark] ? '' : undefined}
              style={{ flexGrow: counts[mark] }}
            />
          ))}
        </div>
      </div>
      <ul className="tiles" aria-label="Agents">
        {(['claude', ...Object.keys(state.agents)] as (keyof typeof NAMES)[]).map((agent) => {
          const work =
            agent === 'claude'
              ? sessions
                  .filter((session) => session.state !== 'idle')
                  .map((session) => ({
                    id: session.id,
                    title: session.title,
                    now: session.waitingFor ?? session.phase,
                    mark: sessionMark(session),
                    job: false,
                  }))
              : state.jobs
                  .filter((job) => visible(job) && job.agent === agent && !job.endedAt)
                  .map((job) => ({
                    id: job.id,
                    title: job.title,
                    now: job.state === 'waiting' ? jobLabel(job) : job.phase,
                    mark: jobMark(job),
                    job: true,
                  }));
          work.sort((a, b) => URGENCY.indexOf(a.mark) - URGENCY.indexOf(b.mark));
          const mood = together(work.map((item) => item.mark)) || 'idle';
          const roles = Object.entries(ROLE_NAMES)
            .filter(([role]) => state.roles[role as keyof typeof ROLE_NAMES]?.agent === agent)
            .map(([, label]) => label)
            .join(' · ');
          const windows = agent === 'codex' ? (state.limits.codex?.windows ?? []) : [];
          const used = Math.max(0, ...windows.map((window) => Math.round(window.usedPercent)));
          const usage = state.usage?.source === 'agentgauge'
            ? state.usage.providers.find((provider) => provider.agent === agent)
            : undefined;
          return (
            <li className="tile" key={agent}>
              <div className="tile-head">
                <span className="agent-well" aria-hidden="true">
                  {NAMES[agent][0]}
                </span>
                <div className="tile-id">
                  <p className="tile-label">{agent === 'claude' ? 'Lead' : roles || 'No role'}</p>
                  <p className="tile-value">{NAMES[agent]}</p>
                </div>
                <Chip state={mood}>
                  {mood === 'working'
                    ? work.length > 1
                      ? `${work.length} working`
                      : 'Working'
                    : mood === 'waiting'
                      ? 'Needs you'
                      : mood === 'stalled'
                        ? 'May be stuck'
                        : mood === 'failed'
                          ? 'Failed'
                          : 'Idle'}
                </Chip>
              </div>
              <div className="tile-body">
                {work.length ? (
                  <>
                    <ul className="tile-work">
                      {work.slice(0, 3).map((item) => (
                        <li key={item.id}>
                          {item.job ? (
                            <button className="work" data-state={item.mark} onClick={() => openJob(item.id)}>
                              <MarkIcon state={item.mark} />
                              <span className="what">{item.title}</span>
                              <span className="sub">{item.now}</span>
                            </button>
                          ) : (
                            <div className="work" data-state={item.mark}>
                              <MarkIcon state={item.mark} />
                              <span className="what">{item.title}</span>
                              <span className="sub">{item.now}</span>
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                    {work.length > 3 && <p className="more">{work.length - 3} more in progress</p>}
                  </>
                ) : (
                  <p className="tile-hint">
                    {agent === 'claude'
                      ? 'Plans the work, checks it, and puts it together'
                      : state.agents[agent]?.enabled
                        ? 'Ready for the next job'
                        : 'Disabled in configuration'}
                  </p>
                )}
              </div>
              {usage && <UsageGauges provider={usage} />}
              {(!state.usage || state.usage.source === 'none') && windows.length > 0 && (
                <p
                  className="usage"
                  title={windows
                    .map(
                      (window) =>
                        `${Math.round(window.usedPercent)}% of the ${window.minutes >= 1440 ? `${Math.round(window.minutes / 1440)}-day` : `${Math.round(window.minutes / 60)}-hour`} limit`,
                    )
                    .join(', ')}
                >
                  <span
                    className="meter"
                    data-high={used >= 90 ? '' : undefined}
                    style={{ '--used': Math.min(100, used) } as CSSProperties}
                  >
                    <i />
                  </span>
                  <span className="pct">{used}% of limit used</span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
export function EventList({
  events,
  state,
  openJob,
}: {
  events: CrewEvent[];
  state: Snapshot;
  openJob?: (id: string) => void;
}) {
  const tones: Record<string, string> = {
    waiting: 'waiting',
    stalled: 'waiting',
    error: 'failed',
    limit: 'failed',
    done: 'done',
  };
  return (
    <ol className="feed-list">
      {events
        .slice()
        .reverse()
        .map((event) => {
          const job = state.jobs.find((job) => job.id === event.job_id);
          return (
            <li key={event.seq}>
              <time dateTime={event.ts}>
                {new Date(event.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}
              </time>
              <span className="who">
                {NAMES[event.agent]}
                {job && openJob && (
                  <button className="tag" onClick={() => openJob(job.id)}>
                    {job.title}
                  </button>
                )}
              </span>
              <span className="what" data-tone={tones[event.kind]} title={event.detail}>
                {event.detail}
              </span>
            </li>
          );
        })}
    </ol>
  );
}
export function Activity({
  state,
  project,
  openJob,
}: {
  state: Snapshot;
  project: string;
  openJob: (id: string) => void;
}) {
  const now = useNow();
  const events = state.events.filter((event) => {
    const owner =
      state.jobs.find((job) => job.id === event.job_id) ??
      state.claude.find((session) => session.id === event.session_id);
    return !project || !owner || projectOf(owner) === project;
  });
  const bins = Array.from(
    { length: 12 },
    (_, index) =>
      events.filter((event) => {
        const ago = now - Date.parse(event.ts);
        return ago >= (11 - index) * 300_000 && ago < (12 - index) * 300_000;
      }).length,
  );
  const max = Math.max(1, ...bins);
  return (
    <section className="feed" aria-labelledby="feed-title">
      <div className="feed-head">
        <h2 id="feed-title">Activity</h2>
        <p className="pulse-read">{bins.reduce((sum, n) => sum + n, 0)} in the last hour</p>
        <div className="pulse" aria-hidden="true">
          {bins.map((n, index) => (
            <i key={index} data-empty={!n ? '' : undefined} style={{ '--h': n / max } as CSSProperties} />
          ))}
        </div>
      </div>
      <EventList events={events.slice(-60)} state={state} openJob={openJob} />
      {!events.length && <p className="empty">Nothing has happened yet.</p>}
    </section>
  );
}
