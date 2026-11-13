import { useEffect, useState } from 'react';
import type { BoardJob, CrewEvent, Snapshot } from './types.ts';
import { actions, request } from './api.ts';
import { board, mergeEvents } from './store.ts';
import { brief, jobLabel, jobMark, NAMES, projectOf } from './model.ts';
import { ActionStatus, Chip, Composer, CopyButton, Dialog, useAction, useNow } from './ui.tsx';
import { Answer } from './NeedsYou.tsx';
import { EventList } from './Overview.tsx';

function RoundRow({ job, round }: { job: BoardJob; round: NonNullable<BoardJob['rounds']>[number] }) {
  const key = `round:${job.id}:${round.turn}`;
  const action = useAction(key);
  const reason =
    job.state === 'running' || job.state === 'waiting'
      ? 'Wait until the job has stopped before changing a round.'
      : !job.worktree ? 'This job has no worktree.' : undefined;
  return (
    <li className="round">
      <div className="row">
        <span>
          Turn {round.turn} · {round.files.length} {round.files.length === 1 ? 'file' : 'files'} ·{' '}
          {round.state === 'kept' ? 'Kept' : 'Undone'}
        </span>
        <button
          disabled={Boolean(reason) || action.pending}
          title={reason}
          onClick={() => {
            void actions.run(key, async () => {
              const updated = await request<BoardJob>(
                `/api/jobs/${job.id}/rounds/${round.turn}`,
                round.state === 'kept' ? { undo: true } : { keep: true },
              );
              board.receive('job', updated);
            }, { once: false, done: '' });
          }}
        >
          {round.state === 'kept' ? 'Undo' : 'Keep'}
        </button>
      </div>
      <p className="hint">{round.stat || 'No files changed'}</p>
      <ActionStatus actionKey={key} />
    </li>
  );
}

