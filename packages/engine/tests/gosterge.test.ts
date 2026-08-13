import { describe, it, expect } from 'vitest';
import { createGame, viewFor, applyMove } from '../src/game';
import { analyzeHand } from '../src/insight';
import type { Card, GameState, NormalCard, Rank, Suit } from '../src/types';
import { isNormalCard } from '../src/types';

function c(id: string, suit: Suit, rank: Rank): NormalCard {
  return { id, joker: false, suit, rank };
}

function withHand(state: GameState, seat: number, hand: Card[]): GameState {
  return {
    ...state,
    players: state.players.map((p) => (p.seat === seat ? { ...p, hand } : p)),
  };
}

function fourPairsPlus(g: NormalCard): Card[] {
  return [
    { ...g, id: `${g.id}-eldeki-es` },
    c('p1a', 'H', 2), c('p1b', 'H', 2),
    c('p2a', 'D', 3), c('p2b', 'D', 3),
    c('p3a', 'S', 4), c('p3b', 'S', 4),
    c('p4a', 'C', 5), c('p4b', 'C', 5),
    c('tek', 'H', 9),
  ];
}

/** İlk el için gösterge state'i kurulu mu, viewFor doğru yansıtıyor mu. */
describe('gösterge — kurulum ve görünürlük', () => {
  it('ilk el destenin dibinde (stock[0]) AÇIK gösterge kartı vardır', () => {
    const s = createGame({ seed: 42 });
    expect(s.handNumber).toBe(1);
    expect(s.gostergeKart).toBeTruthy();
    expect(s.gostergeKart).toEqual(s.stock[0]);
    expect(s.gostergeTaken).toBe(false);
    expect(s.gostergeShown).toEqual([]);
  });

  it('gösterge kartı viewFor ile HERKESE görünür (ilk el)', () => {
    const s = createGame({ seed: 42 });
    for (let seat = 0; seat < s.rules.playerCount; seat++) {
      const v = viewFor(s, seat);
      expect(v.gostergeKart).toBeTruthy();
    }
  });

  it('gösterge eşi dağıtımda eldeyse sıra gelmeden de G işareti ister', () => {
    const s = createGame({ seed: 43 });
    const gKart = s.gostergeKart;
    if (!gKart || !isNormalCard(gKart)) throw new Error('test göstergesi normal kart olmalı');
    const seat = (s.currentSeat + 1) % s.rules.playerCount;
    const mate = { ...gKart, id: `${gKart.id}-eldeki-es` };
    const prepared = withHand(s, seat, [mate, ...s.players[seat]!.hand]);
    expect(viewFor(prepared, seat).gostergeCanShow).toBe(false);
    expect(viewFor(prepared, seat).gostergeMark).toBe(true);

    const locked = { ...prepared, gostergeLocked: [seat] };
    expect(viewFor(locked, seat).gostergeMark).toBe(false);

    const shownAndLocked = { ...locked, gostergeShown: [seat] };
    expect(viewFor(shownAndLocked, seat).gostergeMark).toBe(true);
  });

  it('kart çeken oyuncunun gösterge hakkı KİLİTLENİR (artık gösteremez)', () => {
    const s = createGame({ seed: 7 });
    // Dağıtıcı action'da; bir sonraki oyuncu draw'da. Sırayı draw fazına getir:
    // dağıtıcı bir kart atsın (advanceTurn → sonraki draw).
    const dealer = s.players[s.currentSeat]!;
    const after = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    // Sıradaki oyuncu draw fazında; çeksin → kilitlensin.
    const drawer = after.currentSeat;
    const drawn = applyMove(after, { type: 'drawStock' });
    expect(drawn.gostergeLocked).toContain(drawer);
    // Kilitliyken göster denemesi reddedilir.
    const v = viewFor(drawn, drawer);
    expect(v.gostergeCanShow).toBe(false);
  });

  it('ilk iskarta atan oyuncunun gösterge penceresi kapanır', () => {
    const s = createGame({ seed: 11 });
    const dealer = s.players[s.currentSeat]!;
    const after = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    expect(after.gostergeLocked).toContain(dealer.seat);
  });

  it('yerden kart alan oyuncunun gösterge hakkı kilitlenir', () => {
    const s = createGame({ seed: 12 });
    const dealer = s.players[s.currentSeat]!;
    const afterDiscard = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    const taker = afterDiscard.currentSeat;
    const afterPickup = applyMove(afterDiscard, { type: 'pickupDiscard' });
    expect(afterPickup.gostergeLocked).toContain(taker);
    expect(viewFor(afterPickup, taker).gostergeCanShow).toBe(false);
  });

  it('göstergeyi gösterdikten sonra kart çekse bile eşi eldeyse 4 çiftle takas yapabilir', () => {
    const s = createGame({ seed: 13 });
    const dealer = s.players[s.currentSeat]!;
    const afterDiscard = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    const seat = afterDiscard.currentSeat;
    const gKart = afterDiscard.gostergeKart;
    if (!gKart || !isNormalCard(gKart)) throw new Error('test göstergesi normal kart olmalı');
    const g = gKart;
    const hand = fourPairsPlus(g);
    const prepared = withHand(afterDiscard, seat, hand);
    const shown = applyMove(prepared, { type: 'gostergeGoster', cardId: hand[0]!.id });
    expect(viewFor(shown, seat).gostergeCanTake).toBe(true);
    const drawn = applyMove(shown, { type: 'drawStock' });
    expect(viewFor(drawn, seat).gostergeCanTake).toBe(true);

    const before = drawn.players[seat]!.hand;
    const pairBefore = analyzeHand(before, drawn.rules).pairCount;
    const exchangeCard = before.find((card) =>
      card.id !== hand[0]!.id &&
      analyzeHand(before.filter((c2) => c2.id !== card.id), drawn.rules).pairCount === pairBefore
    );
    if (!exchangeCard) throw new Error('test için çift dışı kart bulunmalı');

    const exchanged = applyMove(drawn, { type: 'gostergeAl', cardId: exchangeCard.id });
    expect(exchanged.gostergeTaken).toBe(true);
    expect(exchanged.players[seat]!.isCift).toBe(true);
    expect(exchanged.players[seat]!.hand.some((card) => card.id === g.id)).toBe(true);
    expect(exchanged.stock[0]!.id).toBe(exchangeCard.id);
  });

  it('gösterge takasında gösterge eşi veya çiftin parçası verilemez', () => {
    const s = createGame({ seed: 14 });
    const dealer = s.players[s.currentSeat]!;
    const afterDiscard = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    const seat = afterDiscard.currentSeat;
    const gKart = afterDiscard.gostergeKart;
    if (!gKart || !isNormalCard(gKart)) throw new Error('test göstergesi normal kart olmalı');
    const hand = fourPairsPlus(gKart);
    const shown = applyMove(withHand(afterDiscard, seat, hand), { type: 'gostergeGoster', cardId: hand[0]!.id });

    expect(() => applyMove(shown, { type: 'gostergeAl', cardId: hand[0]!.id }))
      .toThrow(/Gösterge eşini veremezsin/);
    expect(() => applyMove(shown, { type: 'gostergeAl', cardId: hand[1]!.id }))
      .toThrow(/çift olmayan/);
  });
});
