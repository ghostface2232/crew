import {
  ArrowUpRight16Filled, ChatMultipleRegular, CheckmarkCircleRegular, CheckmarkRegular, DismissRegular,
  SearchRegular,
} from '@fluentui/react-icons';
import { useSyncExternalStore } from 'react';
import type { CSSProperties } from 'react';
import type { BoardJob, ClaudeSession } from './types.ts';
import { board } from './store.ts';
import { actions, answerKey, request } from './api.ts';
import { NAMES, projectOf, sessionAgent } from './model.ts';
import { ActionStatus, AgentMark, Chip, Composer, EmptyState, Icon, useAction, useDraft, Elapsed } from './ui.tsx';
import { t } from './i18n.ts';

/** The link that opens the session in its desktop app; a session in a terminal has none, Claude's or Codex's. */
export function sessionAppLink(session: ClaudeSession): string | null {
  const id = session.desktopId;
  if (!id) return null;
  if (sessionAgent(session) === 'codex') return /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id) ? `codex://threads/${id}` : null;
  return `claude://code/continue?session=${encodeURIComponent(id)}`;
}

/** Opens the session in its agent's desktop app, where its prompts are answered. */
export function OpenInAgent({ session, small }: { session: ClaudeSession; small?: boolean }) {
  const link = sessionAppLink(session);
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
      {t('Open in {agent}', { agent: NAMES[sessionAgent(session)] })}
    </button>
  );
}

/** What a waiting Claude session asks beyond its headline: each question's choices, or the tool input an approval is for. */
export function ClaudeAsk({ session }: { session: ClaudeSession }) {
  const ask = session.ask;
  if (session.state !== 'waiting' || !ask) return null;
  if (ask.questions) {
    return (
      <div className="ask">
        {ask.questions.map((question, index) => (
          <div className="ask" key={index}>
            {/* The first question is the card's headline. */}
            {index > 0 && <p className="headline selectable">{question.question}</p>}
            {question.options.length > 0 && (
              <ol className="ask-options" aria-label={question.multiSelect ? t('Choices, any number') : t('Choices')}>
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
            label={t('Your answer')}
            placeholder={t('Write an answer…')}
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
            {button(t('No'), 'deny', false)}
            {button(t('Yes'), 'approve', false)}
          </div>
        </>
      ) : (
        <div className="answer-actions" data-approval>
          <ActionStatus actionKey={key} />
          {button(t('Deny'), 'deny', false)}
          {waiting.grant && button(t('Allow for This Job'), 'allow_for_job', false, t("Also allow this job's later requests for {grant}, without asking", { grant: waiting.grant }))}
          {button(t('Approve'), 'approve', true)}
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
        <EmptyState title={t('All caught up')} icon={CheckmarkCircleRegular} />
      ) : (
        !jobs.length && !sessions.length && <EmptyState title={t('No matching requests')} icon={SearchRegular} />
      )}
      {(jobs.length > 0 || sessions.length > 0) && (
        <div className="needs-grid">
          {jobs.map((job, index) => (
            <article className="card need" key={job.id} data-job={job.id} data-flip={`need:${job.id}`} style={{ '--i': index } as CSSProperties}>
              <div className="need-head">
                <div className="need-bar">
                  <Chip state="waiting">{job.waiting?.type === 'approval' ? t('Approval') : t('Question')}</Chip>
                  <span className="need-who" title={projectOf(job)}>
                    <AgentMark agent={job.agent} size={13} />
                    <span>
                      {NAMES[job.agent]}
                    </span>
                  </span>
                  {job.waiting && <span className="need-age digits"><Elapsed start={job.waiting.since} /></span>}
                  <button className="caption small" data-opens-panel="" onClick={() => openJob(job.id)}>
                    <Icon icon={ArrowUpRight16Filled} size={12} />
                    {t('Details')}
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
              data-flip={`need:session:${session.id}`}
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
                  <Chip state="waiting">{t('Input')}</Chip>
                  <span className="need-who" title={projectOf(session)}>
                    <AgentMark agent={sessionAgent(session)} size={13} />
                    <span>{NAMES[sessionAgent(session)]}</span>
                  </span>
                  <OpenInAgent session={session} small />
                </div>
                <button className="need-title" data-opens-panel="" title={session.title} onClick={(event) => { event.stopPropagation(); openSession(session.id); }}>
                  {session.title}
                </button>
              </div>
              <div className="answer">
                <p className="headline selectable">{session.waitingFor ?? t('{agent} needs your input.', { agent: NAMES[sessionAgent(session)] })}</p>
                <ClaudeAsk session={session} />
                {!sessionAppLink(session) && <p className="callout secondary"><Icon icon={ChatMultipleRegular} size={13} /> {t('Answer in {agent}.', { agent: NAMES[sessionAgent(session)] })}</p>}
              </div>
            </article>
          ))}
        </div>
      )}
    </>
  );
}
