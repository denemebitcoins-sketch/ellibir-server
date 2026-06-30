import type {
  Card,
  CardId,
  GameState,
  Meld,
  MeldAnalysis,
  Move,
  PlayerState,
  PlayerView,
  PublicEvent,
  SheetEntry,
} from './types';
import { MoveError } from './types';
import type { RuleConfig } from './rules';
import { DEFAULT_RULES } from './rules';
import { buildDeck, createRng, deal, shuffle } from './deck';
import { analyzeCards, analyzePair, analyzeRun, analyzeSet } from './melds';
import { applyHandResult, computeHandResult } from './scoring';
import { analyzeHand, bestOpeningWithCard, bestPairOpening } from './insight';
import { enumerateCandidateMelds, solveHand } from './solver';

let meldCounter = 0;
function nextMeldId(): string {
  meldCounter += 1;
  return `meld-${meldCounter}`;
}

/* ------------------------------------------------------------------ */
/* Kurulum                                                             */
/* ------------------------------------------------------------------ */

export interface CreateGameOptions {
  rules?: RuleConfig;
  seed?: number;
  playerNames?: string[];
  /** Hangi koltuklar bot (varsayılan: 0 insan, kalanlar bot). */
  botSeats?: number[];
  dealerSeat?: number;
}

export function createGame(options: CreateGameOptions = {}): GameState {
  const rules = options.rules ?? DEFAULT_RULES;
  const seed = options.seed ?? 1;
  const dealerSeat = options.dealerSeat ?? 0;
  const names = options.playerNames ?? ['Sen', 'Ayşe', 'Mehmet', 'Fatma'];
  const botSeats = options.botSeats ?? [1, 2, 3];

  const players: PlayerState[] = Array.from({ length: rules.playerCount }, (_, seat) => ({
    seat,
    name: names[seat] ?? `Oyuncu ${seat + 1}`,
    isBot: botSeats.includes(seat),
    hand: [],
    hasOpened: false,
    openMode: null,
    isCift: false,
    openedOnTurn: null,
    totalScore: 0,
    barajTokens: 0,
  }));

  const state: GameState = {
    rules,
    seed,
    handNumber: 1,
    dealerSeat,
    currentSeat: dealerSeat,
    phase: 'draw',
    turnCount: 0,
    players,
    melds: [],
    stock: [],
    discard: [],
    pickup: null,
    sorgu: null,
    ciftIslekUsed: false,
    enYuksekSeriAcisi: null,
    enYuksekCiftAcisi: null,
    log: [],
    sheet: [],
    lastHandResult: null,
    matchWinnerSeat: null,
    matchLog: [],
  };
  return dealHand(state);
}

/** Maç loguna olay mesajı ekler (maç boyu birikir; el geçişinde korunur). */
function addLog(state: GameState, msg: string): string[] {
  return [...(state.matchLog ?? []), msg].slice(-200);
}

/** Bir koltuğun adı (log mesajları için). */
function nameOf(state: GameState, seat: number): string {
  return state.players[seat]?.name ?? `Oyuncu ${seat + 1}`;
}

/** Eli (yeniden) dağıtır: desteyi kur, karıştır, dağıt; dağıtıcı atışla başlar. */
function dealHand(state: GameState): GameState {
  const { rules } = state;
  const rng = createRng(state.seed + state.handNumber * 7919);
  const deck = shuffle(buildDeck(rules), rng);
  const { hands, stock } = deal(deck, rules, state.dealerSeat);

  // GÖSTERGE OKEY (joker) OLAMAZ: deste dibi (stock[0]) joker ise, ilk joker-olmayan kartla
  // yer değiştir. Böylece gösterge hep gerçek bir kart olur.
  if (stock.length > 0 && stock[0]!.joker) {
    const nj = stock.findIndex((c) => !c.joker);
    if (nj > 0) {
      const t = stock[0]!;
      stock[0] = stock[nj]!;
      stock[nj] = t;
    }
  }

  return {
    ...state,
    players: state.players.map((p) => ({
      ...p,
      hand: hands[p.seat]!,
      hasOpened: false,
      openMode: null,
      isCift: false, // çift statüsü EL BAŞINA sıfırlanır
      openedOnTurn: null,
    })),
    melds: [],
    stock,
    discard: [],
    currentSeat: state.dealerSeat,
    // Dağıtıcı fazladan kartla başlar; çekmeden açabilir/atar.
    phase: 'action',
    turnCount: 1,
    pickup: null,
    sorgu: null,
    ciftIslekUsed: false,
    // Katlamalı çıtalar EL BAŞINA sıfırlanır (yarış el içidir).
    enYuksekSeriAcisi: null,
    enYuksekCiftAcisi: null,
    log: [],
    // GÖSTERGE HER EL: destenin en altı (stock[0], en son çekilecek kart) AÇIK.
    gostergeKart: stock[0] ?? null,
    gostergeShown: [],
    gostergeLocked: [],
    gostergeTaken: false,
  };
}

/** Sonraki eli başlatır (skor ekranından sonra çağrılır). */
export function startNextHand(state: GameState): GameState {
  if (state.phase !== 'handEnded') throw new MoveError('phase', 'El henüz bitmedi.');
  if (state.handNumber >= state.rules.totalHands) {
    return finishMatch(state);
  }
  const dealer = (state.dealerSeat + 1) % state.rules.playerCount;
  return dealHand({
    ...state,
    handNumber: state.handNumber + 1,
    dealerSeat: dealer,
    lastHandResult: state.lastHandResult,
  });
}

function finishMatch(state: GameState): GameState {
  // RULES.md 1.7: eleme yoktur; maç yalnız el sayısı dolunca biter,
  // en düşük toplam puan kazanır.
  const winner = state.players.reduce(
    (best, p) => (p.totalScore < best.totalScore ? p : best),
    state.players[0]!,
  );
  return { ...state, phase: 'matchEnded', matchWinnerSeat: winner.seat };
}

/* ------------------------------------------------------------------ */
/* Yardımcılar                                                         */
/* ------------------------------------------------------------------ */

function currentPlayer(state: GameState): PlayerState {
  return state.players[state.currentSeat]!;
}

function cardsFromHand(player: PlayerState, ids: readonly CardId[]): Card[] {
  const result: Card[] = [];
  const seen = new Set<CardId>();
  for (const id of ids) {
    if (seen.has(id)) throw new MoveError('duplicateCard', 'Aynı kart iki kez kullanılamaz.');
    seen.add(id);
    const card = player.hand.find((c) => c.id === id);
    if (!card) throw new MoveError('notInHand', 'Kart elde değil.');
    result.push(card);
  }
  return result;
}

function removeFromHand(hand: Card[], ids: ReadonlySet<CardId>): Card[] {
  return hand.filter((c) => !ids.has(c.id));
}

function findMeld(state: GameState, meldId: string): Meld {
  const meld = state.melds.find((m) => m.id === meldId);
  if (!meld) throw new MoveError('noMeld', 'Perde bulunamadı.');
  return meld;
}

/* ------------------------------------------------------------------ */
/* Doğrulama (can*) — UI ve botlar bu fonksiyonları kullanır           */
/* ------------------------------------------------------------------ */

/** Seçilen kartlar geçerli tek bir perde mi? */
export function canMeld(cards: readonly Card[], rules: RuleConfig): MeldAnalysis | null {
  return analyzeCards(cards, rules);
}

/**
 * ŞU ANKİ etkin per açma sınırı: masada ÇİFT (çiftle açan YA DA soldan
 * alıp çift olan) biri varsa, henüz açmamış herkes için yükselmiş sınır
 * geçerlidir (her tur canlı değerlendirilir).
 * KATLAMALI (RULES.md 1.8): ilk açıştan sonra her seri açışı son açışın
 * EN AZ +1 puanı olmalı — birebir eşit açılamaz.
 */
export function openingThreshold(state: GameState): number {
  const anyCift = state.players.some((p) => p.isCift);
  const base = anyCift
    ? state.rules.openingMinPointsAfterPairOpen
    : state.rules.openingMinPoints;
  if (state.rules.katlamali && state.enYuksekSeriAcisi !== null) {
    return Math.max(base, state.enYuksekSeriAcisi + 1);
  }
  return base;
}

/**
 * ŞU ANKİ etkin çift açma adedi (RULES.md 1.8): katlamalıda ilk çift
 * açışından sonra her çift açışı son açışın EN AZ +1 adedi olmalı.
 * Seri ve çift çıtaları AYRI yarışlardır.
 */
export function pairsOpeningMin(state: GameState): number {
  const base = state.rules.pairs.pairsToOpen;
  if (state.rules.katlamali && state.enYuksekCiftAcisi !== null) {
    return Math.max(base, state.enYuksekCiftAcisi + 1);
  }
  return base;
}

/** Koltuğun solundaki (tur sırasında bir önceki) koltuk. */
export function prevActiveSeat(state: GameState, seat: number): number {
  const n = state.rules.playerCount;
  return (seat - 1 + n) % n;
}

