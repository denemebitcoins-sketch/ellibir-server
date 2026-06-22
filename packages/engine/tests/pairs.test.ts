import { describe, expect, it } from 'vitest';
import { analyzePair } from '../src/melds';
import { analyzeHand } from '../src/insight';
import { applyMove, canOpenPairs, createGame } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState } from '../src/types';
import { c, ids, joker } from './helpers';

const R = DEFAULT_RULES;

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

describe('çift (pair) doğrulama', () => {
  it('aynı rank + aynı renk iki kart geçerli çifttir', () => {
    const a = analyzePair([c('S', 9, 0), c('S', 9, 1)], R);
    expect(a?.type).toBe('pair');
    expect(a?.points).toBe(18);
  });

  it('aynı rank farklı renk çift DEĞİLDİR', () => {
    expect(analyzePair([c('S', 9), c('H', 9)], R)).toBeNull();
  });

  it('joker eksik eşi tutar ve neyi temsil ettiği bilinir', () => {
    const a = analyzePair([c('D', 12), joker()], R);
    expect(a).not.toBeNull();
    expect(a?.jokers[0]).toMatchObject({ rank: 12, suits: ['D'] });
  });

  it('iki joker çift olamaz; 3 kart çift olamaz', () => {
    expect(analyzePair([joker(0), joker(1)], R)).toBeNull();
    expect(analyzePair([c('S', 9, 0), c('S', 9, 1), c('S', 9, 2)], R)).toBeNull();
  });

  it('pairs.enabled=false iken çift geçersizdir', () => {
    const off = makeRules({ pairs: { enabled: false } as never });
    expect(analyzePair([c('S', 9, 0), c('S', 9, 1)], off)).toBeNull();
  });
});

describe('çiftle açış', () => {
  const fivePairs = (): Card[][] => [
    [c('S', 9, 0), c('S', 9, 1)],
    [c('H', 5, 0), c('H', 5, 1)],
    [c('D', 12, 0), c('D', 12, 1)],
    [c('C', 2, 0), c('C', 2, 1)],
    [c('S', 1, 0), joker()],
  ];

  it('5 geçerli çift açar, 4 açamaz', () => {
    const pairs = fivePairs();
    expect(canOpenPairs(pairs, R)).not.toBeNull();
    expect(canOpenPairs(pairs.slice(0, 4), R)).toBeNull();
  });

  it('openPairs hamlesi modu kilitler ve çiftleri masaya koyar', () => {
    const pairs = fivePairs();
    const hand = [...pairs.flat(), c('D', 7)];
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    const next = applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
    expect(next.players[0]!.hasOpened).toBe(true);
    expect(next.players[0]!.openMode).toBe('pairs');
    expect(next.melds.filter((m) => m.type === 'pair')).toHaveLength(5);
    expect(next.players[0]!.hand).toHaveLength(1);
  });

  it('4 çiftle openPairs reddedilir', () => {
    const pairs = fivePairs().slice(0, 4);
    const hand = [...pairs.flat(), c('D', 7)];
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    expect(() => applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) })).toThrowError(
      /çift/i,
    );
  });
});

