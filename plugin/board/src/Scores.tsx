import type { CSSProperties } from 'react';
import { TrophyRegular } from '@fluentui/react-icons';
import type { ModelScore } from './types.ts';
import { NAMES } from './model.ts';
import { AgentMark, Icon, RollingNumber } from './ui.tsx';
import styles from './Scores.module.css';

const shown = (value: number | null) => (value === null ? '—' : value.toFixed(1));
/** A word for where a score sits, read before the number; a model still short of reviews gets none. */
function band(score: ModelScore): { word: string; tone: string } | null {
  if (score.score === null || score.status === 'too few samples') return null;
  if (score.score >= 9) return { word: 'Outstanding', tone: 'var(--green)' };
  if (score.score >= 8) return { word: 'Strong', tone: 'var(--green)' };
  if (score.score >= 7) return { word: 'Solid', tone: 'var(--accent)' };
  if (score.score >= 6) return { word: 'Mixed', tone: 'var(--orange)' };
  return { word: 'Shaky', tone: 'var(--red)' };
}
const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const toneOf = (score: ModelScore) => band(score)?.tone ?? 'var(--tertiary)';
const statusText = (score: ModelScore) => (score.status === 'settled' ? 'Settled' : score.status === 'on trial' ? 'On trial' : 'Too few reviews');
/** How the lead took a model's delegated work; an older daemon, or a model never delegated to, has none. */
const adoptionText = ({ adoption: a }: ModelScore) => a && `Merged ${a.asIs} of ${a.judged} as is · ${a.afterReply} after a reply${a.partly ? ` · ${a.partly} in part` : ''}${a.rejected ? ` · ${a.rejected} rejected` : ''} · ${counted(a.rounds, 'follow-up', 'follow-ups')}`;

/** The score as a ring filling out of 10, with the number in its middle. */
function Ring({ score, size = 52 }: { score: ModelScore; size?: number }) {
  const value = score.score ?? 0;
  return (
    <span className={styles.ring} style={{ '--tone': toneOf(score), '--size': `${size}px` } as CSSProperties} role="img" aria-label={`${shown(score.score)} out of 10`}>
      <svg viewBox="0 0 36 36" aria-hidden="true">
        <circle className={styles.track} cx="18" cy="18" r="15.5" pathLength="100" />
        {score.score !== null && <circle className={styles.arc} cx="18" cy="18" r="15.5" pathLength="100" style={{ '--value': value * 10 } as CSSProperties} />}
      </svg>
      <span className={styles.ringValue} aria-hidden="true">{shown(score.score)}</span>
    </span>
  );
}

/** The items beside correctness, which the ring shows; an older daemon sends none, and an item with nothing behind it is left out. */
const ITEMS = [['brief', 'Brief'], ['report', 'Report'], ['findings', 'Findings']] as const;
const itemBars = (score: ModelScore) => ITEMS.filter(([item]) => score.items?.[item] != null);

/** A build or fix score, or an item, as a short bar out of 10. */
function Bar({ label, value }: { label: string; value: number | null }) {
  return (
    <span className={styles.bar} data-empty={value === null || undefined}>
      <span className={styles.barLabel}>{label}</span>
      <span className={styles.barTrack} aria-hidden="true"><i style={{ '--value': (value ?? 0) / 10 } as CSSProperties} /></span>
      <span className={styles.barValue}>{shown(value)}</span>
    </span>
  );
}

/** The three best-scored models on a podium, the winner in the middle and highest. */
function Podium({ top }: { top: ModelScore[] }) {
  // Second on the left, first in the middle, third on the right; they rise third, second, then first.
  const places = [1, 0, 2].filter((index) => top[index]);
  return (
    <section className={styles.podium} aria-label="Top models">
      {places.map((index) => {
        const score = top[index];
        const place = index + 1;
        return (
          <div className={styles.place} data-place={place} key={score.model} style={{ '--order': 3 - place } as CSSProperties}>
            <div className={styles.contender}>
              {place === 1 && <span className={styles.trophy}><Icon icon={TrophyRegular} size={18} /></span>}
              <span className={styles.avatar}>
                <AgentMark agent={score.agent} size={place === 1 ? 28 : 22} />
                <span className={styles.medal} aria-hidden="true">{place}</span>
              </span>
              <span className={styles.podiumName} title={score.model}>{score.model}</span>
              <span className={styles.pill} style={{ '--tone': toneOf(score) } as CSSProperties} aria-label={`${shown(score.score)} out of 10`} role="img">
                <RollingNumber className={styles.pillNumber} value={score.score ?? 0} format={(value) => value.toFixed(1)} />
                <span className={styles.pillUnit} aria-hidden="true">/10</span>
              </span>
            </div>
            <div className={styles.pedestal} aria-hidden="true"><span>{place}</span></div>
          </div>
        );
      })}
    </section>
  );
}

