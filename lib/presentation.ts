type ScoreValue = { score: number | null };
type ScorePair = { latest?: ScoreValue | null; previous?: ScoreValue | null };

export function scoreChange(current?: ScoreValue | null, previous?: ScoreValue | null): number | null {
  if (current?.score == null || previous?.score == null) return null;
  return current.score - previous.score;
}

export function changeTone(value: number | null): 'up' | 'down' | 'flat' {
  return value == null || value === 0 ? 'flat' : value > 0 ? 'up' : 'down';
}

export function compareScoreChanges(a: ScorePair, b: ScorePair): number {
  const da = scoreChange(a.latest, a.previous);
  const db = scoreChange(b.latest, b.previous);
  if (da == null) return db == null ? 0 : 1;
  if (db == null) return -1;
  return db - da;
}
