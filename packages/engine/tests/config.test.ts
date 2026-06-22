import { describe, expect, it } from 'vitest';
import { applyMove, createGame } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState } from '../src/types';
import { c, joker } from './helpers';

const R = DEFAULT_RULES;

function rig(
  state: GameState,
  patch: Partial<GameState> & { hands?: Record<number, Card[]>; opened?: number[] },
): GameState {
  const next: GameState = { ...state, ...patch };
  next.players = state.players.map((p) => ({
    ...p,
    hand: patch.hands?.[p.seat] ?? p.hand,
    hasOpened: patch.opened?.includes(p.seat) ?? p.hasOpened,
    openMode: patch.opened?.includes(p.seat) ? ('melds' as const) : p.openMode,
    openedOnTurn: patch.opened?.includes(p.seat) ? 1 : p.openedOnTurn,
  }));
  return next;
}

describe('RULES.md §4 config sabitleri (Paket 2)', () => {
  it('tüm anahtarlar tek modülde, belge değerleriyle var', () => {
    expect(R.deckCount * 52 + R.jokerCount).toBe(106); // DECK
    expect(R.openingMinPoints).toBe(81); // ACAR_TABAN
    expect(R.openingMinPointsAfterPairOpen).toBe(101); // ACAR_CIFTLI
    expect(R.pairs.pairsToOpen).toBe(5); // CIFT_ACMA_MIN
    expect(R.barajTokens.pairThresholds).toEqual([5, 6, 7]); // CIFT_BARAJ
    expect(R.barajTokens.value).toBe(-100); // BARAJ_VALUE
    expect(R.scoring.basePenalty).toBe(200); // KAFA_CEZASI
    expect(R.scoring.stockOutPenalty).toBe(200); // STOCK_OUT_PENALTY
    expect(R.scoring.carpanBitirenCift).toBe(2); // CARPAN_BITIREN_CIFT
    expect(R.scoring.carpanOkeyBitis).toBe(2); // CARPAN_OKEY_BITIS
    expect(R.scoring.carpanYiyenCift).toBe(2); // CARPAN_YIYEN_CIFT
    expect(R.islek.penaltyPoints).toBe(50); // ISLEK_ATMA_CEZASI
    expect(R.jokerHandPenalty).toBe(50); // OKEY_EL_PUANI
    expect(R.turSecenekleri).toEqual([25, 20, 15]); // TUR_SURELERI
    expect(R.turSecenekleri).toContain(R.turnTimerSeconds); // varsayılan 20 listeden
    expect(R.turnTimerSeconds).toBe(20);
    expect(R.elSecenekleri).toEqual([3, 5, 7, 9, 11]); // EL_SAYILARI
    expect(R.elSecenekleri).toContain(R.totalHands);
    expect(R.otopilotEsigi).toBe(3); // OTOPILOT_ESIGI (ardışık tur)
    expect(R.botDevralmaSn).toBe(10); // BOT_DEVRALMA_SN
    expect(R.donusPenceresiSn).toBe(180); // DONUS_PENCERESI_SN
    expect(R.sorguSuresi).toBe(15); // SORGU_SURESI
    expect(R.sorguVarsayilan).toBe('VER'); // SORGU_VARSAYILAN
    expect(R.ekonomi.komisyonOrani).toBe(0.1); // KOMISYON_ORANI (faz 4 anahtarı)
  });

  it('çarpanlar gerçekten config’ten okunur (override etkili)', () => {
    // Okey çarpanını 3 yap: kapalı ödeyen 200×3 = 600 olmalı.
    const rules = makeRules({
      scoring: { ...R.scoring, carpanOkeyBitis: 3 },
    });
    let state = createGame({ seed: 1, dealerSeat: 0, rules });
    const lastJoker = joker(0);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0],
      hands: { 0: [lastJoker], 1: [c('S', 5)], 2: [c('D', 3)], 3: [c('H', 11)] },
    });
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    expect(ended.lastHandResult?.okeyFinish).toBe(true);
    expect(ended.lastHandResult?.penalties).toEqual([0, 600, 600, 600]);
  });
});
