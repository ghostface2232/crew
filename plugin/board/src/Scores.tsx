import type { CSSProperties } from 'react';
import { Trophy } from 'lucide-react';
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
const toneOf = (score: ModelScore) => band(score)?.tone ?? 'var(--tertiary)';
const statusText = (score: ModelScore) => (score.status === 'settled' ? 'Settled' : score.status === 'on trial' ? 'On trial' : 'Too few reviews');

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

/** A build or fix score as a short bar out of 10. */
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
              {place === 1 && <span className={styles.trophy}><Icon icon={Trophy} size={18} /></span>}
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

/** Every model ranked, with its ring, its build and fix bars, and the lead's summary. */
export function Scores({ scores }: { scores: ModelScore[] }) {
  const scored = scores.filter((score) => score.score !== null);
  return (
    <>
      {scored.length >= 2 && <Podium top={scored.slice(0, 3)} />}
      <section className={styles.standings} aria-label="Standings">
        {scores.length ? scores.map((score, index) => {
          const word = band(score);
          return (
            <article className={styles.row} key={score.model} data-status={score.status} style={{ '--i': index } as CSSProperties}>
              <span className={styles.rank} aria-label={`Rank ${index + 1}`}>{index + 1}</span>
              <span className={styles.rowAvatar}><AgentMark agent={score.agent} size={18} /></span>
              <div className={styles.rowText}>
                <div className={styles.rowHead}>
                  <span className={styles.rowName}>{score.model}<span className={styles.hidden}>, {NAMES[score.agent]}</span></span>
                  {word && <span className={styles.word} style={{ '--tone': word.tone } as CSSProperties}>{word.word}</span>}
                </div>
                <span className={styles.meta}>{statusText(score)} · {score.samples} {score.samples === 1 ? 'review' : 'reviews'}</span>
                <div className={styles.bars}>
                  <Bar label="Build" value={score.build} />
                  <Bar label="Fix" value={score.fix} />
                </div>
                {score.summary && <p className={styles.summary}>{score.summary}</p>}
              </div>
              <Ring score={score} />
            </article>
          );
        }) : <p className={styles.empty}>No reviews noted yet.</p>}
      </section>
    </>
  );
}
