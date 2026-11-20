import { useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { board } from './store.ts';
import { Check, ChevronDown, ChevronRight, CircleCheck, CircleX, Ellipsis, Gauge } from 'lucide-react';
import type { BoardJob, ClaudeSession, Mission, PresetName } from './types.ts';
import { actions, request } from './api.ts';
import {
  agentSummary, elapsed, jobLabel, jobRole, missionJobStep, missionLooksFinished, missionProgress, missionStep, missionStopPosition,
  missionStops, NAMES, roleLabel,
} from './model.ts';
import { ActionStatus, AgentMark, Chip, Collapse, Icon, Menu, useAction, useFade, useNow } from './ui.tsx';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const jobStatusState = (job: BoardJob) => (job.stalled ? 'stalled' : job.state);
/** What a job is, as the app names it in a row: its role, or Question for a question. */
export function jobKind(job: BoardJob) {
  return job.debate ? 'Debate' : job.ask ? 'Question' : roleLabel(board.getSnapshot(), jobRole(job));
}

/** A job: the agent's mark leads, the kind and phase follow the title, then status and time. */
export function JobRow({ job, selected, openJob, showsKind = true, index = 0 }: {
  job: BoardJob;
  selected?: boolean;
  openJob: (id: string) => void;
  /** Under a mission's stage, which already names the kind. */
  showsKind?: boolean;
  index?: number;
}) {
  const now = useNow();
  const active = job.endedAt == null;
  const detail = [
    showsKind ? jobKind(job) : job.debate ? 'Debate' : job.ask ? 'Question' : null,
    job.error?.message ?? (active ? job.phase : null),
    job.runsApp ? 'Runs the app' : null,
    job.exclusive ? 'Runs alone' : null,
  ].filter(Boolean).join(' · ');
  return (
    <button
      className="job-row"
      data-job={job.id}
      data-opens-panel=""
      data-state={jobStatusState(job)}
      data-waiting={job.state === 'waiting' ? '' : undefined}
      aria-current={selected || undefined}
      aria-description={NAMES[job.agent]}
      style={{ '--i': index } as CSSProperties}
      onClick={() => openJob(job.id)}
    >
      <span className="row-mark" title={NAMES[job.agent]}><AgentMark agent={job.agent} size={16} /></span>
      <span className="job-row-text">
        <b>{job.title}</b>
        {detail && <span data-error={job.error ? '' : undefined} key={detail} className="swap">{detail}</span>}
      </span>
      <Chip state={jobStatusState(job)}>{jobLabel(job)}</Chip>
      <span className="job-row-time">{elapsed((job.endedAt ?? now) - job.createdAt)}</span>
      <Icon icon={ChevronRight} className="row-chevron" />
    </button>
  );
}

type SessionAgent = ClaudeSession['agents'][number];

/** Sub-agents, each as what it is and what it is doing, with how long it has run. */
export function SessionAgents({ agents, now, label }: { agents: SessionAgent[]; now: number; label: string }) {
  return (
    <ul className="session-agents" aria-label={label}>
      {agents.map((agent) => (
        <li key={agent.id}>
          <span>
            <span title={agent.title}>{agent.title}</span>
            <span className="caption secondary" title={agent.phase}>{agent.phase}</span>
          </span>
          <span className="caption secondary">{elapsed(now - agent.startedAt)}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * One square per agent of a run, finished ones first and running ones pulsing after them. The total is not known
 * ahead, so there are no empty squares for agents to come; past STRIP_LIMIT, the oldest finished ones give way to a count.
 */
const STRIP_LIMIT = 30;
function WorkflowStrip({ done, running }: { done: number; running: number }) {
  const shownRunning = Math.min(running, STRIP_LIMIT);
  const shownDone = Math.min(done, STRIP_LIMIT - shownRunning);
  const hidden = done + running - shownDone - shownRunning;
  return (
    <span className="workflow-strip" aria-hidden="true">
      {hidden > 0 && <small>+{hidden}</small>}
      {Array.from({ length: shownDone }, (_, index) => <i key={`d${index}`} />)}
      {Array.from({ length: shownRunning }, (_, index) => <i key={`r${index}`} data-running="" style={{ '--i': index } as CSSProperties} />)}
    </span>
  );
}

/** A workflow run, which can hold dozens of agents: the first few by stage, and the rest on request. */
export function SessionWorkflow({ run, agents, now }: { run: ClaudeSession['workflows'][number]; agents: SessionAgent[]; now: number }) {
  const [expanded, setExpanded] = useState(false);
  const fadeName = useFade<HTMLSpanElement>();
  const visible = expanded ? agents : agents.slice(0, 5);
  // Grouped after the cut, so the folded view keeps start order across stages; one stage needs no headings.
  const staged = new Set(agents.map((agent) => agent.stage)).size > 1;
  const groups = new Map<string, SessionAgent[]>();
  for (const agent of visible) groups.set(agent.stage ?? '', [...(groups.get(agent.stage ?? '') ?? []), agent]);
  return (
    <section className="detail-section session-workflow" aria-label={run.name}>
      <h3>
        <span className="fade-line" ref={fadeName} title={run.name}>{run.name}</span>
        <span className="caption secondary digits">{elapsed((agents.length ? now : run.activeAt) - run.startedAt)}</span>
      </h3>
      <p className="session-workflow-counts caption secondary">
        <WorkflowStrip done={run.done} running={agents.length} />
        <span>{agents.length} running · {run.done} done</span>
      </p>
      {agents.length === 0 && <p className="callout secondary">No agent running: between phases, or finished.</p>}
      {[...groups].map(([stage, group]) => (
        <div className="session-stage" key={stage}>
          {staged && stage && <p className="caption secondary" title={stage}>{stage}</p>}
          <SessionAgents agents={group} now={now} label={staged && stage ? `${run.name}: ${stage}` : run.name} />
        </div>
      ))}
      {agents.length > 5 && (
        <button className="reveal-toggle" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Show fewer agents' : `Show all ${agents.length} agents`}
        </button>
      )}
    </section>
  );
}

/** A Claude session as a row like a job's, opening its own detail panel. */
export function SessionRow({ session, selected, openSession }: { session: ClaudeSession; selected?: boolean; openSession: (id: string) => void }) {
  const now = useNow();
  // The mark names the agent, so the detail line says only what the session is doing.
  const detail = [session.waitingFor ?? (session.state === 'idle' ? null : session.phase), session.inTool ? 'Running a tool' : null, agentSummary(session)]
    .filter(Boolean).join(' · ');
  return (
    <button
      className="job-row"
      data-session={session.id}
      data-opens-panel=""
      data-state={session.stalled ? 'stalled' : session.state}
      data-waiting={session.state === 'waiting' ? '' : undefined}
      aria-current={selected || undefined}
      aria-description="Claude"
      onClick={() => openSession(session.id)}
    >
      <span className="row-mark"><AgentMark agent="claude" size={16} /></span>
      <span className="job-row-text">
        <b>{session.title}</b>
        {detail && <span key={detail} className="swap">{detail}</span>}
      </span>
      <Chip state={session.stalled ? 'stalled' : session.state}>{session.stalled ? 'May be stuck' : capitalized(session.state)}</Chip>
      {/* An idle session stops its clock at its last activity. */}
      <span className="job-row-time">{elapsed((session.state === 'idle' ? session.activeAt : now) - session.startedAt)}</span>
      <Icon icon={ChevronRight} className="row-chevron" />
    </button>
  );
}

export function MissionTrack({ mission }: { mission: Mission }) {
  const stops = missionStops(mission);
  const at = missionStep(mission);
  const active = mission.state === 'active';
  return (
    <ol
      className="track"
      // One element for assistive technology, as the app's track is.
      role="img"
      data-abandoned={mission.state === 'abandoned' || undefined}
      style={{ '--steps': stops.length } as CSSProperties}
      aria-label={
        mission.state === 'done'
          ? `Done, all ${stops.length} steps passed`
          : `Step ${at + 1} of ${stops.length}, ${stops[at]?.name}`
      }
    >
      {stops.map(({ name }, index) => {
        const position = missionStopPosition(mission, index);
        // An ended mission's step it stopped on is filled, not left to do.
        const pos = !active && mission.state !== 'done' && index === at ? 'stopped' : position;
        return (
          <li
            key={index}
            data-pos={pos}
            // A done mission's last step is not bolded, as it is past like the others.
            data-current={index === at && (active || pos !== 'past') ? '' : undefined}
            aria-hidden="true"
          >
            <span className="track-node">
              <b>{pos === 'past' ? <Icon icon={Check} /> : index + 1}</b>
            </span>
            {/* A name the lead gave can be longer than its column. */}
            <span className="track-name" title={name}>{name}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Open or closed per mission, kept across pages and layout changes, as the app keeps it. */
const expandedMissions = new Map<string, boolean>();
/** A mission with more jobs than this lets each stage fold; the user's choice per stage is kept as a mission's is. */
const FOLD_STAGES_AFTER = 1;
/** A stage with this many jobs or fewer stays open by default, as reopening each one would cost more than it saves. */
const STAGE_OPENS_UP_TO = 3;
const openStages = new Map<string, boolean>();
const PRESETS: [PresetName | null, string][] = [[null, 'Global'], ['economy', 'Economy'], ['balanced', 'Balanced'], ['best', 'Best']];

export function MissionPanel({
  mission,
  jobs,
  allJobs,
  lead,
  projectName,
  selected,
  openJob,
  openSession,
  index = 0,
}: {
  mission: Mission;
  jobs: BoardJob[];
  allJobs: BoardJob[];
  lead?: ClaudeSession;
  projectName?: string;
  selected: string;
  openJob: (id: string) => void;
  openSession: (id: string) => void;
  index?: number;
}) {
  const now = useNow();
  const [expanded, setExpandedState] = useState(() => expandedMissions.get(mission.id) ?? mission.state === 'active');
  const setExpanded = (value: boolean) => {
    expandedMissions.set(mission.id, value);
    setExpandedState(value);
  };
  // Keyed by state as in the app: once a mission is abandoned, Mark Done takes a fresh lock.
  const key = `mission:${mission.id}:${mission.state}`;
  const action = useAction(key);
  const presetKey = `mission-preset:${mission.id}`;
  const presetAction = useAction(presetKey);
  const stops = missionStops(mission);
  const at = missionStep(mission);
  const tokens = jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  const active = mission.state === 'active';
  const meta = [
    elapsed((mission.endedAt ?? now) - mission.createdAt),
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
    projectName,
    `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`,
    // An active mission shows its preset in its menu instead.
    mission.preset && !active ? `${capitalized(mission.preset)} preset` : null,
  ].filter(Boolean).join(' · ');
  const progress = missionProgress(mission, jobs);
  const live = useSyncExternalStore(board.subscribe, () => board.getSnapshot().connection === 'live');
  const locked = action.pending || action.accepted || !live;
  const update = (body: object, done: string) => void actions.run(key, () => request(`/api/missions/${mission.id}`, body), { done });
  const markDone = () => update({ done: true, ...(mission.state === 'abandoned' ? { reopen: true } : {}), outcome: 'Marked done on the board.' }, 'Marked done');
  const stopTracking = () => update({ abandoned: true, outcome: 'Dismissed on the board.' }, 'Dismissed');
  // A daemon without the role registry ignores a mission's preset.
  const presets = Boolean(board.getSnapshot().roleInfo);
  const finished = missionLooksFinished(mission, allJobs, now, lead);
  const fadeTitle = useFade<HTMLHeadingElement>();
  const fadeMeta = useFade<HTMLParagraphElement>();
  const presetName = PRESETS.find(([preset]) => preset === (mission.preset ?? null))?.[1] ?? 'Global';
  const foldsStages = jobs.length > FOLD_STAGES_AFTER;
  const [, setStagesVersion] = useState(0);
  const setOpenStage = (stageKey: string, value: boolean) => {
    openStages.set(stageKey, value);
    setStagesVersion((version) => version + 1);
  };
  return (
    <section
      className="card mission"
      data-key={mission.id}
      data-state={mission.state}
      data-expanded={expanded || undefined}
      style={{ '--i': index } as CSSProperties}
      // A closed card opens from a click anywhere on it, as the app's does.
      onClick={(event) => {
        if (!expanded && !(event.target as Element).closest('button, [role="menu"]')) setExpanded(true);
      }}
    >
      <div
        className="mission-head"
        onClick={(event) => {
          if (expanded && !(event.target as Element).closest('button, [role="menu"]')) setExpanded(false);
        }}
      >
        <div className="mission-heading">
          <h2 className="title selectable fade-line" ref={fadeTitle} title={mission.title}>{mission.title}</h2>
          <p className="mission-meta fade-line" ref={fadeMeta} title={mission.root}>{meta}</p>
        </div>
        <span className="mission-progress digits" title="Mission progress" style={{ '--progress': progress } as CSSProperties}>
          {Math.round(progress * 100)}%
        </span>
        <Chip state={active ? 'running' : mission.state}>{capitalized(mission.state)}</Chip>
        <span className="mission-controls">
          {(active || mission.state === 'abandoned') && (
            <Menu label="Mission options" icon={Ellipsis}>
              <button role="menuitem" disabled={locked} onClick={markDone}>
                <Icon icon={CircleCheck} />
                Mark Done
              </button>
              {active && (
                <button role="menuitem" disabled={locked} title="Stops tracking without marking done. Its jobs keep running." onClick={stopTracking}>
                  <Icon icon={CircleX} />
                  Stop Tracking
                </button>
              )}
            </Menu>
          )}
          <button
            className="icon"
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse mission' : 'Expand mission'}
            title={expanded ? 'Collapse' : 'Expand'}
            onClick={() => setExpanded(!expanded)}
          >
            <Icon icon={ChevronDown} className="disclosure" />
          </button>
        </span>
      </div>
      <Collapse open={expanded} className="mission-body">
        {mission.notes?.map((note, noteIndex) => (
          <p className="mission-note selectable" key={`${note.at}:${noteIndex}`}>{note.text}</p>
        ))}
        <MissionTrack mission={mission} />
        <div className="stage-groups">
          {stops.map(({ name }, stopIndex) => {
            const mine = jobs.filter((job) => missionJobStep(mission, job) === stopIndex);
            const stageLead = active && stopIndex === at ? lead : undefined;
            if (!mine.length && !stageLead) return null;
            const stageKey = `${mission.id}:${stopIndex}`;
            // Until the user picks, a busy stage the mission has moved past folds away once nothing in it is live or chosen.
            const open = !foldsStages || (openStages.get(stageKey) ?? (
              mine.length <= STAGE_OPENS_UP_TO || stopIndex >= at || Boolean(stageLead) || mine.some((job) => job.endedAt == null || job.waiting || selected === job.id)
            ));
            return (
              <div className="rows" key={stopIndex}>
                <h3 className="stage-name">
                  {foldsStages ? (
                    <button
                      aria-expanded={open}
                      aria-label={`${name}, ${mine.length} ${mine.length === 1 ? 'job' : 'jobs'}`}
                      onClick={() => setOpenStage(stageKey, !open)}
                    >
                      {name}
                      <span className="digits">{mine.length}</span>
                      <Icon icon={ChevronDown} className="disclosure" />
                    </button>
                  ) : name}
                </h3>
                {/* Always wrapped, so rows are not mounted again when the mission starts folding. */}
                <Collapse open={open} className="rows">
                  {stageLead && <SessionRow session={stageLead} selected={selected === `session:${stageLead.id}`} openSession={openSession} />}
                  {mine.map((job, rowIndex) => (
                    <JobRow key={job.id} job={job} selected={selected === job.id} openJob={openJob} showsKind={false} index={rowIndex} />
                  ))}
                </Collapse>
              </div>
            );
          })}
        </div>
        {(mission.outcome || finished || mission.state === 'abandoned' || (active && presets)) && (
          <div className="mission-foot">
            {mission.outcome ? <p className="mission-outcome selectable">{mission.outcome}</p> : <span />}
            <div className="mission-foot-actions">
              {finished && <span className="caption secondary">Looks finished</span>}
              {finished && active && (
                <button className="pill-warning small" disabled={locked} onClick={stopTracking}>Stop Tracking</button>
              )}
              {(finished || mission.state === 'abandoned') && (
                <button className="prominent small" disabled={locked} onClick={markDone}>Mark Done</button>
              )}
              {active && presets && (
                <Menu label="Mission preset" icon={Gauge} text={`${presetName} preset`}>
                  {PRESETS.map(([preset, name]) => (
                    <button
                      key={name}
                      role="menuitemradio"
                      aria-checked={(mission.preset ?? null) === preset}
                      disabled={presetAction.pending || !live}
                      title="Applies to the mission's next jobs. Jobs already started keep theirs."
                      onClick={() => void actions.run(presetKey, () => request(`/api/missions/${mission.id}`, { preset }), {
                        done: preset ? `${name} preset for new jobs` : 'Global preset for new jobs', once: false,
                      })}
                    >
                      <Icon icon={(mission.preset ?? null) === preset ? Check : Gauge} />
                      {preset ? `${name} preset` : 'Global preset'}
                    </button>
                  ))}
                </Menu>
              )}
            </div>
          </div>
        )}
        <ActionStatus actionKey={presetKey} />
      </Collapse>
      {!expanded && finished && <span className="caption secondary mission-hint reveal">Looks finished</span>}
      <ActionStatus actionKey={key} />
    </section>
  );
}
