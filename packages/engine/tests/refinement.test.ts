import { describe, expect, it } from 'vitest';
import {
  applyMove,
  canPickupDiscard,
  createGame,
  meldBarajTokens,
  openingThreshold,
  prevActiveSeat,
} from '../src/game';
import { sheetTeamTotals, sheetTotals, teamOf } from '../src/scoring';
import { DEFAULT_RULES, makeRules } from '../src/rules';
import type { Card, GameState, PublicEvent } from '../src/types';
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

const discardEvent = (seat: number, cardId: string): PublicEvent => ({
  seat,
  type: 'discard',
  cardId,
});

describe('çift olma — yerden alma yolu', () => {
  it('solundakinin attığını açmadan almak çift yapar; sınır 101 olur', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('C', 9); // hiçbir açışa yaramayan kart
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: [discardEvent(3, top.id)], // 0'ın solu = 3 (önceki aktif koltuk)
      hands: { 0: [c('S', 2), c('H', 7), c('D', 4)] },
    });
    expect(prevActiveSeat(state, 0)).toBe(3);
    expect(canPickupDiscard(state, 0)).toBe(true);
    // P7: kart işe yaramasa da DENEMEYE alınır; açmadan ATARAK devam = ÇİFT.
    let next = applyMove(state, { type: 'pickupDiscard' });
    expect(next.players[0]!.isCift).toBe(false); // henüz taahhüt yok
    // Alınan kart DEĞİL, başka bir kart atılır (açmadan devam = çift).
    next = applyMove(next, { type: 'discard', cardId: next.players[0]!.hand[0]!.id });
    expect(next.players[0]!.isCift).toBe(true);
    expect(openingThreshold(next)).toBe(101);
  });

  it('üstteki kart soldan GELMEDİYSE deneme alımı reddedilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('C', 9);
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: [discardEvent(1, top.id)], // 1, 0'ın solu DEĞİL
      hands: { 0: [c('S', 2), c('H', 7), c('D', 4)] },
    });
    expect(canPickupDiscard(state, 0)).toBe(false);
    expect(() => applyMove(state, { type: 'pickupDiscard' })).toThrowError(/solundakinin/);
  });

  it('çift olan per ile AÇAMAZ (kilit), çiftle açabilir', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    const top = c('C', 9);
    const strongHand = [
      c('S', 1), c('H', 1), c('D', 1),
      c('S', 13), c('H', 13), c('D', 13),
      c('D', 9), c('D', 10), c('D', 11),
      c('S', 4, 0), c('S', 4, 1),
      c('H', 6, 0), c('H', 6, 1),
      c('C', 8, 0),
    ];
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      discard: [top],
      log: [discardEvent(3, top.id)],
      hands: { 0: strongHand },
    });
    // Denemeye al, açmadan başka kart atarak ÇİFT ol; sonraki turda dene.
    state = applyMove(state, { type: 'pickupDiscard' });
    state = applyMove(state, { type: 'discard', cardId: c('C', 8, 0).id });
    expect(state.players[0]!.isCift).toBe(true);
    // Sırayı 0'a geri sar (test düzeneği).
    state = { ...state, currentSeat: 0, phase: 'action' };
    // 92 puanlık per planı var ama çift kilidi açmayı engeller.
    const melds = [
      ids(strongHand.slice(0, 3)),
      ids(strongHand.slice(3, 6)),
      ids(strongHand.slice(6, 9)),
    ];
    expect(() => applyMove(state, { type: 'open', melds })).toThrowError(/çift/i);
  });

  it('çiftle açan da çift statüsü alır (mevcut yol)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const pairs = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      hands: { 0: [...pairs.flat(), c('D', 7)] },
    });
    const next = applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
    expect(next.players[0]!.isCift).toBe(true);
    expect(openingThreshold(next)).toBe(101);
  });

  it('101 sınırında açış BARAJ getirmez (111 gerekir)', () => {
    expect(meldBarajTokens(101, R)).toBe(0);
    expect(meldBarajTokens(110, R)).toBe(0);
    expect(meldBarajTokens(111, R)).toBe(1);
  });
});

