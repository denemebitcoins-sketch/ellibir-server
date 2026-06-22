import { describe, expect, it } from 'vitest';
import {
  applyMove,
  canPickupDiscard,
  canPickupLocked,
  canSor,
  createGame,
  isDiscardLocked,
  openingThreshold,
  viewFor,
} from '../src/game';
import type { Card, GameState, Meld, PublicEvent } from '../src/types';
import { c, ids } from './helpers';

function rig(
  state: GameState,
  patch: Partial<GameState> & {
    hands?: Record<number, Card[]>;
    opened?: number[];
    ciftler?: number[];
  },
): GameState {
  const next: GameState = { ...state, ...patch };
  next.players = state.players.map((p) => ({
    ...p,
    hand: patch.hands?.[p.seat] ?? p.hand,
    hasOpened: patch.opened?.includes(p.seat) ?? p.hasOpened,
    openMode: patch.opened?.includes(p.seat) ? ('melds' as const) : p.openMode,
    openedOnTurn: patch.opened?.includes(p.seat) ? 1 : p.openedOnTurn,
    isCift: patch.ciftler?.includes(p.seat) ?? p.isCift,
  }));
  return next;
}

function meld(id: string, type: Meld['type'], cards: Card[], ownerSeat = 2): Meld {
  return { id, ownerSeat, type, cards };
}

const fromSeat = (seat: number, cardId: string): PublicEvent[] => [
  { seat, type: 'discard', cardId },
];

/** Sol komşunun (3) attığı kartla temel düzen — 0 sırada, çekiş fazında. */
function baseState(top: Card, hand0: Card[], extra?: Parameters<typeof rig>[1]): GameState {
  let state = createGame({ seed: 9, dealerSeat: 3 });
  state = rig(state, {
    currentSeat: 0,
    phase: 'draw',
    discard: [top],
    log: fromSeat(3, top.id),
    hands: { 0: hand0 },
    ...extra,
  });
  return state;
}

