import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Ellipsis, Hammer, MessageCircleQuestion, ShieldCheck, SpellCheck, Wrench } from 'lucide-react';
import type { BoardJob, ClaudeSession, Mission } from './types.ts';
import { actions, request } from './api.ts';
import {
  elapsed, jobLabel, missionJobStep, missionLooksFinished, missionProgress, missionStep, missionStopPosition,
  missionStops, NAMES,
} from './model.ts';
import { ActionStatus, AgentMark, Chip, Icon, Menu, useAction, useNow } from './ui.tsx';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const jobStatusState = (job: BoardJob) => (job.stalled ? 'stalled' : job.state);

export function JobRow({ job, selected, openJob }: { job: BoardJob; selected?: boolean; openJob: (id: string) => void }) {
  const now = useNow();
  const active = job.endedAt == null;
  const detail = [
    NAMES[job.agent],
    job.ask ? 'Question' : null,
    job.error?.message ?? (active ? job.phase : null),
    job.runsApp ? 'Runs the app' : null,
    job.exclusive ? 'Runs alone' : null,
  ].filter(Boolean).join(' · ');
  const kind = job.ask ? MessageCircleQuestion : job.kind === 'review' ? ShieldCheck : job.kind === 'polish' ? SpellCheck : Hammer;
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

export function SessionView({ session }: { session: ClaudeSession }) {
  return (
    <details className="session">
      <summary>
        <AgentMark agent="claude" size={14} />
        <span>{session.title}</span>
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
  const key = `dismiss:${mission.id}`;
  const action = useAction(key);
  const stops = missionStops(mission);
  const at = missionStep(mission);
  const tokens = jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  const meta = [
    elapsed((mission.endedAt ?? now) - mission.createdAt),
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
    projectName,
    `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`,
  ].filter(Boolean).join(' · ');
  const progress = missionProgress(mission, jobs);
  const locked = action.pending || action.accepted;
  const update = (body: object, done: string) => void actions.run(key, () => request(`/api/missions/${mission.id}`, body), { done });
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
          {mission.state === 'active' && (
            <Menu label="Mission options" icon={Ellipsis}>
              <button role="menuitem" disabled={locked} onClick={() => update({ done: true, outcome: 'Marked done on the board.' }, 'Marked done')}>
                <Icon icon={CircleCheck} />
                Mark done
              </button>
              <button
                role="menuitem"
                disabled={locked}
                title="Stops tracking without marking done. Its jobs keep running."
                onClick={() => update({ abandoned: true, outcome: 'Dismissed on the board.' }, 'Dismissed')}
              >
                <Icon icon={CircleX} />
                Stop tracking
              </button>
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