describe('SABİT BİRİM ceza modeli — kabul örnekleri', () => {
  /** Bitiren 0. koltuk; okey atarak bitirir; 1. koltuk çift, 2-3 normal. */
  function workedExample(): GameState {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const meldCards = [
      c('S', 1), c('H', 1), c('D', 1),
      c('S', 13), c('H', 13), c('D', 13),
      c('D', 9), c('D', 10), c('D', 11),
    ];
    const lastJoker = joker(5); // okey atışı
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0],
      hands: {
        0: [...meldCards.slice(0, 0), lastJoker], // elde yalnız okey kaldı
        1: [c('S', 5), c('H', 9)],
        2: [c('D', 3), c('C', 6)],
        3: [c('H', 11), c('S', 8)],
      },
    });
    state.players = state.players.map((p) =>
      p.seat === 1 ? { ...p, isCift: true } : p,
    );
    return applyMove(state, { type: 'discard', cardId: lastJoker.id });
  }

  it('SOLO örnek: okeyle bitiş — çift 800, normaller 400 öder; bitirene ceza yazılmaz', () => {
    const ended = workedExample();
    const result = ended.lastHandResult!;
    expect(result.okeyFinish).toBe(true);
    // çift: 200 ×2(çift) ×2(okey) = 800; normal: 200 ×2(okey) = 400
    expect(result.penalties).toEqual([0, 800, 400, 400]);
    const b1 = result.breakdown.find((b) => b.seat === 1)!;
    expect(b1.base).toBe(200);
    expect(b1.multipliers.map((m) => m.label).sort()).toEqual(['okey', 'çift']);
    expect(b1.amount).toBe(800);
    // Yazboz: bitirene ceza satırı YOK; ödeyenlere ayrı satırlar var.
    const handRows = ended.sheet.filter((e) => e.kind === 'penalty');
    expect(handRows.some((e) => e.seat === 0)).toBe(false);
    expect(handRows.map((e) => e.amount).sort((a, b) => a - b)).toEqual([400, 400, 800]);
  });

  it('C6 EŞLİ: bitirenin ortağı CEZA YEMEZ; karşı takım sütununa 800+400=1200 yazılır', () => {
    // workedExample ile aynı senaryo, teamMode açık (çapraz eşler 0&2 vs 1&3).
    const rules = makeRules({ teamMode: true });
    let state = createGame({ seed: 1, dealerSeat: 0, rules });
    const lastJoker = joker(5);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0],
      hands: {
        0: [lastJoker],
        1: [c('S', 5), c('H', 9)],
        2: [c('D', 3), c('C', 6)], // bitirenin ORTAĞI (takım 0)
        3: [c('H', 11), c('S', 8)],
      },
    });
    state.players = state.players.map((p) => (p.seat === 1 ? { ...p, isCift: true } : p));
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    const result = ended.lastHandResult!;
    expect(result.okeyFinish).toBe(true);
    // Ortak (koltuk 2) MUAF; çift rakip 800, normal rakip 400.
    expect(result.penalties).toEqual([0, 800, 0, 400]);
    expect(result.breakdown.some((b) => b.seat === 2)).toBe(false);
    expect(teamOf(0)).toBe(0);
    expect(teamOf(2)).toBe(0);
    const [team0, team1] = sheetTeamTotals(ended.sheet);
    expect(team1).toBe(1200); // karşı takım hanesi
    expect(team0).toBe(0); // bitirenin takımı ceza yazmaz
  });

  it('belge örneği: açmış çiftçi rakip (elinde 30), çiftçi okeyle bitirdi → 30×2×2×2 = 240', () => {
    const pairsToOpen = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    const lastJoker = joker(3);
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      hands: {
        0: [...pairsToOpen.flat(), lastJoker],
        1: [c('S', 13), c('H', 10), c('D', 10)], // 10+10+10 = 30
        2: [c('D', 3)],
        3: [c('H', 11)],
      },
    });
    // 1. koltuk: AÇMIŞ çiftçi (çiftle açtı, bitememiş).
    state.players = state.players.map((p) =>
      p.seat === 1
        ? { ...p, hasOpened: true, openMode: 'pairs' as const, isCift: true, openedOnTurn: 1 }
        : p,
    );
    state = applyMove(state, { type: 'openPairs', pairs: pairsToOpen.map(ids) });
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    const result = ended.lastHandResult!;
    expect(result.okeyFinish).toBe(true);
    expect(result.pairFinish).toBe(true); // bitiren çiftçi
    const b1 = result.breakdown.find((b) => b.seat === 1)!;
    // elde 30 × 2 (yiyen çift) × 2 (okey) × 2 (çiftten) = 240.
    expect(b1).toMatchObject({ baseKind: 'hand', base: 30, amount: 240 });
  });

  it('C5: deste bitti + taahhütlü — açan elinde kalanı, ÇİFT-AÇAMAYAN 200×2=400, taahhütsüz 200', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      stock: [],
      discard: [c('H', 2)],
      opened: [1], // 1. koltuk açmış (serici)
      hands: {
        0: [c('S', 13)], // taahhütsüz → 200
        1: [c('H', 10), c('D', 7)], // açan → elde 17
        2: [c('D', 9, 0)], // çift İLAN ETMİŞ ama AÇAMAMIŞ → 200×2 = 400
        3: [c('D', 1)], // taahhütsüz → 200
      },
    });
    state.players = state.players.map((p) => (p.seat === 2 ? { ...p, isCift: true } : p));
    const next = applyMove(state, { type: 'drawStock' });
    expect(next.phase).toBe('handEnded');
    expect(next.lastHandResult?.winnerSeat).toBeNull();
    // Çift ilan edip açamayan (seat 2) deste bitince de çift-açamama bedelini öder (200×2=400).
    expect(next.lastHandResult?.penalties).toEqual([200, 17, 400, 200]);
    // Yalnız çift-açamayan koltukta çarpan; diğerleri çarpansız.
    const bd = next.lastHandResult!.breakdown;
    expect(bd.find((b) => b.seat === 2)?.multipliers).toEqual([{ label: 'çift', factor: 2 }]);
    for (const b of bd.filter((x) => x.seat !== 2)) {
      expect(b.multipliers).toEqual([]);
    }
  });

  it('C5b: deste bitti — AÇMIŞ çiftçi de elinde kalanı × 2 (çift) öder', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      stock: [],
      discard: [c('H', 2)],
      hands: {
        0: [c('S', 13)], // taahhütsüz → 200
        1: [c('H', 10), c('D', 7)], // açmış çiftçi → elde 17 × 2 = 34
        2: [c('C', 5)], // taahhütsüz → 200
        3: [c('D', 1)], // taahhütsüz → 200
      },
    });
    // seat 1: çift ilan etmiş VE açmış (openMode='pairs', isCift, hasOpened).
    state.players = state.players.map((p) =>
      p.seat === 1 ? { ...p, hasOpened: true, openMode: 'pairs', isCift: true } : p,
    );
    const next = applyMove(state, { type: 'drawStock' });
    expect(next.lastHandResult?.winnerSeat).toBeNull();
    // seat1 açmış çiftçi: 17 × 2 = 34; taahhütsüzler 200.
    expect(next.lastHandResult?.penalties).toEqual([200, 34, 200, 200]);
    expect(next.lastHandResult!.breakdown.find((b) => b.seat === 1)?.multipliers).toEqual([
      { label: 'çift', factor: 2 },
    ]);
  });

  it('C7: çarpanlar İSTİSNASIZDIR — katlamali=false bile ×2leri etkilemez', () => {
    const rules = makeRules({ katlamali: false });
    let state = createGame({ seed: 1, dealerSeat: 0, rules });
    const lastJoker = joker(5);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0],
      hands: { 0: [lastJoker], 1: [c('S', 5)], 2: [c('D', 3)], 3: [c('H', 11)] },
    });
    state.players = state.players.map((p) => (p.seat === 1 ? { ...p, isCift: true } : p));
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    // Okey bitişi: çift 200×2×2=800, normaller 200×2=400 — katlamasızda da aynı.
    expect(ended.lastHandResult?.penalties).toEqual([0, 800, 400, 400]);
  });

  it('açmış ama bitirememiş oyuncu ELİNDE KALAN puanları öder (hibrit)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const last = c('D', 2);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0, 2], // 2. koltuk açmış -> elde kalan 3 puanı öder
      hands: { 0: [last], 1: [c('S', 5)], 2: [c('D', 3)], 3: [c('H', 11)] },
    });
    const ended = applyMove(state, { type: 'discard', cardId: last.id });
    expect(ended.lastHandResult?.penalties).toEqual([0, 200, 3, 200]);
    const b2 = ended.lastHandResult!.breakdown.find((b) => b.seat === 2)!;
    expect(b2.baseKind).toBe('hand');
    expect(b2.base).toBe(3);
  });

  it('HİBRİT örnek: açık ödeyen elde 27p x2 (okey) = 54; kapalı 200 x2 = 400', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    const lastJoker = joker(6);
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [0, 1], // 1. koltuk açmış
      hands: {
        0: [lastJoker],
        1: [c('S', 13), c('H', 10), c('D', 7)], // 10+10+7 = 27
        2: [c('D', 3), c('C', 6)],
        3: [c('H', 11), c('S', 8)],
      },
    });
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    const result = ended.lastHandResult!;
    expect(result.okeyFinish).toBe(true);
    expect(result.penalties).toEqual([0, 54, 400, 400]);
    const b1 = result.breakdown.find((b) => b.seat === 1)!;
    expect(b1).toMatchObject({ baseKind: 'hand', base: 27, amount: 54 });
    const b2 = result.breakdown.find((b) => b.seat === 2)!;
    expect(b2).toMatchObject({ baseKind: 'closed', base: 200, amount: 400 });
  });

  it('berabere elde (deste bitti) sabit modelde ceza yazılmaz', () => {
    let state = createGame({ seed: 1, dealerSeat: 3 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'draw',
      stock: [],
      discard: [c('H', 2)],
      hands: { 0: [c('S', 13)], 1: [c('H', 5)], 2: [joker(9)], 3: [c('D', 1)] },
    });
    const next = applyMove(state, { type: 'drawStock' });
    expect(next.phase).toBe('handEnded');
    expect(next.lastHandResult?.penalties).toEqual([0, 0, 0, 0]);
    expect(next.sheet.filter((e) => e.kind === 'penalty')).toHaveLength(0);
  });
});

