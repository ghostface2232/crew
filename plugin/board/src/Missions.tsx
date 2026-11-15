import { useState, useSyncExternalStore } from 'react';
import { board } from './store.ts';
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Ellipsis, Gauge, Hammer, MessageCircleQuestion, MessagesSquare, ShieldCheck, SpellCheck, Wrench } from 'lucide-react';
import type { BoardJob, ClaudeSession, Mission, PresetName } from './types.ts';
import { actions, request } from './api.ts';
import {
  elapsed, jobLabel, jobRole, missionJobStep, missionLooksFinished, missionProgress, missionStep, missionStopPosition,
  missionStops, NAMES, roleLabel,
} from './model.ts';
import { ActionStatus, AgentMark, Chip, Icon, Menu, useAction, useNow } from './ui.tsx';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const jobStatusState = (job: BoardJob) => (job.stalled ? 'stalled' : job.state);

export function JobRow({ job, selected, openJob }: { job: BoardJob; selected?: boolean; openJob: (id: string) => void }) {
  const now = useNow();
  const active = job.endedAt == null;
  const role = jobRole(job);
  const detail = [
    NAMES[job.agent],
    // The three original roles show as the row's icon; the others are named.
    job.ask && !job.debate ? 'Question' : ['delegate', 'review', 'polish'].includes(role) ? null : roleLabel(board.getSnapshot(), role),
    job.error?.message ?? (active ? job.phase : null),
    job.runsApp ? 'Runs the app' : null,
    job.exclusive ? 'Runs alone' : null,
  ].filter(Boolean).join(' · ');
  const kind = job.debate ? MessagesSquare : job.ask ? MessageCircleQuestion : job.kind === 'review' ? ShieldCheck : job.kind === 'polish' ? SpellCheck : Hammer;
  return (
    <button
      className="job-row"
      data-job={job.id}
      data-state={jobStatusState(job)}
      data-waiting={job.state === 'waiting' ? '' : undefined}
      aria-current={selected || undefined}
      onClick={() => openJob(job.id)}
    >
      <Icon icon={kind} />
      <span className="job-row-text">
        <b>{job.title}</b>
        <span data-error={job.error ? '' : undefined}>{detail}</span>
      </span>
      <Chip state={jobStatusState(job)}>{jobLabel(job)}</Chip>
      <span className="job-row-time">{elapsed((job.endedAt ?? now) - job.createdAt)}</span>
      <Icon icon={ChevronRight} />
    </button>
  );
}

type SessionAgent = ClaudeSession['agents'][number];

function SessionAgents({ agents, now, label }: { agents: SessionAgent[]; now: number; label: string }) {
  return <ul className="session-agents" aria-label={label}>
    {agents.map((agent) => <li key={agent.id}>
      <span>
        <span title={agent.title} tabIndex={0}>{agent.title}</span>
        <span className="caption secondary" title={agent.phase} tabIndex={0}>{agent.phase}</span>
      </span>
      <span className="caption secondary">{elapsed(now - agent.startedAt)}</span>
    </li>)}
  </ul>;
}

function SessionWorkflow({ run, agents, now }: { run: ClaudeSession['workflows'][number]; agents: SessionAgent[]; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? agents : agents.slice(0, 5);
  const groups = new Map<string, SessionAgent[]>();
  for (const agent of visible) {
    const stage = agent.stage || 'Other agents';
    const group = groups.get(stage) ?? [];
    group.push(agent);
    groups.set(stage, group);
  }
  return <section className="session-workflow" aria-label={run.name}>
    <div className="session-workflow-head">
      <b title={run.name} tabIndex={0}>{run.name}</b>
      <span className="caption secondary">{elapsed(now - run.startedAt)}</span>
    </div>
    <p className="caption secondary">{agents.length} running · {run.done} done</p>
    {agents.length === 0 && <p className="caption secondary">Between phases or finished</p>}
    {[...groups].map(([stage, group]) => <div className="session-stage" key={stage}>
      <p className="caption secondary" title={stage}>{stage}</p>
      <SessionAgents agents={group} now={now} label={`${run.name}: ${stage}`} />
    </div>)}
    {agents.length > 5 && <button className="small" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? 'Show fewer agents' : `Show all ${agents.length} agents`}
    </button>}
  </section>;
}

