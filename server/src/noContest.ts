export function isOneRound(totalRounds: unknown): boolean {
  const n = Math.floor(Number(totalRounds));
  return Number.isFinite(n) && n === 1;
}

export function hasLowestScoreTie(scores: Iterable<number> | null | undefined): boolean {
  if (!scores) return false;
  const values = [...scores].map((v) => Number(v)).filter((v) => Number.isFinite(v));
  if (values.length < 2) return false;
  const best = Math.min(...values);
  return values.filter((v) => v === best).length > 1;
}

export function isOneRoundNoContest(opts: {
  totalRounds: unknown;
  handWinnerSeat: unknown;
  scores?: Iterable<number> | null;
}): boolean {
  if (!isOneRound(opts.totalRounds)) return false;
  if (opts.handWinnerSeat == null) return true;
  const winner = Number(opts.handWinnerSeat);
  if (!Number.isFinite(winner) || winner < 0) return true;
  return hasLowestScoreTie(opts.scores);
}

export function shouldDeferEntryHouse(totalRounds: unknown): boolean {
  return isOneRound(totalRounds);
}
