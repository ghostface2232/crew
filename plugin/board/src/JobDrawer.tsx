import { memo, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import {
  ArrowCounterclockwiseRegular, ArrowUndoRegular, BranchFork16Regular, BranchRegular, ChatRegular,
  CheckmarkCircle16Regular, CheckmarkCircleRegular, CheckmarkRegular, CheckmarkStarburstRegular, ChevronDownRegular,
  CircleHintRegular, CircleMultipleConcentricRegular, ClockRegular, ColumnDoubleCompareRegular, DismissCircle16Regular, DismissRegular,
  DocumentTextRegular, FilmstripRegular, FlagCheckeredRegular, FlagRegular, FlashRegular, HistoryRegular,
  ImageMultipleRegular, NotebookRegular, PeopleRegular, QuestionCircleRegular, RecordStopRegular,
  ShieldCheckmarkRegular, ShieldErrorRegular, SubtractCircleRegular, TextAlignLeftRegular, WarningRegular,
} from '@fluentui/react-icons';
import type { FluentIcon } from '@fluentui/react-icons';
import type { ReactNode } from 'react';
import type { BoardJob, CrewEvent, Snapshot } from './types.ts';
import { actions, drafts, request } from './api.ts';
import { board, mergeEvents } from './store.ts';
import { elapsed, evidenceTurn, jobLabel, jobRole, MAX_COMPARED, NAMES, orderEvidence, projectOf, roleLabel, sessionAgent } from './model.ts';
import { ActionStatus, CloseButton, CopyButton, CopyMenu, Dialog, Icon, Chip, useAction, useDraft, Elapsed, useLanguage, useStableItems } from './ui.tsx';
import { ReportText as RenderReport } from './Report.ts';
import { debatePoints, stanceCounts } from './debate.ts';
import type { Stance } from './debate.ts';
import { Answer, ClaudeAsk, OpenInAgent, sessionAppLink } from './NeedsYou.tsx';
import { EventList } from './Overview.tsx';
import { jobStatusState, missionStateLabel, SessionAgents, sessionStateLabel, SessionWorkflow } from './Missions.tsx';
import { t, translated } from './i18n.ts';

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
      ? t('Wait until the job has stopped before changing rounds.')
      : !job.worktree ? t('This job has no worktree.') : undefined;
  const undone = round.state === 'undone';
  return (
    <div className="round">
      <div className="round-head">
        <b>{t('Turn {turn}', { turn: round.turn })}</b>
        <span>
          <Icon icon={undone ? ArrowUndoRegular : CheckmarkRegular} size={11} />
          {undone ? t('Undone') : t('Kept')}
        </span>
        <button
          disabled={Boolean(reason) || action.pending || board.getSnapshot().connection !== 'live'}
          title={reason ?? t('Change this round on the job branch.')}
          onClick={() => {
            void actions.run(key, async () => {
              const updated = await request<BoardJob>(`/api/jobs/${job.id}/rounds/${round.turn}`, undone ? { keep: true } : { undo: true });
              board.receive('job', updated);
            }, { once: false, done: '' });
          }}
        >
          {undone ? t('Keep') : t('Undo')}
        </button>
      </div>
      <pre>{round.stat || t('No files changed')}</pre>
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
    <Section title={t('Changes so far')} icon={BranchRegular}>
      <pre className="selectable live-diff">{diff}</pre>
    </Section>
  );
}

