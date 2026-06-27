import { describe, expect, it } from 'vitest';
import { analyzeCards, analyzeRun } from '../src/melds';
import { solveHand } from '../src/solver';
import { bestOpening, bestPairOpening } from '../src/insight';
import { applyMove, canExtend, createGame } from '../src/game';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState, Meld, Rank } from '../src/types';
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

describe('seri sınır durumları', () => {
  it('13 kartlık tam seri 2..K..A geçerlidir; A..K (as başta) GEÇERSİZDİR', () => {
    // As yalnız üstten: en uzun seri 2-3-...-K-A (pozisyon 2..14).
    const run = ([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1] as Rank[]).map((r) => c('S', r));
    const a = analyzeRun(run, R);
    expect(a).not.toBeNull();
    expect(a?.points).toBe((2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10) + 3 * R.facePoints + R.acePoints);
    // Aynı kartlar A başta verilirse (A-2-...-K) artık seri DEĞİLDİR.
    const aceFirst = ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as Rank[]).map((r) => c('S', r));
    expect(analyzeRun(aceFirst, R)).toBeNull();
  });

  it('per başına okey sınırı YOKTUR: iki okey AYNI seride geçerlidir (RULES.md 1.3)', () => {
    const a = analyzeCards([c('D', 4), joker(0), joker(1), c('D', 7)], R);
    expect(a?.type).toBe('run');
    expect(a?.points).toBe(4 + 5 + 6 + 7);
    expect(a?.jokers.map((j) => j.rank).sort((x, y) => x - y)).toEqual([5, 6]);
  });

  it('iki okey AYRI perlerde de tam işlevlidir (bilinen bug regresyonu)', () => {
    // El: 8♠9♠+★ serisi ve Q-Q+★ kütü — çözücü İKİ okeyi de kullanmalı.
    const hand = [
      c('S', 8), c('S', 9), joker(0),
      c('H', 12), c('D', 12), joker(1),
      c('C', 3),
    ];
    const solved = solveHand(hand, R, 'cards');
    expect(solved.cardCount).toBe(6); // 3+3 — her iki okey perlerde
    const usedJokers = solved.melds.flat().filter((x) => x.joker);
    expect(usedJokers).toHaveLength(2);
  });

  it('otomatik dizme okeyi PUAN ÖNCELİĞİYLE yerleştirir', () => {
    // [7♠,★,★]: küt 21 yerine 7-8-9 serisi (24) seçilmeli.
    const a = analyzeCards([c('S', 7), joker(0), joker(1)], R);
    expect(a?.type).toBe('run');
    expect(a?.points).toBe(7 + 8 + 9);
    // [K♠,★,★]: Q-K-A (31) > küt (30).
    const b = analyzeCards([c('S', 13), joker(0), joker(1)], R);
    expect(b?.type).toBe('run');
    expect(b?.points).toBe(10 + 10 + R.acePoints);
  });

  it('joker seri uçlarında çalışır; pozisyon 1 ("As altı") TUTAMAZ', () => {
    expect(analyzeRun([joker(), c('H', 5), c('H', 6)], R)?.jokers[0]?.rank).toBe(4);
    expect(analyzeRun([c('H', 5), c('H', 6), joker()], R)?.jokers[0]?.rank).toBe(7);
    // ★-2-3: okey As yerine geçemez (A oraya oturamaz) → geçersiz.
    expect(analyzeRun([joker(), c('H', 2), c('H', 3)], R)).toBeNull();
  });
});