/** Açık yığının üstünü en son atan koltuk (açık kayıttan). */
function lastDiscarderSeat(state: GameState): number | null {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i]!;
    if (e.type === 'discard') return e.seat;
  }
  return null;
}

/**
 * KİLİTLİ ISKARTA (RULES.md 1.4): üstteki kartı atan KESİN ÇİFT ise kart
 * kilitlidir — yalnız çiftler alabilir (serici alamaz, deneme açamaz).
 */
export function isDiscardLocked(state: GameState): boolean {
  if (state.discard.length === 0) return false;
  const discarder = lastDiscarderSeat(state);
  if (discarder === null) return false;
  return state.players[discarder]?.isCift === true;
}

/**
 * ATIŞ KİLİDİ (RULES.md işlek/okey atış kuralı): atılan kart İŞLEK (cezalı ya da
 * çift-muaf) ya da OKEY ise rakip o kartı ALAMAZ ve SORAMAZ (çift olsa dahi).
 * Kilit son atış olayının `islek` bayrağından okunur (applyDiscard işler).
 */
export function isDiscardAtisLocked(state: GameState): boolean {
  for (let i = state.log.length - 1; i >= 0; i--) {
    const e = state.log[i]!;
    if (e.type === 'discard') return e.islek === true;
  }
  return false;
}

/**
 * DENEME ALIMI uygunluğu (RULES.md 1.6): sırası gelen oyuncu, SOL KOMŞUNUN
 * az önce attığı KİLİTSİZ kartı denemeye alabilir — hemen-kullanma şartı
 * YOKTUR; taahhüt gerçek hamleyle olur, GERİ BIRAK her an mümkündür.
 */
export function canPickupDiscard(state: GameState, seat: number): boolean {
  const player = state.players[seat];
  const top = state.discard[state.discard.length - 1];
  if (!player || !top) return false;
  if (state.phase !== 'draw' || state.currentSeat !== seat) return false;
  if (lastDiscarderSeat(state) !== prevActiveSeat(state, seat)) return false;
  if (isDiscardAtisLocked(state)) return false; // işlek/okey atışı rakip alamaz
  return !isDiscardLocked(state);
}

/**
 * KİLİTLİ ALIM uygunluğu (RULES.md 1.4): çiftin attığı kartı yalnız çift
 * olan ya da (çift OLMAYI kabul ederek) açmamış oyuncu alabilir — ATOMİK,
 * deneme modu yoktur, geri bırakılamaz.
 */
export function canPickupLocked(state: GameState, seat: number): boolean {
  const player = state.players[seat];
  const top = state.discard[state.discard.length - 1];
  if (!player || !top || !state.rules.pairs.enabled) return false;
  if (state.phase !== 'draw' || state.currentSeat !== seat) return false;
  if (lastDiscarderSeat(state) !== prevActiveSeat(state, seat)) return false;
  if (isDiscardAtisLocked(state)) return false; // işlek/okey atışı çift de alamaz
  if (!isDiscardLocked(state)) return false;
  return player.isCift || !player.hasOpened;
}

/** UI için açık yığın seçenekleri (deneme alımı / kilit / kilitli alım). */
export function discardTakeOptions(
  state: GameState,
  seat: number,
): { pickup: boolean; locked: boolean; lockedTake: boolean } {
  return {
    pickup: canPickupDiscard(state, seat),
    locked: isDiscardLocked(state),
    lockedTake: canPickupLocked(state, seat),
  };
}

/**
 * SOR uygunluğu (RULES.md 1.11): yalnız deneme modundaki alım üzerinde,
 * iki taraf da kesin çift DEĞİLKEN, taahhütten önce ve alım başına bir kez.
 * AÇIK ELE SORULAMAZ (kullanıcı kuralı): sorulan oyuncu hasOpened ise sorgu
 * açılamaz — açık oyuncudan kuralları dahilinde sormadan ALINIR.
 */
export function canSor(state: GameState, seat: number): boolean {
  const p = state.pickup;
  const player = state.players[seat];
  if (!p || !player || state.sorgu || state.currentSeat !== seat) return false;
  if (state.phase !== 'action') return false;
  if (p.committed || p.zorunlu || p.sorguUsed) return false;
  if (player.isCift) return false; // alan kesin çiftse sorgu yok
  if (player.hand.length <= 2) return false; // el ≤2 → sorgu yok (son atış; bot ile tutarlı)
  const sorulan = state.players[prevActiveSeat(state, seat)];
  if (!sorulan) return false;
  if (sorulan.hasOpened) return false; // ELİ AÇIK olana sorgu açılamaz
  return !sorulan.isCift; // atan kesin çiftse kart zaten kilitliydi
}

/** AÇIŞI GERİ AL hakkı: bu turda açtı, henüz kart atmadı (snapshot duruyor). */
export function canCancelOpen(state: GameState, seat: number): boolean {
  if (state.phase !== 'action' || state.currentSeat !== seat) return false;
  const player = state.players[seat];
  return !!player?.hasOpened && player.openedOnTurn === state.turnCount && !!state.openSnapshot;
}

/**
 * Per açış puanından kazanılan baraj jetonu — SINIRSIZ merdiven
 * (RULES.md 1.5): floor((puan - 111) / 10) + 1 (puan ≥ 111 ise; altı 0).
 */
export function meldBarajTokens(points: number, rules: RuleConfig): number {
  if (!rules.barajTokens.enabled) return 0;
  const { seriBarajBaslangic, seriBarajAdim } = rules.barajTokens;
  if (points < seriBarajBaslangic) return 0;
  return Math.floor((points - seriBarajBaslangic) / seriBarajAdim) + 1;
}

/** Çift açışından kazanılan baraj jetonu (çift sayısı >= eşik → +1). */
export function pairBarajTokens(pairCount: number, rules: RuleConfig): number {
  if (!rules.barajTokens.enabled) return 0;
  return rules.barajTokens.pairThresholds.filter((t) => pairCount >= t).length;
}

/**
 * İlk açış doğrulaması: her grup geçerli perde ve toplam >= minPoints
 * (dinamik sınır çağıran tarafından verilir). Geçerliyse analizler.
 */
export function canOpen(
  meldGroups: readonly (readonly Card[])[],
  rules: RuleConfig,
  minPoints: number = rules.openingMinPoints,
): MeldAnalysis[] | null {
  if (meldGroups.length === 0) return null;
  const analyses: MeldAnalysis[] = [];
  let total = 0;
  for (const group of meldGroups) {
    const a = analyzeCards(group, rules);
    if (!a) return null;
    analyses.push(a);
    total += a.points;
  }
  return total >= minPoints ? analyses : null;
}

/**
 * İŞLEK kart: masadaki herhangi bir peri işleyebilen ya da jokerini
 * kurtarabilen kart. İşleme doğrulamasıyla AYNI kodu kullanır.
 */
export function isIslekCard(card: Card, melds: readonly Meld[], rules: RuleConfig): boolean {
  return melds.some(
    (m) => canExtend(m, card, rules) !== null || canRetrieveJoker(m, card, rules) !== null,
  );
}

interface DiscardUseParams {
  hand: readonly Card[];
  melds: readonly Meld[];
  top: Card;
  rules: RuleConfig;
  hasOpened: boolean;
  openMode: 'melds' | 'pairs' | null;
  /** Çiftçinin bu turki işlek hakkı kullanıldı mı. */
  ciftIslekUsed: boolean;
  /** Etkin per açma sınırı. */
  minPoints: number;
  /** Etkin çift açma adedi (katlamalı çıtası dahil). */
  minPairs: number;
}

/**
 * "Üst kart işe yarar mı?" SEZGİSİ — (a) açışın parçası olabilir,
 * (b) açık oyuncu hemen işleyebilir/indirebilir.
 * P7 NOTU: artık alım ŞARTI DEĞİLDİR (deneme modu her kilitsiz sol-komşu
 * kartına izin verir); botlar ve UI ipuçları için sezgi olarak yaşar.
 */
export function canUseDiscardCard(p: DiscardUseParams): boolean {
  const { hand, melds, top, rules } = p;

  if (p.hasOpened) {
    if (p.openMode === 'pairs') {
      // Hemen çift indirme YA DA (işlek hakkı duruyorsa) hemen işleme/takas.
      if (hand.some((c) => analyzePair([top, c], rules) !== null)) return true;
      return !p.ciftIslekUsed && isIslekCard(top, melds, rules);
    }
    // Hemen işleme ya da joker kurtarma.
    if (isIslekCard(top, melds, rules)) return true;
    // Üst kartla hemen yeni per indirilebilir mi (atacak kart kalarak)?
    const plus = [...hand, top];
    return enumerateCandidateMelds(plus, rules).some(
      (cand) => cand.cards.some((x) => x.id === top.id) && cand.cards.length < plus.length,
    );
  }

  // Açmamış oyuncu: üst kart, ETKİN sınırı geçen bir açışın parçası olmalı.
  const plus = [...hand, top];
  const planM = bestOpeningWithCard(plus, top, rules);
  if (planM.points >= p.minPoints) return true;
  if (rules.pairs.enabled) {
    const pp = bestPairOpening(plus, rules);
    if (pp.count >= p.minPairs && pp.pairs.some((g) => g.includes(top.id))) {
      return true;
    }
  }
  return false;
}

