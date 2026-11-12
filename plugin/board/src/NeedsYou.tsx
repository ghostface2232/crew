import type { BoardJob, Snapshot } from './types.ts';
import { actions, answerKey, request } from './api.ts';
import { NAMES, projectOf, shortPath } from './model.ts';
import { ActionStatus, Chip, Composer, useAction } from './ui.tsx';

export function Answer({ job }: { job: BoardJob }) {
  const waiting = job.waiting;
  const key = answerKey(job.id, waiting?.id ?? '');
  const state = useAction(key);
  if (job.state !== 'waiting' || !waiting) return null;
  const reply = (body: object) => request(`/api/jobs/${job.id}/reply`, { ...body, request_id: waiting.id });
  return (
    <div className="callout">
      <p>{waiting.reason}</p>
      {waiting.type === 'question' && (
        <Composer
          key={waiting.id}
          label="Your answer"
          placeholder="Type an answer"
          actionKey={key}
          once
          onSend={(message) => reply({ message })}
        />
      )}
      <div className="actions">
        <button
          className="primary"
          disabled={state.pending || state.accepted}
          onClick={() => void actions.run(key, () => reply({ decision: 'approve' }))}
        >
          {waiting.type === 'approval' ? 'Approve' : 'Yes'}
        </button>
        <button
          disabled={state.pending || state.accepted}
          onClick={() => void actions.run(key, () => reply({ decision: 'deny' }))}
        >
          {waiting.type === 'approval' ? 'Deny' : 'No'}
        </button>
      </div>
      {waiting.type === 'approval' && <ActionStatus actionKey={key} />}
    </div>
  );
}
export function NeedsYou({ state, openJob }: { state: Snapshot; openJob: (id: string) => void }) {
  const jobs = state.jobs
    .filter((job) => job.state === 'waiting')
    .sort((a, b) => (a.waiting?.since ?? 0) - (b.waiting?.since ?? 0));
  const sessions = state.claude.filter((session) => session.state === 'waiting');
  const total = jobs.length + sessions.length;
  if (!total) return null;
  return (
    <section className="attention" aria-labelledby="needs-title">
      <header>
        <h2 id="needs-title">
          Needs you <span className="count">{total}</span>
        </h2>
        <p className="hint">Across all projects · paused until you answer</p>
      </header>
      <div className="attention-list">
        {jobs.map((job) => (
          <article className="card need" key={job.id}>
            <div className="need-bar">
              <Chip state="waiting">{job.waiting?.type === 'approval' ? 'Approval' : 'Question'}</Chip>
              <button className="quiet" onClick={() => openJob(job.id)}>
                Details
              </button>
            </div>
            <div className="need-head">
              <span className="agent-well" aria-hidden="true">
                {NAMES[job.agent][0]}
              </span>
              <div>
                <p className="need-title">{NAMES[job.agent]} needs your input</p>
                <p className="need-who">
                  {job.title} · {shortPath(projectOf(job))}
                </p>
              </div>
            </div>
            <Answer job={job} />
          </article>
        ))}
        {sessions.map((session) => (
          <article className="card need" key={session.id}>
            <Chip state="waiting">Claude needs your input</Chip>
            <h3>{session.title}</h3>
            <p className="detail" data-wrap>
              {session.waitingFor}
            </p>
            <p className="hint">Answer in the Claude app, in the session that asked.</p>
          </article>
        ))}
      </div>
    </section>
  );
}
