import {
  ArrowUpRight16Filled, ChatMultipleRegular, CheckmarkCircleRegular, CheckmarkRegular, DismissRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { BoardJob, ClaudeSession } from './types.ts';
import { board } from './store.ts';
import { actions, answerKey, request } from './api.ts';
import { NAMES, projectOf } from './model.ts';
import { ActionStatus, AgentMark, Chip, Composer, EmptyState, Icon, useAction, useDraft, Elapsed } from './ui.tsx';

/** AnswerView in the app: the request leads, then the reply controls. */
export function Answer({ job }: { job: BoardJob }) {
  const waiting = job.waiting;
  const key = answerKey(job.id, waiting?.id ?? '');
  const state = useAction(key);
  const [draft, setDraft] = useDraft(key);
  const live = useSyncExternalStore(board.subscribe, () => board.getSnapshot().connection === 'live');
  if (job.state !== 'waiting' || !waiting) return null;
  const locked = state.pending || state.accepted || !live;
  const reply = (body: object) => request(`/api/jobs/${job.id}/reply`, { ...body, request_id: waiting.id });
  type Decision = 'approve' | 'deny' | 'allow_for_job';
  const decide = (decision: Decision) => {
    // A draft typed before a quick reply goes along with it rather than being discarded.
    const note = draft.trim();
    void actions.run(key, () => reply({ decision, ...(note ? { message: note } : {}) })).then((sent) => {
      if (sent) setDraft('');
    });
  };
  const icons = { approve: CheckmarkRegular, deny: DismissRegular, allow_for_job: CheckmarkCircleRegular };
  const button = (label: string, decision: Decision, prominent: boolean, title?: string) => (
    <button className={prominent ? 'prominent' : ''} disabled={locked} title={title} onClick={() => decide(decision)}>
      <Icon icon={icons[decision]} />
      {label}
    </button>
  );
  return (
    <div className="answer">
      <p className="headline selectable">{waiting.reason}</p>
      {waiting.type === 'question' ? (
        <>
          <Composer
            label="Your answer"
            placeholder="Write an answer…"
            actionKey={key}
            once
            disabled={!live}
            draft={draft}
            setDraft={setDraft}
            onSend={(message) => reply({ message })}
          />
          <div className="answer-actions">
            {/* Sent or an error shows at the leading edge of the buttons' row. */}
            <ActionStatus actionKey={key} />
            {/* The completing answer comes last, at the trailing edge, as in the app. */}
            {button('No', 'deny', false)}
            {button('Yes', 'approve', false)}
          </div>
        </>
      ) : (
        <div className="answer-actions" data-approval>
          <ActionStatus actionKey={key} />
          {button('Deny', 'deny', false)}
          {waiting.grant && button('Allow for This Job', 'allow_for_job', false, `Also allow this job's later requests for ${waiting.grant}, without asking`)}
          {button('Approve', 'approve', true)}
        </div>
      )}
    </div>
  );
}

export function NeedsYou({
  jobs,
  sessions,
  pending,
  names,
  openJob,
  openSession,
}: {
  jobs: BoardJob[];
  sessions: ClaudeSession[];
  pending: number;
  names: Map<string, string>;
  openJob: (id: string) => void;
  openSession: (id: string) => void;
}) {
  return (
    <>
      {pending === 0 ? (
        <EmptyState title="All caught up" icon={CheckmarkCircleRegular} />
      ) : (
        !jobs.length && !sessions.length && <EmptyState title="No matching requests" icon={SearchRegular} />
      )}
      {(jobs.length > 0 || sessions.length > 0) && (
        <div className="needs-grid">
          {jobs.map((job, index) => (
            <article className="card need" key={job.id} data-job={job.id} style={{ '--i': index } as CSSProperties}>
              <div className="need-head">
                <div className="need-bar">
                  <Chip state="waiting">{job.waiting?.type === 'approval' ? 'Approval' : 'Question'}</Chip>
                  <span className="need-who" title={projectOf(job)}>
                    <AgentMark agent={job.agent} size={13} />
                    <span>
                      {NAMES[job.agent]} · {names.get(projectOf(job)) ?? projectOf(job)}
                    </span>
                  </span>
                  {job.waiting && <span className="need-age digits"><Elapsed start={job.waiting.since} /></span>}
                  <button className="caption small" data-opens-panel="" onClick={() => openJob(job.id)}>
                    <Icon icon={ArrowUpRight16Filled} size={12} />
                    Details
                  </button>
                </div>
                <p className="need-title" title={job.title}>{job.title}</p>
              </div>
              <Answer job={job} />
            </article>
          ))}
          {sessions.map((session, index) => (
            <article className="card need" key={session.id} data-session={session.id} style={{ '--i': jobs.length + index } as CSSProperties}>
              <div className="need-head">
                <div className="need-bar">
                  <Chip state="waiting">Input</Chip>
                  <span className="need-who" title={projectOf(session)}>
                    <AgentMark agent="claude" size={13} />
                    <span>Claude · {names.get(projectOf(session)) ?? projectOf(session)}</span>
                  </span>
                  <button className="caption small" data-opens-panel="" onClick={() => openSession(session.id)}>
                    <Icon icon={ArrowUpRight16Filled} size={12} />
                    Details
                  </button>
                </div>
                {/* Laid out as a job's card: who and where on the bar, the session's title under it. */}
                <p className="need-title" title={session.title}>{session.title}</p>
              </div>
              <div className="answer">
                <p className="headline selectable">{session.waitingFor ?? 'Claude needs your input.'}</p>
                <p className="callout secondary"><Icon icon={ChatMultipleRegular} size={13} /> Answer in Claude.</p>
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