/** Alım yasal VE kart işe yarar mı (bot kararı / UI ipucu — şart değil sezgi). */
export function canTakeDiscard(state: GameState, seat: number): boolean {
  const top = state.discard[state.discard.length - 1];
  const player = state.players[seat];
  if (!top || !player) return false;
  if (!canPickupDiscard(state, seat)) return false;
  return canUseDiscardCard({
    hand: player.hand,
    melds: state.melds,
    top,
    rules: state.rules,
    hasOpened: player.hasOpened,
    openMode: player.openMode,
    ciftIslekUsed: state.ciftIslekUsed,
    minPoints: openingThreshold(state),
    minPairs: pairsOpeningMin(state),
  });
}

/** Oyuncu görünümünden aynı karar (botlar yalnız view görür). */
export function canTakeDiscardView(view: PlayerView): boolean {
  if (!view.discardTop || !view.canPickupTop) return false;
  return canUseDiscardCard({
    hand: view.hand,
    melds: view.melds,
    top: view.discardTop,
    rules: view.rules,
    hasOpened: view.hasOpened,
    openMode: view.openMode,
    ciftIslekUsed: view.ciftIslekUsed,
    minPoints: view.currentOpeningMin,
    minPairs: view.currentPairsMin,
  });
}

/**
 * Çiftle açış doğrulaması: her grup geçerli çift ve sayı >= minPairs
 * (katlamalıda dinamik sınır çağıran tarafından verilir).
 */
export function canOpenPairs(
  pairGroups: readonly (readonly Card[])[],
  rules: RuleConfig,
  minPairs: number = rules.pairs.pairsToOpen,
): MeldAnalysis[] | null {
  if (!rules.pairs.enabled) return null;
  if (pairGroups.length < minPairs) return null;
  const analyses: MeldAnalysis[] = [];
  for (const group of pairGroups) {
    const a = analyzePair(group, rules);
    if (!a) return null;
    analyses.push(a);
  }
  return analyses;
}

/**
 * Perdeye tek kart ekleme: geçerliyse perdenin yeni kanonik dizilimi, değilse null.
 * Çiftler tamamlanmıştır; uzatılamaz.
 */
export function canExtend(meld: Meld, card: Card, rules: RuleConfig): MeldAnalysis | null {
  if (meld.type === 'pair') return null;
  if (meld.type === 'set') {
    return analyzeSet([...meld.cards, card], rules);
  }
  // Seri: sona, sonra başa eklemeyi dene (joker dahil).
  return (
    analyzeRun([...meld.cards, card], rules) ?? analyzeRun([card, ...meld.cards], rules)
  );
}

/**
 * Joker geri alma: replacement, perdedeki bir jokerin temsil ettiği kartla
 * eşleşiyorsa o jokerin id'sini döndürür; değilse null.
 */
export function canRetrieveJoker(
  meld: Meld,
  replacement: Card,
  rules: RuleConfig,
): CardId | null {
  if (replacement.joker) return null;
  // RULES.md 1.3 istisnası (C4): ÇİFT perindeki okey de gerçek kartıyla
  // takas edilebilir (perde bozulmaz, okey ele gelir).
  const analysis =
    meld.type === 'pair'
      ? analyzePair(meld.cards, rules)
      : meld.type === 'set'
        ? analyzeSet(meld.cards, rules)
        : analyzeRun(meld.cards, rules);
  if (!analysis) return null;
  for (const slot of analysis.jokers) {
    if (slot.rank === replacement.rank && slot.suits.includes(replacement.suit)) {
      return slot.jokerId;
    }
  }
  return null;
}

/** Atılabilir mi? (kart elde ve faz uygun — kural varyantları buraya eklenir.) */
export function canDiscard(state: GameState, cardId: CardId): boolean {
  if (state.phase !== 'action') return false;
  return currentPlayer(state).hand.some((c) => c.id === cardId);
}

/** Seçilen kart için masadaki yasal hedef perdeler (UI vurgusu için). */
export function legalExtendTargets(state: GameState, seat: number, cardId: CardId): string[] {
  const player = state.players[seat];
  if (!player?.hasOpened) return [];
  // Çiftçi: tur başına TEK işlek (RULES.md 1.4) — hakkı bittiyse hedef yok.
  if (player.openMode === 'pairs' && state.ciftIslekUsed) return [];
  const card = player.hand.find((c) => c.id === cardId);
  if (!card) return [];
  return state.melds.filter((m) => canExtend(m, card, state.rules) !== null).map((m) => m.id);
}

/* ------------------------------------------------------------------ */
/* Hamle uygulama                                                      */
/* ------------------------------------------------------------------ */

const LOG_LIMIT = 40;

/** Olayı açık kayda işler (kart bilgisi yalnız zaten açık olanlar için). */
function pushLog(state: GameState, event: PublicEvent): GameState {
  const log = [...state.log, event];
  return { ...state, log: log.length > LOG_LIMIT ? log.slice(-LOG_LIMIT) : log };
}

/** Hamleyi açık kayda işler. */
function withLog(state: GameState, seat: number, move: Move): GameState {
  const event: PublicEvent = { seat, type: move.type };
  if (move.type === 'discard') event.cardId = move.cardId;
  if (move.type === 'pickupLocked') {
    event.cardId = state.discard[state.discard.length - 1]?.id;
  }
  return pushLog(state, event);
}

/**
 * Deneme alımını TAAHHÜT eder (ilk gerçek hamlede): alım ancak şimdi
 * kamuya duyurulur (RULES.md 1.6 gizlilik) ve geri dönüş kapanır.
 */
function commitPickup(state: GameState): GameState {
  const p = state.pickup;
  if (!p || p.committed) return state;
  const logged = pushLog(state, {
    seat: state.currentSeat,
    type: 'pickupCommit',
    cardId: p.cardId,
  });
  return { ...logged, pickup: { ...p, committed: true } };
}

/** Deneme/sorgu gizliliği: bu hamleler açık kayda HİÇ yazılmaz. */
const PRIVATE_MOVES: ReadonlySet<Move['type']> = new Set(['pickupDiscard', 'cancelPickup']);
/** Sorgu hamleleri kendi log'unu (gerçek aktör koltuğuyla) kendisi yazar. */
const SORGU_MOVES: ReadonlySet<Move['type']> = new Set(['sor', 'sorguCevap', 'sorguSonuc']);

export function applyMove(state: GameState, move: Move): GameState {
  if (state.phase === 'handEnded' || state.phase === 'matchEnded') {
    throw new MoveError('phase', 'El bitti; hamle yapılamaz.');
  }
  // SORGU beklerken yalnız sorgu hamleleri oynanabilir (tur sayacı durur).
  if (state.sorgu) {
    if (state.sorgu.asama === 'cevap' && move.type !== 'sorguCevap') {
      throw new MoveError('sorguBekliyor', 'Sorgu cevabı bekleniyor.');
    }
    if (state.sorgu.asama === 'sonuc' && move.type !== 'sorguSonuc') {
      throw new MoveError('sorguBekliyor', 'Sorgu kararı bekleniyor.');
    }
  }
  // Taahhüt eden hamlelerde alım, hamlenin KENDİSİNDEN önce kamuya açılır.
  const COMMIT_MOVES: ReadonlySet<Move['type']> = new Set([
    'open',
    'openPairs',
    'meld',
    'extend',
    'retrieveJoker',
  ]);
  const committed = COMMIT_MOVES.has(move.type) ? commitPickup(state) : state;
  const logged =
    PRIVATE_MOVES.has(move.type) || SORGU_MOVES.has(move.type)
      ? committed
      : withLog(committed, committed.currentSeat, move);
  switch (move.type) {
    case 'drawStock':
      return applyDrawStock(logged);
    case 'pickupDiscard':
      return applyPickupDiscard(logged);
    case 'pickupLocked':
      return applyPickupLocked(logged);
    case 'cancelPickup':
      return applyCancelPickup(logged);
    case 'cancelOpen':
      return applyCancelOpen(logged);
    case 'sor':
      return applySor(logged);
    case 'sorguOrtakGorus':
      return applySorguOrtakGorus(logged, move.gorus);
    case 'sorguCevap':
      return applySorguCevap(logged, move.cevap);
    case 'sorguSonuc':
      return applySorguSonuc(logged, move.al);
    case 'open':
      return applyOpen(logged, move.melds);
    case 'openPairs':
      return applyOpenPairs(logged, move.pairs);
    case 'meld':
      return applyNewMeld(logged, move.cards);
    case 'extend':
      return applyExtend(logged, move.meldId, move.cardId);
    case 'retrieveJoker':
      return applyRetrieveJoker(logged, move.meldId, move.cardId);
    case 'discard':
      return applyDiscard(logged, move.cardId);
    case 'gostergeGoster':
      return applyGostergeGoster(logged, move.cardId);
    case 'gostergeAl':
      return applyGostergeAl(logged, move.cardId);
  }
}

