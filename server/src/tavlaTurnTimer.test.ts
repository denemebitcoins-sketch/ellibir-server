import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TavlaRoom } from './rooms/TavlaRoom';
import { createTavlaGame, applyTavlaMove } from '../../packages/engine/src/tavla';

let room: any;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-14T12:00:00Z'));
  room = new TavlaRoom();
  room.game = createTavlaGame({ seed: 7, names: ['A', 'B'], botSeats: [] });
  room.game.turn = 0;
  room.game.phase = 'move';
  room.game.dice = [1, 1];
  room.game.movesLeft = [1, 1, 1, 1];
  room.game.points.fill(0);
  room.game.points[23] = 15;
  room.game.points[0] = -15;
  room.pushViews = vi.fn();
  room.afterChange();
});
afterEach(() => {
  room.clearTurnTimers();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Tavla authoritative turn deadline', () => {
  it('keeps one deadline across partial moves, undo and repeated updates', () => {
    const deadline = room.turnDeadlineAt;
    const timer = room.humanTimer;
    vi.advanceTimersByTime(20000);
    expect(applyTavlaMove(room.game, 0, { t: 'move', from: 23, die: 1 }).ok).toBe(true);
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(deadline);
    expect(room.humanTimer).toBe(timer);
    vi.advanceTimersByTime(1000);
    expect(applyTavlaMove(room.game, 0, { t: 'undo' }).ok).toBe(true);
    room.afterChange();
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(deadline);
    expect(room.turnDeadlineAt - Date.now()).toBe(30000);
  });

  it('does not reset the deadline when rolling', () => {
    room.game.phase = 'roll';
    const deadline = room.turnDeadlineAt;
    vi.advanceTimersByTime(15000);
    expect(applyTavlaMove(room.game, 0, { t: 'roll' }).ok).toBe(true);
    expect(room.game.turn).toBe(0);
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(deadline);
  });

  it('renews only when the final step passes the turn', () => {
    const deadline = room.turnDeadlineAt;
    vi.advanceTimersByTime(18000);
    for (let i = 0; i < 4; i++) {
      expect(applyTavlaMove(room.game, 0, { t: 'move', from: 23 - i, die: 1 }).ok).toBe(true);
      room.afterChange();
      if (i < 3) expect(room.turnDeadlineAt).toBe(deadline);
    }
    expect(room.game.turn).toBe(1);
    expect(room.turnDeadlineAt).toBe(Date.now() + 51000);
  });

  it('auto-plays at the original deadline after a partial move', () => {
    const deadline = room.turnDeadlineAt;
    vi.advanceTimersByTime(25000);
    applyTavlaMove(room.game, 0, { t: 'move', from: 23, die: 1 });
    room.afterChange();
    vi.advanceTimersByTime(deadline - Date.now());
    expect(room.game.turn).toBe(1);
    expect(room.turnDeadlineAt).toBe(Date.now() + 51000);
  });

  it('keeps response windows separate and stable across repeated updates', () => {
    vi.advanceTimersByTime(12000);
    room.game.phase = 'roll';
    expect(applyTavlaMove(room.game, 0, { t: 'double' }).ok).toBe(true);
    room.afterChange();
    const responseDeadline = room.turnDeadlineAt;
    expect(responseDeadline).toBe(Date.now() + 16000);
    vi.advanceTimersByTime(2000);
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(responseDeadline);
    expect(applyTavlaMove(room.game, 1, { t: 'takeDouble' }).ok).toBe(true);
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(Date.now() + 51000);
  });

  it('changes timers for bot takeover and returning human', () => {
    room.abandoned.add(0);
    room.afterChange();
    expect(room.humanTimer).toBeNull();
    expect(room.botTimer).not.toBeNull();
    expect(room.turnDeadlineAt).toBe(0);
    room.abandoned.delete(0);
    room.afterChange();
    expect(room.botTimer).toBeNull();
    expect(room.humanTimer).not.toBeNull();
    expect(room.turnDeadlineAt).toBe(Date.now() + 51000);
  });

  it('renews for a new game even with the same starting seat', () => {
    const deadline = room.turnDeadlineAt;
    vi.advanceTimersByTime(1000);
    room.game.gameNumber++;
    room.afterChange();
    expect(room.turnDeadlineAt).toBe(deadline + 1000);
  });
});
