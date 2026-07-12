import { describe, expect, it } from 'vitest';
import { selectJoinSeat } from './seatSelection';

describe('absolute room seat selection', () => {
  const humanSeats = [0, 1, 2, 3];

  it('keeps the exact seat selected in the salon', () => {
    expect(selectJoinSeat(humanSeats, new Set([0]), false, 1)).toEqual({ seat: 1 });
    expect(selectJoinSeat(humanSeats, new Set([0]), false, '3')).toEqual({ seat: 3 });
  });

  it('does not silently move a player when the requested seat became occupied', () => {
    expect(selectJoinSeat(humanSeats, new Set([1]), false, 1)).toEqual({
      seat: null,
      error: 'seat_unavailable',
    });
  });

  it('rejects seats outside the room human-seat policy', () => {
    expect(selectJoinSeat([0, 2], new Set(), false, 1)).toEqual({
      seat: null,
      error: 'invalid_seat',
    });
  });

  it('preserves quick-play first-free behavior when no seat was requested', () => {
    expect(selectJoinSeat(humanSeats, new Set([0, 1]), false, -1)).toEqual({ seat: 2 });
    expect(selectJoinSeat(humanSeats, new Set([0, 1]), false, undefined)).toEqual({ seat: 2 });
  });

  it('always keeps explicit spectators unseated', () => {
    expect(selectJoinSeat(humanSeats, new Set(), true, 2)).toEqual({ seat: null });
  });
});