function requirePhase(state: GameState, phase: GameState['phase'], msg: string): void {
  if (state.phase !== phase) throw new MoveError('phase', msg);
}

function applyDrawStock(state: GameState): GameState {
  requirePhase(state, 'draw', 'Şu an kart çekemezsin.');
  const stock = state.stock;
  const discard = state.discard;

  // RULES.md 1.7: deste bitti, kimse bitemedi → el biter (karma yok).
  if (stock.length === 0) {
    return endHand(state, null, false);
  }

  const card = stock[stock.length - 1]!;
  const player = currentPlayer(state);
  return {
    ...state,
    stock: stock.slice(0, -1),
    discard,
    phase: 'action',
    // OLAY LOGU YALNIZ EKSTREM olaylar içindir; normal çekme LOGLANMAZ.
    players: state.players.map((p) =>
      p.seat === player.seat ? { ...p, hand: [...p.hand, card] } : p,
    ),
    ...lockGosterge(state, player.seat), // çekti → gösterge hakkı kilitlenir
  };
}

/**
 * DENEME ALIMI (RULES.md 1.6): sol komşunun attığı kilitsiz kart denemeye
 * alınır — hiçbir şey taahhüt edilmez, rakipler GÖRMEZ (log'a yazılmaz).
 */
function applyPickupDiscard(state: GameState): GameState {
  requirePhase(state, 'draw', 'Şu an kart çekemezsin.');
  const player = currentPlayer(state);
  if (state.discard.length === 0) throw new MoveError('emptyDiscard', 'Açık yığın boş.');
  if (!canPickupDiscard(state, player.seat)) {
    // İŞLEK/OKEY atışı: rakip ceza yiyerek attı → o kart kilitli, kimse yerden alamaz.
    //   Sol-komşu kuralından ÖNCE kontrol; "soldan alınır" mesajı yanıltıcıydı.
    if (isDiscardAtisLocked(state)) {
      throw new MoveError(
        'atisLocked',
        'Rakip işlek/okey attı (ceza yedi) — bu kartı yerden alamazsın.',
      );
    }
    if (isDiscardLocked(state)) {
      throw new MoveError(
        'lockedDiscard',
        'Rakibin çift; attığı kartı almak için senin de çift olman gerekir.',
      );
    }
    throw new MoveError('pickupBlocked', 'Yerden yalnız solundakinin attığı kart alınır.');
  }

  const card = state.discard[state.discard.length - 1]!;
  return {
    ...state,
    discard: state.discard.slice(0, -1),
    phase: 'action',
    pickup: {
      cardId: card.id,
      wasOpened: player.hasOpened,
      committed: false,
      zorunlu: false,
      sorguUsed: false,
    },
    players: state.players.map((p) =>
      p.seat === player.seat ? { ...p, hand: [...p.hand, card] } : p,
    ),
  };
}

/**
 * KİLİTLİ ALIM (RULES.md 1.4): çiftin attığı kart — onay + alım ATOMİK,
 * deneme yok, geri bırakılamaz; alan ÇİFT olur (çiftse kalır).
 */
function applyPickupLocked(state: GameState): GameState {
  requirePhase(state, 'draw', 'Şu an kart çekemezsin.');
  const player = currentPlayer(state);
  if (state.discard.length === 0) throw new MoveError('emptyDiscard', 'Açık yığın boş.');
  if (!canPickupLocked(state, player.seat)) {
    throw new MoveError('lockedTake', 'Bu kart kilitli değil ya da alamazsın (açmış serici alamaz).');
  }

  const card = state.discard[state.discard.length - 1]!;
  const wasCift = player.isCift;
  return {
    ...state,
    discard: state.discard.slice(0, -1),
    phase: 'action',
    matchLog: addLog(state, `${nameOf(state, player.seat)} kilitli kartı aldı${wasCift ? '' : ' (çift oldu)'}`),
    players: state.players.map((p) =>
      p.seat === player.seat ? { ...p, hand: [...p.hand, card], isCift: true } : p,
    ),
  };
}

/** GERİ BIRAK (RULES.md 1.6): kart ıskartanın üstüne aynen döner, ceza yok. */
function applyCancelPickup(state: GameState): GameState {
  requirePhase(state, 'action', 'Geri bırakılacak deneme yok.');
  const p = state.pickup;
  if (!p) throw new MoveError('noPickup', 'Denemede kart yok.');
  if (p.committed) throw new MoveError('committed', 'Taahhütten sonra geri bırakılamaz.');
  if (p.zorunlu) throw new MoveError('zorunluAlim', 'Sorguda VER çıktı; kartı almak zorundasın.');

  const player = currentPlayer(state);
  const card = player.hand.find((c) => c.id === p.cardId)!;
  return {
    ...state,
    pickup: null,
    phase: 'draw',
    discard: [...state.discard, card],
    players: state.players.map((pl) =>
      pl.seat === player.seat ? { ...pl, hand: pl.hand.filter((c) => c.id !== card.id) } : pl,
    ),
  };
}

/** SOR (RULES.md 1.11): denemedeki kart için atana kağıt sorulur. */
function applySor(state: GameState): GameState {
  const player = currentPlayer(state);
  if (!canSor(state, player.seat)) {
    throw new MoveError('sorBlocked', 'Şu an sorgu açılamaz.');
  }
  const sorulanSeat = prevActiveSeat(state, player.seat);
  const cardId = state.pickup!.cardId;
  // SOR alımı kamuya açıklar (modal iki tarafta da görünür).
  const logged = pushLog(state, { seat: player.seat, type: 'sor', cardId });
  // EŞLİ: önce sorulanın ORTAĞI görüş bildirir; tekli: doğrudan sorulan cevaplar.
  const partnerSeat = (sorulanSeat + 2) % state.rules.playerCount;
  const sorgu = state.rules.teamMode
    ? { askerSeat: player.seat, sorulanSeat, cardId, asama: 'ortakGorus' as const, partnerSeat, partnerGorus: null }
    : { askerSeat: player.seat, sorulanSeat, cardId, asama: 'cevap' as const };
  return {
    ...logged,
    pickup: { ...state.pickup!, sorguUsed: true },
    sorgu,
    matchLog: addLog(state, `${nameOf(state, player.seat)}, ${nameOf(state, sorulanSeat)}'a kağıt sordu`),
  };
}

/** (Eşli) Ortağın görüşü kaydedilir → sorulan 'cevap' aşamasına geçer (görüşü görerek karar verir). */
function applySorguOrtakGorus(state: GameState, gorus: 'ver' | 'verme'): GameState {
  const sorgu = state.sorgu;
  if (!sorgu || sorgu.asama !== 'ortakGorus') {
    throw new MoveError('sorgu', 'Şu an ortak görüşü beklenmiyor.');
  }
  return { ...state, sorgu: { ...sorgu, asama: 'cevap', partnerGorus: gorus } };
}

/** Sorgu cevabı — VER: zorunlu alım; VERME: vermeyen ÇİFT olur, karar askere döner. */
function applySorguCevap(state: GameState, cevap: 'ver' | 'verme'): GameState {
  const sorgu = state.sorgu;
  if (!sorgu || sorgu.asama !== 'cevap') {
    throw new MoveError('noSorgu', 'Cevap bekleyen sorgu yok.');
  }
  const logged = pushLog(state, { seat: sorgu.sorulanSeat, type: 'sorguCevap' });

  if (cevap === 'ver') {
    // Kart askerde KALIR ve ALINMAK ZORUNDADIR (geri bırakma kapandı).
    return {
      ...logged,
      sorgu: null,
      pickup: state.pickup ? { ...state.pickup, zorunlu: true } : null,
      matchLog: addLog(state, `${nameOf(state, sorgu.sorulanSeat)} VERDİ`),
    };
  }
  // VERME: bitişi engellemenin bedeli — vermeyen ÇİFT olur (geri dönüşsüz).
  return {
    ...logged,
    sorgu: { ...sorgu, asama: 'sonuc' },
    matchLog: addLog(state, `${nameOf(state, sorgu.sorulanSeat)} vermedi çift oldu`),
    players: state.players.map((p) =>
      p.seat === sorgu.sorulanSeat ? { ...p, isCift: true } : p,
    ),
  };
}

