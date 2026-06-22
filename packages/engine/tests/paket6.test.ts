import { describe, expect, it } from 'vitest';
import { applyMove, createGame, openingThreshold, pairsOpeningMin, viewFor } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState } from '../src/types';
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

/** 92 puanlık açış: A-A-A (33) + K-K-K (30) + 9-10-J (29). */
function open92(): Card[][] {
  return [
    [c('S', 1), c('H', 1), c('D', 1)],
    [c('S', 13), c('H', 13), c('D', 13)],
    [c('D', 9), c('D', 10), c('D', 11)],
  ];
}

/** 93 puanlık açış: A-A-A (33) + K-K-K (30) + J-Q-K (30). */
function open93(): Card[][] {
  return [
    [c('S', 1), c('H', 1), c('C', 1)],
    [c('S', 13), c('H', 13), c('C', 13)],
    [c('H', 11), c('H', 12), c('H', 13)],
  ];
}

function fivePairs(): Card[][] {
  return [9, 7, 3, 12, 5].map((r, i) => {
    const suit = (['S', 'H', 'D', 'C', 'S'] as const)[i]!;
    return [c(suit, r as 9, i * 10), c(suit, r as 9, i * 10 + 1)];
  });
}

describe('PAKET 6 — katlamalı açış çıtaları (RULES.md 1.8)', () => {
  it('SERİ: ilk açış çıtayı kurar; sonraki açış EN AZ +1 puan olmalı (eşit AÇILAMAZ)', () => {
    let state = createGame({ seed: 2, dealerSeat: 3 });
    const m0 = open92();
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...m0.flat(), c('S', 4)] },
    });
    state = applyMove(state, { type: 'open', melds: m0.map(ids) });
    expect(state.enYuksekSeriAcisi).toBe(92);
    expect(openingThreshold(state)).toBe(93);

    // Rakip birebir 92 ile açamaz...
    const m1 = open92();
    let blocked = rig(state, {
      currentSeat: 1,
      phase: 'action',
      hands: { 1: [...m1.flat(), c('H', 4)] },
    });
    expect(() => applyMove(blocked, { type: 'open', melds: m1.map(ids) })).toThrowError(/93/);

    // ...93 ile açar; çıta 93'e çıkar.
    const m2 = open93();
    blocked = rig(blocked, { hands: { 1: [...m2.flat(), c('H', 4)] } });
    const next = applyMove(blocked, { type: 'open', melds: m2.map(ids) });
    expect(next.enYuksekSeriAcisi).toBe(93);
    expect(openingThreshold(next)).toBe(94);
  });

  it('KATLAMASIZ: başkasının açışı kimseyi bağlamaz — eşik 81 kalır', () => {
    let state = createGame({ seed: 2, dealerSeat: 3, rules: makeRules({ katlamali: false }) });
    const m0 = open92();
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...m0.flat(), c('S', 4)] },
    });
    state = applyMove(state, { type: 'open', melds: m0.map(ids) });
    expect(state.enYuksekSeriAcisi).toBe(92); // çıta izlenir ama bağlamaz
    expect(openingThreshold(state)).toBe(81);

    const m1 = open92();
    const second = rig(state, {
      currentSeat: 1,
      phase: 'action',
      hands: { 1: [...m1.flat(), c('H', 4)] },
    });
    expect(() => applyMove(second, { type: 'open', melds: m1.map(ids) })).not.toThrow();
  });

  it('ÇİFT: ilk 5 çift açışından sonra sıradaki çiftçi EN AZ 6 çift açmalı', () => {
    let state = createGame({ seed: 2, dealerSeat: 3 });
    const p0 = fivePairs();
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...p0.flat(), c('D', 8)] },
    });
    state = applyMove(state, { type: 'openPairs', pairs: p0.map(ids) });
    expect(state.enYuksekCiftAcisi).toBe(5);
    expect(pairsOpeningMin(state)).toBe(6);

    // 5 çiftle ikinci açış reddedilir.
    const p1 = fivePairs();
    let second = rig(state, {
      currentSeat: 1,
      phase: 'action',
      hands: { 1: [...p1.flat(), c('D', 6)] },
    });
    expect(() =>
      applyMove(second, { type: 'openPairs', pairs: p1.map(ids) }),
    ).toThrowError(/en az 6/);

    // 6 çiftle açılır; çıta 6'ya çıkar.
    const p2 = [...fivePairs(), [c('H', 10, 90), c('H', 10, 91)]];
    second = rig(second, { hands: { 1: [...p2.flat(), c('D', 6)] } });
    const next = applyMove(second, { type: 'openPairs', pairs: p2.map(ids) });
    expect(next.enYuksekCiftAcisi).toBe(6);
    expect(pairsOpeningMin(next)).toBe(7);
  });

  it('SERİ ve ÇİFT çıtaları AYRI yarışlardır', () => {
    let state = createGame({ seed: 2, dealerSeat: 3 });
    const m0 = open92();
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...m0.flat(), c('S', 4)] },
    });
    state = applyMove(state, { type: 'open', melds: m0.map(ids) });
    // 92'lik seri açışı çift adedini ETKİLEMEZ.
    expect(pairsOpeningMin(state)).toBe(DEFAULT_RULES.pairs.pairsToOpen);
    expect(state.enYuksekCiftAcisi).toBeNull();
  });

  it('çıtalar EL BAŞINA sıfırlanır ve view dinamik sınırları taşır', () => {
    const fresh = createGame({ seed: 3 });
    expect(fresh.enYuksekSeriAcisi).toBeNull();
    expect(fresh.enYuksekCiftAcisi).toBeNull();

    let state = createGame({ seed: 2, dealerSeat: 3 });
    const m0 = open92();
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...m0.flat(), c('S', 4)] },
    });
    state = applyMove(state, { type: 'open', melds: m0.map(ids) });
    const view = viewFor(state, 1);
    expect(view.currentOpeningMin).toBe(93);
    expect(view.currentPairsMin).toBe(DEFAULT_RULES.pairs.pairsToOpen);
  });
});
