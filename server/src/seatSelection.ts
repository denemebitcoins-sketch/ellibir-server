export type JoinSeatDecision = {
  seat: number | null;
  error?: 'invalid_seat' | 'seat_unavailable';
};

export type OnlineGameKind = 'ellibir' | 'okey' | 'tavla';
export type ExistingUserSeat = { sessionId: string; seat: number };

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

export function findExistingUserSeat(
  seats: ReadonlyMap<string, number>,
  seatUsers: ReadonlyMap<number, string>,
  userId: string | null | undefined,
): ExistingUserSeat | null {
  if (!userId) return null;
  for (const [sessionId, seat] of seats) {
    if (seatUsers.get(seat) === userId) return { sessionId, seat };
  }
  return null;
}

/**
 * Human seats that would enter a fresh match with nobody able to play them: the seat was
 * vacated while the entry fee was being collected, or its holder is only a dropped session
 * waiting in the 180 s reconnection window. Such seats must start under bot control
 * (exactly like a drop after the match started) instead of waiting out the human turn timer.
 */
export function seatsWithoutLivePlayer(
  humanSeats: readonly number[],
  seats: ReadonlyMap<string, number>,
  connectedSessions: ReadonlySet<string>,
  botSeats: Iterable<number>,
): number[] {
  const bots = new Set(botSeats);
  const holder = new Map<number, string>();
  for (const [sessionId, seat] of seats) holder.set(seat, sessionId);
  return humanSeats.filter((seat) => {
    if (bots.has(seat)) return false;
    const sessionId = holder.get(seat);
    return sessionId === undefined || !connectedSessions.has(sessionId);
  });
}

/** Spectator sit requests preserve an explicit chair even if another chair is free. */
export function selectSitSeat(humanSeats: readonly number[], occupied: ReadonlySet<number>, raw: unknown): JoinSeatDecision {
  const automatic = raw === undefined || raw === null || raw === '' || raw === -1;
  if (automatic && humanSeats.filter(s => !occupied.has(s)).length !== 1)
    return { seat: null, error: 'invalid_seat' };
  if (!automatic && (!Number.isInteger(Number(raw)) || Number(raw) < 0))
    return { seat: null, error: 'invalid_seat' };
  return selectJoinSeat(humanSeats, occupied, false, raw);
}