describe('elde kalan okey (OKEY_EL_PUANI = 50)', () => {
  it('açık ödeyenin elindeki okey 50 sayılır ve çarpanlara tabidir: 50×2×2 = 200', () => {
    // Bitiren ÇİFT ve OKEYLE bitiriyor; ödeyen AÇIK, elinde yalnız okey var.
    const pairs = [
      [c('S', 9, 0), c('S', 9, 1)],
      [c('H', 5, 0), c('H', 5, 1)],
      [c('D', 12, 0), c('D', 12, 1)],
      [c('C', 2, 0), c('C', 2, 1)],
      [c('S', 1, 0), c('S', 1, 1)],
    ];
    const lastJoker = joker(0); // bitiş kartı: okey
    const payerJoker = joker(1); // ödeyenin elinde kalan okey
    let state = createGame({ seed: 1, dealerSeat: 0 });
    state = rig(state, {
      currentSeat: 0,
      phase: 'action',
      turnCount: 9,
      opened: [1], // 1. koltuk açık (serici)
      hands: {
        0: [...pairs.flat(), lastJoker],
        1: [payerJoker], // elde yalnız okey → taban 50
        2: [c('D', 3)],
        3: [c('H', 11)],
      },
    });
    state = applyMove(state, { type: 'openPairs', pairs: pairs.map(ids) });
    const ended = applyMove(state, { type: 'discard', cardId: lastJoker.id });
    const result = ended.lastHandResult!;
    expect(result.okeyFinish).toBe(true);
    expect(result.pairFinish).toBe(true);
    const b1 = result.breakdown.find((b) => b.seat === 1)!;
    // Taban 50 (elde okey) × 2 (okey bitişi) × 2 (çiftten bitiş) = 200.
    expect(b1).toMatchObject({ baseKind: 'hand', base: 50, amount: 200 });
    // Kapalı ödeyenler: 200 × 2 × 2 = 800.
    expect(result.penalties).toEqual([0, 200, 800, 800]);
  });
});

