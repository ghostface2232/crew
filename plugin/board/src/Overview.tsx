import { ArrowUpRight, BellDot, CircleAlert, CircleCheck, CircleDot, CircleDotDashed, Layers, MessagesSquare, Plus, Search, SquareStack } from 'lucide-react';
import type { ProviderUsage } from '../../bridge/usage.ts';
import type { BoardJob, ClaudeSession, CrewEvent, Mission, Snapshot, WorkerAgent } from './types.ts';
import { NAMES, projectOf, relativeDuration, ROLE_NAMES, usageWindowName, unsettled } from './model.ts';
import { AgentMark, Chip, ContentPanel, EmptyState, Icon, useNow } from './ui.tsx';
import { JobRow, MissionPanel, SessionView } from './Missions.tsx';

export interface Scope {
  state: Snapshot;
  project: string;
  search: string;
  names: Map<string, string>;
  selectedJob: string;
  openJob: (id: string) => void;
}
export const matches = (search: string, text: string) => !search || text.toLowerCase().includes(search.toLowerCase());
const inProject = (project: string, item: Parameters<typeof projectOf>[0]) => !project || projectOf(item) === project;

/** WorkspaceSummary: four counts and their shares as one bar. */
export function Summary({ state, project }: { state: Snapshot; project: string }) {
  const jobs = state.jobs.filter((job) => inProject(project, job));
  const metrics = [
    // Lead sessions count like jobs, as they already do under Needs you.
    [
      'In progress',
      jobs.filter((job) => job.state === 'running').length +
        state.claude.filter((session) => session.state === 'working' && inProject(project, session)).length,
      CircleDotDashed,
      'working',
    ],
    [
      'Needs you',
      jobs.filter((job) => job.state === 'waiting').length +
        state.claude.filter((session) => session.state === 'waiting' && inProject(project, session)).length,
      BellDot,
      'waiting',
    ],
    // Settled jobs stay in the list but leave the totals, which would otherwise only grow.
    ['Finished', jobs.filter((job) => job.state === 'done' && unsettled(job)).length, CircleCheck, 'idle'],
    ['Failed', jobs.filter((job) => job.state === 'failed' && unsettled(job)).length, CircleAlert, 'failed'],
  ] as const;
  const total = Math.max(1, metrics.reduce((sum, metric) => sum + metric[1], 0));
  return (
    <section className="card summary" aria-label="Jobs by state">
      <ul className="metrics">
        {metrics.map(([label, count, icon, state]) => (
          <li className="metric" key={label} data-state={state} data-zero={count === 0 ? '' : undefined}>
            <span>
              <Icon icon={icon} />
              {label}
            </span>
            <b>{count.toLocaleString()}</b>
          </li>
        ))}
      </ul>
      <div className="summary-bar" aria-hidden="true">
        {metrics.map(([label, count, , state]) =>
          count > 0 ? <i key={label} data-state={state} style={{ flexGrow: count / total }} /> : null,
        )}
      </div>
    </section>
  );
}

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
            <div className="usage-window" data-status={status} key={window.key}>
              <p className="usage-line">
                <span>{usageWindowName(window.kind)}</span>
                <span>{Math.round(window.usedRatio * 100)}%</span>
                {(status === 'stale' || status === 'unknown' || (status === 'exhausted' && window.status !== 'exhausted')) && (
                  <span>{status === 'exhausted' ? 'limit reached' : status}</span>
                )}
                {window.resetTime != null && (
                  <span className="usage-reset">{window.resetTime <= now ? 'Reset due' : `Resets in ${relativeDuration(window.resetTime - now)}`}</span>
                )}
              </p>
              <span className="usage-bar" aria-hidden="true">
                <i style={{ width: `${ratio * 100}%` }} />
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
      data-high={used >= 90 ? '' : undefined}
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
  const sessions = state.claude.filter((session) => session.state !== 'idle' && inProject(project, session));
  const items: { state: string; stalled: boolean }[] = agent === 'claude' ? sessions : jobs;
  const mark = items.some((item) => item.state === 'waiting')
    ? 'waiting'
    : items.some((item) => item.stalled)
      ? 'stalled'
      : items.length
        ? 'working'
        : 'idle';
  const title =
    mark === 'waiting'
      ? 'Needs you'
      : mark === 'stalled'
        ? 'May be stuck'
        : mark === 'working'
          ? 'Working'
          : state.agents[agent as WorkerAgent]?.enabled === false
            ? 'Disabled'
            : 'Ready';
  return { count: items.length, mark, title };
}

