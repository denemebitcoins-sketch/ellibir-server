import { describe, expect, it } from 'vitest';
import { createTavlaGame, startNextGame, applyTavlaMove } from '../../packages/engine/src/tavla';

describe('tavla opening roll contract', () => {
  it('uses the opening dice as the first playable dice in game one', () => {
    const st = createTavlaGame({ seed: 20260813, names: ['A', 'B'], botSeats: [] });

    expect(st.gameNumber).toBe(1);
    expect(st.openRoll[0]).toBeGreaterThan(0);
    expect(st.openRoll[1]).toBeGreaterThan(0);
    expect(st.openRoll[0]).not.toBe(st.openRoll[1]);
    expect(st.turn).toBe(st.openRoll[0]! > st.openRoll[1]! ? 0 : 1);
    expect(st.phase).toBe('move');
    expect(st.dice).toEqual(st.openRoll);
    expect(st.movesLeft).toEqual(st.openRoll);

    expect(applyTavlaMove(st, st.turn, { t: 'roll' }).ok).toBe(false);
  });

  it('starts later games with the previous winner in roll phase', () => {
    const st = createTavlaGame({ seed: 20260814, names: ['A', 'B'], botSeats: [] });
    st.lastGameWinner = 1;
    st.gameWinner = 1;
    st.gameEnded = true;

    startNextGame(st);

    expect(st.gameNumber).toBe(2);
    expect(st.turn).toBe(1);
    expect(st.phase).toBe('roll');
    expect(st.dice).toEqual([0, 0]);
    expect(st.movesLeft).toEqual([]);
    expect(st.openRoll).toEqual([0, 0]);
  });
});