function EvidenceSection({ job }: { job: BoardJob }) {
  const items = (job.evidence ?? []).toSorted((a, b) => b.turn - a.turn);
  const [picked, setPicked] = useState<string[]>([]);
  // A capture the worker has since deleted leaves the viewer for good, so one coming back under its name does not
  // reopen it or rejoin a comparison.
  const shown = picked.filter((file) => items.some((item) => item.file === file));
  if (shown.length !== picked.length) setPicked(shown);
  if (!items.length) return null;
  return (
    <Section title={t('Evidence')} icon={ImageMultipleRegular}>
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
                  title={t('Open')}
                  onClick={(event) => {
                    // A plain press opens it here; a modified one opens the file.
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
      {shown.length > 0 && <EvidenceViewer job={job} items={items} shown={shown} onShown={setPicked} />}
    </Section>
  );
}

/**
 * One capture at a time, with the others in a strip below to switch to. Compare puts several side by side: a result
 * alone says little, and is judged against what was there before or what it was meant to match. Each says which turn
 * it is from, since one from an earlier turn may not show the final state.
 */
function EvidenceViewer({ job, items, shown, onShown }: { job: BoardJob; items: EvidenceItem[]; shown: string[]; onShown: (files: string[]) => void }) {
  const [comparing, setComparing] = useState(false);
  // With one capture left there is nothing to compare, and Compare does not come back on its own with the next.
  if (comparing && items.length < 2) setComparing(false);
  const close = () => onShown([]);
  const caption = (item: EvidenceItem) => evidenceTurn(item, job.turns);
  const strip = orderEvidence(items);
  // `shown` is in the order captures were added, so the last is the one most recently looked at.
  const current = shown.at(-1)!;
  const panes = comparing ? orderEvidence(items.filter((item) => shown.includes(item.file))) : items.filter((item) => item.file === current);
  // Moves to the capture beside the one shown; while comparing, the arrows are left alone.
  const step = useRef<(by: number) => boolean>(() => false);
  step.current = (by) => {
    if (comparing) return false;
    const next = strip[strip.findIndex((item) => item.file === current) + by];
    if (next) onShown([next.file]);
    return true;
  };
  useEffect(() => {
    // On the document, like the sheet's Escape, so the arrows still work when focus has fallen out of the sheet.
    const keydown = (event: KeyboardEvent) => {
      if ((event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') || event.defaultPrevented) return;
      if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      // A focused video keeps its arrows for seeking, and a field or another sheet keeps its own.
      if (target instanceof HTMLVideoElement || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) return;
      const owner = target.closest('dialog');
      if (owner && !owner.classList.contains('evidence-viewer')) return;
      if (step.current(event.key === 'ArrowLeft' ? -1 : 1)) event.preventDefault();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, []);
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The strip follows the arrows when it has more captures than fit. Only the strip scrolls: `scrollIntoView` would
    // also scroll the sheet when it is taller than the window, taking its head out of view.
    const strip = stripRef.current;
    const button = strip?.querySelector('[aria-current="true"]');
    if (!strip || !button) return;
    const box = button.getBoundingClientRect();
    const view = strip.getBoundingClientRect();
    if (box.left < view.left) strip.scrollLeft += box.left - view.left;
    else if (box.right > view.right) strip.scrollLeft += box.right - view.right;
  }, [current, comparing]);
  return (
    <Dialog labelId="evidence-viewer-title" className="evidence-viewer" onClose={close}>
      <div className="sheet-body">
        <div className="sheet-head">
          <h2 className="title" id="evidence-viewer-title">{t('Evidence')}</h2>
          {items.length > 1 && (
            <button
              type="button"
              className="compare-toggle"
              aria-pressed={comparing}
              onClick={() => {
                // Leaving keeps only the one most recently added.
                if (comparing) onShown([current]);
                setComparing(!comparing);
              }}
            >
              <Icon icon={ColumnDoubleCompareRegular} />
              {t('Compare')}
            </button>
          )}
          <CloseButton label={t('Close')} onClose={close} />
        </div>
        <div className="compare" data-panes={panes.length}>
          {panes.map((item) => {
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
          <div
            ref={stripRef}
            className="compare-picker"
            role="group"
            aria-label={comparing ? t('Captures to compare, up to {max}', { max: MAX_COMPARED }) : t('Captures')}
          >
            {strip.map((item) => {
              const on = comparing ? shown.includes(item.file) : item.file === current;
              return (
                <button
                  key={item.file}
                  type="button"
                  aria-pressed={comparing ? on : undefined}
                  aria-current={!comparing && on ? 'true' : undefined}
                  // While comparing, the last one stays, and a fifth has no room.
                  disabled={comparing && (on ? shown.length === 1 : shown.length >= MAX_COMPARED)}
                  title={item.file}
                  onClick={() => {
                    if (!comparing) onShown([item.file]);
                    else onShown(on ? shown.filter((file) => file !== item.file) : [...shown, item.file]);
                  }}
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

const NETWORK = translated((): Record<NonNullable<BoardJob['capabilities']>['network'], string> => ({
  on: t('network on'),
  off: t('no network'),
  'agent-managed': t('network as the agent allows'),
}));

/** Whose shared instructions a job was given, as the bridge recorded them; jobs from before that list their files. */
function sharedLabel(job: BoardJob) {
  return job.sharedScopes?.map((scope) => (scope === 'project' ? t('This project') : t('Every project'))).join(' · ') ?? job.shared!.join('\n');
}

function duration(ms: number) {
  return ms < 60_000 ? t('{n}s', { n: Math.max(1, Math.round(ms / 1000)) }) : elapsed(ms);
}

function tokenSplit(use: NonNullable<BoardJob['tokenUse']>, turns: number) {
  const values = { cached: use.cachedInput.toLocaleString(), uncached: (use.input - use.cachedInput).toLocaleString(), output: use.output.toLocaleString() };
  return turns > 1
    ? t('{cached} cached input · {uncached} uncached input · {output} output · {latest} in the latest turn', { ...values, latest: use.turn.toLocaleString() })
    : t('{cached} cached input · {uncached} uncached input · {output} output', values);
}

/** The latest turn's receipt: the check the bridge ran itself, or what a review looked at. */
function ReceiptView({ receipt }: { receipt: NonNullable<BoardJob['receipts']>[number] }) {
  const { check, reviewed, stale } = receipt;
  if (!check && !reviewed) return null;
  const passed = check?.exit === 0 && !check.timedOut;
  const [state, icon, label] = !check
    ? (['done', CheckmarkRegular, t('Reviewed')] as const)
    : check.skipped
      ? (['idle', SubtractCircleRegular, t('Check not run')] as const)
      : passed
      ? (['done', CheckmarkRegular, t('Check passed')] as const)
      : check.timedOut
        ? (['waiting', ClockRegular, t('Check timed out after {duration}', { duration: duration(check.ms) })] as const)
        : check.exit == null
          ? (['failed', DismissRegular, t('Check stopped before it finished')] as const)
          : (['failed', DismissRegular, t('Check failed with exit code {code}', { code: check.exit })] as const);
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
        {t('Turn {turn}', { turn: receipt.turn })}
        {check && !check.skipped && ` · ${duration(check.ms)}${check.sandboxed ? '' : ` · ${t('not sandboxed')}`}`}
      </p>
      {stale && (
        <p className="callout stale selectable">
          <Icon icon={HistoryRegular} size={12} />{t('No longer current: {reason}', { reason: stale })}
        </p>
      )}
      {check && !check.skipped && !passed && check.output && (
        <Reveal show={t('Show the end of the output')} hide={t('Hide the output')}>
          <pre className="selectable output">{check.output.split('\n').slice(-15).join('\n')}</pre>
        </Reveal>
      )}
    </div>
  );
}

function approvalLine({ turn, recorded, matched }: NonNullable<BoardJob['approvals']>[number]) {
  if (!recorded) return t('Approval relayed for turn {turn} — no messages of the user were recorded, so only the lead’s quote went with it.', { turn });
  return matched
    ? t('Approval relayed for turn {turn} — the user’s own words went with it, and the quote matches them.', { turn })
    : t('Approval relayed for turn {turn} — the user’s own words went with it; the quote is a translation or paraphrase.', { turn });
}

/** What backs the result: the latest check or review, what the worker could reach, and relayed approvals. */
function VerificationSection({ job }: { job: BoardJob }) {
  const receipt = job.receipts?.at(-1);
  const shown = receipt && (receipt.check || receipt.reviewed);
  const capabilities = job.capabilities;
  const approvals = job.approvals ?? [];
  if (!shown && !capabilities && !approvals.length) return null;
  return (
    <Section title={t('Verification')} icon={ShieldCheckmarkRegular}>
      {shown && <ReceiptView receipt={receipt} />}
      {capabilities && (
        <dl className="facts selectable">
          <dt>{t('Runs with')}</dt>
          <dd>
            {[
              capabilities.filesystem,
              NETWORK()[capabilities.network],
              capabilities.plugins.length && t('plugins {plugins} (act outside the sandbox)', { plugins: capabilities.plugins.join(', ') }),
            ].filter(Boolean).join(' · ')}
          </dd>
        </dl>
      )}
      {approvals.map((approval, index) => (
        <div className="approval selectable" key={index}>
          <Icon icon={approval.recorded ? CheckmarkStarburstRegular : QuestionCircleRegular} />
          <div>
            <p className="callout">{approvalLine(approval)}</p>
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

const STANCES = translated((): Record<Stance, [string, (count: number) => string, typeof CheckmarkCircle16Regular]> => ({
  agree: [t('Agree'), (count) => t('{count} agree', { count }), CheckmarkCircle16Regular],
  disagree: [t('Disagree'), (count) => t('{count} disagree', { count }), DismissCircle16Regular],
  alternative: [t('Alternative'), (count) => t('{count} alternative', { count }), BranchFork16Regular],
}));
/** A point's stance as a colored mark, followed in a round's heading by its count. */
function StanceMark({ stance, count }: { stance: Stance; count?: number }) {
  const [title, counted, icon] = STANCES()[stance];
  return (
    <span className="stance" data-stance={stance} title={title} role="img" aria-label={count === undefined ? title : counted(count)}>
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

function DebateRound({ job, turn, final, last }: { job: BoardJob; turn: number; final: boolean; last: boolean }) {
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
        <b>{final ? t('Round {round} · final', { round: turn }) : job.debate ? t('Round {round}', { round: turn }) : t('Turn {turn}', { turn })}</b>
        {!open && reply && <Stances points={points} />}
        <Icon icon={ChevronDownRegular} className="disclosure" />
      </button>
      {open && (
        <div className="debate-round-body reveal">
          {lead && (
            <div className="exchange-entry" data-from="lead">
              <div className="caption voice">{job.debate ? t('Lead · round {round}', { round: turn }) : t('Lead · turn {turn}', { turn })}</div>
              <Clamp text={lead.text} lines={4} show={t("Show the lead's message")} hide={t("Hide the lead's message")} />
            </div>
          )}
          {reply ? (
            <div className="exchange-entry" data-from="worker">
              <div className="caption voice">{job.debate ? t('{name} · round {round}', { name, round: turn }) : t('{name} · turn {turn}', { name, turn })} <Stances points={points} /></div>
              {points.length ? (
                <>
                  <ol className="points">
                    {points.map((point, index) => (
                      <li key={index}><StanceMark stance={point.stance} /><span className="selectable">{point.title}</span></li>
                    ))}
                  </ol>
                  <Reveal show={t('Show the full reply')} hide={t('Hide the full reply')}><ReportText text={reply.text} /></Reveal>
                </>
              ) : (
                <Clamp text={reply.text} lines={8} show={t('Show the reply')} hide={t('Hide the reply')} />
              )}
            </div>
          ) : working && <p className="caption secondary answering"><i className="dots" aria-hidden="true" />{t('{name} is answering…', { name })}</p>}
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
    <ol className="stepper" role="img" aria-label={concluded
      ? rounds === 1 ? t('Debate concluded after 1 round') : t('Debate concluded after {rounds} rounds', { rounds })
      : t('Debate, round {round} of {rounds}', { round: Math.min(job.turns, rounds), rounds })}>
      {Array.from({ length: rounds }, (_, index) => index + 1).map((round) => (
        <li key={round} data-done={round <= replied || undefined}>
          <Icon icon={round <= replied ? CheckmarkCircleRegular : round === job.turns && job.endedAt == null ? CircleHintRegular : CircleMultipleConcentricRegular} size={13} />
          <span>{t('Round {round}', { round })}</span>
        </li>
      ))}
      <li data-done={concluded || undefined}>
        <Icon icon={concluded ? FlagCheckeredRegular : FlagRegular} size={13} />
        <span>{t('Conclusion')}</span>
      </li>
    </ol>
  );
}

function DebateSection({ job }: { job: BoardJob }) {
  const debate = job.debate;
  const settled = debateConcluded(job);
  const progress = debate && { round: Math.min(job.turns, debate.rounds), rounds: debate.rounds };
  const title = progress
    ? settled ? t('Debate · round {round} of {rounds} · concluded', progress) : t('Debate · round {round} of {rounds}', progress)
    : t('Conversation');
  const turns = [...new Set((job.exchange ?? []).map((entry) => entry.turn))].sort((a, b) => a - b);
  const last = turns[0] - 1;
  return (
    <section className="detail-section" aria-label={title}>
      <h3>
        <Icon icon={ChatRegular} />
        {debate ? t('Debate') : t('Conversation')}
        {debate && <DebateStepper job={job} />}
      </h3>
      {/* A job begun before conversations were kept has its first turns missing; say so rather than start partway. */}
      {turns[0] > 1 && (
        <p className="caption secondary">
          {last === 1
            ? debate ? t('Round 1 was not recorded.') : t('Turn 1 was not recorded.')
            : debate ? t('Rounds 1–{last} were not recorded.', { last }) : t('Turns 1–{last} were not recorded.', { last })}
        </p>
      )}
      <ol className="exchange">
        {turns.map((turn) => (
          <DebateRound key={turn} job={job} turn={turn} final={turn === debate?.rounds} last={turn === turns.at(-1)} />
        ))}
      </ol>
      {settled && <ConcludedNote />}
    </section>
  );
}

function ConcludedNote() {
  return <p className="callout secondary concluded"><Icon icon={CheckmarkCircleRegular} size={13} />{t('This debate has used all its rounds. Decide from it, or start a new debate.')}</p>;
}

/** What Resume sends a stopped worker; workers read English, whatever language the board is in. */
const RESUME_MESSAGE = 'Continue where you stopped.';

function FollowUp({ job }: { job: BoardJob }) {
  const key = `followup:${job.id}`;
  const [draft, setDraft] = useDraft(key);
  const state = useAction(key);
  const name = NAMES[job.agent];
  return (
    <Section title={job.endedAt == null ? t('Steer') : job.debate ? t('Reply') : t('Follow up')} icon={ChatRegular}>
      <textarea aria-label={t('Message to {name}', { name })} placeholder={t('Write a message…')} value={draft} onChange={(event) => setDraft(event.target.value)} />
      <div className="answer-actions">
        <ActionStatus actionKey={key} />
        {/* A job stopped by a usage limit, a budget or a restart only needs telling to go on, as in the app. */}
        {job.state === 'failed' && (
          <button
            disabled={state.pending || board.getSnapshot().connection !== 'live'}
            title={t('Sends “{message}”', { message: RESUME_MESSAGE })}
            onClick={() => void actions.run(key, () => request(`/api/jobs/${job.id}/reply`, { message: RESUME_MESSAGE }), { once: false })}
          >
            {t('Resume')}
          </button>
        )}
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
          {t('Send')}
        </button>
      </div>
    </Section>
  );
}

/**
 * The job the panel shows: the live one, with the prompt and instructions only the fetched detail carries. Nothing
 * else comes from the detail, which would bring back what the daemon has since removed, such as the last turn's outcome.
 */
export function drawerJob(detail: BoardJob | null, current?: BoardJob): BoardJob | undefined {
  if (!detail || !current) return current ?? detail ?? undefined;
  return { ...current, prompt: detail.prompt, instructions: detail.instructions };
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
  useLanguage();
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
        [t('Agent'), [NAMES[job.agent], job.resolvedModel ?? job.model, job.tier && t('{tier} tier', { tier: job.tier }), (job.resolvedEffort ?? job.effort) && t('{effort} effort', { effort: (job.resolvedEffort ?? job.effort)! })].filter(Boolean).join(' · ')],
        [t('Role'), job.ask && !job.debate ? t('Question') : roleLabel({ roleInfo }, jobRole(job))],
        // What the worker declared, set against what the bridge observed.
        ...(job.state === 'done' && job.outcome ? [[t('Outcome'), job.outcomeContradiction ? t('Done as declared, but {contradiction}', { contradiction: job.outcomeContradiction }) : job.outcome[0].toUpperCase() + job.outcome.slice(1)] as [string, string]] : []),
        ...(job.preset ? [[t('Preset'), job.preset[0].toUpperCase() + job.preset.slice(1)] as [string, string]] : []),
        [t('Project'), projectOf(job)],
        [t('Duration'), <Elapsed start={job.createdAt} end={job.endedAt} />],
        ...(job.worktree ? [[t('Branch'), job.worktree.branch] as [string, string]] : []),
        ...(job.tokens != null ? [[t('Tokens'), job.tokens.toLocaleString()] as [string, string]] : []),
        ...(job.tokenUse ? [[t('Of which'), tokenSplit(job.tokenUse, job.turns)] as [string, string]] : []),
        ...(job.context ? [[t('Context'), t('{used} of {size} ({percent}%)', { used: job.context.used.toLocaleString(), size: job.context.size.toLocaleString(), percent: Math.round((job.context.used / job.context.size) * 100) })] as [string, string]] : []),
        [t('Turns'), String(job.turns)],
        ...(job.shared?.length ? [[t('Instructions'), sharedLabel(job)] as [string, string]] : []),
      ]
    : [];
  const result = job?.result;
  const files = result ? [...new Set([...result.files, ...result.outOfScope])].sort() : [];
  return (
    <DetailPanel
      label={job?.title ?? t('Job details')}
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
              {t('Retry')}
            </button>
          </div>
        </div>
      )}
      {!job && !error && (
        <p className="secondary" role="status">
          {t('Loading details…')}
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
            <Section title={t('Changes')} icon={BranchRegular}>
              <pre className="selectable">{result.stat || t('No files changed')}</pre>
              {result.commit && <p className="caption selectable">{t('Commit {commit}', { commit: result.commit })}</p>}
              {files.map((file) => (
                <div className="file" key={file}>
                  <code className="selectable">{file}</code>
                  {result.outOfScope.includes(file) && (
                    <span className="caption error">
                      <Icon icon={WarningRegular} size={11} />
                      {result.files.includes(file) ? t('Outside the allowed targets') : t('Outside the workspace')}
                    </span>
                  )}
                </div>
              ))}
              {/* A section's own action ends it at the trailing edge, as in the app. */}
              {job.worktree && result.files.length > 0 && (
                <div className="answer-actions">
                  <CopyButton text={`git diff ${job.worktree.base.slice(0, 8)}..${job.worktree.branch}`}>{t('Diff Command')}</CopyButton>
                </div>
              )}
            </Section>
          )}
          <VerificationSection job={job} />
          <EvidenceSection job={job} />
          {!!job.rounds?.length && (
            <Section title={t('Rounds')} icon={ArrowCounterclockwiseRegular}>
              {job.rounds.toSorted((a, b) => a.turn - b.turn).map((round) => (
                <RoundRow key={round.turn} job={job} round={round} />
              ))}
            </Section>
          )}
          {refusals.length > 0 && (
            <Section title={t('Automatic review')} icon={ShieldErrorRegular}>
              {refusals.map((refusal, index) => (
                <p className="callout error selectable" key={index}>
                  {refusal.action} — {refusal.reason}
                </p>
              ))}
              {job.retrying && <p className="callout secondary">{t('Sent back once with your approval.')}</p>}
            </Section>
          )}
          {job.notes.length > 0 && (
            <Section title={t('Notes')} icon={NotebookRegular}>
              {job.notes.map((note, index) => (
                <p className="callout selectable" key={index}>{trimNote(note)}</p>
              ))}
            </Section>
          )}
          {hasConversation(job) ? <DebateSection job={job} /> : (
            <>
              {job.report && (
                <Section title={t('Report')} icon={DocumentTextRegular}>
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
            <Section title={t('Activity')} icon={FlashRegular}>
              <EventList events={events} />
            </Section>
          )}
          <Footer status={<ActionStatus actionKey={cancelKey} />}>
            {job.sessionId && (job.agent === 'claude' || agents[job.agent]) && !job.capabilities?.confined && (
              <CopyButton text={`${job.agent === 'claude' ? 'claude --resume' : agents[job.agent].resume} ${job.sessionId}`} short={t('Resume')}>{t('Resume Command')}</CopyButton>
            )}
            {job.endedAt == null && (
              <button
                className="destructive"
                disabled={!live || cancelling.pending || cancelling.accepted}
                onClick={() => void actions.run(cancelKey, () => request(`/api/jobs/${job.id}/cancel`, {}), { done: t('Cancelled') })}
              >
                <Icon icon={RecordStopRegular} />
                {t('Cancel Job')}
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
  const kept = note.slice(0, 2000);
  return rest === 1 ? t('{note}… and 1 more line', { note: kept }) : t('{note}… and {rest} more lines', { note: kept, rest });
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
    <section className="detail-section original" aria-label={t('Original task')}>
      <h3>
        <button className="section-toggle" aria-expanded={shown} onClick={() => long && setShown(!shown)}>
          <Icon icon={TextAlignLeftRegular} />{t('Original task')}
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
      {long && <button className="reveal-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>{shown ? t('Hide the original task') : t('Show the original task')}</button>}
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
        aria-label={t('Panel width')}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        tabIndex={0}
        title={t('Drag to resize, double-click to reset')}
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
          <CloseButton label={t('Close details')} onClose={close} />
        </div>
        {title && (
          <CopyMenu text={title} label={t('Copy Title')}>
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
  useLanguage();
  const session = state.claude.find((item) => item.id === id);
  const missions = state.missions.filter((mission) => mission.owner === id).sort((a, b) => b.createdAt - a.createdAt);
  const status = session && (session.stalled ? 'stalled' : session.state);
  const plainAgents = (session?.agents ?? []).filter((agent) => !agent.workflow);
  return (
    <DetailPanel
      label={session?.title ?? t('Session details')}
      close={close}
      chip={session && <Chip state={status!}>{sessionStateLabel(session)}</Chip>}
      title={session?.title}
      subtitle={session?.state === 'working' ? session.phase : undefined}
    >
      {!session ? (
        <p className="secondary">{t('This session has ended.')}</p>
      ) : (
        <>
          {session.state === 'waiting' && (
            <div className="card answer-card answer">
              <p className="headline selectable">{session.waitingFor ?? t('{agent} needs your input.', { agent: NAMES[sessionAgent(session)] })}</p>
              <ClaudeAsk session={session} />
              {!sessionAppLink(session) && <p className="callout secondary">{t('Answer in {agent}.', { agent: NAMES[sessionAgent(session)] })}</p>}
            </div>
          )}
          <Facts
            facts={[
              [t('Agent'), t('{agent} · Lead', { agent: NAMES[sessionAgent(session)] })],
              [t('Project'), projectOf(session)],
              ...(session.cwd !== projectOf(session) ? [[t('Directory'), session.cwd] as [string, string]] : []),
              [t('Started'), <Elapsed start={session.startedAt} suffix={t(' ago')} />],
              [t('Last active'), <Elapsed start={session.activeAt} suffix={t(' ago')} />],
              ...(session.inTool ? [[t('Now'), t('Running a tool')] as [string, string]] : []),
            ]}
          />
          {plainAgents.length > 0 && (
            <Section title={t('Sub-agents')} icon={PeopleRegular}>
              <SessionAgents agents={plainAgents} label={t('Sub-agents')} />
            </Section>
          )}
          {(session.workflows ?? []).map((run) => (
            <SessionWorkflow key={run.id} run={run} agents={(session.agents ?? []).filter((agent) => agent.workflow === run.id)} />
          ))}
          {missions.length > 0 && (
            <Section title={t('Missions')} icon={FlagRegular}>
              {missions.map((mission) => (
                <div className="session-mission" key={mission.id}>
                  <span>{mission.title}</span>
                  <Chip state={mission.state === 'active' ? 'running' : mission.state}>{missionStateLabel(mission.state)}</Chip>
                </div>
              ))}
            </Section>
          )}
          <Footer>
            <OpenInAgent session={session} />
            <CopyButton text={session.host === 'codex' ? `codex resume ${session.id}` : `claude --resume ${session.id}`} short={t('Resume')}>{t('Resume Command')}</CopyButton>
          </Footer>
        </>
      )}
    </DetailPanel>
  );
}, (a, b) => a.id === b.id && a.close === b.close &&
  a.state.missions === b.state.missions &&
  a.state.claude.find((session) => session.id === a.id) === b.state.claude.find((session) => session.id === b.id));
