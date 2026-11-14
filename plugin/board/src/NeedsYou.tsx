import { ArrowUpRight, Check, CircleCheck, MessagesSquare, Search, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import type { BoardJob, ClaudeSession } from './types.ts';
import { board } from './store.ts';
import { actions, answerKey, request } from './api.ts';
import { NAMES, projectOf } from './model.ts';
import { ActionStatus, AgentMark, Chip, Composer, ContentPanel, EmptyState, Icon, useAction, useDraft } from './ui.tsx';

/** AnswerView in the app: the request leads, then the reply controls. */
export function Answer({ job }: { job: BoardJob }) {
  const waiting = job.waiting;
  const key = answerKey(job.id, waiting?.id ?? '');
  const state = useAction(key);
  const [draft, setDraft] = useDraft(key);
  if (job.state !== 'waiting' || !waiting) return null;
  const live = useSyncExternalStore(board.subscribe, () => board.getSnapshot().connection === 'live');
  const locked = state.pending || state.accepted || !live;
  const reply = (body: object) => request(`/api/jobs/${job.id}/reply`, { ...body, request_id: waiting.id });
  const decide = (decision: 'approve' | 'deny') => {
    // A draft typed before a quick reply goes along with it rather than being discarded.
    const note = draft.trim();
    void actions.run(key, () => reply({ decision, ...(note ? { message: note } : {}) })).then((sent) => {
      if (sent) setDraft('');
    });
  };
  const button = (label: string, decision: 'approve' | 'deny', prominent: boolean) => (
    <button className={prominent ? 'prominent' : ''} disabled={locked} onClick={() => decide(decision)}>
      <Icon icon={decision === 'approve' ? Check : X} />
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
            {button('Yes', 'approve', false)}
            {button('No', 'deny', false)}
          </div>
        </>
      ) : (
        <div className="answer-actions" data-approval>
          {button('Approve', 'approve', true)}
          {button('Deny', 'deny', false)}
        </div>
      )}
      <ActionStatus actionKey={key} />
    </div>
  );
}

export function NeedsYou({
  jobs,
  sessions,
  pending,
  names,
  openJob,
}: {
  jobs: BoardJob[];
  sessions: ClaudeSession[];
  pending: number;
  names: Map<string, string>;
  openJob: (id: string) => void;
}) {
  return (
    <>
      {pending === 0 ? (
        <EmptyState title="All caught up" icon={CircleCheck} />
      ) : (
        !jobs.length && !sessions.length && <EmptyState title="No matching requests" icon={Search} />
      )}
      {jobs.length > 0 && (
        <div className="needs-grid">
          {jobs.map((job) => (
            <article className="card need" key={job.id} data-job={job.id}>
              <div className="need-head">
                <div className="need-bar">
                  <Chip state="waiting">{job.waiting?.type === 'approval' ? 'Approval' : 'Question'}</Chip>
                  <span className="need-who" title={projectOf(job)}>
                    <AgentMark agent={job.agent} size={13} />
                    <span>
                      {NAMES[job.agent]} · {names.get(projectOf(job)) ?? projectOf(job)}
                    </span>
                  </span>
                  <button className="caption small" onClick={() => openJob(job.id)}>
                    <Icon icon={ArrowUpRight} size={12} />
                    Details
                  </button>
                </div>
                <p className="need-title" title={job.title}>{job.title}</p>
              </div>
              <Answer job={job} />
            </article>
          ))}
        </div>
      )}
      {sessions.map((session) => (
        <ContentPanel key={session.id} title={session.title} icon={MessagesSquare}>
          <p className="selectable">{session.waitingFor ?? 'Claude needs your input.'}</p>
          <p className="caption secondary">{projectOf(session)}</p>
          <p className="callout secondary">Answer in Claude.</p>
        </ContentPanel>
      ))}
    </>
  );
}
