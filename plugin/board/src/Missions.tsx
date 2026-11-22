import { memo, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import { board } from './store.ts';
import {
  BranchRequest16Regular, BranchRequestClosed16Regular, Checkmark16Regular, CheckmarkCircleRegular, CheckmarkRegular,
  ChevronDown16Regular, ChevronDownRegular, ChevronRight16Regular, Clock16Regular, DismissCircleRegular,
  GaugeRegular, Merge16Regular, MoreHorizontalRegular,
} from '@fluentui/react-icons';
import type { BoardJob, BoardPull, ClaudeSession, Mission, PresetName, Snapshot } from './types.ts';
import { actions, request } from './api.ts';
import {
  agentSummary, elapsed, jobLabel, jobRole, missionJobStep, missionLooksFinished, missionStep, missionStopPosition,
  missionStops, NAMES, pullIsStale, pullStatuses, roleLabel,
} from './model.ts';
import { ActionStatus, AgentMark, Chip, Collapse, Elapsed, Icon, Menu, StatusIcon, sameItems, useAction, useFade, useClock } from './ui.tsx';

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
export const jobStatusState = (job: BoardJob) => (job.stalled ? 'stalled' : job.state);
/** What a job is, as the app names it in a row: its role, or Question for a question. */
export function jobKind(job: BoardJob, state: Pick<Snapshot, 'roleInfo'>) {
  return job.debate ? 'Debate' : job.ask ? 'Question' : roleLabel(state, jobRole(job));
}

/** A job: the agent's mark leads, the kind and phase follow the title, then status and time. */
export const JobRow = memo(function JobRow({ job, selected, openJob, kind, index = 0 }: {
  job: BoardJob;
  selected?: boolean;
  openJob: (id: string) => void;
  kind?: string;
  index?: number;
}) {
  const active = job.endedAt == null;
  const detail = [
    kind ?? (job.debate ? 'Debate' : job.ask ? 'Question' : null),
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
      <StatusIcon state={jobStatusState(job)} label={jobLabel(job)} />
      <span className="job-row-time"><Elapsed start={job.createdAt} end={job.endedAt} /></span>
      <Icon icon={ChevronRight16Regular} className="row-chevron" />
    </button>
  );
});

type SessionAgent = ClaudeSession['agents'][number];

/** Sub-agents, each as what it is and what it is doing, with how long it has run. */
export function SessionAgents({ agents, label }: { agents: SessionAgent[]; label: string }) {
  return (
    <ul className="session-agents" aria-label={label}>
      {agents.map((agent) => (
        <li key={agent.id}>
          <span>
            <span title={agent.title}>{agent.title}</span>
            <span className="caption secondary" title={agent.phase}>{agent.phase}</span>
          </span>
          <span className="caption secondary"><Elapsed start={agent.startedAt} /></span>
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
export function SessionWorkflow({ run, agents }: { run: ClaudeSession['workflows'][number]; agents: SessionAgent[] }) {
  const [expanded, setExpanded] = useState(false);
  const fadeName = useFade<HTMLSpanElement>(run.name);
  const visible = expanded ? agents : agents.slice(0, 5);
  // Grouped after the cut, so the folded view keeps start order across stages; one stage needs no headings.
  const staged = new Set(agents.map((agent) => agent.stage)).size > 1;
  const groups = new Map<string, SessionAgent[]>();
  for (const agent of visible) groups.set(agent.stage ?? '', [...(groups.get(agent.stage ?? '') ?? []), agent]);
  return (
    <section className="detail-section session-workflow" aria-label={run.name}>
      <h3>
        <span className="fade-line" ref={fadeName} title={run.name}>{run.name}</span>
        <span className="caption secondary digits"><Elapsed start={run.startedAt} end={agents.length ? undefined : run.activeAt} /></span>
      </h3>
      <p className="session-workflow-counts caption secondary">
        <WorkflowStrip done={run.done} running={agents.length} />
        <span>{agents.length} running · {run.done} done</span>
      </p>
      {agents.length === 0 && <p className="callout secondary">No agent running: between phases, or finished.</p>}
      {[...groups].map(([stage, group]) => (
        <div className="session-stage" key={stage}>
          {staged && stage && <p className="caption secondary" title={stage}>{stage}</p>}
          <SessionAgents agents={group} label={staged && stage ? `${run.name}: ${stage}` : run.name} />
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
export const SessionRow = memo(function SessionRow({ session, selected, openSession }: { session: ClaudeSession; selected?: boolean; openSession: (id: string) => void }) {
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
      <StatusIcon state={session.stalled ? 'stalled' : session.state} label={session.stalled ? 'May be stuck' : capitalized(session.state)} />
      {/* An idle session stops its clock at its last activity. */}
      <span className="job-row-time"><Elapsed start={session.startedAt} end={session.state === 'idle' ? session.activeAt : undefined} /></span>
      <Icon icon={ChevronRight16Regular} className="row-chevron" />
    </button>
  );
});

/** Measures step names for the track's end insets; one canvas serves every track. */
let measure: CanvasRenderingContext2D | null | undefined;

export const MissionTrack = memo(function MissionTrack({ mission }: { mission: Mission }) {
  const stops = missionStops(mission);
  const at = missionStep(mission);
  const active = mission.state === 'active';
  const track = useRef<HTMLOListElement>(null);
  // The end insets' least width that keeps the longer end name inside the card, as the app's track measures it.
  const [fit, setFit] = useState<number>();
  const first = stops[0]?.name ?? '';
  const last = stops.at(-1)?.name ?? '';
  useLayoutEffect(() => {
    const name = track.current?.querySelector('.track-name');
    if (!name || stops.length < 2) return setFit(undefined);
    let current = true;
    const update = () => {
      measure ??= document.createElement('canvas').getContext('2d');
      if (!current || !measure) return;
      const style = getComputedStyle(name);
      // In the current step's heavier weight, so the insets hold still as the mission advances.
      measure.font = `600 ${style.fontSize} ${style.fontFamily}`;
      const padding = parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd);
      setFit(Math.ceil((Math.max(measure.measureText(first).width, measure.measureText(last).width) + padding) / 2));
    };
    update();
    // Measured again once the face the names use has loaded; the board may not have asked for it yet.
    if (measure) void document.fonts.load(measure.font, first + last).then(update, () => {});
    return () => { current = false; };
  }, [first, last, stops.length]);
  return (
    <ol
      ref={track}
      className="track"
      // One element for assistive technology, as the app's track is.
      role="img"
      data-abandoned={mission.state === 'abandoned' || undefined}
      style={{ '--steps': stops.length, '--fit': fit === undefined ? undefined : `${fit}px` } as CSSProperties}
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
              <b>{pos === 'past' ? <Icon icon={Checkmark16Regular} /> : index + 1}</b>
            </span>
            {/* A name the lead gave can be longer than its column. */}
            <span className="track-name" title={name}>{name}</span>
          </li>
        );
      })}
    </ol>
  );
});

/** Open or closed per mission, kept across pages and layout changes, as the app keeps it. */
const expandedMissions = new Map<string, boolean>();
/** A mission with more jobs than this lets each stage fold; the user's choice per stage is kept as a mission's is. */
const FOLD_STAGES_AFTER = 1;
/** A stage with this many jobs or fewer stays open by default, as reopening each one would cost more than it saves. */
const STAGE_OPENS_UP_TO = 3;
const openStages = new Map<string, boolean>();
const PRESETS: [PresetName | null, string][] = [[null, 'Default'], ['economy', 'Economy'], ['balanced', 'Balanced'], ['best', 'Best']];

/** A chip that names a pull request's most urgent status and counts the others the lead must act on; it opens the pull request. */
function MissionPull({ pull }: { pull: BoardPull }) {
  const statuses = pullStatuses(pull);
  const checked = useClock((now) => pullIsStale(pull, now) ? elapsed(now - pull.checkedAt) : '', pull.state === 'open');
  const stale = Boolean(checked);
  // A failed read leaves the last statuses in doubt, so the chip names the failure in their place.
  const unread = stale && pull.error != null;
  const word = unread ? 'Could not be read' : statuses[0]?.word;
  const more = unread ? 0 : statuses.slice(1).filter((status) => status.needsLead).length;
  const details = [
    pull.title,
    ...statuses.map((status) => status.word),
    unread ? 'Could not be read' : null,
    stale ? `Checked ${checked} ago` : null,
  ].filter(Boolean).join(' · ');
  const glyph = pull.state === 'merged' ? Merge16Regular : pull.state === 'closed' ? BranchRequestClosed16Regular : BranchRequest16Regular;
  return (
    <a
      className="chip pull-chip"
      // Stale statuses keep their words but lose their color.
      data-state={stale ? '' : statuses[0]?.tone ?? ''}
      data-stale={stale || undefined}
      href={pull.url}
      target="_blank"
      rel="noreferrer"
      title={details}
      aria-label={`Pull request ${pull.repo} #${pull.number}${details ? `: ${details}` : ''}`}
    >
      <Icon icon={glyph} />
      <span className="digits">#{pull.number}</span>
      {word && <span>{word}</span>}
      {more > 0 && <span className="pull-more digits">+{more}</span>}
      {stale && (
        <>
          <Icon icon={Clock16Regular} />
          <span className="digits">{checked}</span>
        </>
      )}
    </a>
  );
}

export const MissionPanel = memo(function MissionPanel({
  mission,
  jobs,
  missionJobs,
  owner,
  lead,
  pulls,
  projectName,
  selected,
  openJob,
  openSession,
  index = 0,
}: {
  mission: Mission;
  jobs: BoardJob[];
  missionJobs: BoardJob[];
  owner?: ClaudeSession;
  lead?: ClaudeSession;
  pulls?: BoardPull[];
  projectName?: string;
  selected: string;
  openJob: (id: string) => void;
  openSession: (id: string) => void;
  index?: number;
}) {
  const [expanded, setExpandedState] = useState(() => expandedMissions.get(mission.id) ?? mission.state === 'active');
  const setExpanded = (value: boolean) => {
    expandedMissions.set(mission.id, value);
    setExpandedState(value);
  };
  // Keyed by state as in the app: once a mission is abandoned, Mark Done takes a fresh lock.
  const key = `mission:${mission.id}:${mission.state}`;
  const action = useAction(key);
  const stops = useMemo(() => missionStops(mission), [mission]);
  const jobsByStep = useMemo(() => {
    const groups = stops.map(() => [] as BoardJob[]);
    for (const job of jobs) groups[missionJobStep(mission, job, stops)]?.push(job);
    return groups;
  }, [mission, jobs, stops]);
  const at = missionStep(mission);
  const tokens = jobs.reduce((sum, job) => sum + (job.tokens ?? 0), 0);
  const active = mission.state === 'active';
  const tasks = mission.tasks?.filter((task) => task.state !== 'dropped') ?? [];
  const meta = [
    tokens > 0 ? `${tokens.toLocaleString()} tokens` : null,
    projectName,
    `${jobs.length} ${jobs.length === 1 ? 'job' : 'jobs'}`,
    tasks.length ? `${tasks.filter((task) => task.state === 'done').length}/${tasks.length} tasks` : null,
    mission.preset ? capitalized(mission.preset) : null,
  ].filter(Boolean).join(' · ');
  const live = useSyncExternalStore(board.subscribe, () => board.getSnapshot().connection === 'live');
  const locked = action.pending || action.accepted || !live;
  const update = (body: object, done: string) => void actions.run(key, () => request(`/api/missions/${mission.id}`, body), { done });
  const markDone = () => update({ done: true, ...(mission.state === 'abandoned' ? { reopen: true } : {}), outcome: 'Marked done on the board.' }, 'Marked done');
  const stopTracking = () => update({ abandoned: true, outcome: 'Dismissed on the board.' }, 'Dismissed');
  // A daemon without the role registry ignores a mission's preset.
  const presets = useSyncExternalStore(board.subscribe, () => Boolean(board.getSnapshot().roleInfo));

  const fadeTitle = useFade<HTMLHeadingElement>(mission.title);
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
        if (!expanded && !(event.target as Element).closest('a, button, [role="menu"]')) setExpanded(true);
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
          <MissionMeta mission={mission} meta={meta} />
        </div>
        {/* One group, so the status and the menu move to a line of their own together. */}
        <span className="mission-controls">
          <Chip state={active ? 'running' : mission.state}>{capitalized(mission.state)}</Chip>
          {(active || mission.state === 'abandoned') && (
            <Menu label="Mission options" icon={MoreHorizontalRegular}>
              <button role="menuitem" disabled={locked} onClick={markDone}>
                <Icon icon={CheckmarkCircleRegular} />
                Mark Done
              </button>
              {active && (
                <button role="menuitem" disabled={locked} title="Stops tracking without marking done. Its jobs keep running." onClick={stopTracking}>
                  <Icon icon={DismissCircleRegular} />
                  Stop Tracking
                </button>
              )}
              {active && presets && (
                <>
                  <hr />
                  <p className="menu-label" role="presentation">Model Preset</p>
                  {PRESETS.map(([preset, name]) => (
                    <button
                      key={name}
                      role="menuitemradio"
                      aria-checked={(mission.preset ?? null) === preset}
                      disabled={locked}
                      title="Applies to new jobs only. Running jobs keep theirs."
                      // The meta line and the check show the choice, so only sending and failure are said.
                      onClick={() => void actions.run(key, () => request(`/api/missions/${mission.id}`, { preset }), { done: '', once: false })}
                    >
                      <Icon icon={(mission.preset ?? null) === preset ? CheckmarkRegular : GaugeRegular} />
                      {name}
                    </button>
                  ))}
                </>
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
            <Icon icon={ChevronDownRegular} className="disclosure" />
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
            const mine = jobsByStep[stopIndex];
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
                      <Icon icon={ChevronDown16Regular} className="disclosure" />
                    </button>
                  ) : name}
                </h3>
                {/* Always wrapped, so rows are not mounted again when the mission starts folding. */}
                <Collapse open={open} className="rows">
                  {stageLead && <SessionRow session={stageLead} selected={selected === `session:${stageLead.id}`} openSession={openSession} />}
                  {mine.map((job, rowIndex) => (
                    <JobRow key={job.id} job={job} selected={selected === job.id} openJob={openJob} index={rowIndex} />
                  ))}
                </Collapse>
              </div>
            );
          })}
        </div>
        {mission.outcome && <p className="mission-outcome selectable">{mission.outcome}</p>}
      </Collapse>
      {/* Its menu holds Mark Done, so the card only says so. */}
      {active && <MissionHint mission={mission} jobs={missionJobs} owner={owner} />}
      <ActionStatus actionKey={key} />
      {!!pulls?.length && (
        <div className="mission-pulls">
          {pulls.map((pull) => <MissionPull key={pull.id} pull={pull} />)}
        </div>
      )}
    </section>
  );
}, (a, b) =>
  a.mission === b.mission && a.owner === b.owner && a.lead === b.lead &&
  a.projectName === b.projectName && a.index === b.index &&
  a.openJob === b.openJob && a.openSession === b.openSession &&
  (a.selected === b.selected || (!a.jobs.some((job) => job.id === a.selected || job.id === b.selected) &&
    (!a.lead || (a.selected !== `session:${a.lead.id}` && b.selected !== `session:${a.lead.id}`)))) &&
  sameItems(a.jobs, b.jobs) && sameItems(a.missionJobs, b.missionJobs) &&
  (a.pulls === b.pulls || Boolean(a.pulls && b.pulls && sameItems(a.pulls, b.pulls))),
);

function MissionMeta({ mission, meta }: { mission: Mission; meta: string }) {
  const text = useClock((now) => elapsed((mission.endedAt ?? now) - mission.createdAt), mission.endedAt == null);
  const content = `${text} · ${meta}`;
  const fade = useFade<HTMLParagraphElement>(content);
  return <p className="mission-meta fade-line" ref={fade} title={mission.root}>{content}</p>;
}

function MissionHint({ mission, jobs, owner }: { mission: Mission; jobs: BoardJob[]; owner?: ClaudeSession }) {
  const finished = useClock((now) => missionLooksFinished(mission, jobs, now, owner));
  return finished ? <span className="caption secondary mission-hint reveal">Looks finished</span> : null;
}