export function SessionView({ session }: { session: ClaudeSession }) {
  const now = useNow();
  const plain = session.agents.filter((agent) => !agent.workflow);
  const running = session.agents.length - plain.length;
  return (
    <details className="session">
      <summary>
        <AgentMark agent="claude" size={14} />
        <span>{session.title}</span>
        {(plain.length > 0 || session.workflows.length > 0) && <small className="session-count secondary">
          {[plain.length > 0 ? `${plain.length} sub-agent${plain.length === 1 ? '' : 's'}` : '',
            session.workflows.length > 0 ? `${running} workflow running` : ''].filter(Boolean).join(' · ')}
        </small>}
        <Chip state={session.stalled ? 'stalled' : session.state}>
          {session.stalled ? 'May be stuck' : capitalized(session.state)}
        </Chip>
      </summary>
      <div className="session-body selectable">
        <p>{session.waitingFor ?? session.phase}</p>
        <p className="caption secondary">{session.cwd}</p>
        {session.state === 'waiting' && <p className="secondary">Answer in Claude.</p>}
        {session.inTool && (
          <p className="caption">
            <Icon icon={Wrench} size={11} /> A tool is running
          </p>
        )}
        {plain.length > 0 && <SessionAgents agents={plain} now={now} label="Sub-agents" />}
        {session.workflows.map((run) => <SessionWorkflow key={run.id} run={run}
          agents={session.agents.filter((agent) => agent.workflow === run.id)} now={now} />)}
      </div>
    </details>
  );
}

