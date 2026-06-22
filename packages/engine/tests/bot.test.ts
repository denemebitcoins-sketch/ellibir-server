import { describe, expect, it } from 'vitest';
import { HeuristicBot } from '../src/bot';
import { applyMove, createGame, viewFor } from '../src/game';
import type { GameState } from '../src/types';

function totalCards(state: GameState): number {
  return (
    state.stock.length +
    state.discard.length +
    state.players.reduce((s, p) => s + p.hand.length, 0) +
    state.melds.reduce((s, m) => s + m.cards.length, 0)
  );
}

describe('bot simülasyonu', () => {
  it('4 bot hatasız bir el oynar; kart sayısı korunur', () => {
    for (const seed of [11, 22, 33]) {
      let state = createGame({ seed, botSeats: [0, 1, 2, 3] });
      const bot = new HeuristicBot();
      let guard = 0;
      while (state.phase === 'draw' || state.phase === 'action') {
        expect(totalCards(state)).toBe(106);
        // SORGU açıksa hamleyi DECIDER yapar (ortak/sorulan/asker), yoksa sıradaki oyuncu.
        const sg = state.sorgu;
        const actor = sg
          ? (sg.asama === 'ortakGorus' ? sg.partnerSeat! : sg.asama === 'cevap' ? sg.sorulanSeat : sg.askerSeat)
          : state.currentSeat;
        const move = bot.nextMove(viewFor(state, actor));
        state = applyMove(state, move);
        guard++;
        expect(guard).toBeLessThan(5000);
      }
      expect(state.phase === 'handEnded' || state.phase === 'matchEnded').toBe(true);
      expect(totalCards(state)).toBe(106);
      // Kazanan varsa eli boşalmış olmalı.
      const result = state.lastHandResult!;
      if (result.winnerSeat !== null) {
        expect(state.players[result.winnerSeat]!.hand).toHaveLength(0);
        expect(state.players[result.winnerSeat]!.hasOpened).toBe(true);
      }
    }
  }, 30000);
});