/** VERME sonrası asker kararı: Yine de Al (asker DE çift olur) / Geri Bırak. */
function applySorguSonuc(state: GameState, al: boolean): GameState {
  const sorgu = state.sorgu;
  if (!sorgu || sorgu.asama !== 'sonuc') {
    throw new MoveError('noSorgu', 'Karar bekleyen sorgu yok.');
  }
  const asker = state.players[sorgu.askerSeat]!;
  const logged = pushLog(state, { seat: sorgu.askerSeat, type: 'sorguSonuc' });

  if (al) {
    // Çifte-çift: yine de alan asker de ÇİFT olur; alım kesinleşir (kamuya açık).
    const committed = pushLog(logged, {
      seat: sorgu.askerSeat,
      type: 'pickupCommit',
      cardId: sorgu.cardId,
    });
    return {
      ...committed,
      sorgu: null,
      pickup: null,
      matchLog: addLog(state, `${nameOf(state, sorgu.askerSeat)} yine de ALDI (çift oldu)`),
      players: state.players.map((p) =>
        p.seat === sorgu.askerSeat ? { ...p, isCift: true } : p,
      ),
    };
  }
  // Geri bırakan temiz çıkar; kart ıskartaya döner (atan artık çift → kart kilitli).
  const card = asker.hand.find((c) => c.id === sorgu.cardId)!;
  return {
    ...logged,
    sorgu: null,
    pickup: null,
    phase: 'draw',
    discard: [...state.discard, card],
    matchLog: addLog(state, `${nameOf(state, sorgu.askerSeat)} kağıdı geri bıraktı`),
    players: state.players.map((p) =>
      p.seat === sorgu.askerSeat ? { ...p, hand: p.hand.filter((c) => c.id !== card.id) } : p,
    ),
  };
}

/**
 * SORGU ZAMAN AŞIMI (RULES.md 1.11 — `SORGU_VARSAYILAN = "VER"`): süre dolunca
 * kararsız taraf otomatik VER sayılır (AFK ile bedava "verme" istismarı kapanır).
 * - ortakGorus → ortak 'ver' der (cevap aşamasına geçer)
 * - cevap → sorulan VERİR (kart askerde kalır, zorunlu alım)
 * - sonuc → asker GERİ BIRAKIR (al:false) — AFK askeri çifte zorlamak haksız olur.
 * Aktif sorgu yoksa state aynen döner (idempotent; güvenli).
 */
export function applySorguTimeout(state: GameState): GameState {
  const sorgu = state.sorgu;
  if (!sorgu) return state;
  if (sorgu.asama === 'ortakGorus') return applySorguOrtakGorus(state, 'ver');
  if (sorgu.asama === 'cevap') return applySorguCevap(state, 'ver');
  return applySorguSonuc(state, false);
}

/** Açış gruplarının ortak doğrulaması: kartlar elde, tekil ve atacak kart kalıyor. */
function collectOpeningGroups(
  player: PlayerState,
  groupIds: readonly (readonly CardId[])[],
): { groups: Card[][]; usedIds: Set<CardId> } {
  const groups = groupIds.map((ids) => cardsFromHand(player, ids));
  const usedIds = new Set<CardId>();
  for (const ids of groupIds) {
    for (const id of ids) {
      if (usedIds.has(id)) throw new MoveError('duplicateCard', 'Aynı kart iki grupta kullanılamaz.');
      usedIds.add(id);
    }
  }
  if (usedIds.size >= player.hand.length) {
    throw new MoveError('mustKeepDiscard', 'Atacak bir kart kalmalı.');
  }
  return { groups, usedIds };
}

function commitOpening(
  state: GameState,
  player: PlayerState,
  analyses: MeldAnalysis[],
  usedIds: Set<CardId>,
  openMode: 'melds' | 'pairs',
): GameState {
  const newMelds: Meld[] = analyses.map((a) => ({
    id: nextMeldId(),
    ownerSeat: player.seat,
    type: a.type,
    cards: a.cards,
  }));

  // BARAJ jetonları: AÇILIŞ ANINDAKİ puana/çift sayısına göre (sonraki
  // işlemeler asla değiştirmez); 81/101 eşik mantığından TAMAMEN bağımsız.
  // Kazanç anında toplam puana işlenir; yazboza jeton başına -100 satırı düşer.
  const openPoints = analyses.reduce((s, a) => s + a.points, 0);
  const tokens =
    openMode === 'pairs'
      ? pairBarajTokens(analyses.length, state.rules)
      : meldBarajTokens(openPoints, state.rules);
  const tokenPoints = tokens * state.rules.barajTokens.value;
  const barajRows: SheetEntry[] = Array.from({ length: tokens }, () => ({
    hand: state.handNumber,
    seat: player.seat,
    kind: 'baraj' as const,
    amount: state.rules.barajTokens.value,
  }));

  // KATLAMALI çıtaları güncelle (RULES.md 1.8) — seri ve çift AYRI yarışlar.
  // Çıta her modda izlenir; eşik yükseltmesi yalnız katlamalıda uygulanır.
  const enYuksekSeriAcisi =
    openMode === 'melds'
      ? Math.max(state.enYuksekSeriAcisi ?? 0, openPoints)
      : state.enYuksekSeriAcisi;
  const enYuksekCiftAcisi =
    openMode === 'pairs'
      ? Math.max(state.enYuksekCiftAcisi ?? 0, analyses.length)
      : state.enYuksekCiftAcisi;

  // AÇIŞ LOGU TEK OLSUN (kullanıcı kuralı): açış parça parça yapılabilir (open +
  // ek meld'ler). Ne açış anında ne de ara perlerde loglanır; açış KESİNLEŞİNCE
  // (ilk kart atışı, applyDiscard) toplam puanla TEK özet log düşer.
  return {
    ...state,
    // Açış ÖNCESİ state'i sakla → aynı turda (kart atılmadan) cancelOpen ile geri dönülür.
    openSnapshot: { ...state, openSnapshot: null },
    enYuksekSeriAcisi,
    enYuksekCiftAcisi,
    melds: [...state.melds, ...newMelds],
    sheet: [...state.sheet, ...barajRows],
    players: state.players.map((p) =>
      p.seat === player.seat
        ? {
            ...p,
            hand: removeFromHand(p.hand, usedIds),
            hasOpened: true,
            openMode,
            // Çiftle açmak çift statüsü verir (zaten çiftse korunur).
            isCift: p.isCift || openMode === 'pairs',
            openedOnTurn: state.turnCount,
            // Açış anındaki SABİT değer — sonraki perlemeler bunu DEĞİŞTİRMEZ.
            openingValue: openMode === 'melds' ? openPoints : (p.openingValue ?? 0),
            openingPairs: openMode === 'pairs' ? analyses.length : (p.openingPairs ?? 0),
            barajTokens: p.barajTokens + tokens,
            totalScore: p.totalScore + tokenPoints,
          }
        : p,
    ),
  };
}

function applyOpen(state: GameState, meldIds: readonly (readonly CardId[])[]): GameState {
  requirePhase(state, 'action', 'Açmak için önce kart çekmelisin.');
  const player = currentPlayer(state);
  if (player.hasOpened) throw new MoveError('alreadyOpen', 'Zaten açtın; yeni perde indirebilirsin.');
  // ÇİFT kilidi: çift olan oyuncu artık yalnız çiftle açabilir.
  if (player.isCift) {
    throw new MoveError('ciftLock', 'Çift oldun; artık yalnız çiftle açabilirsin.');
  }
  // YANDAN ALINAN KARTLA AÇIŞ → önce SORGU zorunlu (sorgu mümkünse). Sorgusuz "şak" açış YASAK.
  if (canSor(state, player.seat))
    throw new MoveError('sorguGerek', 'Yandan aldığın kartla açmadan önce SOR — rakibe sorgu yapmalısın.');

  const { groups, usedIds } = collectOpeningGroups(player, meldIds);
  const minPoints = openingThreshold(state);
  // PER PER (PARÇA) AÇIŞ — kullanıcı tasarımı: açış puan eşiği YALNIZ indirilen
  // perlerin toplamına DEĞİL, oyuncunun ELİNDEKİ açılabilir TOPLAM puana bağlıdır.
  // Örn elde 30+41+27=98, açar 84 → önce yalnız 30'luk peri açmak (parça) KABUL
  // (elde toplam 98 ≥ 84). İlk parça tek başına eşiğin altında olsa bile, kalan elde
  // açılabilir perlerle birlikte eşik karşılanıyorsa açılır.
  // Yapı doğrulaması (her grup geçerli per) eşik=0 ile yapılır; PUAN eşiği =
  //   (seçilen perlerin GERÇEK toplamı) + (kalan eldeki açılabilir en iyi toplam).
  // Seçilen perler her zaman TAM sayılır (solver kalan eli az çözse bile gerilemez).
  const analyses = canOpen(groups, state.rules, 0);
  if (!analyses) {
    throw new MoveError('openingPoints', 'Seçili kartlar geçerli per değil.');
  }
  const selectedPoints = analyses.reduce((s, a) => s + a.points, 0);
  const usedSet = new Set(usedIds);
  const remaining = player.hand.filter((card) => !usedSet.has(card.id));
  const remainingBest = solveHand(remaining, state.rules, 'points').totalPoints;
  const handOpenable = selectedPoints + remainingBest;
  if (handOpenable < minPoints) {
    throw new MoveError('openingPoints', `Açış için en az ${minPoints} puan gerekli.`);
  }
  return commitOpening(state, player, analyses, usedIds, 'melds');
}

