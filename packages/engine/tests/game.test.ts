import { describe, expect, it } from 'vitest';
import {
  applyMove,
  canExtend,
  canRetrieveJoker,
  createGame,
  legalExtendTargets,
  startNextHand,
  viewFor,
} from '../src/game';
import { makeRules } from '../src/rules';
import type { Card, GameState, Meld } from '../src/types';
import { c, ids, joker } from './helpers';

function meld(id: string, type: 'set' | 'run', cards: Card[], ownerSeat = 1): Meld {
  return { id, ownerSeat, type, cards };
}

/** Test senaryosu için durumu elle kur. */
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

describe('el kurulumu ve tur akışı', () => {
  it('dağıtıcı 15 kartla "action" fazında başlar, diğerleri 14 kart alır', () => {
    const state = createGame({ seed: 5, dealerSeat: 2 });
    expect(state.players[2]!.hand).toHaveLength(15);
    expect(state.players[0]!.hand).toHaveLength(14);
    expect(state.currentSeat).toBe(2);
    expect(state.phase).toBe('action');
    expect(state.discard).toHaveLength(0);
  });

  it('atış sırayı bir sonraki oyuncuya geçirir', () => {
    const state = createGame({ seed: 5, dealerSeat: 0 });
    const cardId = state.players[0]!.hand[0]!.id;
    const next = applyMove(state, { type: 'discard', cardId });
    expect(next.currentSeat).toBe(1);
    expect(next.phase).toBe('draw');
    expect(next.discard.map((card) => card.id)).toEqual([cardId]);
  });

  it('açık yığından alınan kart ele gelir (deneme modu — RULES.md 1.6)', () => {
    let state = createGame({ seed: 5, dealerSeat: 0 });
    // Alıcı (1. koltuk) açık olsun. Atılan kart İŞLEK OLMAMALI (işlek/okey atışı
    // artık kilitli — rakip alamaz, RULES.md işlek atış kuralı); ♠2 hiçbir peri işlemez.
    const dropped = c('S', 2);
    state = rig(state, {
      hands: { 0: [dropped, c('S', 10)], 1: [c('H', 3), c('H', 9)] },
      opened: [1],
      melds: [meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)])],
    });
    state = applyMove(state, { type: 'discard', cardId: dropped.id });
    state = applyMove(state, { type: 'pickupDiscard' });
    expect(state.players[1]!.hand.map((card) => card.id)).toContain(dropped.id);
    expect(state.pickup?.cardId).toBe(dropped.id);
    expect(state.discard).toHaveLength(0);
    expect(state.phase).toBe('action');
  });

  it('deste bitince el biter (karma yok — RULES.md 1.7)', () => {
    let state = createGame({ seed: 5, dealerSeat: 3 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      stock: [],
      discard: [c('H', 2)],
      hands: { 0: [c('S', 13)], 1: [c('H', 5)], 2: [joker(9)], 3: [c('D', 1)] },
    });
    const next = applyMove(state, { type: 'drawStock' });
    expect(next.phase).toBe('handEnded');
    expect(next.lastHandResult?.winnerSeat).toBeNull();
    // Hibrit modelde berabere elde ceza yazılmaz.
    expect(next.lastHandResult?.penalties).toEqual([0, 0, 0, 0]);
  });
});

