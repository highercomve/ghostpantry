export interface FoodMatch {
  label: string;
  score: number;
  adjustment?: number;
}

// A presentation heuristic, not a presence detector or probability threshold.
// Keep distant runners-up available without presenting every top-k label equally.
export function splitSuggestions<T extends FoodMatch>(
  matches: readonly T[],
  backgroundScore = 0,
): { stronger: T[]; alternatives: T[] } {
  const rank = (match: T) => match.score + (match.adjustment ?? 0);
  const finite = matches.filter((match) => Number.isFinite(rank(match)));
  const best = Math.max(...finite.map(rank));
  const stronger = finite.filter(
    (match) => rank(match) > backgroundScore && rank(match) >= best - 0.04,
  );
  const names = new Set(stronger.map((match) => match.label));
  return {
    stronger,
    alternatives: matches.filter((match) => !names.has(match.label)),
  };
}