function applyOpenPairs(state: GameState, pairIds: readonly (readonly CardId[])[]): GameState {
  requirePhase(state, 'action', 'Açmak için önce kart çekmelisin.');
  const player = currentPlayer(state);
  if (player.hasOpened) throw new MoveError('alreadyOpen', 'Zaten açtın.');
  // YANDAN ALINAN KARTLA ÇİFT AÇIŞ → önce SORGU zorunlu (sorgu mümkünse). Sorgusuz açış YASAK.
  if (canSor(state, player.seat))
    throw new MoveError('sorguGerek', 'Yandan aldığın kartla açmadan önce SOR — rakibe sorgu yapmalısın.');

  const { groups, usedIds } = collectOpeningGroups(player, pairIds);
  const minPairs = pairsOpeningMin(state);
  // PARÇA AÇIŞ (seri applyOpen ile birebir): yapı eşiksiz doğrulanır (minPairs=0 → her grup geçerli
  //   çift mi); eşik SEÇİLİ-toplam yerine ELDE-toplam: seçili çift + eldeki KALAN ulaşılabilir çift
  //   (okey dahil) >= minPairs. 2+2+2 (3) seçip elde 5 potansiyel varsa açar; kalan sonra ayrı açılır.
  const analyses = canOpenPairs(groups, state.rules, 0);
  if (!analyses) {
    throw new MoveError('pairsToOpen', 'Seçili kartlar geçerli çift değil.');
  }
  const selectedPairs = analyses.length;
  const usedSet = new Set(usedIds);
  const remaining = player.hand.filter((c: any) => !usedSet.has(c.id));
  const remainingReachable = bestPairOpening(remaining, state.rules).count;
  if (selectedPairs + remainingReachable < minPairs) {
    throw new MoveError('pairsToOpen', `Çiftle açmak için en az ${minPairs} çift gerekli.`);
  }
  return commitOpening(state, player, analyses, usedIds, 'pairs');
}

/**
 * AÇIŞI GERİ AL: bu turda yapılan açışı (kart atılmadan) tümüyle iptal eder.
 * Açış-öncesi snapshot'a dönerek el, melds, baraj, çıta ve puanı eski haline getirir.
 * Yalnız açan oyuncunun AYNI turunda geçerli (kart atılınca turn ilerler, geri alınamaz).
 */
function applyCancelOpen(state: GameState): GameState {
  requirePhase(state, 'action', 'Açışı geri almak için tur sürüyor olmalı.');
  const player = currentPlayer(state);
  if (!player.hasOpened || player.openedOnTurn !== state.turnCount || !state.openSnapshot) {
    throw new MoveError('cannotCancelOpen', 'Geri alınacak bir açış yok.');
  }
  return state.openSnapshot;
}

function applyNewMeld(state: GameState, cardIds: readonly CardId[]): GameState {
  requirePhase(state, 'action', 'Önce kart çekmelisin.');
  const player = currentPlayer(state);
  if (!player.hasOpened) throw new MoveError('notOpen', 'Önce açış yapmalısın.');

  const cards = cardsFromHand(player, cardIds);
  if (cards.length >= player.hand.length) {
    throw new MoveError('mustKeepDiscard', 'Atacak bir kart kalmalı.');
  }
  // Açış modu kilidi: çift açan yalnızca çift, per açan yalnızca per indirir.
  const analysis =
    player.openMode === 'pairs'
      ? analyzePair(cards, state.rules)
      : analyzeCards(cards, state.rules);
  if (!analysis) {
    throw new MoveError(
      'invalidMeld',
      player.openMode === 'pairs' ? 'Geçerli bir çift değil.' : 'Geçerli bir perde değil.',
    );
  }

  const meld: Meld = {
    id: nextMeldId(),
    ownerSeat: player.seat,
    type: analysis.type,
    cards: analysis.cards,
  };
  const used = new Set(cardIds);
  // PARÇA AÇIŞ: oyuncu AÇIŞ TURUNDA parça parça indirdiği her ek per/küt, masada
  // gösterilen açış puanına (openingValue) EKLENİR — rozet ilk perin değil aynı
  // turda inen TÜM açış perlerinin toplamını gösterir (40 → 81 → 127 ...).
  // ÖNEMLİ: openingValue YALNIZ açılış turunda birikir. Açılış kesinleştikten
  // SONRAKİ turlarda inen yeni perler rozete EKLENMEZ (rozet ilk açtığı puandır,
  // sonradan büyümez). Çift modunda per puanı sayılmaz; openingPairs ayrıca
  // takip edilir (yeni çift indirilince +1).
  const isPairMode = player.openMode === 'pairs';
  // AÇIŞ LOGU TEK OLSUN: AÇIŞ TURUNDA indirilen ek perler açışın PARÇASIDIR → ayrı
  // loglanmaz (özet log ilk atışta düşer). Açıştan SONRAKİ turlarda indirilen yeni
  // perde gerçek bir olaydır → "yeni perde indirdi" loglanır.
  const isOpeningTurn = player.openedOnTurn === state.turnCount;
  return {
    ...state,
    melds: [...state.melds, meld],
    matchLog: isOpeningTurn
      ? (state.matchLog ?? [])
      : addLog(state, `${nameOf(state, player.seat)} yeni perde indirdi`),
    players: state.players.map((p) =>
      p.seat === player.seat
        ? {
            ...p,
            hand: removeFromHand(p.hand, used),
            openingValue: isPairMode || !isOpeningTurn ? (p.openingValue ?? 0) : (p.openingValue ?? 0) + analysis.points,
            openingPairs: isPairMode ? (p.openingPairs ?? 0) + 1 : (p.openingPairs ?? 0),
          }
        : p,
    ),
  };
}

function applyExtend(state: GameState, meldId: string, cardId: CardId): GameState {
  requirePhase(state, 'action', 'Önce kart çekmelisin.');
  const player = currentPlayer(state);
  if (!player.hasOpened) throw new MoveError('notOpen', 'Perde işlemek için önce açış yapmalısın.');
  // RULES.md 1.4 (C3): açmış çiftçi tur başına YALNIZ 1 işlek yapabilir.
  const isCiftci = player.openMode === 'pairs';
  if (isCiftci && state.ciftIslekUsed) {
    throw new MoveError('ciftIslek', 'Çiftçi tur başına yalnız bir işlek yapabilir.');
  }
  if (player.hand.length <= 1) throw new MoveError('mustKeepDiscard', 'Atacak bir kart kalmalı.');

  const meld = findMeld(state, meldId);
  const card = cardsFromHand(player, [cardId])[0]!;
  const analysis = canExtend(meld, card, state.rules);
  if (!analysis) throw new MoveError('invalidExtend', 'Bu kart bu perdeye uymuyor.');

  const used = new Set([cardId]);
  return {
    ...state,
    ciftIslekUsed: state.ciftIslekUsed || isCiftci,
    melds: state.melds.map((m) => (m.id === meldId ? { ...m, cards: analysis.cards } : m)),
    matchLog: addLog(state, `${nameOf(state, player.seat)} perdeye kart işledi`),
    players: state.players.map((p) =>
      p.seat === player.seat ? { ...p, hand: removeFromHand(p.hand, used) } : p,
    ),
  };
}

function applyRetrieveJoker(state: GameState, meldId: string, cardId: CardId): GameState {
  requirePhase(state, 'action', 'Önce kart çekmelisin.');
  const player = currentPlayer(state);
  if (!player.hasOpened) throw new MoveError('notOpen', 'Joker almak için önce açış yapmalısın.');
  // RULES.md 1.4 (C3): çiftçide okey takası da o turun TEK işleğidir.
  const isCiftci = player.openMode === 'pairs';
  if (isCiftci && state.ciftIslekUsed) {
    throw new MoveError('ciftIslek', 'Çiftçi tur başına yalnız bir işlek yapabilir.');
  }

  const meld = findMeld(state, meldId);
  const replacement = cardsFromHand(player, [cardId])[0]!;
  const jokerId = canRetrieveJoker(meld, replacement, state.rules);
  if (!jokerId) throw new MoveError('invalidRetrieve', 'Bu kart jokerin yerini tutmuyor.');

  const joker = meld.cards.find((c) => c.id === jokerId)!;
  const newCards = meld.cards.map((c) => (c.id === jokerId ? replacement : c));
  const used = new Set([cardId]);

  return {
    ...state,
    ciftIslekUsed: state.ciftIslekUsed || isCiftci,
    melds: state.melds.map((m) => (m.id === meldId ? { ...m, cards: newCards } : m)),
    matchLog: addLog(state, `${nameOf(state, player.seat)} OKEY'i perdeden kurtardı`),
    players: state.players.map((p) =>
      p.seat === player.seat ? { ...p, hand: [...removeFromHand(p.hand, used), joker] } : p,
    ),
  };
}

