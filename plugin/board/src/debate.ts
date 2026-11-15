export type Stance = 'agree' | 'disagree' | 'alternative';

export interface DebatePoint {
  number: number;
  stance: Stance;
  title: string;
}

export function debatePoints(text: string): DebatePoint[] {
  const pattern = /^\s*(?:[-*]\s*)?(\d+)\.\s*(?:\*\*)?\[?(agree|disagree|alternative)\b\]?(?:\*\*)?[\s:.\-—–·,]*(.*)$/i;
  const basisPattern = /^[(\[]?(?:\*\*)?(?:verified|read|inferred)(?:\*\*)?[)\]]?\s*[:\-—–·,]+\s*(.*)$/i;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const points: DebatePoint[] = [];
  for (const line of text.split('\n')) {
    const match = pattern.exec(line);
    if (!match) continue;
    const number = Number(match[1]);
    if (!Number.isSafeInteger(number)) continue;
    let title = (basisPattern.exec(match[3])?.[1] ?? match[3])
      .replaceAll('**', '').replaceAll('`', '').trim();
    // Swift counts Characters, so emoji and combining marks occupy one position.
    let characters = Array.from(segmenter.segment(title), (part) => part.segment);
    const end = characters.findIndex((character) => '.!?。'.includes(character));
    if (end > 12) characters = characters.slice(0, end + 1);
    if (characters.length > 140) characters = [...characters.slice(0, 139), '…'];
    title = characters.join('');
    points.push({ number, stance: match[2].toLowerCase() as Stance, title });
  }
  return points;
}

export function stanceCounts(points: readonly DebatePoint[]): Record<Stance, number> {
  const counts = { agree: 0, disagree: 0, alternative: 0 };
  for (const point of points) counts[point.stance]++;
  return counts;
}
