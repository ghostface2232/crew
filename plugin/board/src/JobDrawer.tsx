import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowCounterclockwiseRegular, ArrowUndoRegular, BranchFork16Regular, BranchRegular, ChatRegular,
  CheckmarkCircle16Regular, CheckmarkCircleRegular, CheckmarkRegular, CheckmarkStarburstRegular, ChevronDownRegular,
  CircleHintRegular, CircleMultipleConcentricRegular, ClockRegular, DismissCircle16Regular, DismissRegular,
  DocumentTextRegular, FilmstripRegular, FlagCheckeredRegular, FlagRegular, FlashRegular, HistoryRegular,
  ImageMultipleRegular, NotebookRegular, PeopleRegular, QuestionCircleRegular, RecordStopRegular,
  ShieldCheckmarkRegular, ShieldErrorRegular, SubtractCircleRegular, TextAlignLeftRegular, WarningRegular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import type { BoardJob, CrewEvent, Snapshot } from './types.ts';
import { actions, drafts, request } from './api.ts';
import { board, mergeEvents } from './store.ts';
import { elapsed, evidenceTurn, jobLabel, jobRole, MAX_COMPARED, NAMES, orderEvidence, projectOf, roleLabel } from './model.ts';
import { ActionStatus, CloseButton, CopyButton, CopyMenu, Dialog, Icon, Chip, useAction, useDraft, Elapsed, useStableItems } from './ui.tsx';
import { ReportText as RenderReport } from './Report.ts';
import { debatePoints, stanceCounts } from './debate.ts';
import type { Stance } from './debate.ts';
import { Answer } from './NeedsYou.tsx';
import { EventList } from './Overview.tsx';
import { jobStatusState, SessionAgents, SessionWorkflow } from './Missions.tsx';

/** Reports are parsed once per text, not on every clock tick the panel renders for. */
const ReportText = memo(RenderReport);