export function MissionTrack({ mission }: { mission: Mission }) {
  const stops = missionStops(mission);
  const at = missionStep(mission);
  return (
    <ol
      className="track"
      // One element for assistive technology, as the app's track is.
      role="img"
      aria-label={
        mission.state === 'done'
          ? `Done, all ${stops.length} steps passed`
          : `Step ${at + 1} of ${stops.length}, ${stops[at]?.name}`
      }
    >
      {stops.map(({ name }, index) => {
        const pos = missionStopPosition(mission, index);
        return (
          <li key={index} data-pos={pos} data-current={index === at ? '' : undefined} aria-hidden="true">
            <span className="track-node">
              <b>{pos === 'past' ? <Icon icon={Check} /> : index + 1}</b>
              {index < stops.length - 1 && <i />}
            </span>
            <span className="track-name">{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function MissionPanel({
  mission,
  jobs,
  allJobs,
  lead,
  projectName,
  selectedJob,
  openJob,
}: {
  mission: Mission;
  jobs: BoardJob[];
  allJobs: BoardJob[];
  lead?: ClaudeSession;
  projectName?: string;
  selectedJob: string;
  openJob: (id: string) => void;
}) {
  const now = useNow();
  const [expanded, setExpanded] = useState(mission.state === 'active');
  // Keyed by state as in the app: once a mission is abandoned, Mark done takes a fresh lock.
  const key = `mission:${mission.id}:${mission.state}`;
  const action = useAction(key);
  const stops = missionStops(mission);
  const at = missionStep(mission);
  const tokens = jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  const meta = [
    elapsed((mission.endedAt ?? now) - mission.createdAt),
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
    projectName,
    `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`,
    mission.preset ? `${capitalized(mission.preset)} preset` : null,
  ].filter(Boolean).join(' · ');
  const progress = missionProgress(mission, jobs);
  const live = useSyncExternalStore(board.subscribe, () => board.getSnapshot().connection === 'live');
  const locked = action.pending || action.accepted || !live;
  // Done and Stop tracking change the state, and with it the key; a preset leaves both, so its action must not lock the menu.
  const update = (body: object, done: string, once = true) => void actions.run(key, () => request(`/api/missions/${mission.id}`, body), { done, once });
  // A daemon without the role registry ignores a mission's preset.
  const presets = Boolean(board.getSnapshot().roleInfo);
  return (
    <section className="card mission" data-key={mission.id} data-state={mission.state}>
      <div className="mission-head">
        <div>
          <h2 className="title selectable">{mission.title}</h2>
          <p className="mission-meta" title={mission.root}>{meta}</p>
        </div>
        <span className="caption secondary digits mission-progress" title="Mission progress">
          {Math.round(progress * 100)}%
        </span>
        <Chip state={mission.state === 'active' ? 'running' : mission.state}>{capitalized(mission.state)}</Chip>
        {missionLooksFinished(mission, allJobs, now, lead) && <span className="caption secondary">Looks finished</span>}
        <span className="mission-controls">
          <button
            className="icon"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse mission' : 'Expand mission'}
            title={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon icon={ChevronDown} className="disclosure" />
          </button>
          {(mission.state === 'active' || mission.state === 'abandoned') && (
            <Menu label="Mission options" icon={Ellipsis}>
              <button
                role="menuitem"
                disabled={locked}
                // The daemon reopens an abandoned mission only when asked to explicitly.
                onClick={() => update({ done: true, ...(mission.state === 'abandoned' ? { reopen: true } : {}), outcome: 'Marked done on the board.' }, 'Marked done')}
              >
                <Icon icon={CircleCheck} />
                Mark done
              </button>
              {mission.state === 'active' && (
                <button
                  role="menuitem"
                  disabled={locked}
                  title="Stops tracking without marking done. Its jobs keep running."
                  onClick={() => update({ abandoned: true, outcome: 'Dismissed on the board.' }, 'Dismissed')}
                >
                  <Icon icon={CircleX} />
                  Stop tracking
                </button>
              )}
              {mission.state === 'active' && presets && (
                <>
                  <hr />
                  {([['economy', 'Economy'], ['balanced', 'Balanced'], ['best', 'Best'], [null, 'Global preset']] as [PresetName | null, string][]).map(([preset, name]) => (
                    <button
                      key={name}
                      role="menuitemradio"
                      aria-checked={(mission.preset ?? null) === preset}
                      disabled={locked}
                      title="Applies to the mission's next jobs. Jobs already started keep theirs."
                      onClick={() => update({ preset }, preset ? `${name} preset for new jobs` : 'Global preset for new jobs', false)}
                    >
                      <Icon icon={(mission.preset ?? null) === preset ? Check : Gauge} />
                      {preset ? `${name} preset` : name}
                    </button>
                  ))}
                </>
              )}
            </Menu>
          )}
        </span>
      </div>
      {expanded && (
        <>
          {mission.notes?.map((note, index) => (
            <p className="mission-note selectable" key={`${note.at}:${index}`}>{note.text}</p>
          ))}
          <MissionTrack mission={mission} />
          <div className="stage-groups">
            {stops.map(({ name }, index) => {
              const mine = jobs.filter((job) => missionJobStep(mission, job) === index);
              const stageLead = mission.state === 'active' && index === at ? lead : undefined;
              if (!mine.length && !stageLead) return null;
              return (
                <div className="rows" key={index}>
                  <h3 className="stage-name">{name}</h3>
                  {stageLead && (
                    <div className="session-row">
                      <SessionView session={stageLead} />
                    </div>
                  )}
                  {mine.map((job) => (
                    <JobRow key={job.id} job={job} selected={selectedJob === job.id} openJob={openJob} />
                  ))}
                </div>
              );
            })}
          </div>
          {mission.outcome && <p className="mission-outcome selectable">{mission.outcome}</p>}
        </>
      )}
      <ActionStatus actionKey={key} />
    </section>
  );
}