describe('açış ve işleme sınırları', () => {
  it('tek turda üç perdeyle açılabilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const m1 = [c('S', 1), c('H', 1), c('D', 1)]; // 33
    const m2 = [c('S', 13), c('H', 13), c('D', 13)]; // 30
    const m3 = [c('D', 9), c('D', 10), c('D', 11)]; // 29 → toplam 92
    const hand = [...m1, ...m2, ...m3, c('S', 4)];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    const next = applyMove(state, { type: 'open', melds: [ids(m1), ids(m2), ids(m3)] });
    expect(next.melds).toHaveLength(3);
    expect(next.players[0]!.hand).toHaveLength(1);
  });

  it('rakibin perdesi de işlenebilir; uymayan kart reddedilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const oppMeld: Meld = {
      id: 'opp-1',
      ownerSeat: 2,
      type: 'run',
      cards: [c('S', 8), c('S', 9), c('S', 10)],
    };
    const seven = c('S', 7);
    const five = c('S', 5);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      opened: [0],
      melds: [oppMeld],
      hands: { 0: [seven, five, c('H', 2)] },
    });
    const next = applyMove(state, { type: 'extend', meldId: 'opp-1', cardId: seven.id });
    expect(next.melds[0]!.cards).toHaveLength(4);
    expect(canExtend(next.melds[0]!, five, R)).toBeNull();
    expect(() => applyMove(next, { type: 'extend', meldId: 'opp-1', cardId: five.id })).toThrowError();
  });

  it('geri alınan joker AYNI turda yeniden kullanılabilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const jk = joker(3);
    const sourceMeld: Meld = {
      id: 'm-src',
      ownerSeat: 1,
      type: 'run',
      cards: [c('D', 4), jk, c('D', 6)],
    };
    const targetMeld: Meld = {
      id: 'm-tgt',
      ownerSeat: 2,
      type: 'run',
      cards: [c('C', 9), c('C', 10), c('C', 11)],
    };
    const five = c('D', 5);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      opened: [0],
      melds: [sourceMeld, targetMeld],
      hands: { 0: [five, c('H', 2), c('H', 9)] },
    });
    state = applyMove(state, { type: 'retrieveJoker', meldId: 'm-src', cardId: five.id });
    expect(state.players[0]!.hand.some((x) => x.id === jk.id)).toBe(true);
    // Joker hâlâ aynı turdayız; başka perdeye işlenebilmeli (Q ya da 8 yerine).
    state = applyMove(state, { type: 'extend', meldId: 'm-tgt', cardId: jk.id });
    expect(state.melds.find((m) => m.id === 'm-tgt')!.cards).toHaveLength(4);
  });

  it('eli bitirmek için tam BİR kart atılmalı: tüm eli indirmek reddedilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const meld = [c('S', 7), c('H', 7), c('D', 7)];
    state = rig(state, { currentSeat: 0, phase: 'action', opened: [0], hands: { 0: meld } });
    expect(() => applyMove(state, { type: 'meld', cards: ids(meld) })).toThrowError(/kalmalı/);
  });

  it('son kart atılınca el biter; atmadan bitmek imkânsızdır', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const meld = [c('S', 7), c('H', 7), c('D', 7)];
    const last = c('D', 2);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 7,
      opened: [0],
      hands: { 0: [...meld, last], 1: [c('S', 5)], 2: [c('H', 5)], 3: [c('D', 5)] },
    });
    state = applyMove(state, { type: 'meld', cards: ids(meld) });
    expect(state.phase).toBe('action'); // per indirmek eli bitirmez
    const ended = applyMove(state, { type: 'discard', cardId: last.id });
    expect(ended.phase === 'handEnded' || ended.phase === 'matchEnded').toBe(true);
    expect(ended.lastHandResult?.winnerSeat).toBe(0);
  });

  it('bestOpening atacak en az bir kart bırakır (tam kapsama durumu)', () => {
    // Tüm el iki perden oluşuyor: plan tüm eli KAPSAYAMAZ.
    const hand = [
      c('S', 12), c('H', 12), c('D', 12),
      c('C', 6), c('C', 7), c('C', 8),
    ];
    const plan = bestOpening(hand, R);
    const used = plan.melds.flat().length;
    expect(used).toBeLessThan(hand.length);
    expect(plan.points).toBeGreaterThanOrEqual(21);
  });

  it('bestPairOpening atacak kart bırakır ve jokerle tek tamamlar', () => {
    const hand = [
      c('S', 9, 0), c('S', 9, 1),
      c('H', 5, 0), c('H', 5, 1),
      c('D', 13), joker(),
    ];
    const plan = bestPairOpening(hand, R);
    expect(plan.count).toBe(2); // 3 çift mümkün ama (6-1)/2 = 2 sınırı
    expect(plan.pairs.flat().length).toBeLessThan(hand.length);
  });

  it('açık hamle kaydı tutulur; DENEME ALIMI taahhüde kadar GİZLİDİR (1.6)', () => {
    let state = createGame({ seed: 5, dealerSeat: 0 });
    // 1. koltuk açık. Atılan kart İŞLEK OLMAMALI (işlek/okey atışı artık kilitli —
    // rakip alamaz); ♠2 hiçbir peri işlemez, deneme alımı serbest kalır.
    const dropped = c('S', 2);
    const h2 = c('H', 2);
    const cl2 = c('C', 2);
    state = rig(state, {
      hands: { 0: [dropped, c('S', 10)], 1: [h2, cl2, c('H', 9)] },
      opened: [1],
      melds: [meldOf('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)], 1)],
    });
    state = applyMove(state, { type: 'discard', cardId: dropped.id });
    state = applyMove(state, { type: 'pickupDiscard' });
    // Deneme henüz kayda GEÇMEDİ (rakipler görmez).
    expect(state.log.map((e) => e.type)).toEqual(['discard']);
    // Taahhüt (yeni perde indirme) anında pickupCommit yayınlanır.
    state = applyMove(state, {
      type: 'meld',
      cards: [dropped.id, h2.id, cl2.id],
    });
    expect(state.log.map((e) => e.type)).toEqual(['discard', 'pickupCommit', 'meld']);
    expect(state.log[1]?.cardId).toBe(dropped.id);
  });
});

function meldOf(
  id: string,
  type: 'set' | 'run',
  cards: Card[],
  ownerSeat: number,
): Meld {
  return { id, ownerSeat, type, cards };
}