function Section({ title, icon, children }: { title: string; icon: FluentIcon; children: ReactNode }) {
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
          <Icon icon={undone ? ArrowUndoRegular : CheckmarkRegular} size={11} />
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

type EvidenceItem = NonNullable<BoardJob['evidence']>[number];
const isVideo = (file: string) => /\.(webm|mp4)$/i.test(file);
// The version keeps a cached copy from standing in for a file rewritten under the same name. The seal stands in
// for the credential, which an image, a video or a new tab cannot send.
const evidenceSrc = (job: BoardJob, item: EvidenceItem) => `/api/jobs/${encodeURIComponent(job.id)}/evidence/${encodeURIComponent(item.file)}?v=${item.modified}${item.sig ? `&sig=${item.sig}` : ''}`;

/** What the worker saw, newest turn first, and what the lead attached. */
/** What a running Codex turn has changed so far. The daemon keeps it only while the turn runs. */
function LiveDiffSection({ job }: { job: BoardJob }) {
  const [diff, setDiff] = useState('');
  const at = job.endedAt == null ? job.liveDiff?.at : undefined;
  useEffect(() => {
    // The previous diff stays up until the newer one arrives.
    if (!at) {
      setDiff('');
      return;
    }
    const abort = new AbortController();
    request<{ diff: string }>(`/api/jobs/${job.id}/diff`, undefined, abort.signal).then(
      (result) => { if (!abort.signal.aborted) setDiff(result.diff); },
      () => {},
    );
    return () => abort.abort();
  }, [job.id, at]);
  if (!at || !diff) return null;
  return (
    <Section title="Changes so far" icon={BranchRegular}>
      <pre className="selectable live-diff">{diff}</pre>
    </Section>
  );
}

function EvidenceSection({ job }: { job: BoardJob }) {
  const items = (job.evidence ?? []).toSorted((a, b) => b.turn - a.turn);
  const [picked, setPicked] = useState<string[]>([]);
  if (!items.length) return null;
  // A capture the worker has since deleted leaves the comparison.
  const compared = picked.filter((file) => items.some((item) => item.file === file));
  return (
    <Section title="Evidence" icon={ImageMultipleRegular}>
      <div className="evidence">
        {items.map((item) => {
          const src = evidenceSrc(job, item);
          return (
            <figure key={item.file}>
              {isVideo(item.file) ? (
                <video src={src} controls preload="metadata" />
              ) : (
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  title="Open"
                  onClick={(event) => {
                    // A plain press opens it here, where others can be added beside it; a modified one opens the file.
                    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                    event.preventDefault();
                    setPicked([item.file]);
                  }}
                >
                  <img src={src} alt={item.file} loading="lazy" />
                </a>
              )}
              <figcaption className="caption secondary selectable">
                {evidenceTurn(item, job.turns)} · {item.file}
              </figcaption>
            </figure>
          );
        })}
      </div>
      {compared.length > 0 && <EvidenceCompare job={job} items={items} shown={compared} onShown={setPicked} />}
    </Section>
  );
}

/**
 * A capture, and the others added beside it from the strip below. A result alone says little: it is judged against
 * what was there before, or what it was meant to match. Each says which turn it is from, since one from an earlier
 * turn may not show the final state.
 */
function EvidenceCompare({ job, items, shown, onShown }: { job: BoardJob; items: EvidenceItem[]; shown: string[]; onShown: (files: string[]) => void }) {
  const close = () => onShown([]);
  const caption = (item: EvidenceItem) => evidenceTurn(item, job.turns);
  return (
    <Dialog labelId="evidence-compare-title" className="evidence-compare" onClose={close}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 className="title" id="evidence-compare-title">Evidence</h2>
          <CloseButton label="Close" onClose={close} />
        </div>
        <div className="compare" data-panes={shown.length}>
          {orderEvidence(items.filter((item) => shown.includes(item.file))).map((item) => {
            const src = evidenceSrc(job, item);
            return (
              <figure key={item.file}>
                {isVideo(item.file) ? <video src={src} controls preload="metadata" /> : <img src={src} alt={item.file} />}
                <figcaption className="caption selectable">
                  <b>{caption(item)}</b>
                  <a className="secondary" href={src} target="_blank" rel="noreferrer">{item.file}</a>
                </figcaption>
              </figure>
            );
          })}
        </div>
        {items.length > 1 && (
          <div className="compare-picker" role="group" aria-label={`Captures to compare, up to ${MAX_COMPARED}`}>
            {orderEvidence(items).map((item) => {
              const on = shown.includes(item.file);
              return (
                <button
                  key={item.file}
                  type="button"
                  aria-pressed={on}
                  // The last one stays, and a fourth has no room.
                  disabled={on ? shown.length === 1 : shown.length >= MAX_COMPARED}
                  title={item.file}
                  onClick={() => onShown(on ? shown.filter((file) => file !== item.file) : [...shown, item.file])}
                >
                  {isVideo(item.file) ? <span className="compare-video"><Icon icon={FilmstripRegular} /></span> : <img src={evidenceSrc(job, item)} alt="" loading="lazy" />}
                  <span className="caption">{caption(item)}</span>
                  <span className="caption secondary">{item.file}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}

const NETWORK: Record<NonNullable<BoardJob['capabilities']>['network'], string> = {
  on: 'network on',
  off: 'no network',
  'agent-managed': 'network as the agent allows',
};

/** Which shared instructions a file holds: the project's own `.crew/instructions.md`, or those for every project. */
function instructionScope(file: string, project: string) {
  const slashes = (path: string) => path.replaceAll('\\', '/');
  return slashes(file) === `${slashes(project)}/.crew/instructions.md` ? 'This project' : 'Every project';
}

function duration(ms: number) {
  return ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : elapsed(ms);
}

/** The latest turn's receipt: the check the bridge ran itself, or what a review looked at. */
function ReceiptView({ receipt }: { receipt: NonNullable<BoardJob['receipts']>[number] }) {
  const { check, reviewed, stale } = receipt;
  if (!check && !reviewed) return null;
  const passed = check?.exit === 0 && !check.timedOut;
  const [state, icon, label] = !check
    ? (['done', CheckmarkRegular, 'Reviewed'] as const)
    : check.skipped
      ? (['idle', SubtractCircleRegular, 'Check not run'] as const)
      : passed
      ? (['done', CheckmarkRegular, 'Check passed'] as const)
      : check.timedOut
        ? (['waiting', ClockRegular, `Check timed out after ${duration(check.ms)}`] as const)
        : check.exit == null
          ? (['failed', DismissRegular, 'Check stopped before it finished'] as const)
          : (['failed', DismissRegular, `Check failed with exit code ${check.exit}`] as const);
  return (
    // A stale receipt keeps its words but loses its color: it no longer speaks for the branch.
    <div className="receipt" data-state={stale ? 'idle' : state}>
      <p className="receipt-status">
        <Icon icon={icon} size={12} />
        {label}
      </p>
      {check?.skipped && <p className="caption secondary selectable">{check.skipped[0].toUpperCase() + check.skipped.slice(1)}.</p>}
      {check ? (
        <code className="selectable">{check.command}</code>
      ) : (
        <code className="selectable">{reviewed!.target}</code>
      )}
      <p className="caption secondary selectable">
        Turn {receipt.turn}
        {check && !check.skipped && ` · ${duration(check.ms)}${check.sandboxed ? '' : ' · not sandboxed'}`}
      </p>
      {stale && (
        <p className="callout stale selectable">
          <Icon icon={HistoryRegular} size={12} />No longer current: {stale}
        </p>
      )}
      {check && !check.skipped && !passed && check.output && (
        <Reveal show="Show the end of the output" hide="Hide the output">
          <pre className="selectable output">{check.output.split('\n').slice(-15).join('\n')}</pre>
        </Reveal>
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
    <Section title="Verification" icon={ShieldCheckmarkRegular}>
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
          <Icon icon={approval.recorded ? CheckmarkStarburstRegular : QuestionCircleRegular} />
          <div>
            <p className="callout">Approval relayed for turn {approval.turn} — {approvalBasis(approval)}.</p>
            <p className="callout secondary">“{approval.quote}”</p>
          </div>
        </div>
      ))}
    </Section>
  );
}

/** A debate, or a job the lead followed up, reads as its conversation in order. */
const hasConversation = (job: BoardJob) => job.debate ? Boolean(job.exchange?.length) : Boolean(job.exchange?.some((entry) => entry.from === 'lead' && entry.turn > 1));

/** A debate that has had its rounds and stopped: the daemon refuses another reply, whatever state it ended in. */
const debateConcluded = (job: BoardJob) => Boolean(job.debate && job.state !== 'running' && job.state !== 'waiting' && job.turns >= job.debate.rounds);

const STANCES: Record<Stance, [string, typeof CheckmarkCircle16Regular]> = { agree: ['Agree', CheckmarkCircle16Regular], disagree: ['Disagree', DismissCircle16Regular], alternative: ['Alternative', BranchFork16Regular] };
/** A point's stance as a colored mark, followed in a round's heading by its count. */
function StanceMark({ stance, count }: { stance: Stance; count?: number }) {
  const [title, icon] = STANCES[stance];
  return (
    <span className="stance" data-stance={stance} title={title} role="img" aria-label={count === undefined ? title : `${count} ${title.toLowerCase()}`}>
      <Icon icon={icon} size={13} />
      {count !== undefined && <b className="digits">{count}</b>}
    </span>
  );
}
function Stances({ points }: { points: ReturnType<typeof debatePoints> }) {
  const counts = useMemo(() => stanceCounts(points), [points]);
  return <>{(Object.keys(counts) as Stance[]).map((stance) => counts[stance] > 0 && <StanceMark key={stance} stance={stance} count={counts[stance]} />)}</>;
}
/** A show/hide toggle under folded content, as the app's RevealToggle is. */
function Reveal({ show, hide, open, children }: { show: string; hide: string; open?: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(open ?? false);
  return (
    <>
      {shown && <div className="reveal">{children}</div>}
      <button className="reveal-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? hide : show}</button>
    </>
  );
}
/** Text cut to a few lines with its end fading, opened in full by its toggle. */
function Clamp({ text, lines, show, hide }: { text: string; lines: number; show: string; hide: string }) {
  const [shown, setShown] = useState(false);
  const long = text.split('\n').length > lines || text.length > lines * 90;
  return (
    <>
      <div className="clamp" data-clamped={long && !shown || undefined} style={{ '--lines': lines } as CSSProperties}>
        <ReportText text={text} />
      </div>
      {long && <button className="reveal-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? hide : show}</button>}
    </>
  );
}

function DebateRound({ job, turn, label, final, last }: { job: BoardJob; turn: number; label: string; final: boolean; last: boolean }) {
  const entries = job.exchange ?? [];
  const lead = entries.findLast((entry) => entry.turn === turn && entry.from === 'lead');
  const reply = entries.findLast((entry) => entry.turn === turn && entry.from === 'worker');
  // Earlier rounds start folded to their heading and stances; the latest starts open.
  const [open, setOpen] = useState(last);
  const text = reply?.text;
  const points = useMemo(() => text === undefined ? [] : debatePoints(text), [text]);
  const working = job.endedAt == null && turn === job.turns;
  const name = NAMES[job.agent];
  return (
    <li className="debate-round" data-open={open || undefined}>
      <button className="debate-round-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <b>{final ? `${label} ${turn} · final` : `${label} ${turn}`}</b>
        {!open && reply && <Stances points={points} />}
        <Icon icon={ChevronDownRegular} className="disclosure" />
      </button>
      {open && (
        <div className="debate-round-body reveal">
          {lead && (
            <div className="exchange-entry" data-from="lead">
              <div className="caption voice">Lead · {label.toLowerCase()} {turn}</div>
              <Clamp text={lead.text} lines={4} show="Show the lead's message" hide="Hide the lead's message" />
            </div>
          )}
          {reply ? (
            <div className="exchange-entry" data-from="worker">
              <div className="caption voice">{name} · {label.toLowerCase()} {turn} <Stances points={points} /></div>
              {points.length ? (
                <>
                  <ol className="points">
                    {points.map((point, index) => (
                      <li key={index}><StanceMark stance={point.stance} /><span className="selectable">{point.title}</span></li>
                    ))}
                  </ol>
                  <Reveal show="Show the full reply" hide="Hide the full reply"><ReportText text={reply.text} /></Reveal>
                </>
              ) : (
                <Clamp text={reply.text} lines={8} show="Show the reply" hide="Hide the reply" />
              )}
            </div>
          ) : working && <p className="caption secondary answering"><i className="dots" aria-hidden="true" />{name} is answering…</p>}
        </div>
      )}
    </li>
  );
}

/** A debate's progress over its rounds: done, in progress, then the conclusion. */
function DebateStepper({ job }: { job: BoardJob }) {
  const rounds = job.debate!.rounds;
  const replied = Math.max(0, ...(job.exchange ?? []).filter((entry) => entry.from === 'worker').map((entry) => entry.turn));
  const concluded = debateConcluded(job);
  return (
    <ol className="stepper" role="img" aria-label={concluded ? `Debate concluded after ${rounds} round${rounds === 1 ? '' : 's'}` : `Debate, round ${Math.min(job.turns, rounds)} of ${rounds}`}>
      {Array.from({ length: rounds }, (_, index) => index + 1).map((round) => (
        <li key={round} data-done={round <= replied || undefined}>
          <Icon icon={round <= replied ? CheckmarkCircleRegular : round === job.turns && job.endedAt == null ? CircleHintRegular : CircleMultipleConcentricRegular} size={13} />
          <span>Round {round}</span>
        </li>
      ))}
      <li data-done={concluded || undefined}>
        <Icon icon={concluded ? FlagCheckeredRegular : FlagRegular} size={13} />
        <span>Conclusion</span>
      </li>
    </ol>
  );
}

function DebateSection({ job }: { job: BoardJob }) {
  const debate = job.debate;
  const settled = debateConcluded(job);
  const title = debate ? `Debate · round ${Math.min(job.turns, debate.rounds)} of ${debate.rounds}${settled ? ' · concluded' : ''}` : 'Conversation';
  const turns = [...new Set((job.exchange ?? []).map((entry) => entry.turn))].sort((a, b) => a - b);
  const label = debate ? 'Round' : 'Turn';
  return (
    <section className="detail-section" aria-label={title}>
      <h3>
        <Icon icon={ChatRegular} />
        {debate ? 'Debate' : 'Conversation'}
        {debate && <DebateStepper job={job} />}
      </h3>
      {/* A job begun before conversations were kept has its first turns missing; say so rather than start partway. */}
      {turns[0] > 1 && <p className="caption secondary">{turns[0] === 2 ? `${label} 1 was not recorded.` : `${label}s 1–${turns[0] - 1} were not recorded.`}</p>}
      <ol className="exchange">
        {turns.map((turn) => (
          <DebateRound key={turn} job={job} turn={turn} label={label} final={turn === debate?.rounds} last={turn === turns.at(-1)} />
        ))}
      </ol>
      {settled && <ConcludedNote />}
    </section>
  );
}

function ConcludedNote() {
  return <p className="callout secondary concluded"><Icon icon={CheckmarkCircleRegular} size={13} />This debate has used all its rounds. Decide from it, or start a new debate.</p>;
}

function FollowUp({ job }: { job: BoardJob }) {
  const key = `followup:${job.id}`;
  const [draft, setDraft] = useDraft(key);
  const state = useAction(key);
  const name = NAMES[job.agent];
  return (
    <Section title={job.endedAt == null ? 'Steer' : job.debate ? 'Reply' : 'Follow up'} icon={ChatRegular}>
      <textarea aria-label={`Message to ${name}`} placeholder="Write a message…" value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="answer-actions">
        <ActionStatus actionKey={key} />
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
          Send
        </button>
      </div>
    </Section>
  );
}

export function drawerJob(detail: BoardJob | null, current?: BoardJob): BoardJob | undefined {
  if (!detail || !current) return current ?? detail ?? undefined;
  return { ...detail, ...current, prompt: detail.prompt ?? current.prompt, liveDiff: current.liveDiff };
}

/** JobDetailView in the app: status and close, then the job, its facts, results and controls. */
export function JobDrawer({ id, state, close }: { id: string; state: Snapshot; close: () => void }) {
  const current = state.jobs.find((job) => job.id === id);
  const streamLog = useStableItems(useMemo(() => state.events.filter((event) => event.job_id === id), [state.events, id]));
  const { agents, roleInfo, revision, connection } = state;
  return <JobDetails id={id} current={current} streamLog={streamLog} agents={agents} roleInfo={roleInfo} revision={revision} connection={connection} close={close} />;
}

const JobDetails = memo(function JobDetails({ id, current, streamLog, agents, roleInfo, revision, connection, close }: {
  id: string;
  current?: BoardJob;
  streamLog: CrewEvent[];
  close: () => void;
} & Pick<Snapshot, 'agents' | 'roleInfo' | 'revision' | 'connection'>) {
  const [detail, setDetail] = useState<BoardJob | null>(null);
  const [log, setLog] = useState<CrewEvent[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const job = drawerJob(detail, current);
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
  }, [id, retry, revision]);
  const events = useMemo(() => mergeEvents(log, streamLog, 80), [log, streamLog]);
  const refusals = job?.refusals?.filter((refusal) => refusal.turn === job.turns) ?? [];
  const live = connection === 'live';
  const facts: [string, ReactNode][] = job
    ? [
        // The model the session reported, else the configured one.
        ['Agent', [NAMES[job.agent], job.resolvedModel ?? job.model, job.tier && `${job.tier} tier`, (job.resolvedEffort ?? job.effort) && `${job.resolvedEffort ?? job.effort} effort`].filter(Boolean).join(' · ')],
        ['Role', job.ask && !job.debate ? 'Question' : roleLabel({ roleInfo }, jobRole(job))],
        // What the worker declared, set against what the bridge observed.
        ...(job.state === 'done' && job.outcome ? [['Outcome', job.outcomeContradiction ? `Done as declared, but ${job.outcomeContradiction}` : job.outcome[0].toUpperCase() + job.outcome.slice(1)] as [string, string]] : []),
        ...(job.preset ? [['Preset', job.preset[0].toUpperCase() + job.preset.slice(1)] as [string, string]] : []),
        ['Project', projectOf(job)],
        ['Duration', <Elapsed start={job.createdAt} end={job.endedAt} />],
        ...(job.worktree ? [['Branch', job.worktree.branch] as [string, string]] : []),
        ...(job.tokens != null ? [['Tokens', job.tokens.toLocaleString()] as [string, string]] : []),
        ...(job.tokenUse
          ? [['Of which', `${job.tokenUse.cachedInput.toLocaleString()} cached input · ${(job.tokenUse.input - job.tokenUse.cachedInput).toLocaleString()} uncached input · ${job.tokenUse.output.toLocaleString()} output${job.turns > 1 ? ` · ${job.tokenUse.turn.toLocaleString()} in the latest turn` : ''}`] as [string, string]]
          : []),
        ...(job.context ? [['Context', `${job.context.used.toLocaleString()} of ${job.context.size.toLocaleString()} (${Math.round((job.context.used / job.context.size) * 100)}%)`] as [string, string]] : []),
        ['Turns', String(job.turns)],
        ...(job.shared?.length ? [['Instructions', job.shared.map((file) => instructionScope(file, projectOf(job))).join(' · ')] as [string, string]] : []),
      ]
    : [];
  const result = job?.result;
  const files = result ? [...new Set([...result.files, ...result.outOfScope])].sort() : [];
  return (
    <DetailPanel
      label={job?.title ?? 'Job details'}
      close={close}
      chip={job && <Chip state={jobStatusState(job)}>{jobLabel(job)}</Chip>}
      title={job?.title}
      subtitle={job?.endedAt == null ? job?.phase : undefined}
    >
      {error && (
        <div role="alert" className="detail-title">
          <p className="error selectable">{error}</p>
          <div>
            <button onClick={() => setRetry((value) => value + 1)}>
              <Icon icon={ArrowCounterclockwiseRegular} />
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
          {job.error && <p className="error selectable">{job.error.message}</p>}
          {job.state === 'waiting' && (
            <div className="card answer-card">
              <Answer job={job} />
            </div>
          )}
          <Facts facts={facts} />
          <LiveDiffSection job={job} />
          {result && (
            <Section title="Changes" icon={BranchRegular}>
              <pre className="selectable">{result.stat || 'No files changed'}</pre>
              {result.commit && <p className="caption selectable">Commit {result.commit}</p>}
              {files.map((file) => (
                <div className="file" key={file}>
                  <code className="selectable">{file}</code>
                  {result.outOfScope.includes(file) && (
                    <span className="caption error">
                      <Icon icon={WarningRegular} size={11} />
                      {result.files.includes(file) ? 'Outside the allowed targets' : 'Outside the workspace'}
                    </span>
                  )}
                </div>
              ))}
              {/* A section's own action ends it at the trailing edge, as in the app. */}
              {job.worktree && result.files.length > 0 && (
                <div className="answer-actions">
                  <CopyButton text={`git diff ${job.worktree.base.slice(0, 8)}..${job.worktree.branch}`}>Diff Command</CopyButton>
                </div>
              )}
            </Section>
          )}
          <VerificationSection job={job} />
          <EvidenceSection job={job} />
          {!!job.rounds?.length && (
            <Section title="Rounds" icon={ArrowCounterclockwiseRegular}>
              {job.rounds.toSorted((a, b) => a.turn - b.turn).map((round) => (
                <RoundRow key={round.turn} job={job} round={round} />
              ))}
            </Section>
          )}
          {refusals.length > 0 && (
            <Section title="Automatic review" icon={ShieldErrorRegular}>
              {refusals.map((refusal, index) => (
                <p className="callout error selectable" key={index}>
                  {refusal.action} — {refusal.reason}
                </p>
              ))}
              {job.retrying && <p className="callout secondary">Sent back once with your approval.</p>}
            </Section>
          )}
          {job.notes.length > 0 && (
            <Section title="Notes" icon={NotebookRegular}>
              {job.notes.map((note, index) => (
                <p className="callout selectable" key={index}>{trimNote(note)}</p>
              ))}
            </Section>
          )}
          {hasConversation(job) ? <DebateSection job={job} /> : (
            <>
              {job.report && (
                <Section title="Report" icon={DocumentTextRegular}>
                  <ReportText text={job.report} />
                </Section>
              )}
              {/* A debate begun before conversations were kept still says why there is no Reply. */}
              {debateConcluded(job) && <ConcludedNote />}
            </>
          )}
          {!debateConcluded(job) && job.sessionId && job.state !== 'waiting' && <FollowUp key={job.id} job={job} />}
          {job.prompt && <OriginalTask text={job.prompt} />}
          {events.length > 0 && (
            <Section title="Activity" icon={FlashRegular}>
              <EventList events={events} />
            </Section>
          )}
          <Footer status={<ActionStatus actionKey={cancelKey} />}>
            {job.sessionId && agents[job.agent] && !job.capabilities?.confined && (
              <CopyButton text={`${agents[job.agent].resume} ${job.sessionId}`} short="Resume">Resume Command</CopyButton>
            )}
            {job.endedAt == null && (
              <button
                className="destructive"
                disabled={!live || cancelling.pending || cancelling.accepted}
                onClick={() => void actions.run(cancelKey, () => request(`/api/jobs/${job.id}/cancel`, {}), { done: 'Cancelled' })}
              >
                <Icon icon={RecordStopRegular} />
                Cancel Job
              </button>
            )}
          </Footer>
        </>
      )}
    </DetailPanel>
  );
});

/** A long note is cut, saying how much was left out, as the app cuts it. */
function trimNote(note: string) {
  if (note.length <= 2000) return note;
  const rest = note.slice(2000).split('\n').length;
  return `${note.slice(0, 2000)}… and ${rest} more line${rest === 1 ? '' : 's'}`;
}

function Facts({ facts }: { facts: [string, ReactNode][] }) {
  return (
    <dl className="facts selectable">
      {facts.map(([label, value]) => (
        <div key={label} style={{ display: 'contents' }}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The task as the worker received it: three lines, the last fading, and all of it from a click anywhere on it. */
function OriginalTask({ text }: { text: string }) {
  const [shown, setShown] = useState(false);
  const body = useRef<HTMLPreElement>(null);
  const [long, setLong] = useState(true);
  useEffect(() => {
    const element = body.current;
    if (element) setLong(element.scrollHeight > element.clientHeight + 1 || shown);
  }, [text]);
  return (
    <section className="detail-section original" aria-label="Original task">
      <h3>
        <button className="section-toggle" aria-expanded={shown} onClick={() => long && setShown(!shown)}>
          <Icon icon={TextAlignLeftRegular} />Original task
        </button>
      </h3>
      <pre
        ref={body}
        className="callout task"
        data-folded={long && !shown || undefined}
        // Folded, a click anywhere opens it; open, the text is selectable instead.
        onClick={() => long && !shown && setShown(true)}
      >
        {long && !shown ? text : <span className="selectable">{text}</span>}
      </pre>
      {long && <button className="reveal-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? 'Hide the original task' : 'Show the original task'}</button>}
    </section>
  );
}

/** The panel's last row: its actions at the trailing edge, and the outcome of one under them. */
function Footer({ status, children }: { status?: ReactNode; children: ReactNode }) {
  return (
    <footer className="detail-foot">
      <span className="detail-actions">{children}</span>
      {status}
    </footer>
  );
}

const PANEL_WIDTH = 'crew.panelWidth';
const panelBounds = () => ({ min: 360, max: Math.max(360, Math.min(760, innerWidth - 120)) });
const storedWidth = () => {
  try {
    return Number(localStorage.getItem(PANEL_WIDTH)) || 440;
  } catch {
    return 440;
  }
};
/**
 * The detail panel: a card over the page's right edge that leaves the page usable. Its header stays put with the
 * title in it while the details scroll under a soft blur, and its leading edge drags to resize, remembered.
 */
function DetailPanel({ label, close, chip, title, subtitle, children }: {
  label: string;
  close: () => void;
  chip?: ReactNode;
  title?: string;
  subtitle?: string;
  children: ReactNode;
}) {
  const [width, setWidth] = useState(storedWidth);
  const [scrolled, setScrolled] = useState(false);
  /** Ends a drag in progress; the panel can close or switch jobs in the middle of one. */
  const endDrag = useRef<() => void>(undefined);
  useEffect(() => () => endDrag.current?.(), []);
  const { min, max } = panelBounds();
  const shown = Math.max(min, Math.min(max, width));
  const save = (value: number) => {
    const next = Math.max(min, Math.min(max, Math.round(value)));
    setWidth(next);
    try {
      localStorage.setItem(PANEL_WIDTH, String(next));
    } catch {
      /* Storage may be off. */
    }
  };
  return (
    <Dialog variant="detail-panel" label={label} onClose={close} style={{ '--panel-width': `${shown}px` } as CSSProperties}>
      <div
        className="panel-grip"
        role="separator"
        aria-orientation="vertical"
        aria-label="Panel width"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        tabIndex={0}
        title="Drag to resize, double-click to reset"
        onDoubleClick={() => save(440)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            save(shown + (event.key === 'ArrowLeft' ? 40 : -40));
          }
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const grip = event.currentTarget;
          grip.setPointerCapture(event.pointerId);
          const start = event.clientX;
          const from = shown;
          const move = (next: PointerEvent) => save(from + start - next.clientX);
          const up = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
            grip.removeEventListener('lostpointercapture', up);
            document.documentElement.removeAttribute('data-resizing');
            endDrag.current = undefined;
          };
          endDrag.current = up;
          document.documentElement.setAttribute('data-resizing', '');
          grip.addEventListener('pointermove', move);
          grip.addEventListener('pointerup', up);
          grip.addEventListener('pointercancel', up);
          grip.addEventListener('lostpointercapture', up);
        }}
      />
      <header className="detail-head" data-scrolled={scrolled || undefined}>
        <div className="detail-bar">
          {chip ?? <span />}
          <CloseButton label="Close details" onClose={close} />
        </div>
        {title && (
          <CopyMenu text={title} label="Copy Title">
            <h2 className="title selectable detail-heading" id="drawer-title" tabIndex={-1} data-autofocus title={title}>{title}</h2>
          </CopyMenu>
        )}
        {subtitle && <p className="secondary selectable detail-subtitle swap" key={subtitle}>{subtitle}</p>}
      </header>
      <div className="detail-scroll" onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 1)}>
        {children}
      </div>
    </Dialog>
  );
}

/** A Claude session's details, as the app shows them: what it waits on, its facts and missions, and how to resume it. */
export const SessionDrawer = memo(function SessionDrawer({ id, state, close }: { id: string; state: Snapshot; close: () => void }) {
  const session = state.claude.find((item) => item.id === id);
  const missions = state.missions.filter((mission) => mission.owner === id).sort((a, b) => b.createdAt - a.createdAt);
  const status = session && (session.stalled ? 'stalled' : session.state);
  const plainAgents = (session?.agents ?? []).filter((agent) => !agent.workflow);
  return (
    <DetailPanel
      label={session?.title ?? 'Session details'}
      close={close}
      chip={session && <Chip state={status!}>{session.stalled ? 'May be stuck' : session.state[0].toUpperCase() + session.state.slice(1)}</Chip>}
      title={session?.title}
      subtitle={session?.state === 'working' ? session.phase : undefined}
    >
      {!session ? (
        <p className="secondary">This session has ended.</p>
      ) : (
        <>
          {session.state === 'waiting' && (
            <div className="card answer-card answer">
              <p className="headline selectable">{session.waitingFor ?? 'Claude needs your input.'}</p>
              <p className="callout secondary">Answer in Claude.</p>
            </div>
          )}
          <Facts
            facts={[
              ['Agent', 'Claude · Lead'],
              ['Project', projectOf(session)],
              ...(session.cwd !== projectOf(session) ? [['Directory', session.cwd] as [string, string]] : []),
              ['Started', <Elapsed start={session.startedAt} suffix=" ago" />],
              ['Last active', <Elapsed start={session.activeAt} suffix=" ago" />],
              ...(session.inTool ? [['Now', 'Running a tool'] as [string, string]] : []),
            ]}
          />
          {plainAgents.length > 0 && (
            <Section title="Sub-agents" icon={PeopleRegular}>
              <SessionAgents agents={plainAgents} label="Sub-agents" />
            </Section>
          )}
          {(session.workflows ?? []).map((run) => (
            <SessionWorkflow key={run.id} run={run} agents={(session.agents ?? []).filter((agent) => agent.workflow === run.id)} />
          ))}
          {missions.length > 0 && (
            <Section title="Missions" icon={FlagRegular}>
              {missions.map((mission) => (
                <div className="session-mission" key={mission.id}>
                  <span>{mission.title}</span>
                  <Chip state={mission.state === 'active' ? 'running' : mission.state}>{mission.state[0].toUpperCase() + mission.state.slice(1)}</Chip>
                </div>
              ))}
            </Section>
          )}
          <Footer>
            <CopyButton text={`claude --resume ${session.id}`} short="Resume">Resume Command</CopyButton>
          </Footer>
        </>
      )}
    </DetailPanel>
  );
}, (a, b) => a.id === b.id && a.close === b.close &&
  a.state.missions === b.state.missions &&
  a.state.claude.find((session) => session.id === a.id) === b.state.claude.find((session) => session.id === b.id));
