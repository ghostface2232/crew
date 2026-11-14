import { useEffect, useState } from 'react';
import { Check, CircleStop, Clock, FileText, GitBranch, History, Images, MessageSquare, NotebookText, RotateCcw, ShieldAlert, ShieldCheck, TriangleAlert, Undo2, X, Zap } from 'lucide-react';
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

/** What the worker saw, newest turn first, and what the lead attached. */
function EvidenceSection({ job }: { job: BoardJob }) {
  const items = (job.evidence ?? []).toSorted((a, b) => b.turn - a.turn);
  if (!items.length) return null;
  return (
    <Section title="Evidence" icon={Images}>
      <div className="evidence">
        {items.map((item) => {
          // The version keeps a cached copy from standing in for a file rewritten under the same name.
          const src = `/api/jobs/${encodeURIComponent(job.id)}/evidence/${encodeURIComponent(item.file)}?v=${item.modified}`;
          return (
            <figure key={item.file}>
              {item.file.match(/\.(webm|mp4)$/i) ? (
                <video src={src} controls preload="metadata" />
              ) : (
                <a href={src} target="_blank" rel="noreferrer">
                  <img src={src} alt={item.file} loading="lazy" />
                </a>
              )}
              <figcaption className="caption secondary selectable">
                {item.from === 'lead' ? 'Attached by the lead' : `Turn ${item.turn}`} · {item.file}
              </figcaption>
            </figure>
          );
        })}
      </div>
    </Section>
  );
}

const NETWORK: Record<NonNullable<BoardJob['capabilities']>['network'], string> = {
  on: 'network on',
  off: 'no network',
  'agent-managed': 'network as the agent allows',
};

function duration(ms: number) {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : elapsed(ms);
}

/** The latest turn's receipt: the check the bridge ran itself, or what a review looked at. */
function ReceiptView({ receipt }: { receipt: NonNullable<BoardJob['receipts']>[number] }) {
  const { check, reviewed, stale } = receipt;
  if (!check && !reviewed) return null;
  const at = receipt.head ? ` · ${receipt.head.slice(0, 8)}` : '';
  const passed = check?.exit === 0 && !check.timedOut;
  const [state, icon, label] = !check
    ? (['done', Check, 'Reviewed'] as const)
    : passed
      ? (['done', Check, 'Check passed'] as const)
      : check.timedOut
        ? (['waiting', Clock, `Check timed out after ${duration(check.ms)}`] as const)
        : check.exit == null
          ? (['failed', X, 'Check stopped before it finished'] as const)
          : (['failed', X, `Check failed with exit code ${check.exit}`] as const);
  return (
    // A stale receipt keeps its words but loses its color: it no longer speaks for the branch.
    <div className="receipt" data-state={stale ? 'idle' : state}>
      <p className="receipt-status">
        <Icon icon={icon} size={12} />
        {label}
      </p>
      {check ? (
        <code className="selectable">{check.command}</code>
      ) : (
        <code className="selectable">{reviewed!.target}</code>
      )}
      <p className="caption secondary selectable">
        Turn {receipt.turn}
        {at}
        {check && ` · ${duration(check.ms)}${check.sandboxed ? '' : ' · not sandboxed'}`}
        {reviewed?.diff && ` · diff ${reviewed.diff}`}
      </p>
      {stale && (
        <p className="callout secondary selectable">
          <Icon icon={History} size={11} /> No longer current: {stale}
        </p>
      )}
      {check && !passed && check.output && (
        <details className="disclosure-group">
          <summary>Output (end)</summary>
          <pre className="selectable">{check.output.split('\n').slice(-15).join('\n')}</pre>
        </details>
      )}
    </div>
  );
}

function approvalBasis({ recorded, matched }: NonNullable<BoardJob['approvals']>[number]) {
  if (!recorded) return 'no messages of the user were recorded, so only the lead’s quote went with it';
  return matched ? 'the user’s own words went with it, and the quote matches them' : 'the user’s own words went with it; the quote is a translation or paraphrase';
}

/** What backs the result: the latest check or review, what the worker could reach, and relayed approvals. */
function VerificationSection({ job }: { job: BoardJob }) {
  const receipt = job.receipts?.at(-1);
  const shown = receipt && (receipt.check || receipt.reviewed);
  const capabilities = job.capabilities;
  const approvals = job.approvals ?? [];
  if (!shown && !capabilities && !approvals.length) return null;
  return (
    <Section title="Verification" icon={ShieldCheck}>
      {shown && <ReceiptView receipt={receipt} />}
      {capabilities && (
        <dl className="facts selectable">
          <dt>Runs with</dt>
          <dd>
            {[
              capabilities.filesystem,
              NETWORK[capabilities.network],
              capabilities.plugins.length && `plugins ${capabilities.plugins.join(', ')} (act outside the sandbox)`,
            ].filter(Boolean).join(' · ')}
          </dd>
        </dl>
      )}
      {approvals.map((approval, index) => (
        <div className="approval selectable" key={index}>
          <p className="callout">Approval relayed for turn {approval.turn} — {approvalBasis(approval)}.</p>
          <p className="caption secondary">“{approval.quote}”</p>
        </div>
      ))}
    </Section>
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
            const message = draft.trim();
            const sent = await actions.run(key, () => request(`/api/jobs/${job.id}/reply`, { message }), { once: false });
            // Text typed while sending stays for the next message.
            if (sent && drafts.get(key)?.trim() === message) setDraft('');
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
export function JobDrawer({ id, state, close }: { id: string; state: Snapshot; close: () => void }) {
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
        // The model the session reported, else the configured one.
        ['Agent', [NAMES[job.agent], job.resolvedModel ?? job.model, (job.resolvedEffort ?? job.effort) && `${job.resolvedEffort ?? job.effort} effort`].filter(Boolean).join(' · ')],
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
            <VerificationSection job={job} />
            <EvidenceSection job={job} />
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
                <EventList events={events} />
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
