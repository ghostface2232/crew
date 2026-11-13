import { useState } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import type { BoardJob, ClaudeSession, Mission, Snapshot } from './types.ts';
import { actions, request } from './api.ts';
import {
  brief,
  cardsForProject,
  compact,
  jobLabel,
  jobMark,
  missionProgress,
  NAMES,
  projectOf,
  sessionMark,
  shortPath,
  STOPS,
  STOP_NOTES,
  STOP_OF_KIND,
  STOP_OF_STAGE,
  timeLabel,
  together,
} from './model.ts';
import { ActionStatus, Chip, Icon, MarkIcon, useAction, useNow } from './ui.tsx';

export function JobRow({ job, openJob }: { job: BoardJob; openJob: (id: string) => void }) {
  const now = useNow();
  const phase =
    job.state === 'waiting'
      ? jobLabel(job)
      : job.stalled
        ? `May be stuck · ${job.phase}`
        : job.state === 'running'
          ? job.phase
          : job.state === 'failed'
            ? job.error?.message
            : '';
  return (
    <li>
      <button
        className="item"
        data-state={jobMark(job)}
        data-job={job.id}
        onClick={() => openJob(job.id)}
        title={jobLabel(job)}
      >
        <MarkIcon state={jobMark(job)} />
        <span className="what">
          <span className="title">{job.title}</span>
        </span>
        {phase && (
          <span className="now" title={phase}>
            {phase}
          </span>
        )}
        <span className="sub">{timeLabel(job, now)}</span>
        <span className="where">
          <span className="at">{job.ask ? 'Question' : STOPS[STOP_OF_KIND[job.kind]]}</span>
          <span className="who">{NAMES[job.agent]}</span>
        </span>
        {(job.runsApp || job.exclusive) && (
          <span className="flags">
            {job.runsApp && <span className="flag">runs the app</span>}
            {job.exclusive && <span className="flag">runs alone</span>}
          </span>
        )}
      </button>
    </li>
  );
}
export function SessionRow({ session, stage }: { session: ClaudeSession; stage?: string }) {
  const mark = sessionMark(session);
  return (
    <li className={stage ? '' : 'session'} data-state={mark}>
      <details className={stage ? 'lead' : ''}>
        <summary className={stage ? 'item' : ''} data-state={mark}>
          <MarkIcon state={mark} />
          <span className="what">{stage ?? session.title}</span>
          {stage && <span className="now">{session.waitingFor ?? session.phase}</span>}
          <span className="sub">
            Claude · {mark === 'waiting' ? 'Needs input' : mark === 'stalled' ? 'May be stuck' : session.state}
          </span>
          <Icon icon={ChevronDown} className="disclosure" />
        </summary>
        <div className="session-detail">
          <p>{session.title}</p>
          <p>{session.state === 'waiting' ? session.waitingFor : session.phase}</p>
          <p className="path">{session.cwd}</p>
        </div>
      </details>
    </li>
  );
}
function Track({
  jobs,
  mission,
  lead,
  openJob,
}: {
  jobs: BoardJob[];
  mission?: Mission;
  lead?: ClaudeSession;
  openJob: (id: string) => void;
}) {
  const at = mission ? STOP_OF_STAGE[mission.stage] : -1;
  const active = mission?.state === 'active';
  return (
    <>
      {active && (
        <p className="step-note">
          <b>{STOPS[at]}.</b> {STOP_NOTES[at]}
        </p>
      )}
      <ol className="track">
        {STOPS.map((name, index) => {
          const mine = jobs.filter((job) => STOP_OF_KIND[job.kind] === index);
          return (
            <li
              className="stop"
              data-pos={mission?.state === 'done' || index < at ? 'past' : index === at && active ? 'now' : 'todo'}
              key={name}
            >
              <p className="stop-name">
                <i className="node">{(mission?.state === 'done' || index < at) && <Icon icon={Check} size={16} />}</i>
                <span>{name}</span>
              </p>
              {(mine.length > 0 || (lead && index === at)) && (
                <ul className="items">
                  {lead && index === at && <SessionRow session={lead} stage={name} />}
                  {mine.map((job) => (
                    <JobRow key={job.id} job={job} openJob={openJob} />
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}
function MissionCard({
  mission,
  jobs,
  lead,
  openJob,
}: {
  mission?: Mission;
  jobs: BoardJob[];
  lead?: ClaudeSession;
  openJob: (id: string) => void;
}) {
  const now = useNow();
  const active = mission ? mission.state === 'active' : jobs.some((job) => !job.endedAt);
  const [folded, setFolded] = useState<boolean | null>(null);
  const closed = folded ?? !active;
  const at = mission ? STOP_OF_STAGE[mission.stage] : -1;
  const key = `dismiss:${mission?.id}`;
  const progress = mission ? missionProgress(mission, jobs) : 0;
  const action = useAction(key);
  const mood =
    together([...jobs.filter((job) => !job.endedAt).map(jobMark), ...(lead ? [sessionMark(lead)] : [])]) || 'working';
  const tokens = jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  const state = active ? mood : mission?.state === 'done' ? 'done' : 'idle';
  const label = active
    ? mood === 'waiting'
      ? 'Needs you'
      : mood === 'failed'
        ? 'A job failed'
        : mood === 'stalled'
          ? 'Gone quiet'
          : mission
            ? `Step ${at + 1} of ${STOPS.length} · ${STOPS[at]}`
            : 'Working'
    : mission?.state === 'done'
      ? 'Done'
      : mission
        ? 'Abandoned'
        : 'Finished';
  return (
    <li
      className="card"
      data-key={mission?.id ?? 'loose:jobs'}
      data-closed={closed ? '' : undefined}
      data-quiet={!active ? '' : undefined}
    >
      <div className="cmd-head">
        <button className="cmd-toggle" aria-expanded={!closed} onClick={() => setFolded(!closed)}>
          <Icon icon={ChevronDown} className="disclosure" />
          <span className="cmd-title">{mission?.title ?? 'Other jobs'}</span>
          <span className="cmd-meta">
            {mission
              ? `${brief((mission.endedAt ?? now) - mission.createdAt)} ${active ? 'so far' : 'total'}`
              : `${jobs.filter((job) => !job.endedAt).length} running`}
            {tokens > 0 && ` · ${compact(tokens)} tokens`}
          </span>
        </button>
        <span className="mini" aria-hidden="true">
          {STOPS.map((name, index) => (
            <i
              key={name}
              data-state={
                together(jobs.filter((job) => STOP_OF_KIND[job.kind] === index).map(jobMark)) ||
                (mission?.state === 'done' || index < at ? 'done' : index === at && active ? 'working' : '')
              }
            />
          ))}
        </span>
        <Chip state={state}>{label}</Chip>
        {mission && active && (
          <button
            className="quiet"
            title="Closes this command on the board. Its jobs keep running."
            disabled={action.pending || action.accepted}
            onClick={() =>
              void actions.run(
                key,
                () => request(`/api/missions/${mission.id}`, { abandoned: true, outcome: 'Dismissed on the board.' }),
                { done: 'Dismissed' },
              )
            }
          >
            Dismiss
          </button>
        )}
      </div>
      {mission && (
        <div className="mission-progress">
          <progress aria-label="Mission progress" max={1} value={progress} />
          <span>{Math.round(progress * 100)}%</span>
        </div>
      )}
      {!!mission?.notes?.length && (
        <ul className="notes mission-notes" aria-label="Pinned notes">
          {mission.notes.map((note, index) => (
            <li key={`${note.at}:${index}`}>{note.text}</li>
          ))}
        </ul>
      )}
      <div className="cmd-body" data-plain={!mission ? '' : undefined} inert={closed}>
        {mission && (
          <div className="stage" data-ended={active ? undefined : mission.state}>
            <div className="stage-ring">
              <svg className="ring steps" viewBox="0 0 100 100" aria-hidden="true">
                {STOPS.map((name, index) => (
                  <circle
                    key={name}
                    cx="50"
                    cy="50"
                    r="42"
                    strokeDasharray="30.98 232.91"
                    strokeDashoffset={-index * 43.98 - 6.5}
                    data-pos={mission.state === 'done' || index < at ? 'past' : index === at && active ? 'now' : 'todo'}
                  />
                ))}
              </svg>
              <b>
                {mission.state === 'done' ? (
                  <Icon icon={Check} size={32} />
                ) : (
                  <>
                    {at + 1}
                    <small>/{STOPS.length}</small>
                  </>
                )}
              </b>
            </div>
            <p className="stage-label">
              {active ? 'Now at step' : mission.state === 'done' ? 'Finished' : 'Stopped at step'}
            </p>
            <p className="stage-name">{mission.state === 'done' ? 'All done' : STOPS[at]}</p>
          </div>
        )}
        <div className="cmd-main">
          <Track jobs={jobs} mission={mission} lead={lead} openJob={openJob} />
          {mission?.outcome && <p className="outcome">{mission.outcome}</p>}
        </div>
      </div>
      <ActionStatus actionKey={key} />
    </li>
  );
}
export function ProjectGroup({
  dir,
  name,
  state,
  openJob,
  selectProject,
}: {
  dir: string;
  name: string;
  state: Snapshot;
  openJob: (id: string) => void;
  selectProject: (dir: string) => void;
}) {
  const mine = (item: Parameters<typeof projectOf>[0]) => !dir || projectOf(item) === dir;
  const missions = state.missions.filter(mine);
  const jobs = state.jobs.filter(mine);
  const sessions = state.claude.filter(mine);
  const { open, ended, loose } = cardsForProject(missions, jobs);
  const leads = new Set(open.map((mission) => mission.owner));
  const order = { waiting: 0, working: 1, error: 2, idle: 3 };
  const running =
    jobs.filter((job) => !job.endedAt).length + sessions.filter((session) => session.state !== 'idle').length;
  const card = (mission: Mission) => (
    <MissionCard
      key={mission.id}
      mission={mission}
      jobs={jobs.filter((job) => job.mission === mission.id)}
      lead={mission.state === 'active' ? sessions.find((session) => session.id === mission.owner) : undefined}
      openJob={openJob}
    />
  );
  return (
    <section className="group">
      <header className="group-head">
        <h2>
          <button className="link" onClick={() => selectProject(dir)}>
            {name}
          </button>
        </h2>
        <span className="path" title={dir}>
          {shortPath(dir)}
        </span>
        <span className="group-meta">{running ? `${running} active` : 'Nothing running'}</span>
      </header>
      <ul className="sessions">
        {sessions
          .filter((session) => !leads.has(session.id))
          .sort((a, b) => order[a.state] - order[b.state])
          .map((session) => (
            <SessionRow key={session.id} session={session} />
          ))}
      </ul>
      <ul className="commands">
        {open.map(card)}
        {loose.length > 0 && <MissionCard key={`loose:${dir}`} jobs={loose} openJob={openJob} />}
        {ended.map(card)}
      </ul>
      {!missions.length && !jobs.length && !sessions.length && (
        <p className="empty">Start a task with /crew:run in a Claude session, or send a job below.</p>
      )}
    </section>
  );
}
