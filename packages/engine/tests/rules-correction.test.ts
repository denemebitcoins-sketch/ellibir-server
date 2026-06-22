import { describe, expect, it } from 'vitest';
import {
  applyMove,
  canTakeDiscard,
  createGame,
  isIslekCard,
  meldBarajTokens,
  openingThreshold,
  pairBarajTokens,
} from '../src/game';
import { canExtend, canRetrieveJoker } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState, Meld } from '../src/types';
import { c, ids, joker } from './helpers';

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

function meld(id: string, type: 'set' | 'run', cards: Card[], ownerSeat = 1): Meld {
  return { id, ownerSeat, type, cards };
}

describe('dinamik açma sınırı (81 → 101)', () => {
  it('çift açan yoksa 81, varsa 101', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    expect(openingThreshold(state)).toBe(81);
    state.players = state.players.map((p) =>
      p.seat === 3 ? { ...p, hasOpened: true, openMode: 'pairs' as const, isCift: true } : p,
    );
    expect(openingThreshold(state)).toBe(101);
  });
});

describe('baraj jetonu hesabı (sınır değerleri)', () => {
  it('per açışı: >110 kuralı — 110→0, 111→1, 120→1, 121→2, 150→4, 151→5', () => {
    expect(meldBarajTokens(110, R)).toBe(0);
    expect(meldBarajTokens(111, R)).toBe(1);
    expect(meldBarajTokens(120, R)).toBe(1);
    expect(meldBarajTokens(121, R)).toBe(2);
    expect(meldBarajTokens(130, R)).toBe(2);
    expect(meldBarajTokens(131, R)).toBe(3);
    expect(meldBarajTokens(150, R)).toBe(4);
    expect(meldBarajTokens(151, R)).toBe(5);
    expect(meldBarajTokens(81, R)).toBe(0);
  });

  it('çift açışı: 4→0, 5→1, 6→2, 7→3, 8→3', () => {
    expect(pairBarajTokens(4, R)).toBe(0);
    expect(pairBarajTokens(5, R)).toBe(1);
    expect(pairBarajTokens(6, R)).toBe(2);
    expect(pairBarajTokens(7, R)).toBe(3);
    expect(pairBarajTokens(8, R)).toBe(3);
  });

  it('kapalıyken jeton verilmez', () => {
    const off = makeRules({ barajTokens: { enabled: false } as never });
    expect(meldBarajTokens(151, off)).toBe(0);
    expect(pairBarajTokens(7, off)).toBe(0);
  });

  it('per açışında jeton ANINDA toplam puana işlenir (-100/jeton)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // 8 as iki desteden: A-A-A-A (44) + A-A-A-A (44) + 9-10-J (29) = 117 → 1 jeton
    const m1 = [c('S', 1, 0), c('H', 1, 0), c('D', 1, 0), c('C', 1, 0)];
    const m2 = [c('S', 1, 1), c('H', 1, 1), c('D', 1, 1), c('C', 1, 1)];
    const m3 = [c('D', 9), c('D', 10), c('D', 11)];
    const hand = [...m1, ...m2, ...m3, c('S', 4)];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    const next = applyMove(state, { type: 'open', melds: [ids(m1), ids(m2), ids(m3)] });
    expect(next.players[0]!.barajTokens).toBe(1);
    expect(next.players[0]!.totalScore).toBe(R.barajTokens.value); // -100
  });

  it('sonraki işlemeler açılış jetonunu DEĞİŞTİRMEZ', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const m1 = [c('S', 1, 0), c('H', 1, 0), c('D', 1, 0), c('C', 1, 0)];
    const m2 = [c('S', 1, 1), c('H', 1, 1), c('D', 1, 1), c('C', 1, 1)];
    const m3 = [c('D', 9), c('D', 10), c('D', 11)];
    const ext = c('D', 12); // sonradan işlenecek (29→39 olurdu ama sayılmaz)
    const hand = [...m1, ...m2, ...m3, ext, c('S', 4)];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    state = applyMove(state, { type: 'open', melds: [ids(m1), ids(m2), ids(m3)] });
    const meldId = state.melds[2]!.id;
    state = applyMove(state, { type: 'extend', meldId, cardId: ext.id });
    expect(state.players[0]!.barajTokens).toBe(1); // hâlâ 1
  });

  it('5 çiftle açış 1 jeton kazandırır', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const pairs = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    const hand = [...pairs.flat(), c('D', 7)];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    const next = applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
    expect(next.players[0]!.barajTokens).toBe(1);
    expect(next.players[0]!.totalScore).toBe(R.barajTokens.value);
  });
});

