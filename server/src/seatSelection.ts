export type JoinSeatDecision = {
  seat: number | null;
  error?: 'invalid_seat' | 'seat_unavailable';
};

/**
 * Resolves a room join to an absolute table seat.
 * A requested seat is never silently replaced with another free seat.
 */
export function selectJoinSeat(
  humanSeats: readonly number[],
  occupiedSeats: ReadonlySet<number>,
  spectate: boolean,
  requestedRaw: unknown,
): JoinSeatDecision {
  if (spectate) return { seat: null };

  const requested = Number(requestedRaw);
  const hasRequest = requestedRaw !== undefined
    && requestedRaw !== null
    && requestedRaw !== ''
    && requested >= 0;

  if (hasRequest) {
    if (!Number.isInteger(requested) || !humanSeats.includes(requested)) {
      return { seat: null, error: 'invalid_seat' };
    }
    if (occupiedSeats.has(requested)) {
      return { seat: null, error: 'seat_unavailable' };
    }
    return { seat: requested };
  }

  return { seat: humanSeats.find((seat) => !occupiedSeats.has(seat)) ?? null };
}