describe('açma / perde işleme / joker', () => {
  it('açma hamlesi perdeleri masaya koyar ve eli düşürür', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // Q-Q-Q (30) + K-K-K (30) + 6-7-8 (21) = 81
    const hand = [
      c('S', 12), c('H', 12), c('D', 12),
      c('S', 13), c('H', 13), c('D', 13),
      c('C', 6), c('C', 7), c('C', 8),
      c('D', 2),
    ];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    const next = applyMove(state, {
      type: 'open',
      melds: [ids(hand.slice(0, 3)), ids(hand.slice(3, 6)), ids(hand.slice(6, 9))],
    });
    expect(next.melds).toHaveLength(3);
    expect(next.players[0]!.hasOpened).toBe(true);
    expect(next.players[0]!.hand).toHaveLength(1);
  });

  it('etkin sınırın altında açma reddedilir (hata sınırı söyler)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const hand = [c('S', 9), c('H', 9), c('D', 9), c('D', 2)]; // 27 puan
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    expect(() =>
      applyMove(state, { type: 'open', melds: [ids(hand.slice(0, 3))] }),
    ).toThrowError(/81/);
  });

  it('masada çift açan varsa per sınırı 101 olur (canlı)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // 92 puanlık plan: A-A-A (33) + K-K-K (30) + 9-10-J (29)
    const hand = [
      c('S', 1), c('H', 1), c('D', 1),
      c('S', 13), c('H', 13), c('D', 13),
      c('D', 9), c('D', 10), c('D', 11),
      c('C', 2),
    ];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    // Rakip çift açmış olsun → sınır 101'e çıkar.
    state.players = state.players.map((p) =>
      p.seat === 2 ? { ...p, hasOpened: true, openMode: 'pairs' as const, isCift: true, openedOnTurn: 1 } : p,
    );
    const melds = [ids(hand.slice(0, 3)), ids(hand.slice(3, 6)), ids(hand.slice(6, 9))];
    expect(() => applyMove(state, { type: 'open', melds })).toThrowError(/101/);
    // Çift açan olmasaydı 92 yeterdi.
    state.players = state.players.map((p) => ({ ...p, openMode: null, hasOpened: false, isCift: false }));
    expect(applyMove(state, { type: 'open', melds }).players[0]!.hasOpened).toBe(true);
  });

  it('seri başa ve sona kartla uzatılabilir; küte 4. renk eklenir', () => {
    const rules = makeRules({});
    const run = meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)]);
    expect(canExtend(run, c('D', 3), rules)?.cards.map((x) => (x.joker ? 0 : x.rank))).toEqual([
      3, 4, 5, 6,
    ]);
    expect(canExtend(run, c('D', 7), rules)).not.toBeNull();
    expect(canExtend(run, c('H', 7), rules)).toBeNull();

    const set = meld('m2', 'set', [c('S', 12), c('H', 12), c('D', 12)]);
    expect(canExtend(set, c('C', 12), rules)).not.toBeNull();
    expect(canExtend(set, c('C', 11), rules)).toBeNull();
  });

  it('açmamış oyuncu perde işleyemez', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [c('D', 7), c('S', 3)] },
      melds: [meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)])],
    });
    expect(() => applyMove(state, { type: 'extend', meldId: 'm1', cardId: state.players[0]!.hand[0]!.id })).toThrowError();
    expect(legalExtendTargets(state, 0, state.players[0]!.hand[0]!.id)).toEqual([]);
  });

  it('joker, temsil ettiği gerçek kartla değiştirilip ele alınır', () => {
    const rules = makeRules({});
    const jk = joker(1);
    const runMeld = meld('m1', 'run', [c('D', 4), jk, c('D', 6)]);
    const right = c('D', 5);
    const wrongSuit = c('H', 5);
    expect(canRetrieveJoker(runMeld, right, rules)).toBe(jk.id);
    expect(canRetrieveJoker(runMeld, wrongSuit, rules)).toBeNull();

    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [right, c('S', 3)] },
      opened: [0],
      melds: [runMeld],
    });
    const next = applyMove(state, { type: 'retrieveJoker', meldId: 'm1', cardId: right.id });
    expect(next.melds[0]!.cards.map((x) => x.id)).toEqual([runMeld.cards[0]!.id, right.id, runMeld.cards[2]!.id]);
    expect(next.players[0]!.hand.some((x) => x.id === jk.id)).toBe(true);
  });

  it('küt jokerini eksik renklerden biri kurtarır, mevcut renk kurtaramaz', () => {
    const rules = makeRules({});
    const jk = joker(2);
    const setMeld = meld('m1', 'set', [c('S', 12), c('H', 12), jk]);
    expect(canRetrieveJoker(setMeld, c('D', 12), rules)).toBe(jk.id);
    expect(canRetrieveJoker(setMeld, c('C', 12), rules)).toBe(jk.id);
    expect(canRetrieveJoker(setMeld, c('S', 12, 99), rules)).toBeNull();
  });
});