describe('yerden alma — P7 deneme modu + bot sezgisi (canTakeDiscard)', () => {
  /** Sol komşunun (3) attığı kartla kurulmuş düzen. */
  const fromLeft = (cardId: string) => [{ seat: 3, type: 'discard' as const, cardId }];

  it('açmamış oyuncu: kart işe yaramasa da DENEMEYE alınır; GERİ BIRAK aynen iade eder', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('D', 11); // J♦: 9-10-J serisini tamamlar → 33+30+29=92 ≥ 81
    const hand = [
      c('S', 1), c('H', 1), c('D', 1),
      c('S', 13), c('H', 13), c('D', 13),
      c('D', 9), c('D', 10),
      c('C', 2), c('C', 5),
    ];
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: fromLeft(top.id),
      hands: { 0: hand },
    });
    expect(canTakeDiscard(state, 0)).toBe(true); // sezgi: açışın parçası
    expect(applyMove(state, { type: 'pickupDiscard' }).players[0]!.hand).toHaveLength(11);

    // İşe yaramayan kart: sezgi HAYIR der ama deneme alımı yine de yasaldır.
    const uselessTop = c('C', 9);
    const weak = rig(state, { discard: [uselessTop], log: fromLeft(uselessTop.id), hands: { 0: hand } });
    expect(canTakeDiscard(weak, 0)).toBe(false);
    const tried = applyMove(weak, { type: 'pickupDiscard' });
    expect(tried.pickup?.cardId).toBe(uselessTop.id);
    const returned = applyMove(tried, { type: 'cancelPickup' });
    expect(returned.discard[returned.discard.length - 1]?.id).toBe(uselessTop.id);
    expect(returned.phase).toBe('draw'); // desteden çekebilir
    expect(returned.players[0]!.isCift).toBe(false); // ceza yok, çift yok
  });

  it('sınır 101 iken 92 puanlık plan için sezgi HAYIR der (tam sınır testi)', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('D', 11);
    const hand = [
      c('S', 1), c('H', 1), c('D', 1),
      c('S', 13), c('H', 13), c('D', 13),
      c('D', 9), c('D', 10),
      c('C', 2), c('C', 5),
    ];
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: fromLeft(top.id),
      hands: { 0: hand },
    });
    state.players = state.players.map((p) =>
      p.seat === 2 ? { ...p, hasOpened: true, openMode: 'pairs' as const, isCift: true } : p,
    );
    expect(openingThreshold(state)).toBe(101);
    expect(canTakeDiscard(state, 0)).toBe(false);
  });

  it('açık oyuncu sezgisi: işleyebileceği karta EVET, işleyemeyeceğine HAYIR', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const runMeld = meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 2);
    const top = c('D', 7); // seriyi uzatır
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      opened: [0],
      melds: [runMeld],
      discard: [top],
      log: fromLeft(top.id),
      hands: { 0: [c('S', 2), c('H', 9)] },
    });
    expect(canTakeDiscard(state, 0)).toBe(true);

    const other = c('C', 11); // hiçbir şeye uymaz
    const blocked = rig(state, { discard: [other], log: fromLeft(other.id) });
    expect(canTakeDiscard(blocked, 0)).toBe(false);
  });

  it('çift modundaki oyuncu sezgisi: eş kartı varsa EVET, yoksa HAYIR', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('S', 9, 0);
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: fromLeft(top.id),
    });
    state.players = state.players.map((p) =>
      p.seat === 0
        ? {
            ...p,
            hasOpened: true,
            openMode: 'pairs' as const,
            isCift: true,
            hand: [c('S', 9, 1), c('H', 3)],
          }
        : p,
    );
    expect(canTakeDiscard(state, 0)).toBe(true);
    state.players = state.players.map((p) =>
      p.seat === 0 ? { ...p, hand: [c('H', 3), c('D', 4)] } : p,
    );
    expect(canTakeDiscard(state, 0)).toBe(false);
  });
});

describe('işlek kart', () => {
  const tableMelds = [
    meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 1),
    meld('m2', 'set', [c('S', 12), c('H', 12), joker(7)], 2),
  ];

  it('işlek tespiti işleme/joker doğrulamasıyla AYNI sonucu verir', () => {
    const samples = [c('D', 3), c('D', 7), c('C', 12), c('D', 12), c('H', 9), joker(8)];
    for (const card of samples) {
      const expected = tableMelds.some(
        (m) => canExtend(m, card, R) !== null || canRetrieveJoker(m, card, R) !== null,
      );
      expect(isIslekCard(card, tableMelds, R)).toBe(expected);
    }
    expect(isIslekCard(c('D', 3), tableMelds, R)).toBe(true); // seri başı
    expect(isIslekCard(c('D', 12), tableMelds, R)).toBe(true); // joker kurtarır (küt Q)
    expect(isIslekCard(c('H', 9), tableMelds, R)).toBe(false);
  });

  it('işlek kart atana ceza yazılır ve kayda işlenir', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const islek = c('D', 7); // m1 serisini uzatır
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      melds: [meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 1)],
      hands: { 0: [islek, c('H', 2)] },
    });
    const next = applyMove(state, { type: 'discard', cardId: islek.id });
    expect(next.players[0]!.totalScore).toBe(R.islek.penaltyPoints); // +50
    expect(next.log[next.log.length - 1]?.islek).toBe(true);
  });

  it('ceza kapalıyken işlek atmak puan yazmaz', () => {
    const rules = makeRules({ islek: { penaltyEnabled: false } as never });
    let state = createGame({ seed: 1, dealerSeat: 0, rules });
    const islek = c('D', 7);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      melds: [meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 1)],
      hands: { 0: [islek, c('H', 2)] },
    });
    const next = applyMove(state, { type: 'discard', cardId: islek.id });
    expect(next.players[0]!.totalScore).toBe(0);
  });
});

describe('katlamalı / katlamasız', () => {
  it('katlamasız modda elden bitme cezayı katlamaz', () => {
    const rules = makeRules({ katlamali: false, openingMinPoints: 21 });
    let state = createGame({ seed: 1, dealerSeat: 0, rules });
    const m1 = [c('C', 6), c('C', 7), c('C', 8)];
    const last = c('D', 2);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 5,
      hands: { 0: [...m1, last], 1: [c('S', 13)], 2: [c('H', 5)], 3: [c('D', 1)] },
    });
    state = applyMove(state, { type: 'open', melds: [ids(m1)] });
    const ended = applyMove(state, { type: 'discard', cardId: last.id });
    expect(ended.lastHandResult?.handFinish).toBe(true);
    // Katlama yok; ödeyenler kapalı -> düz 200.
    expect(ended.lastHandResult?.penalties).toEqual([0, 200, 200, 200]);
  });
});