function applyDiscard(state: GameState, cardId: CardId): GameState {
  requirePhase(state, 'action', 'Önce kart çekmelisin.');
  let player = currentPlayer(state);

  // DENEME ALIMI taahhüt anı (RULES.md 1.6 + 1.4A).
  if (state.pickup) {
    const pk = state.pickup;
    if (cardId === pk.cardId) {
      // ZORUNLU alım kartı geri atılamaz — TEK İSTİSNA: o kart eldeki SON kartsa
      // (atılacak başka kart yok), aksi halde tur kilitlenir. Bu durumda atış = bitiş.
      if (pk.zorunlu && player.hand.length > 1) {
        throw new MoveError('zorunluAlim', 'Sorguda VER çıktı; kartı almak zorundasın.');
      }
      if (!pk.committed) {
        // Alınan kartı "atmak" = geri bırakmak; o iş GERİ BIRAK'ın.
        throw new MoveError('pickupSame', 'Aldığın kartı geri atamazsın — GERİ BIRAK kullan.');
      }
      // Taahhütten (açıştan) sonra düz atış sayılır — alım zaten kamuya açık.
    }
    if (pk.wasOpened && player.hand.some((c) => c.id === pk.cardId)) {
      // Açık oyuncu kartı kullanmadan devam edemez (çift yolu ona kapalı).
      throw new MoveError(
        'pickupUnused',
        'Aldığın kartı kullanmadan devam edemezsin — işle ya da GERİ BIRAK.',
      );
    }
    state = commitPickup(state);
    // OLAY LOGU YALNIZ EKSTREM: normal "yerden kart aldı" LOGLANMAZ.
    if (!pk.wasOpened && !player.hasOpened) {
      // Açmadan devam = ÇİFT (geri dönüşsüz; masadaki açar 101'e çıkar).
      state = {
        ...state,
        matchLog: addLog(state, `${nameOf(state, state.currentSeat)} aldı çift oldu`),
        players: state.players.map((p) =>
          p.seat === state.currentSeat ? { ...p, isCift: true } : p,
        ),
      };
    }
    state = { ...state, pickup: null };
    player = currentPlayer(state);
  }

  // AÇIŞ LOGU TEK OLSUN (kullanıcı kuralı): bu turda AÇTIYSA, açış KART ATIŞIYLA
  // kesinleşir — burada TOPLAM açış puanı/çift adediyle TEK özet log düşer
  // (ara perler loglanmadı). Çift modda adet, seri modda toplam puan.
  if (player.openedOnTurn === state.turnCount && player.hasOpened) {
    const acanAd = nameOf(state, player.seat);
    const acisMsg =
      player.openMode === 'pairs'
        ? `${acanAd} ${player.openingPairs ?? 0} çift açtı`
        : `${acanAd} ${player.openingValue ?? 0} puanlık seri açtı`;
    state = { ...state, matchLog: addLog(state, acisMsg) };
  }

  const card = cardsFromHand(player, [cardId])[0]!;
  const newHand0 = player.hand.filter((c) => c.id !== cardId);
  const isFinishThrow = newHand0.length === 0;

  // İŞLEK-ÇİFT MUAFİYETİ (RULES.md 1.7 — kullanıcı kanunu): atılan kart İŞLEKSE ve
  // oyuncunun elinde o karttan 2 ADET (özdeş çift) varsa (yani atıştan SONRA elde hâlâ
  // aynı kart kalıyorsa), CEZA YEMEZ. ("çift olması/olmaması" ile ALAKASIZ.)
  const islekCiftMuaf =
    !card.joker &&
    newHand0.some((c) => c.rank === card.rank && c.suit === card.suit);

  // CEZALAR (RULES.md 1.7): BİTİŞ atışı tek değerlendirilir — bitişte işlek/okey
  // ıskarta cezası YAZILMAZ (çift ceza yok). Okey ıskartaya atılırsa 100, işlek 50.
  const islekHit =
    !isFinishThrow &&
    state.rules.islek.penaltyEnabled &&
    !card.joker &&
    !islekCiftMuaf &&
    isIslekCard(card, state.melds, state.rules);
  const okeyHit = !isFinishThrow && state.rules.islek.penaltyEnabled && card.joker;
  const islekPenalty = okeyHit
    ? state.rules.islek.okeyPenaltyPoints
    : islekHit
      ? state.rules.islek.penaltyPoints
      : 0;
  // İşlek bayrağı SON ATIŞ olayına işlenir (pickupCommit araya girebilir).
  const lastDiscardIdx = (() => {
    for (let i = state.log.length - 1; i >= 0; i--) {
      if (state.log[i]!.type === 'discard') return i;
    }
    return -1;
  })();
  // ATILAN KART KİLİTLİ Mİ: işlek (cezalı VEYA çift-muaf) ya da okey ıskarta → rakip
  // ALAMAZ/SORAMAZ (RULES.md işlek/okey atış kuralı). Bitiş atışı kilitlemez.
  const atisKilit =
    !isFinishThrow &&
    (okeyHit || islekHit || (islekCiftMuaf && isIslekCard(card, state.melds, state.rules)));
  const log = atisKilit
    ? state.log.map((e, i) => (i === lastDiscardIdx ? { ...e, islek: true } : e))
    : state.log;
  const sheet =
    islekPenalty > 0
      ? [
          ...state.sheet,
          {
            hand: state.handNumber,
            seat: player.seat,
            kind: 'islek' as const,
            amount: islekPenalty,
          },
        ]
      : state.sheet;

  const newHand = newHand0;
  // OLAY LOGU YALNIZ EKSTREM (RULES.md): okey ıskarta cezası, işlek cezası, işlek-çift
  // muafiyeti. NORMAL çek/at LOGLANMAZ. Bitiş mesajı endHand'de tek değerlendirilir.
  const atanAd = nameOf(state, player.seat);
  const atisLog =
    newHand.length === 0
      ? null
      : okeyHit
        ? `${atanAd} okeyi ıskartaya attı, ceza yedi`
        : islekHit
          ? `${atanAd} işlek attı, ceza yedi`
          : islekCiftMuaf && isIslekCard(card, state.melds, state.rules)
            ? `${atanAd} işlek attı ancak çifti onda olduğu için ceza yemedi`
            : null;
  const next: GameState = {
    ...state,
    log,
    sheet,
    discard: [...state.discard, card],
    matchLog: atisLog ? addLog(state, atisLog) : (state.matchLog ?? []),
    players: state.players.map((p) =>
      p.seat === player.seat
        ? { ...p, hand: newHand, totalScore: p.totalScore + islekPenalty }
        : p,
    ),
  };

  if (newHand.length === 0) {
    // Elden bitme: açışı bu turda yaptıysa hiç "açık oturmamış" demektir.
    const handFinish = player.openedOnTurn === state.turnCount;
    // Okey atma: son atılan kart joker.
    const okeyFinish = card.joker;
    return endHand(next, player.seat, handFinish, okeyFinish);
  }
  // DESTE TÜKENMESİ: el, son kart çekilip SON ISKARTA atılınca biter (çekme anında DEĞİL).
  // Kimse elden bitemedi → kazanan yok, puanlar sayılır.
  if (next.stock.length === 0) {
    return endHand(next, null, false);
  }
  return advanceTurn(next);
}

/* ------------------------------------------------------------------ */
/* GÖSTERGE (kullanıcı kuralı)                                          */
/* ------------------------------------------------------------------ */

/** Oyuncu ŞU AN çekme öncesi (ilk turunda) mı — gösterge göster/al buna bağlı. */
function gostergeDrawWindow(state: GameState, seat: number): boolean {
  if (state.phase === 'draw') return true;
  // Dağıtıcı çekmez ('action' ile başlar); ilk hamlesini yapmadıysa pencere açık.
  return seat === state.dealerSeat && state.phase === 'action' && state.turnCount === 1;
}

/** GÖSTERGE GÖSTER: ilk el, çekmeden, göstergenin eşini göstererek hak kazan. */
function applyGostergeGoster(state: GameState, cardId: CardId): GameState {
  const g = state.gostergeKart;
  if (!g || state.gostergeTaken)
    throw new MoveError('gosterge', 'Gösterge yok.');
  const seat = state.currentSeat;
  if (!gostergeDrawWindow(state, seat))
    throw new MoveError('gosterge', 'Gösterge yalnız ilk turda, kart çekmeden gösterilir.');
  if ((state.gostergeLocked ?? []).includes(seat))
    throw new MoveError('gosterge', 'Hakkın kilitli (kart çektin/yerden aldın).');
  if ((state.gostergeShown ?? []).includes(seat))
    throw new MoveError('gosterge', 'Göstergeyi zaten gösterdin.');
  const player = state.players[seat]!;
  const es = player.hand.find((c) => c.rank === g.rank && c.suit === g.suit);
  if (!es || es.id !== cardId)
    throw new MoveError('gosterge', 'Göstergenin eşi elinde değil.');
  return {
    ...state,
    gostergeShown: [...(state.gostergeShown ?? []), seat],
    matchLog: addLog(state, `${nameOf(state, seat)} göstergeyi gösterdi`),
  };
}

