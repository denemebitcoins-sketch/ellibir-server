import { describe, expect, it } from 'vitest';
import { HeuristicBot } from '../src/bot';
import { applyMove, createGame, startNextHand, viewFor } from '../src/game';
import { sheetTotals } from '../src/scoring';
import { handCardPenalty } from '../src/melds';
import { DEFAULT_RULES } from '../src/rules';
import type { GameState } from '../src/types';

const TOTAL_CARDS =
  DEFAULT_RULES.deckCount * 52 + DEFAULT_RULES.jokerCount;

function countCards(state: GameState): number {
  return (
    state.stock.length +
    state.discard.length +
    state.players.reduce((s, p) => s + p.hand.length, 0) +
    state.melds.reduce((s, m) => s + m.cards.length, 0)
  );
}

/** Tek maçı sonuna kadar oynatır; her hamlede değişmezleri doğrular. */
function playMatch(seed: number): GameState {
  let state = createGame({ seed, botSeats: [0, 1, 2, 3] });
  // Tüm profiller egzersiz edilir (avcı baraj kovalar, garantici erken açar).
  const bots = [
    new HeuristicBot({ difficulty: 'zor', profile: 'avci' }),
    new HeuristicBot({ difficulty: 'normal', profile: 'dengeli' }),
    new HeuristicBot({ difficulty: 'normal', profile: 'garantici' }),
    new HeuristicBot({ difficulty: 'kolay', profile: 'garantici' }),
  ];
  let guard = 0;

  while (state.phase !== 'matchEnded') {
    guard++;
    if (guard > 30000) throw new Error(`Maç bitmedi (seed ${seed})`);

    if (state.phase === 'handEnded') {
      // Skorlar tutarlı: bu elin cezaları toplamlara birebir işlenmiş olmalı.
      expect(state.handNumber).toBeLessThanOrEqual(state.rules.totalHands);
      state = startNextHand(state);
      continue;
    }

    // Kart korunumu — HER hamlede 108 kart hesapta.
    expect(countCards(state)).toBe(TOTAL_CARDS);
    for (const p of state.players) {
      expect(p.hand.length).toBeGreaterThanOrEqual(0);
      // Not: baraj jetonları (-100) toplamı eksiye düşürebilir — geçerli.
      expect(Number.isFinite(p.totalScore)).toBe(true);
    }

    // SORGU açıksa hamleyi DECIDER yapar (ortak/sorulan/asker), yoksa sıradaki oyuncu.
    const sg = state.sorgu;
    const seat = sg
      ? (sg.asama === 'ortakGorus' ? sg.partnerSeat! : sg.asama === 'cevap' ? sg.sorulanSeat : sg.askerSeat)
      : state.currentSeat;
    const before = state.players.map((p) => p.totalScore);
    const sheetLenBefore = state.sheet.length;
    const move = bots[seat]!.nextMove(viewFor(state, seat));
    try {
      state = applyMove(state, move);
    } catch {
      // Gerçek oyundaki bot FALLBACK'i (GameSession.StepBots / Edge): geçersiz hamlede güvenli oyna.
      if (state.sorgu) {
        // Bekleyen sorgu hamlesini güvenli kapat (varsayılan VER).
        if (state.sorgu.asama === 'ortakGorus') {
          state = applyMove(state, { type: 'sorguOrtakGorus', gorus: 'ver' });
        } else if (state.sorgu.asama === 'cevap') {
          state = applyMove(state, { type: 'sorguCevap', cevap: 'ver' });
        } else {
          state = applyMove(state, { type: 'sorguSonuc', al: true });
        }
      } else if (state.phase === 'draw') {
        state = applyMove(state, { type: 'drawStock' });
      } else {
        // Sırası gelen oyuncu (currentSeat) güvenli atış yapar; ZORUNLU kart asla atılmaz.
        const me = state.players[state.currentSeat]!;
        const zorunluId = state.pickup?.zorunlu ? state.pickup.cardId : null;
        const cand = me.hand.filter((c) => c.id !== zorunluId);
        const worst = (cand.length ? cand : me.hand).reduce((a, b) =>
          handCardPenalty(b, state.rules) > handCardPenalty(a, state.rules) ? b : a,
        );
        state = applyMove(state, { type: 'discard', cardId: worst.id });
      }
    }

    if (state.phase === 'handEnded' || state.phase === 'matchEnded') {
      // Cezalar toplamlara doğru eklendi mi? (Son atış işlekse atan +ceza alır.)
      const result = state.lastHandResult!;
      // İŞLEK/OKEY ıskarta cezası (50 ya da 100; muafiyette 0) yazboza 'islek'
      // satırı olarak düşer — gerçek tutarı oradan oku (log bayrağı tutar DEĞİL).
      const islekExtra = state.sheet
        .slice(sheetLenBefore)
        .filter((e) => e.kind === 'islek' && e.seat === seat)
        .reduce((s, e) => s + e.amount, 0);
      for (const p of state.players) {
        const extra = p.seat === seat ? islekExtra : 0;
        expect(p.totalScore).toBe(before[p.seat]! + extra + (result.penalties[p.seat] ?? 0));
      }
      expect(countCards(state)).toBe(TOTAL_CARDS);

      // YAZBOZ bütünlüğü: toplamlar daima satırların toplamı; bitirene
      // bu elde ceza satırı yazılmaz.
      const totals = sheetTotals(state.sheet, state.rules.playerCount);
      for (const p of state.players) {
        expect(p.totalScore).toBe(totals[p.seat]);
      }
      if (result.winnerSeat !== null) {
        const winnerPenaltyRows = state.sheet.filter(
          (e) =>
            e.kind === 'penalty' &&
            e.seat === result.winnerSeat &&
            e.hand === state.handNumber,
        );
        expect(winnerPenaltyRows).toHaveLength(0);
      }
    }
  }
  return state;
}

describe('rastgele bot maç simülasyonu', () => {
  it('500 maç çökmesiz tamamlanır; korunum ve skor tutarlılığı her hamlede sağlanır', () => {
    for (let m = 0; m < 500; m++) {
      const final = playMatch(1000 + m * 17);
      expect(final.phase).toBe('matchEnded');
      expect(final.matchWinnerSeat).not.toBeNull();
      // Kazanan en düşük toplam olmalı (eleme yoktur).
      const minScore = Math.min(...final.players.map((p) => p.totalScore));
      expect(final.players[final.matchWinnerSeat!]!.totalScore).toBe(minScore);
    }
  }, 600000);
});