describe('mod kilidi', () => {
  function openedWithPairs(): GameState {
    const pairs = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    const extraPair = [c('H', 8, 0), c('H', 8, 1)];
    const hand = [...pairs.flat(), ...extraPair, c('D', 7), c('C', 4), c('C', 5), c('C', 6)];
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    return applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
  }

  it('çift açan yeni çift indirebilir ama per indiremez ve işleyemez', () => {
    let state = openedWithPairs();
    const hand = state.players[0]!.hand;
    const pairCards = hand.filter((x) => !x.joker && x.rank === 8);
    state = applyMove(state, { type: 'meld', cards: pairCards.map((x) => x.id) });
    expect(state.melds.filter((m) => m.type === 'pair')).toHaveLength(6);

    // Per (4-5-6) indirmeyi dene → reddedilmeli.
    const run = state.players[0]!.hand.filter((x) => !x.joker && x.suit === 'C');
    expect(() => applyMove(state, { type: 'meld', cards: run.map((x) => x.id) })).toThrowError(
      /çift/i,
    );

    // Masadaki bir per'e işleme → reddedilmeli (pairsMode).
    const anyMeld = state.melds[0]!;
    const anyCard = state.players[0]!.hand[0]!;
    expect(() =>
      applyMove(state, { type: 'extend', meldId: anyMeld.id, cardId: anyCard.id }),
    ).toThrowError();
  });

  it('per açan çift indiremez', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const meldHand = [
      c('S', 12), c('H', 12), c('D', 12),
      c('S', 13), c('H', 13), c('D', 13),
      c('C', 6), c('C', 7), c('C', 8),
      c('H', 3, 0), c('H', 3, 1), c('D', 2),
    ];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: meldHand } });
    state = applyMove(state, {
      type: 'open',
      melds: [ids(meldHand.slice(0, 3)), ids(meldHand.slice(3, 6)), ids(meldHand.slice(6, 9))],
    });
    expect(state.players[0]!.openMode).toBe('melds');
    const pair = state.players[0]!.hand.filter((x) => !x.joker && x.rank === 3);
    expect(() => applyMove(state, { type: 'meld', cards: pair.map((x) => x.id) })).toThrowError(
      /perde/i,
    );
  });
});

describe('çiftten bitme skorlaması', () => {
  it('çiftten bitme: kapalı rakipler 200 x2 (çiftten) = 400 öder', () => {
    const pairs = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    const lastCard = c('D', 7);
    const hand = [...pairs.flat(), lastCard];
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      hands: {
        0: hand,
        1: [c('S', 13)],
        2: [c('H', 5, 9)],
        3: [joker(8)],
      },
    });
    state = applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
    const ended = applyMove(state, { type: 'discard', cardId: lastCard.id });
    expect(ended.phase === 'handEnded' || ended.phase === 'matchEnded').toBe(true);
    expect(ended.lastHandResult).toMatchObject({ winnerSeat: 0, pairFinish: true });
    // Kapalı rakipler: 200 x2 (çiftten) = 400 (elden bitme çarpan değildir).
    expect(ended.lastHandResult?.penalties).toEqual([0, 400, 400, 400]);
  });

  it('normal (per) bitişte pairFinish=false olur', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, { currentSeat: 0, phase: 'action', turnCount: 9, hands: { 0: [c('D', 2)], 1: [c('S', 13)], 2: [c('H', 5)], 3: [c('D', 1)] } });
    state.players = state.players.map((p) =>
      p.seat === 0 ? { ...p, hasOpened: true, openMode: 'melds', openedOnTurn: 1 } : p,
    );
    const ended = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(ended.lastHandResult?.pairFinish).toBe(false);
    expect(ended.lastHandResult?.penalties).toEqual([0, 200, 200, 200]);
  });
});

describe('el analizi (insight)', () => {
  it('perleri, çiftleri ve açılabilirliği raporlar', () => {
    const hand = [
      c('S', 12), c('H', 12), c('D', 12), // küt 30
      c('C', 6), c('C', 7), c('C', 8), // seri 21
      c('H', 3, 0), c('H', 3, 1), // çift
      c('D', 9, 0), c('D', 9, 1), // çift
      joker(), // tek joker → kalan tekille çift sayılır
      c('S', 2),
    ];
    const insight = analyzeHand(hand, R);
    // Çözücü jokeri 4. Q yapar: Q-Q-Q-★ (40) + 6-7-8 (21) = 61.
    expect(insight.meldPoints).toBe(61);
    expect(insight.canOpenMelds).toBe(false); // temel sınır artık 81
    expect(analyzeHand(hand, R, 60).canOpenMelds).toBe(true); // dinamik sınır parametresi
    expect(insight.pairs).toHaveLength(2);
    expect(insight.pairCount).toBe(3); // 2 özdeş + 1 joker tamamlaması
    expect(insight.canOpenPairs).toBe(false); // 5 gerekli
  });
});