export function AgentOverview({ state, project }: { state: Snapshot; project: string }) {
  const agents = ['claude', ...(['codex', 'antigravity'] as const).filter((agent) => state.agents[agent])];
  const measured = state.usage != null && state.usage.source !== 'none';
  return (
    <section className="agents" aria-labelledby="agents-title">
      <h2 className="section-title" id="agents-title">Agents</h2>
      <ul className="agent-cards">
        {agents.map((agent) => {
          const { count, mark, title } = agentActivity(state, project, agent);
          const noun = agent === 'claude' ? 'session' : 'job';
          const role =
            agent === 'claude'
              ? 'Lead'
              : (Object.keys(ROLE_NAMES) as (keyof typeof ROLE_NAMES)[])
                  .filter((key) => state.roles[key]?.agent === agent)
                  .map((key) => ROLE_NAMES[key])
                  .join(' · ');
          return (
            <li className="card agent-card" key={agent} data-agent={agent}>
              <div className="agent-card-head">
                <AgentMark agent={agent} size={22} />
                <div>
                  <h3 className="card-title">{NAMES[agent as keyof typeof NAMES]}</h3>
                  <p className="caption" title={role}>{role}</p>
                </div>
                <Chip state={mark}>{title}</Chip>
              </div>
              <div className="agent-card-row">
                <span>{count === 0 ? `No active ${noun}s` : `${count} active ${noun}${count === 1 ? '' : 's'}`}</span>
                {!measured && <AgentUsage state={state} agent={agent} />}
              </div>
              {measured && <AgentUsage state={state} agent={agent} />}
            </li>
          );
        })}
      </ul>
      <ul className="card agent-list">
        {agents.map((agent) => {
          const { count, mark, title } = agentActivity(state, project, agent);
          return (
            <li key={agent}>
              <div className="agent-list-head">
                <AgentMark agent={agent} size={18} />
                <span>{NAMES[agent as keyof typeof NAMES]}</span>
                {count > 0 && <span className="caption secondary">{count} active</span>}
                <Chip state={mark}>{title}</Chip>
              </div>
              {measured && <AgentUsage state={state} agent={agent} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Without openJob, as in a job's own details, events carry no link to the job. */
export function EventList({ events, openJob }: { events: CrewEvent[]; openJob?: (id: string) => void }) {
  return (
    <ol className="events">
      {events
        .slice()
        .reverse()
        .map((event) => (
          <li className="event" key={event.seq} data-kind={event.kind}>
            <Icon icon={event.kind === 'error' ? CircleAlert : event.kind === 'done' ? CircleCheck : CircleDot} />
            <div>
              <p className="event-head">
                <b>{NAMES[event.agent as keyof typeof NAMES] ?? event.agent}</b>
                <time dateTime={event.ts}>{new Date(event.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
                {event.job_id && openJob && (
                  <button className="icon" aria-label="Show job" title="Show job" onClick={() => openJob(event.job_id!)}>
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

export function Activity({ state, search, openJob }: Pick<Scope, 'state' | 'search' | 'openJob'>) {
  // The page heading already names this list.
  const events = state.events.filter((event) => matches(search, `${event.detail} ${event.agent}`));
  return (
    <ContentPanel>
      {!events.length && <p className="secondary">No activity yet.</p>}
      <EventList events={events} openJob={openJob} />
    </ContentPanel>
  );
}

/** The overview, a project, or the history: missions and jobs in the order the app lists them. */
export function Workspace({ state, project, search, names, selectedJob, openJob, history, newJob }: Scope & { history: boolean; newJob: () => void }) {
  const inScope = state.jobs.filter((job) => inProject(project, job));
  const jobs = search ? inScope.filter((job) => matches(search, `${job.title} ${job.phase} ${projectOf(job)} ${job.agent}`)) : inScope;
  const byMission = (list: BoardJob[]) => {
    const map = new Map<string, BoardJob[]>();
    for (const job of list) if (job.mission) map.set(job.mission, [...(map.get(job.mission) ?? []), job]);
    return map;
  };
  const matched = byMission(jobs);
  const all = search ? byMission(inScope) : matched;
  const missions = state.missions
    .filter((mission) => inProject(project, mission) && (matches(search, mission.title) || matched.has(mission.id)))
    .sort((a, b) => b.createdAt - a.createdAt);
  // A mission found by its title shows all of its jobs; one found through its jobs shows only the matches.
  const missionJobs = (mission: Mission) => ((!search || !matches(search, mission.title) ? matched : all).get(mission.id) ?? []);
  const shown = missions.filter((mission) => (history ? mission.state !== 'active' : mission.state === 'active'));
  const recent = history ? [] : missions.filter((mission) => mission.state !== 'active').slice(0, 2);
  const panel = (mission: Mission) => (
    <MissionPanel
      key={mission.id}
      mission={mission}
      jobs={missionJobs(mission)}
      allJobs={state.jobs}
      lead={state.claude.find((session) => session.id === mission.owner)}
      projectName={project ? undefined : names.get(projectOf(mission))}
      selectedJob={selectedJob}
      openJob={openJob}
    />
  );
  // Jobs of a recent mission already appear inside its panel.
  const panelIds = new Set([...shown, ...recent].map((mission) => mission.id));
  const loose = jobs
    .filter((job) => !panelIds.has(job.mission ?? '') && (history ? job.endedAt != null : job.endedAt == null))
    .sort((a, b) => b.createdAt - a.createdAt);
  const recentJobs = jobs
    .filter((job) => job.endedAt != null && !job.mission)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, 4);
  const sessions = state.claude.filter((session) => inProject(project, session) && matches(search, session.title));
  const row = (job: BoardJob) => <JobRow key={job.id} job={job} selected={selectedJob === job.id} openJob={openJob} />;
  const emptyHistory = history && !shown.length && !loose.length;
  const emptyWorkspace = !history && !jobs.length && !missions.length && !sessions.length;
  return (
    <>
      {!history && !search && <AgentOverview state={state} project={project} />}
      {shown.map(panel)}
      {loose.length > 0 && (
        <ContentPanel title={history ? 'Completed jobs' : 'Other jobs'} icon={SquareStack}>
          <div className="rows">{loose.map(row)}</div>
        </ContentPanel>
      )}
      {!history && (
        <>
          {recent.map(panel)}
          {recentJobs.length > 0 && (
            <ContentPanel title="Recently finished" icon={CircleCheck}>
              <div className="rows">{recentJobs.map(row)}</div>
            </ContentPanel>
          )}
          {sessions.length > 0 && (
            <ContentPanel title="Claude sessions" icon={MessagesSquare}>
              {sessions.map((session: ClaudeSession) => (
                <SessionView key={session.id} session={session} />
              ))}
            </ContentPanel>
          )}
        </>
      )}
      {(emptyHistory || emptyWorkspace) && (
        <EmptyState
          title={search ? 'No matching work' : emptyHistory ? 'No completed work yet' : 'Ready when you are'}
          icon={search ? Search : Layers}
          detail={!search && !emptyHistory ? 'Start with New Job, or /crew:run in Claude.' : undefined}
        >
          {!search && !emptyHistory && (
            <button className="prominent" disabled={state.connection !== 'live'} onClick={newJob}>
              <Icon icon={Plus} />
              New Job
            </button>
          )}
        </EmptyState>
      )}
    </>
  );
}