describe('P7 — deneme alımı (1.6)', () => {
  it('alım denemeye girer, rakip view\'larında GÖRÜNMEZ; geri bırakınca aynen döner', () => {
    const top = c('C', 9);
    let state = baseState(top, [c('S', 2), c('H', 7), c('D', 4)]);
    state = applyMove(state, { type: 'pickupDiscard' });
    expect(state.pickup?.cardId).toBe(top.id);
    expect(viewFor(state, 0).pickup?.cardId).toBe(top.id);
    expect(viewFor(state, 2).pickup).toBeNull(); // GİZLİLİK
    expect(state.log.some((e) => e.type === 'pickupCommit')).toBe(false);

    const back = applyMove(state, { type: 'cancelPickup' });
    expect(back.discard[back.discard.length - 1]?.id).toBe(top.id);
    expect(back.phase).toBe('draw');
    expect(back.players[0]!.isCift).toBe(false);
    // Geri bıraktıktan sonra desteden çekilebilir.
    expect(() => applyMove(back, { type: 'drawStock' })).not.toThrow();
  });

  it('açmadan ATARAK devam = ÇİFT; o turda AÇARSA çift değil', () => {
    const top = c('C', 9);
    // Yol 1: açmadan devam → çift.
    let s1 = baseState(top, [c('S', 2), c('H', 7), c('D', 4)]);
    s1 = applyMove(s1, { type: 'pickupDiscard' });
    s1 = applyMove(s1, { type: 'discard', cardId: s1.players[0]!.hand[0]!.id });
    expect(s1.players[0]!.isCift).toBe(true);
    expect(openingThreshold(s1)).toBe(101);
    expect(s1.log.some((e) => e.type === 'pickupCommit')).toBe(true);

    // Yol 2: aynı turda seri açan çift OLMAZ.
    const m = [
      [c('S', 1), c('H', 1), c('D', 1)],
      [c('S', 13), c('H', 13), c('D', 13)],
      [c('D', 9), c('D', 10), c('D', 11)],
    ];
    const spare = c('S', 4);
    let s2 = baseState(c('C', 9), [...m.flat(), spare]);
    s2 = applyMove(s2, { type: 'pickupDiscard' });
    s2 = applyMove(s2, { type: 'open', melds: m.map(ids) });
    s2 = applyMove(s2, { type: 'discard', cardId: spare.id });
    expect(s2.players[0]!.isCift).toBe(false);
  });

  it('alınan kart taahhütsüzken GERİ ATILAMAZ (GERİ BIRAK gerekir)', () => {
    const top = c('C', 9);
    let state = baseState(top, [c('S', 2), c('H', 7)]);
    state = applyMove(state, { type: 'pickupDiscard' });
    expect(() => applyMove(state, { type: 'discard', cardId: top.id })).toThrowError(
      /GERİ BIRAK/,
    );
  });

  it('AÇIK serici kartı kullanmadan devam EDEMEZ; işlerse devam eder', () => {
    const top = c('D', 7);
    const table = meld('m1', 'run', [c('D', 4), c('D', 5), c('D', 6)]);
    let state = baseState(top, [c('S', 2), c('H', 9)], { opened: [0], melds: [table] });
    state = applyMove(state, { type: 'pickupDiscard' });
    // Kullanmadan atış → red.
    expect(() =>
      applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id }),
    ).toThrowError(/kullanmadan/);
    // İşleyince serbest.
    state = applyMove(state, { type: 'extend', meldId: 'm1', cardId: top.id });
    const done = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(done.players[0]!.isCift).toBe(false); // açık oyuncu çift olmaz
  });

  it('sol komşudan gelmeyen kart denemeye ALINAMAZ', () => {
    let state = createGame({ seed: 9, dealerSeat: 3 });
    const top = c('C', 9);
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: fromSeat(1, top.id), // 1, 0'ın solu değil
    });
    expect(canPickupDiscard(state, 0)).toBe(false);
    expect(() => applyMove(state, { type: 'pickupDiscard' })).toThrowError(/solundakinin/);
  });
});

describe('P7 — kilitli ıskarta (1.4)', () => {
  it('çiftin attığı kart kilitlidir: serici deneme açamaz; ÇİFT OL atomiktir', () => {
    const top = c('C', 9);
    let state = baseState(top, [c('S', 2), c('H', 7)], { ciftler: [3] });
    expect(isDiscardLocked(state)).toBe(true);
    expect(canPickupDiscard(state, 0)).toBe(false);
    expect(() => applyMove(state, { type: 'pickupDiscard' })).toThrowError(/çift olman/);

    // Atomik alım: deneme yok, alan anında ÇİFT, geri dönüş yok.
    expect(canPickupLocked(state, 0)).toBe(true);
    const taken = applyMove(state, { type: 'pickupLocked' });
    expect(taken.players[0]!.isCift).toBe(true);
    expect(taken.pickup).toBeNull(); // deneme modu YOK
    expect(() => applyMove(taken, { type: 'cancelPickup' })).toThrowError();
    // Alım kamuya anında açık (kilitli alım gizlenmez).
    expect(taken.log[taken.log.length - 1]?.type).toBe('pickupLocked');
  });

  it('AÇMIŞ serici kilitli kartı hiçbir yolla alamaz; çift olan alabilir', () => {
    const top = c('C', 9);
    const opened = baseState(top, [c('S', 2), c('H', 7)], { ciftler: [3], opened: [0] });
    expect(canPickupLocked(opened, 0)).toBe(false);
    expect(() => applyMove(opened, { type: 'pickupLocked' })).toThrowError(/alamaz/);

    const cift = baseState(top, [c('S', 2), c('H', 7)], { ciftler: [0, 3] });
    expect(canPickupLocked(cift, 0)).toBe(true);
    const next = applyMove(cift, { type: 'pickupLocked' });
    expect(next.players[0]!.hand.some((x) => x.id === top.id)).toBe(true);
  });
});