/** GÖSTERGE AL: hak kazanmış + 4+ çift; elden bir kart verip göstergeyi al, DİREKT ÇİFT ol. */
function applyGostergeAl(state: GameState, cardId: CardId): GameState {
  const g = state.gostergeKart;
  if (!g || state.gostergeTaken)
    throw new MoveError('gosterge', 'Gösterge yok.');
  const seat = state.currentSeat;
  if (!(state.gostergeShown ?? []).includes(seat))
    throw new MoveError('gosterge', 'Önce göstergeyi göstermeliydin.');
  // Alma = YER DEĞİŞTİRME (kart ver, gösterge al; net 0). Çekmeden de çektikten sonra da
  // yapılabilir — faz şartı YOK (15-1+1=15, fazlalık eklemez).
  const player = state.players[seat]!;
  // ÇİFT sayısı UI'daki "Puan-çift" (myPairCount) ile AYNI hesap — OKEY (joker) dahil.
  if (analyzeHand(player.hand, state.rules).pairCount < 4)
    throw new MoveError('gosterge', 'Göstergeyi almak için en az 4 çiftin olmalı.');
  const verilen = player.hand.find((c) => c.id === cardId);
  if (!verilen) throw new MoveError('notInHand', 'Kart elde değil.');
  // Gösterge ele gelir; verilen kart destenin dibine (stock[0]) gider VE artık gösterge
  // pozisyonunda AÇIK görünür (yeni deste dibi). Alan DİREKT ÇİFT olur. Tekrar alınamaz (taken).
  const newHand = [...player.hand.filter((c) => c.id !== cardId), g];
  const newStock = [verilen, ...state.stock.slice(1)];
  return {
    ...state,
    stock: newStock,
    gostergeKart: verilen, // verilen kart gösterge yerinde açık kalır (görünür)
    gostergeTaken: true,
    matchLog: addLog(state, `${nameOf(state, seat)} göstergeyi aldı (çift oldu)`),
    // phase DEĞİŞMEZ: alma çekme/atış değil, sadece yer değiştirme — oyuncu çekme/atışını ayrıca yapar.
    players: state.players.map((p) =>
      p.seat === seat ? { ...p, hand: newHand, isCift: true } : p,
    ),
  };
}

/** Kart çeken / yerden alan koltuğun gösterge hakkını kilitler (artık gösteremez). */
function lockGosterge(state: GameState, seat: number): Partial<GameState> {
  if (state.gostergeTaken) return {};
  if ((state.gostergeLocked ?? []).includes(seat)) return {};
  return { gostergeLocked: [...(state.gostergeLocked ?? []), seat] };
}

function advanceTurn(state: GameState): GameState {
  const seat = (state.currentSeat + 1) % state.rules.playerCount;
  return {
    ...state,
    currentSeat: seat,
    phase: 'draw',
    pickup: null,
    sorgu: null,
    ciftIslekUsed: false, // çiftçinin işlek hakkı her tur yenilenir
    turnCount: state.turnCount + 1,
    openSnapshot: null, // açış geri-alma penceresi tur ilerleyince kapanır
  };
}

function endHand(
  state: GameState,
  winnerSeat: number | null,
  handFinish: boolean,
  okeyFinish = false,
): GameState {
  const result = computeHandResult(state, winnerSeat, handFinish, okeyFinish);
  const players = applyHandResult(state, result);
  // Ceza satırları yazboza itemize düşer (bitiren ASLA ceza satırı almaz).
  const penaltyRows: SheetEntry[] = result.breakdown
    .filter((b) => b.amount !== 0)
    .map((b) => ({
      hand: state.handNumber,
      seat: b.seat,
      kind: 'penalty' as const,
      amount: b.amount,
      breakdown: b,
    }));
  // Bitiş logu (dinamik: çift/okey çarpanı).
  let bitisMsg: string;
  if (winnerSeat == null) {
    bitisMsg = 'El bitti — kimse bitiremedi (deste tükendi)';
  } else {
    const ad = nameOf(state, winnerSeat);
    const cift = state.players[winnerSeat]?.isCift === true;
    if (okeyFinish && cift) bitisMsg = `${ad} çifte OKEY ile bitti! (rakiplere 4x ceza)`;
    else if (okeyFinish) bitisMsg = `${ad} OKEY ile bitti! (rakiplere 2x ceza)`;
    else if (cift) bitisMsg = `${ad} çifte bitiş yaptı! (rakiplere 2x ceza)`;
    else bitisMsg = `${ad} bitiş yaptı`;
  }
  let next: GameState = {
    ...state,
    players,
    sheet: [...state.sheet, ...penaltyRows],
    phase: 'handEnded',
    lastHandResult: result,
    matchLog: addLog(state, bitisMsg),
  };
  if (state.handNumber >= state.rules.totalHands) {
    const sampiyon = next.players.reduce((b, p) => (p.totalScore < b.totalScore ? p : b), next.players[0]!);
    next = { ...finishMatch(next), lastHandResult: result,
      matchLog: addLog(next, `OYUN BİTTİ — kazanan: ${sampiyon.name} (${sampiyon.totalScore} puan)`) };
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Oyuncu görünümü (sansürlü durum)                                    */
/* ------------------------------------------------------------------ */

export function viewFor(state: GameState, seat: number): PlayerView {
  const me = state.players[seat]!;
  return {
    seat,
    rules: state.rules,
    handNumber: state.handNumber,
    phase: state.phase,
    currentSeat: state.currentSeat,
    hand: me.hand.slice(),
    hasOpened: me.hasOpened,
    openMode: me.openMode,
    isCift: me.isCift,
    ciftIslekUsed: state.ciftIslekUsed,
    currentOpeningMin: openingThreshold(state),
    currentPairsMin: pairsOpeningMin(state),
    // AÇIŞ GİZLİLİĞİ: açan oyuncu kart atana kadar (openSnapshot var) perleri SADECE kendisi görür
    // (geri toplayabilir; kesinleşmemiş açış rakibe sızmaz).
    melds: state.melds
      .filter((m) => !(state.openSnapshot && state.currentSeat !== seat && m.ownerSeat === state.currentSeat))
      .map((m) => ({ ...m, cards: m.cards.slice() })),
    discardTop: state.discard[state.discard.length - 1] ?? null,
    discardCount: state.discard.length,
    stockCount: state.stock.length,
    // GİZLİLİK: deneme alımı yalnız alan oyuncunun view'ında görünür.
    pickup: state.currentSeat === seat ? state.pickup : null,
    sorgu:
      state.sorgu &&
      (state.sorgu.askerSeat === seat ||
        state.sorgu.sorulanSeat === seat ||
        state.sorgu.partnerSeat === seat) // ortak da görür (görüş verecek)
        ? { ...state.sorgu }
        : null,
    discardLocked: isDiscardLocked(state),
    canPickupTop: canPickupDiscard(state, seat),
    canPickupLockedTop: canPickupLocked(state, seat),
    // ÇİFTÇİ ayrıcalığı: yerdeki atıkları görür (kim attığı bilgisi YOK).
    discardPileForCift: me.isCift ? state.discard.slice() : null,
    recentEvents: state.log.slice(-16),
    matchLog: (state.matchLog ?? []).slice(),
    // GÖSTERGE (HER EL, herkese açık deste dibi kartı). Alındıktan sonra da görünür kalır
    // (yerine konan kart açık durur); alınamaz olması canTake/canShow ile kontrol edilir.
    gostergeKart: state.gostergeKart ?? null,
    gostergeShown: (state.gostergeShown ?? []).includes(seat),
    gostergeCanShow:
      !!state.gostergeKart &&
      !state.gostergeTaken &&
      state.currentSeat === seat &&
      gostergeDrawWindow(state, seat) &&
      !(state.gostergeLocked ?? []).includes(seat) &&
      !(state.gostergeShown ?? []).includes(seat) &&
      me.hand.some((c) => c.rank === state.gostergeKart!.rank && c.suit === state.gostergeKart!.suit),
    gostergeCanTake:
      !!state.gostergeKart &&
      !state.gostergeTaken &&
      state.currentSeat === seat &&
      (state.gostergeShown ?? []).includes(seat) && // gösterdiyse + 4 çiftle her faz (yer değiştirme)
      analyzeHand(me.hand, state.rules).pairCount >= 4,
    players: state.players.map((p) => ({
      seat: p.seat,
      name: p.name,
      isBot: p.isBot,
      handCount: p.hand.length,
      hasOpened: p.hasOpened,
      openMode: p.openMode,
      isCift: p.isCift,
      totalScore: p.totalScore,
      barajTokens: p.barajTokens,
      openingValue: p.openingValue ?? 0,
      openingPairs: p.openingPairs ?? 0,
    })),
  };
}
