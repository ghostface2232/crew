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

/** Deep link that opens the session in the Claude desktop app; terminal sessions have none. */
export function claudeLink(session: ClaudeSession): string | null {
  return session.desktopId ? `claude://code/continue?session=${encodeURIComponent(session.desktopId)}` : null;
}

/** Opens the session in the Claude desktop app, where its prompts are answered. */
export function OpenInClaude({ session, small }: { session: ClaudeSession; small?: boolean }) {
  const link = claudeLink(session);
  if (!link) return null;
  return (
    <button
      className={small ? 'caption small' : undefined}
      onClick={(event) => {
        // Keep clicks on this button from opening the card's detail panel.
        event.stopPropagation();
        window.location.href = link;
      }}
    >
      <Icon icon={ArrowUpRight16Filled} size={12} />
      Open in Claude
    </button>
  );
}

/** What a waiting Claude session asks beyond its headline: follow-up questions and choices, or the tool input an approval is for. */
export function ClaudeAsk({ session }: { session: ClaudeSession }) {
  const ask = session.ask;
  if (session.state !== 'waiting' || !ask) return null;
  if (ask.questions) {
    return (
      <div className="ask">
        {ask.questions.map((question, index) => (
          <div className="ask" key={index}>
            {/* The first question is the card's headline. */}
            {index > 0 && <p className="selectable">{question.question}</p>}
            {question.options.length > 0 && (
              <ol className="ask-options" aria-label={question.multiSelect ? 'Choices, any number' : 'Choices'}>
                {question.options.map((option, n) => <li className="selectable" key={n}>{option}</li>)}
              </ol>
            )}
          </div>
        ))}
      </div>
    );
  }
  return ask.input ? <pre className="ask-input selectable">{ask.input}</pre> : null;
}

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
  openJob,
  openSession,
}: {
  jobs: BoardJob[];
  sessions: ClaudeSession[];
  pending: number;
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
                      {NAMES[job.agent]}
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
            // Clicking anywhere on the card opens its details; the title button provides keyboard access.
            <article
              className="card need need-session"
              key={session.id}
              data-session={session.id}
              data-opens-panel=""
              style={{ '--i': jobs.length + index } as CSSProperties}
              onClick={() => {
                // Selecting the prompt's text to copy it ends in a click too.
                if (!getSelection()?.isCollapsed) return;
                openSession(session.id);
              }}
            >
              <div className="need-head">
                <div className="need-bar">
                  <Chip state="waiting">Input</Chip>
                  <span className="need-who" title={projectOf(session)}>
                    <AgentMark agent="claude" size={13} />
                    <span>Claude</span>
                  </span>
                  <OpenInClaude session={session} small />
                </div>
                <button className="need-title" data-opens-panel="" title={session.title} onClick={(event) => { event.stopPropagation(); openSession(session.id); }}>
                  {session.title}
                </button>
              </div>
              <div className="answer">
                <p className="headline selectable">{session.waitingFor ?? 'Claude needs your input.'}</p>
                <ClaudeAsk session={session} />
                {!session.desktopId && <p className="callout secondary"><Icon icon={ChatMultipleRegular} size={13} /> Answer in Claude.</p>}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