describe('P7 — sorgu protokolü (1.11)', () => {
  function pickedUp(ciftler: number[] = []): GameState {
    const top = c('C', 9);
    let state = baseState(top, [c('S', 2), c('H', 7), c('D', 4)], { ciftler });
    return applyMove(state, { type: 'pickupDiscard' });
  }

  it('SOR yalnız iki taraf da kesin çift DEĞİLKEN ve taahhütten önce açılabilir', () => {
    const state = pickedUp();
    expect(canSor(state, 0)).toBe(true);

    // Alan çiftse sorgu yok (kartı her türlü alır).
    const alanCift = pickedUp([0]);
    expect(canSor(alanCift, 0)).toBe(false);
  });

  it('VER: kart askerde kalır ve ZORUNLUDUR — geri bırakılamaz', () => {
    let state = pickedUp();
    state = applyMove(state, { type: 'sor' });
    expect(state.sorgu).toMatchObject({ askerSeat: 0, sorulanSeat: 3, asama: 'cevap' });
    // Sorgu beklerken başka hamle oynanamaz.
    expect(() =>
      applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id }),
    ).toThrowError(/Sorgu/);

    state = applyMove(state, { type: 'sorguCevap', cevap: 'ver' });
    expect(state.sorgu).toBeNull();
    expect(state.pickup?.zorunlu).toBe(true);
    expect(() => applyMove(state, { type: 'cancelPickup' })).toThrowError(/zorunda/);
    // Akıbet hamleye bağlı: açmadan atarak devam → çift.
    const done = applyMove(state, { type: 'discard', cardId: state.players[0]!.hand[0]!.id });
    expect(done.players[0]!.isCift).toBe(true);
  });

  it('VERME: vermeyen ÇİFT olur; Yine de Al → asker DE çift (çifte-çift)', () => {
    let state = pickedUp();
    state = applyMove(state, { type: 'sor' });
    state = applyMove(state, { type: 'sorguCevap', cevap: 'verme' });
    expect(state.players[3]!.isCift).toBe(true); // bedel: vermeyen çift
    expect(state.sorgu?.asama).toBe('sonuc');

    const sorguKart = state.sorgu!.cardId;
    const aldi = applyMove(state, { type: 'sorguSonuc', al: true });
    expect(aldi.players[0]!.isCift).toBe(true); // çifte-çift
    expect(aldi.pickup).toBeNull();
    expect(aldi.players[0]!.hand.some((x) => x.id === sorguKart)).toBe(true); // kart elde kalır
  });

  it('VERME + Geri Bırak: asker temiz çıkar, kart ıskartaya döner ve artık KİLİTLİDİR', () => {
    const top = c('C', 9);
    let state = baseState(top, [c('S', 2), c('H', 7), c('D', 4)]);
    state = applyMove(state, { type: 'pickupDiscard' });
    state = applyMove(state, { type: 'sor' });
    state = applyMove(state, { type: 'sorguCevap', cevap: 'verme' });
    const birakti = applyMove(state, { type: 'sorguSonuc', al: false });
    expect(birakti.players[0]!.isCift).toBe(false);
    expect(birakti.phase).toBe('draw');
    expect(birakti.discard[birakti.discard.length - 1]?.id).toBe(top.id);
    // Atan (3) artık çift → aynı kart şimdi kilitli, deneme açılamaz.
    expect(isDiscardLocked(birakti)).toBe(true);
    expect(canPickupDiscard(birakti, 0)).toBe(false);
  });

  it('SOR hakkı alım başına BİR keredir', () => {
    let state = pickedUp();
    state = applyMove(state, { type: 'sor' });
    state = applyMove(state, { type: 'sorguCevap', cevap: 'ver' });
    expect(canSor(state, 0)).toBe(false);
    expect(() => applyMove(state, { type: 'sor' })).toThrowError(/sorgu/i);
  });
});
