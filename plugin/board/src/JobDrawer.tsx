import { useEffect, useState } from 'react';
import { Check, CircleStop, FileText, GitBranch, MessageSquare, NotebookText, RotateCcw, ShieldAlert, TriangleAlert, Undo2, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { BoardJob, CrewEvent, Snapshot } from './types.ts';
import { actions, drafts, request } from './api.ts';
import { board, mergeEvents } from './store.ts';
import { elapsed, jobLabel, NAMES, projectOf, ROLE_NAMES } from './model.ts';
import { ActionStatus, CloseButton, CopyButton, Dialog, Icon, Chip, useAction, useDraft, useNow } from './ui.tsx';
import { Answer } from './NeedsYou.tsx';
import { EventList } from './Overview.tsx';
import { jobStatusState } from './Missions.tsx';

function Section({ title, icon, children }: { title: string; icon: LucideIcon; children: ReactNode }) {
  return (
    <section className="detail-section" aria-label={title}>
      <h3>
        <Icon icon={icon} />
        {title}
      </h3>
      {children}
    </section>
  );
}

function RoundRow({ job, round }: { job: BoardJob; round: NonNullable<BoardJob['rounds']>[number] }) {
  const key = `round:${job.id}:${round.turn}`;
  const action = useAction(key);
  const reason =
    job.state === 'running' || job.state === 'waiting'
      ? 'Wait until the job has stopped before changing rounds.'
      : !job.worktree ? 'This job has no worktree.' : undefined;
  const undone = round.state === 'undone';
  return (
    <div className="round">
      <div className="round-head">
        <b>Turn {round.turn}</b>
        <span>
          <Icon icon={undone ? Undo2 : Check} size={11} />
          {undone ? 'Undone' : 'Kept'}
        </span>
        <button
          disabled={Boolean(reason) || action.pending || board.getSnapshot().connection !== 'live'}
          title={reason ?? 'Change this round on the job branch.'}
          onClick={() => {
            void actions.run(key, async () => {
              const updated = await request<BoardJob>(`/api/jobs/${job.id}/rounds/${round.turn}`, undone ? { keep: true } : { undo: true });
              board.receive('job', updated);
            }, { once: false, done: '' });
          }}
        >
          {undone ? 'Keep' : 'Undo'}
        </button>
      </div>
      <pre>{round.stat || 'No files changed'}</pre>
      <ActionStatus actionKey={key} />
    </div>
  );
}

function FollowUp({ job }: { job: BoardJob }) {
  const key = `followup:${job.id}`;
  const [draft, setDraft] = useDraft(key);
  const state = useAction(key);
  const name = NAMES[job.agent];
  return (
    <Section title={job.endedAt == null ? 'Steer' : 'Follow up'} icon={MessageSquare}>
      <textarea aria-label={`Message to ${name}`} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div>
        <button
          className="prominent"
          disabled={!draft.trim() || state.pending || board.getSnapshot().connection !== 'live'}
          onClick={async () => {
            const message = draft;
            const sent = await actions.run(key, () => request(`/api/jobs/${job.id}/reply`, { message }), { once: false });
            // Text typed while sending stays for the next message.
            if (sent && drafts.get(key) === message) setDraft('');
          }}
        >
          Send message
        </button>
      </div>
      <ActionStatus actionKey={key} />
    </Section>
  );
}

/** JobDetailView in the app: status and close, then the job, its facts, results and controls. */
export function JobDrawer({ id, state, close, openJob }: { id: string; state: Snapshot; close: () => void; openJob: (id: string) => void }) {
  const [detail, setDetail] = useState<BoardJob | null>(null);
  const [log, setLog] = useState<CrewEvent[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const now = useNow();
  const current = state.jobs.find((job) => job.id === id);
  const job = detail ? { ...detail, ...current, prompt: detail.prompt ?? current?.prompt } : current;
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
  const events = mergeEvents(log, state.events.filter((event) => event.job_id === id), 80);
  const refusals = job?.refusals?.filter((refusal) => refusal.turn === job.turns) ?? [];
  const live = state.connection === 'live';
  const facts: [string, string][] = job
    ? [
        ['Agent', [NAMES[job.agent], job.model, job.effort && `${job.effort} effort`].filter(Boolean).join(' · ')],
        ['Role', job.ask ? 'Question' : (ROLE_NAMES[job.kind] ?? job.kind)],
        ['Project', projectOf(job)],
        ['Duration', elapsed((job.endedAt ?? now) - job.createdAt)],
        ...(job.worktree ? [['Branch', `${job.worktree.branch} (from ${job.worktree.base.slice(0, 8)})`] as [string, string]] : []),
        ...(job.tokens != null ? [['Tokens', job.tokens.toLocaleString()] as [string, string]] : []),
        ...(job.tokenUse
          ? [['Of which', `${job.tokenUse.cachedInput.toLocaleString()} cached input · ${(job.tokenUse.input - job.tokenUse.cachedInput).toLocaleString()} uncached input · ${job.tokenUse.output.toLocaleString()} output${job.turns > 1 ? ` · ${job.tokenUse.turn.toLocaleString()} in the latest turn` : ''}`] as [string, string]]
          : []),
        ['Turns', String(job.turns)],
        ...(job.shared?.length ? [['Instructions', job.shared.join('\n')] as [string, string]] : []),
      ]
    : [];
  const result = job?.result;
  const files = result ? [...new Set([...result.files, ...result.outOfScope])].sort() : [];
  return (
    <Dialog variant="detail-panel" label={job?.title ?? 'Job details'} onClose={close}>
      <div className="detail-head">
        {job ? <Chip state={jobStatusState(job)}>{jobLabel(job)}</Chip> : <span />}
        <CloseButton label="Close details" onClose={close} />
      </div>
      <div className="detail-scroll">
        {error && (
          <div role="alert" className="detail-title">
            <p className="error selectable">{error}</p>
            <div>
              <button onClick={() => setRetry((value) => value + 1)}>
                <Icon icon={RotateCcw} />
                Retry
              </button>
            </div>
          </div>
        )}
        {!job && !error && (
          <p className="secondary" role="status">
            Loading details…
          </p>
        )}
        {job && (
          <>
            <div className="detail-title">
              <h2 className="title selectable" id="drawer-title">{job.title}</h2>
              {job.endedAt == null && <p className="secondary selectable">{job.phase}</p>}
              {job.error && <p className="error selectable">{job.error.message}</p>}
            </div>
            {job.state === 'waiting' && (
              <div className="card answer-card">
                <Answer job={job} />
              </div>
            )}
            <dl className="facts selectable">
              {facts.map(([label, value]) => (
                <div key={label} style={{ display: 'contents' }}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            {result && (
              <Section title="Changes" icon={GitBranch}>
                <pre className="selectable">{result.stat || 'No files changed'}</pre>
                {result.commit && <p className="caption selectable">Commit {result.commit}</p>}
                {files.map((file) => (
                  <div className="file" key={file}>
                    <code className="selectable">{file}</code>
                    {result.outOfScope.includes(file) && (
                      <span className="caption error">
                        <Icon icon={TriangleAlert} size={11} />{' '}
                        {result.files.includes(file) ? 'Outside the allowed targets' : 'Outside the workspace'}
                      </span>
                    )}
                  </div>
                ))}
                {job.worktree && result.files.length > 0 && (
                  <div>
                    <CopyButton text={`git diff ${job.worktree.base.slice(0, 8)}..${job.worktree.branch}`}>Copy diff command</CopyButton>
                  </div>
                )}
              </Section>
            )}
            {!!job.rounds?.length && (
              <Section title="Rounds" icon={RotateCcw}>
                {job.rounds.toSorted((a, b) => a.turn - b.turn).map((round) => (
                  <RoundRow key={round.turn} job={job} round={round} />
                ))}
              </Section>
            )}
            {refusals.length > 0 && (
              <Section title="Automatic review" icon={ShieldAlert}>
                {refusals.map((refusal, index) => (
                  <p className="callout error selectable" key={index}>
                    {refusal.action} — {refusal.reason}
                  </p>
                ))}
                {job.retrying && <p className="callout secondary">Sent back once with your approval.</p>}
              </Section>
            )}
            {job.notes.length > 0 && (
              <Section title="Notes" icon={NotebookText}>
                {job.notes.map((note, index) => (
                  <p className="callout selectable" key={index}>{note}</p>
                ))}
              </Section>
            )}
            {job.report && (
              <Section title="Report" icon={FileText}>
                <pre className="report selectable">{job.report}</pre>
              </Section>
            )}
            {job.sessionId && job.state !== 'waiting' && <FollowUp key={job.id} job={job} />}
            {job.prompt && (
              <details className="disclosure-group">
                <summary>Original task</summary>
                <pre className="callout selectable">{job.prompt}</pre>
              </details>
            )}
            {events.length > 0 && (
              <Section title="Activity" icon={Zap}>
                <EventList events={events} openJob={openJob} />
              </Section>
            )}
            <footer className="detail-foot">
              <div>
                {job.sessionId && state.agents[job.agent] && (
                  <CopyButton text={`${state.agents[job.agent].resume} ${job.sessionId}`}>Copy resume command</CopyButton>
                )}
                {job.endedAt == null && (
                  <button
                    className="destructive"
                    disabled={!live || cancelling.pending || cancelling.accepted}
                    onClick={() => void actions.run(cancelKey, () => request(`/api/jobs/${job.id}/cancel`, {}), { done: 'Cancelled' })}
                  >
                    <Icon icon={CircleStop} />
                    Cancel Job
                  </button>
                )}
              </div>
              <ActionStatus actionKey={cancelKey} />
              <code className="selectable">{job.id}</code>
            </footer>
          </>
        )}
      </div>
    </Dialog>
  );
}