/** One model's standing: its ring, its build and fix bars, and the lead's summary. A model not yet ranked shows no rank. */
function Row({ score, rank, index }: { score: ModelScore; rank?: number; index: number }) {
  const word = band(score);
  return (
    <article className={styles.row} data-status={score.status} style={{ '--i': index } as CSSProperties}>
      <span className={styles.rank} aria-label={rank ? `Rank ${rank}` : undefined}>{rank ?? ''}</span>
      <span className={styles.rowAvatar}><AgentMark agent={score.agent} size={18} /></span>
      <div className={styles.rowText}>
        <div className={styles.rowHead}>
          <span className={styles.rowName}>{score.model}<span className={styles.hidden}>, {NAMES[score.agent]}</span></span>
          {word && <span className={styles.word} style={{ '--tone': word.tone } as CSSProperties}>{word.word}</span>}
        </div>
        <span className={styles.meta}>{statusText(score)} · {counted(score.buildSamples, 'build', 'builds')} · {counted(score.fixSamples, 'fix', 'fixes')}{score.reviewSamples ? ` · ${counted(score.reviewSamples, 'review', 'reviews')}` : ''}</span>
        {adoptionText(score) && <span className={styles.meta}>{adoptionText(score)}</span>}
        <div className={styles.bars}>
          <Bar label="Build" value={score.build} />
          <Bar label="Fix" value={score.fix} />
          {itemBars(score).map(([item, label]) => <Bar key={item} label={label} value={score.items[item]} />)}
        </div>
        {score.summary && <p className={styles.summary} title={score.summary}>{score.summary}</p>}
      </div>
      <Ring score={score} />
    </article>
  );
}

/**
 * Models with enough reviews, ranked, the best three on a podium; then the ones too early to rank, so a few clean
 * reviews never put a model ahead of one with a record. A model that only reviewed has no build to rank by, so it
 * stands apart, by how its findings held up.
 */
export function Scores({ scores }: { scores: ModelScore[] }) {
  const ranked = scores.filter((score) => score.score !== null && score.status !== 'too few samples');
  const reviewers = scores.filter((score) => score.score === null && score.items?.findings != null).sort((a, b) => b.items.findings! - a.items.findings!);
  const early = scores.filter((score) => !ranked.includes(score) && !reviewers.includes(score));
  return (
    <>
      {ranked.length >= 2 && <Podium top={ranked.slice(0, 3)} />}
      {!scores.length && <section className={styles.standings}><p className={styles.empty}>No reviews noted yet.</p></section>}
      {ranked.length > 0 && (
        <section className={styles.standings} aria-label="Standings">
          {ranked.map((score, index) => <Row key={score.model} score={score} rank={index + 1} index={index} />)}
        </section>
      )}
      {early.length > 0 && (
        <section className={styles.early} aria-labelledby="scores-early">
          <h3 className={styles.earlyTitle} id="scores-early">Too early to rank</h3>
          <div className={styles.standings}>
            {early.map((score, index) => <Row key={score.model} score={score} index={ranked.length + index} />)}
          </div>
        </section>
      )}
      {reviewers.length > 0 && (
        <section className={styles.early} aria-labelledby="scores-reviewers">
          <h3 className={styles.earlyTitle} id="scores-reviewers">Reviewers</h3>
          <div className={styles.standings}>
            {reviewers.map((score, index) => <Row key={score.model} score={score} index={ranked.length + early.length + index} />)}
          </div>
        </section>
      )}
    </>
  );
}