export function JobDrawer({ id, state, close }: { id: string; state: Snapshot; close: () => void }) {
  const [detail, setDetail] = useState<BoardJob | null>(null);
  const [log, setLog] = useState<CrewEvent[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const now = useNow();
  const current = state.jobs.find((job) => job.id === id);
  const job = detail ? { ...detail, ...current } : current;
  const cancelKey = `cancel:${id}:${job?.turns ?? 1}`;
  const cancelling = useAction(cancelKey);
  useEffect(() => {
    const abort = new AbortController();
    setError('');
    void Promise.all([
      request<BoardJob>(`/api/jobs/${id}`, undefined, abort.signal),
      request<CrewEvent[]>(`/api/jobs/${id}/events`, undefined, abort.signal),
    ]).then(
      ([result, events]) => {
        if (!abort.signal.aborted) {
          setDetail(result);
          setLog(events);
        }
      },
      (cause: Error) => {
        if (!abort.signal.aborted) setError(cause.message);
      },
    );
    return () => abort.abort();
  }, [id, retry, state.revision]);
  const events = mergeEvents(
    log,
    state.events.filter((event) => event.job_id === id),
    80,
  );
  const outside = new Set(job?.result?.outOfScope ?? []);
  const files = job?.result?.files ?? [];
  const refusals = job?.refusals?.filter((refusal) => refusal.turn === job.turns) ?? [];
  return (
    <Dialog title={job?.title ?? 'Job details'} labelId="drawer-title" onClose={close}>
      {error && (
        <div className="notice" role="alert">
          {error} <button onClick={() => setRetry((value) => value + 1)}>Retry</button>
        </div>
      )}
      {!detail && !error && (
        <p className="hint" role="status">
          Loading details…
        </p>
      )}
      {job && (
        <>
          <div className="row">
            <Chip state={jobMark(job)}>{jobLabel(job)}</Chip>
            <span className="kind">{job.ask ? 'Question' : job.kind}</span>
            <span className="timer">{brief((job.endedAt ?? now) - job.createdAt)}</span>
          </div>
          {job.state === 'running' && (
            <p className="detail" data-wrap>
              {job.phase}
            </p>
          )}
          {job.error && (
            <p className="detail" data-wrap data-tone="failed">
              {job.error.message}
            </p>
          )}
          <Answer job={job} />
          <dl className="facts">
            {[
              [
                'Agent',
                [NAMES[job.agent], job.model, job.effort && `${job.effort} effort`].filter(Boolean).join(' · '),
              ],
              ['Project', projectOf(job)],
              ...(job.worktree ? [['Branch', `${job.worktree.branch} (from ${job.worktree.base.slice(0, 8)})`]] : []),
              ...(job.tokens != null ? [['Tokens', job.tokens.toLocaleString()]] : []),
              ...(job.tokenUse
                ? [['Of which', `${job.tokenUse.cachedInput.toLocaleString()} cached input · ${(job.tokenUse.input - job.tokenUse.cachedInput).toLocaleString()} new input · ${job.tokenUse.output.toLocaleString()} output`]]
                : []),
              ['Turns', String(job.turns)],
              ...(job.shared?.length ? [['Shared instructions', job.shared.join('\n')]] : []),
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {!!job.rounds?.length && (
            <section className="section" aria-label="Rounds">
              <h3>Rounds</h3>
              <ol className="rounds">
                {job.rounds.toSorted((a, b) => a.turn - b.turn).map((round) => (
                  <RoundRow key={round.turn} job={job} round={round} />
                ))}
              </ol>
            </section>
          )}
          {job.result && (
            <section className="section">
              <h3>Changes</h3>
              <p className="detail" data-wrap>
                {job.result.stat || 'No files changed'}
                {job.result.commit && ` · commit ${job.result.commit}`}
              </p>
              <ul className="files">
                {files.map((file) => (
                  <li key={file} data-tone={outside.has(file) ? 'failed' : undefined}>
                    {file}
                    {outside.has(file) && ' — outside the allowed targets'}
                  </li>
                ))}
              </ul>
              {[...outside]
                .filter((file) => !files.includes(file))
                .map((file) => (
                  <p className="detail" data-wrap data-tone="failed" key={file}>
                    {file} — outside the workspace
                  </p>
                ))}
              {job.worktree && files.length > 0 && (
                <CopyButton text={`git diff ${job.worktree.base.slice(0, 8)}..${job.worktree.branch}`}>
                  Copy diff command
                </CopyButton>
              )}
            </section>
          )}
          {refusals.length > 0 && (
            <section className="section">
              <h3>Refused by the automatic reviewer</h3>
              <ul className="notes">
                {refusals.map((refusal, index) => (
                  <li key={index} data-tone="failed">
                    <code>{refusal.action}</code> — {refusal.reason}
                  </li>
                ))}
              </ul>
              {job.retrying && <p className="hint">Sent back once with your approval.</p>}
            </section>
          )}
          {job.notes.length > 0 && (
            <section className="section">
              <h3>Notes</h3>
              <ul className="notes">
                {job.notes.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </section>
          )}
          {job.report && (
            <section className="section">
              <h3>Report</h3>
              <pre className="prose">{job.report}</pre>
            </section>
          )}
          {job.sessionId && job.state !== 'waiting' && (
            <section className="section">
              <h3>{job.endedAt ? 'Follow up' : 'Steer'}</h3>
              <Composer
                key={job.id}
                label={`Message to ${NAMES[job.agent]}`}
                placeholder={
                  job.endedAt
                    ? 'Ask for a fix or a change; the same session continues'
                    : 'Add a note to the work in progress'
                }
                actionKey={`followup:${job.id}`}
                onSend={(message) => request(`/api/jobs/${job.id}/reply`, { message })}
              />
            </section>
          )}
          {job.prompt && (
            <details className="section">
              <summary>Task given to {NAMES[job.agent]}</summary>
              <pre className="prose">{job.prompt}</pre>
            </details>
          )}
          {events.length > 0 && (
            <section className="section">
              <h3>Activity</h3>
              <EventList events={events} state={state} />
            </section>
          )}
          <footer className="row foot">
            <span className="id">{job.id}</span>
            <div className="actions">
              {job.sessionId && state.agents[job.agent] && (
                <CopyButton text={`${state.agents[job.agent].resume} ${job.sessionId}`}>Copy resume command</CopyButton>
              )}
              {!job.endedAt && (
                <button
                  className="quiet"
                  disabled={cancelling.pending || cancelling.accepted}
                  onClick={() =>
                    void actions.run(cancelKey, () => request(`/api/jobs/${job.id}/cancel`, {}), { done: 'Cancelled' })
                  }
                >
                  Cancel job
                </button>
              )}
            </div>
          </footer>
          <ActionStatus actionKey={cancelKey} />
        </>
      )}
    </Dialog>
  );
}
