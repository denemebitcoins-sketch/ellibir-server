export type JoinSeatDecision = {
  seat: number | null;
  error?: 'invalid_seat' | 'seat_unavailable';
};

export type OnlineGameKind = 'ellibir' | 'okey' | 'tavla';

/**
 * Online salon tables always start with real players. Bots are reserved for the
 * local training flow and for taking over a disconnected seat after a match starts.
 */
export function onlineHumanSeats(game: OnlineGameKind): number[] {
  return game === 'tavla' ? [0, 1] : [0, 1, 2, 3];
}

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