describe('yazboz bütünlüğü', () => {
  it('toplamlar her zaman satırların toplamına eşittir (baraj/işlek/ceza ayrı satırlar)', () => {
    let state = createGame({ seed: 1, dealerSeat: 0 });
    // Baraj kazanan açış (117 → 1 jeton = -100).
    const m1 = [c('S', 1, 0), c('H', 1, 0), c('D', 1, 0), c('C', 1, 0)];
    const m2 = [c('S', 1, 1), c('H', 1, 1), c('D', 1, 1), c('C', 1, 1)];
    const m3 = [c('D', 9), c('D', 10), c('D', 11)];
    const islekCard = c('D', 12); // m3'ü işler → atarsa işlek cezası
    const hand = [...m1, ...m2, ...m3, islekCard, c('S', 4)];
    state = rig(state, { currentSeat: 0, phase: 'action', hands: { 0: hand } });
    state = applyMove(state, { type: 'open', melds: [ids(m1), ids(m2), ids(m3)] });
    state = applyMove(state, { type: 'discard', cardId: islekCard.id });

    const barajRows = state.sheet.filter((e) => e.kind === 'baraj');
    const islekRows = state.sheet.filter((e) => e.kind === 'islek');
    expect(barajRows).toHaveLength(1);
    expect(barajRows[0]!.amount).toBe(-100);
    expect(islekRows).toHaveLength(1);
    expect(islekRows[0]!.amount).toBe(R.islek.penaltyPoints);

    const totals = sheetTotals(state.sheet, 4);
    state.players.forEach((p) => expect(p.totalScore).toBe(totals[p.seat]));
  });
});
