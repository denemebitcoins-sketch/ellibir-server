import { describe, expect, it } from 'vitest';
import { findExistingUserSeat, onlineHumanSeats, selectJoinSeat, selectSitSeat } from './seatSelection';

describe('absolute room seat selection', () => {
  const humanSeats = [0, 1, 2, 3];
  for (const game of ['ellibir','okey','tavla'] as const) {
    it(`${game}: exact chair survives every occupancy and spectator-sit combination`, () => {
      const seats = onlineHumanSeats(game);
      for (const requested of seats) {
        expect(selectSitSeat(seats, new Set(seats.filter(s=>s!==requested)), requested).seat).toBe(requested);
        for (const free of seats.filter(s=>s!==requested)) {
          const occupied = new Set(seats.filter(s=>s!==free));
          expect(selectSitSeat(seats,occupied,requested)).toEqual({seat:null,error:'seat_unavailable'});
          expect(selectJoinSeat(seats,occupied,false,requested)).toEqual({seat:null,error:'seat_unavailable'});
        }
      }
      expect(selectSitSeat(seats,new Set(seats.slice(1)),-1).seat).toBe(0);
      expect(selectSitSeat(seats,new Set(),'bad').error).toBe('invalid_seat');
    });
  }

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

describe('online room human-seat policy', () => {
  it('does not reserve table 1 seats for startup bots', () => {
    expect(onlineHumanSeats('ellibir')).toEqual([0, 1, 2, 3]);
    expect(onlineHumanSeats('okey')).toEqual([0, 1, 2, 3]);
    expect(onlineHumanSeats('tavla')).toEqual([0, 1]);
  });
});

describe('same-account room seat guard', () => {
  it('finds the already seated seat for a verified user id', () => {
    const seats = new Map<string, number>([['sid-a', 0], ['sid-b', 3]]);
    const users = new Map<number, string>([[0, 'user-a'], [3, 'user-b']]);

    expect(findExistingUserSeat(seats, users, 'user-b')).toEqual({ sessionId: 'sid-b', seat: 3 });
  });

  it('ignores missing and unknown user ids', () => {
    const seats = new Map<string, number>([['sid-a', 0]]);
    const users = new Map<number, string>([[0, 'user-a']]);

    expect(findExistingUserSeat(seats, users, null)).toBeNull();
    expect(findExistingUserSeat(seats, users, 'other')).toBeNull();
  });
});
