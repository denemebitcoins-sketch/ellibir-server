import { describe, expect, it } from 'vitest';
import { applyMove, createGame, viewFor } from '../src/game';
import { HeuristicBot } from '../src/bot';
import type { Card, GameState, OpenMode } from '../src/types';
import { c, ids } from './helpers';

function rig(
  state: GameState,
  patch: Partial<GameState> & { hands?: Record<number, Card[]> },
): GameState {
  const next: GameState = { ...state, ...patch };
  next.players = state.players.map((p) => ({
    ...p,
    hand: patch.hands?.[p.seat] ?? p.hand,
  }));
  return next;
}

describe('MADDE 2 — açış puanı açıldıktan SONRA artmamalı', () => {
  it('AÇILIŞ TURUNDA parça parça per: openingValue birikir (30 → 51)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // İki ayrı per: 10-10-10 (30) ve K-K-K... ama açış eşiği 81. Tek seferde aç.
    // Burada açış turunda iki ayrı meld hamlesi: önce open (eşik karşılansın),
    // sonra aynı turda yeni per (parça) → openingValue artmalı.
    // Hand: A-A-A(33) + K-K-K(30) + 7-7-7(21) = 84, ayrıca atılacak kart + 2.per
    const hand = [
      c('S', 1), c('H', 1), c('D', 1),       // 33
      c('S', 13), c('H', 13), c('D', 13),    // 30
      c('S', 7), c('H', 7), c('D', 7),       // 21 (açışla beraber)
      c('S', 5), c('H', 5), c('D', 5),       // 15 (aynı turda parça per)
      c('C', 2),                              // atılacak
    ];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    // Aç: 84 puan (3 per)
    state = applyMove(state, {
      type: 'open',
      melds: [ids(hand.slice(0, 3)), ids(hand.slice(3, 6)), ids(hand.slice(6, 9))],
    });
    expect(state.players[0]!.openingValue).toBe(84);
    expect(state.players[0]!.openedOnTurn).toBe(state.turnCount);
    // AYNI turda parça per (5-5-5 = 15) → birikmeli: 84 + 15 = 99
    state = applyMove(state, { type: 'meld', cards: ids(hand.slice(9, 12)) });
    expect(state.players[0]!.openingValue).toBe(99);
  });

  it('AÇILIŞTAN SONRAKİ turda yeni per: openingValue ARTMAZ (84 kalır, 99 olmaz)', () => {
    let state = createGame({ seed: 2, dealerSeat: 0 });
    // Oyuncu daha önceki bir turda açmış (openedOnTurn < turnCount), openingValue=84.
    // Elinde yeni bir per (5-5-5) ve atacak kart var.
    const hand = [c('S', 5), c('H', 5), c('D', 5), c('C', 2)];
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 5,
      hands: { 0: hand },
    });
    state.players = state.players.map((p) =>
      p.seat === 0
        ? {
            ...p,
            hasOpened: true,
            openMode: 'melds' as OpenMode,
            openedOnTurn: 1, // GEÇMİŞ turda açtı
            openingValue: 84,
          }
        : p,
    );
    // Sonraki turda yeni per işle → openingValue HÂLÂ 84 olmalı
    state = applyMove(state, { type: 'meld', cards: ids(hand.slice(0, 3)) });
    expect(state.players[0]!.openingValue).toBe(84);
  });
});

describe('MADDE 3 — bot erken-el açış muhasebesi', () => {
  // İNCE açış (84) + erken deste + GELİŞİM artığı (artık çift 9-9 + ardışık 4-5):
  // garantici/dengeli artık ŞAK açmaz, el gelişimini bekler.
  const upsideHand = [
    c('S', 1), c('H', 1), c('D', 1),    // 33
    c('S', 13), c('H', 13), c('D', 13), // 30
    c('C', 6), c('C', 7), c('C', 8),    // 21 → bestOpening 84
    c('S', 9), c('H', 9),               // artık çift (gelişim)
    c('D', 4), c('D', 5),               // artık ardışık (gelişim)
  ];
  // İNCE açış (84) + ÇÖP artık (alakasız tekler): beklemenin anlamı yok, açar.
  const junkHand = [
    c('S', 1), c('H', 1), c('D', 1),
    c('S', 13), c('H', 13), c('D', 13),
    c('C', 6), c('C', 7), c('C', 8),
    c('S', 2), c('H', 5), c('D', 10), c('C', 11),
  ];

  function firstMove(hand: Card[], profile: 'garantici' | 'dengeli' | 'avci', stock?: number) {
    let state = createGame({ seed: 7, dealerSeat: 0 });
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    if (stock !== undefined) state = { ...state, stock: state.stock.slice(0, stock) };
    return new HeuristicBot({ difficulty: 'normal', profile }).nextMove(viewFor(state, 0));
  }

  it('erken+gelişim malzemesi: dengeli/garantici ŞAK açmaz (bekler)', () => {
    expect(firstMove(upsideHand, 'dengeli').type).not.toBe('open');
    expect(firstMove(upsideHand, 'garantici').type).not.toBe('open');
  });

  it('erken AMA çöp artık: bekleme yok, açar', () => {
    expect(firstMove(junkHand, 'dengeli').type).toBe('open');
    expect(firstMove(junkHand, 'garantici').type).toBe('open');
  });

  it('deste erirken (kapı kapanıyor) tabandan açar — kilitlenmez', () => {
    // Aynı gelişim eli, ama az deste kaldıysa beklemeyi bırakıp açar.
    expect(firstMove(upsideHand, 'dengeli', 49).type).not.toBe('open'); // bol deste → bekle
    expect(firstMove(upsideHand, 'dengeli', 8).type).toBe('open');      // deste az → aç
  });
});
