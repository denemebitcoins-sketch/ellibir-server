import { describe, expect, it } from 'vitest';
import { applyMove, canRetrieveJoker, canUndoIslek, createGame, meldBarajTokens, startNextHand } from '../src/game';
import { DEFAULT_RULES } from '../src/rules';
import type { Card, GameState, Meld } from '../src/types';
import { c, joker } from './helpers';

const R = DEFAULT_RULES;

function rig(
  state: GameState,
  patch: Partial<GameState> & {
    hands?: Record<number, Card[]>;
    openedPairs?: number[];
    openedMelds?: number[];
  },
): GameState {
  const next: GameState = { ...state, ...patch };
  next.players = state.players.map((p) => ({
    ...p,
    hand: patch.hands?.[p.seat] ?? p.hand,
    hasOpened:
      patch.openedPairs?.includes(p.seat) || patch.openedMelds?.includes(p.seat)
        ? true
        : p.hasOpened,
    openMode: patch.openedPairs?.includes(p.seat)
      ? ('pairs' as const)
      : patch.openedMelds?.includes(p.seat)
        ? ('melds' as const)
        : p.openMode,
    isCift: patch.openedPairs?.includes(p.seat) ? true : p.isCift,
    openedOnTurn:
      patch.openedPairs?.includes(p.seat) || patch.openedMelds?.includes(p.seat)
        ? 1
        : p.openedOnTurn,
  }));
  return next;
}

function meld(id: string, type: Meld['type'], cards: Card[], ownerSeat = 1): Meld {
  return { id, ownerSeat, type, cards };
}

describe('C2 — baraj merdiveni SINIRSIZDIR (formül)', () => {
  it('eski sınır değerleri korunur, 151 üstü devam eder: 161→6, 171→7, 201→10', () => {
    expect(meldBarajTokens(110, R)).toBe(0);
    expect(meldBarajTokens(111, R)).toBe(1);
    expect(meldBarajTokens(121, R)).toBe(2);
    expect(meldBarajTokens(151, R)).toBe(5);
    expect(meldBarajTokens(160, R)).toBe(5);
    expect(meldBarajTokens(161, R)).toBe(6); // eski eşik listesi burada 5'te kalıyordu
    expect(meldBarajTokens(171, R)).toBe(7);
    expect(meldBarajTokens(201, R)).toBe(10);
  });
});

describe('C3 — açmış çiftçi tur başına TEK işlek', () => {
  function ciftciAtTable(): GameState {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      openedPairs: [0],
      melds: [
        meld('seri1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 2),
        meld('seri2', 'run', [c('C', 9), c('C', 10), c('C', 11)], 2),
      ],
      hands: { 0: [c('D', 7), c('C', 12), c('S', 2), c('H', 8)] },
    });
    return state;
  }

  it('birinci işlek (seri perine ekleme) serbest; İKİNCİSİ aynı turda reddedilir', () => {
    let state = ciftciAtTable();
    const seven = state.players[0]!.hand[0]!;
    const queen = state.players[0]!.hand[1]!;
    state = applyMove(state, { type: 'extend', meldId: 'seri1', cardId: seven.id });
    expect(state.ciftIslekUsed).toBe(true);
    expect(() =>
      applyMove(state, { type: 'extend', meldId: 'seri2', cardId: queen.id }),
    ).toThrowError(/yalnız bir işlek/);
  });

  it('işlek hakkı SONRAKİ TURDA yenilenir', () => {
    let state = ciftciAtTable();
    const seven = state.players[0]!.hand[0]!;
    state = applyMove(state, { type: 'extend', meldId: 'seri1', cardId: seven.id });
    state = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(state.ciftIslekUsed).toBe(false); // tur ilerledi, hak yenilendi
  });

  it('okey takası da işlek sayılır; takas okeyiyle AYNI turda yeni çift açılabilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const jk = joker(0);
    const five = c('D', 5);
    const twin = c('H', 8, 0); // takas okeyiyle çiftlenecek kart
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      openedPairs: [0],
      melds: [
        meld('seri1', 'run', [c('D', 4), jk, c('D', 6)], 2), // okey = 5♦
        meld('seri2', 'run', [c('C', 9), c('C', 10), c('C', 11)], 2),
      ],
      hands: { 0: [five, twin, c('S', 2), c('S', 3)] },
    });
    // Takas: 5♦ verilir, okey ele gelir → işlek hakkı bitti.
    state = applyMove(state, { type: 'retrieveJoker', meldId: 'seri1', cardId: five.id });
    expect(state.ciftIslekUsed).toBe(true);
    expect(state.players[0]!.hand.some((x) => x.id === jk.id)).toBe(true);
    expect(() =>
      applyMove(state, { type: 'extend', meldId: 'seri2', cardId: c('C', 12).id }),
    ).toThrowError();
    // Okey + 8♥ = yeni çift (indirme işlek DEĞİLDİR, serbest).
    const next = applyMove(state, { type: 'meld', cards: [twin.id, jk.id] });
    expect(next.melds.filter((m) => m.type === 'pair')).toHaveLength(1);
  });
});