describe('skorlama', () => {
  it('elden bitme ceza çarpanı DEĞİLDİR; kapalı rakipler taban 200 öder', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // 81+: Q-Q-Q (30) + K-K-K (30) + 6-7-8 (21) = 81
    const hand = [
      c('S', 12), c('H', 12), c('D', 12),
      c('S', 13), c('H', 13), c('D', 13),
      c('C', 6), c('C', 7), c('C', 8),
      c('D', 2),
    ];
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 5,
      hands: {
        0: hand,
        1: [c('S', 13, 9), joker(7)], // 10 + 25 = 35
        2: [c('H', 5)], // 5
        3: [c('D', 1)], // 11
      },
    });
    state = applyMove(state, {
      type: 'open',
      melds: [ids(hand.slice(0, 3)), ids(hand.slice(3, 6)), ids(hand.slice(6, 9))],
    });
    const ended = applyMove(state, { type: 'discard', cardId: hand[9]!.id });
    expect(ended.phase).toBe('handEnded');
    expect(ended.lastHandResult).toMatchObject({ winnerSeat: 0, handFinish: true });
    // Hibrit: ödeyenler kapalı -> 200 (elden bitme çarpan getirmez).
    expect(ended.lastHandResult?.penalties).toEqual([0, 200, 200, 200]);
    expect(ended.players[1]!.totalScore).toBe(200);
  });

  it('normal bitişte kapalı rakipler taban 200 öder', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0], // 1. turda açmıştı
      hands: { 0: [c('D', 2)], 1: [c('S', 13)], 2: [c('H', 5)], 3: [c('D', 1)] },
    });
    const ended = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(ended.lastHandResult).toMatchObject({ winnerSeat: 0, handFinish: false });
    expect(ended.lastHandResult?.penalties).toEqual([0, 200, 200, 200]);
  });

  it('eleme YOKTUR: yüksek toplam puanlı oyuncu da oynamaya devam eder (RULES.md 1.7)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0],
      hands: { 0: [c('D', 2)], 1: [c('S', 13)], 2: [c('H', 5)], 3: [c('D', 1)] },
    });
    state.players = state.players.map((p) => (p.seat === 1 ? { ...p, totalScore: 9000 } : p));
    const ended = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(ended.players[1]!.totalScore).toBe(9200);
    expect(ended.phase).toBe('handEnded'); // maç erken bitmez

    const nextHand = startNextHand(ended);
    // Koltuk oyunda: yeni dağıtıcı olarak 15 kart alır (elenmedi).
    expect(nextHand.players[1]!.hand).toHaveLength(15);
    expect(nextHand.handNumber).toBe(2);
  });

  it('11. el bitince maç biter ve en düşük toplam kazanır', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      handNumber: 11,
      opened: [0],
      hands: { 0: [c('D', 2)], 1: [c('S', 13)], 2: [c('H', 5)], 3: [c('D', 1)] },
    });
    state.players = state.players.map((p) => ({ ...p, totalScore: p.seat * 50 }));
    const ended = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(ended.phase).toBe('matchEnded');
    expect(ended.matchWinnerSeat).toBe(0);
  });

  it('viewFor rakip ellerini gizler, sayıları doğru verir', () => {
    const state = createGame({ seed: 3, dealerSeat: 1 });
    const view = viewFor(state, 0);
    expect(view.hand).toHaveLength(14);
    expect(view.players[1]!.handCount).toBe(15);
    expect((view.players[1] as Record<string, unknown>)['hand']).toBeUndefined();
    expect(view.stockCount).toBe(state.stock.length);
  });
});