describe('C3B — işlenen kart geri alma penceresi', () => {
  function islekReadyState(): GameState {
    return rig(createGame({ seed: 1, dealerSeat: 3 }), {
      currentSeat: 0,
      phase: 'action',
      openedMelds: [0],
      melds: [
        meld('seri1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 2),
      ],
      hands: { 0: [c('D', 7), c('S', 2), c('H', 8)] },
    });
  }

  it('kart atılmadan önce işleme geri alınabilir ve el/per eski haline döner', () => {
    const initial = islekReadyState();
    const seven = initial.players[0]!.hand[0]!;

    const extended = applyMove(initial, { type: 'extend', meldId: 'seri1', cardId: seven.id });

    expect(canUndoIslek(extended, 0)).toBe(true);
    expect(extended.players[0]!.hand.some((card) => card.id === seven.id)).toBe(false);
    expect(extended.melds[0]!.cards.some((card) => card.id === seven.id)).toBe(true);

    const undone = applyMove(extended, { type: 'undoIslek' });

    expect(canUndoIslek(undone, 0)).toBe(false);
    expect(undone.players[0]!.hand.some((card) => card.id === seven.id)).toBe(true);
    expect(undone.melds[0]!.cards.some((card) => card.id === seven.id)).toBe(false);
  });

  it('kart atılıp tur tamamlanınca işleme geri alma penceresi kapanır', () => {
    const initial = islekReadyState();
    const seven = initial.players[0]!.hand[0]!;

    const extended = applyMove(initial, { type: 'extend', meldId: 'seri1', cardId: seven.id });
    const done = applyMove(extended, { type: 'discard', cardId: extended.players[0]!.hand[0]!.id });

    expect(canUndoIslek(done, 0)).toBe(false);
    expect(done.islekSnapshot).toBeNull();
    expect(() => applyMove(done, { type: 'undoIslek' })).toThrowError();
  });

  it('işlekten sonra bitiş atışı yapılınca geri alma penceresi el ve sonraki el için kapanır', () => {
    const initial = rig(createGame({ seed: 1, dealerSeat: 3 }), {
      currentSeat: 0,
      phase: 'action',
      openedMelds: [0],
      melds: [
        meld('seri1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 2),
      ],
      hands: { 0: [c('D', 7), c('S', 2)] },
    });
    const seven = initial.players[0]!.hand[0]!;

    const extended = applyMove(initial, { type: 'extend', meldId: 'seri1', cardId: seven.id });
    expect(canUndoIslek(extended, 0)).toBe(true);

    const ended = applyMove(extended, { type: 'discard', cardId: extended.players[0]!.hand[0]!.id });
    expect(ended.phase).toBe('handEnded');
    expect(ended.islekSnapshot).toBeNull();
    expect(ended.openSnapshot).toBeNull();
    expect(canUndoIslek(ended, 0)).toBe(false);
    expect(() => applyMove(ended, { type: 'undoIslek' })).toThrowError();

    const nextHand = startNextHand(ended);
    expect(nextHand.islekSnapshot).toBeNull();
    expect(nextHand.openSnapshot).toBeNull();
    expect(canUndoIslek(nextHand, nextHand.currentSeat)).toBe(false);
  });
});

describe('C4 — çift perinden okey takası', () => {
  it('SERİCİ çift perindeki okeyi gerçek kartıyla alabilir; yanlış kart alamaz', () => {
    const jk = joker(1);
    const pairMeld = meld('cift1', 'pair', [c('S', 9, 0), jk], 3); // okey = 9♠ eşi
    expect(canRetrieveJoker(pairMeld, c('S', 9, 1), R)).toBe(jk.id);
    expect(canRetrieveJoker(pairMeld, c('H', 9), R)).toBeNull();

    let state = createGame({ seed: 1, dealerSeat: 3 });
    const replacement = c('S', 9, 1);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      openedMelds: [0],
      melds: [pairMeld],
      hands: { 0: [replacement, c('H', 2), c('D', 4)] },
    });
    const next = applyMove(state, { type: 'retrieveJoker', meldId: 'cift1', cardId: replacement.id });
    // Perde bozulmadı (iki özdeş 9♠), okey sericinin elinde.
    expect(next.melds[0]!.cards.every((x) => !x.joker)).toBe(true);
    expect(next.players[0]!.hand.some((x) => x.id === jk.id)).toBe(true);
    expect(next.ciftIslekUsed).toBe(false); // serici için sınırsız — bayrak işlemez
  });

  it('SERİCİ işleği sınırsızdır: aynı turda iki takas/ekleme yapabilir', () => {
    const jk0 = joker(0);
    const jk1 = joker(1);
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const r5 = c('D', 5);
    const r10 = c('C', 10);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      openedMelds: [0],
      melds: [
        meld('m1', 'run', [c('D', 4), jk0, c('D', 6)], 2),
        meld('m2', 'run', [c('C', 9), jk1, c('C', 11)], 3),
      ],
      hands: { 0: [r5, r10, c('S', 2)] },
    });
    state = applyMove(state, { type: 'retrieveJoker', meldId: 'm1', cardId: r5.id });
    state = applyMove(state, { type: 'retrieveJoker', meldId: 'm2', cardId: r10.id });
    const jokersInHand = state.players[0]!.hand.filter((x) => x.joker);
    expect(jokersInHand).toHaveLength(2);
  });
});
