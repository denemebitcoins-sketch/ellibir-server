/**
 * TS PlayerView → C# ClientView DTO formatına dönüştürür (ClientViewBuilder ile PARITY).
 * C# JsonUtility'nin beklediği alan adları (myHand, seats, vb.) kullanılır.
 */
import { viewFor, isIslekCard, canSor, canCancelOpen, legalExtendTargets, canRetrieveJoker } from '../../packages/engine/src/game';
import { analyzeHand } from '../../packages/engine/src/insight';
import { meldPoints, analyzeCards, analyzePair } from '../../packages/engine/src/melds';
import type { GameState } from '../../packages/engine/src/game';

/* ── Per-koltuk el dizilim sırası (handOrder) — C# HandOrder/ReconcileOrder portu ──
   Motor kuralını DEĞİŞTİRMEZ; yalnız el'in GÖRSEL sırasını izler. Çekilen kart sona,
   seri/çift diz gruplu sıra korunur. */

/** Bir koltuğun handOrder'ını mevcut ele göre reconcile et: mevcut sıradaki kart-id'ler
 *  korunur (elde olmayanlar düşer), elde olup sırada olmayan YENİ kartlar SONA eklenir.
 *  (C# ReconcileOrder.) Yan etki: state.handOrder[seat]'i günceller ve döndürür. */
export function reconcileHandOrder(state: any, seat: number): string[] {
  if (!state) return [];
  const player = (state.players ?? []).find((p: any) => p.seat === seat);
  const hand: any[] = Array.isArray(player?.hand) ? player.hand : [];
  state.handOrder = state.handOrder || {};
  const prev: string[] = Array.isArray(state.handOrder[seat]) ? state.handOrder[seat] : [];
  const ids = new Set(hand.map((c: any) => c.id));
  const kept = prev.filter((id) => ids.has(id));
  const known = new Set(kept);
  for (const c of hand) if (!known.has(c.id)) kept.push(c.id);
  state.handOrder[seat] = kept;
  return kept;
}

/** Bir koltuğun handOrder'ını temizle (el sonu / yeni el). */
export function clearHandOrder(state: any, seat?: number): void {
  if (!state) return;
  if (seat == null) { state.handOrder = {}; return; }
  if (state.handOrder) delete state.handOrder[seat];
}

/** handOrder sırasına göre o koltuğun el kartlarını (Card nesneleri) döndür. */
function orderedHandFor(state: any, seat: number): any[] {
  const player = (state.players ?? []).find((p: any) => p.seat === seat);
  const hand: any[] = Array.isArray(player?.hand) ? player.hand : [];
  const order = reconcileHandOrder(state, seat);
  const byId = new Map(hand.map((c: any) => [c.id, c]));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

export interface ArrangedResult {
  meldPoints: number;
  pairCount: number;
  /** orderedHand ile aynı uzunlukta: 0=serbest, 1=seri/per, 2=çift. */
  blockKinds: number[];
}

/** C# ArrangedBlocks portu: handOrder sırasındaki ARDIŞIK geçerli seri/per (≥3) ve
 *  çift (=2) bloklarını bul. Önce en uzun per, sonra çift. */
export function computeArrangedBlocks(orderedHand: any[], rules: any, dizMode: string = 'none'): ArrangedResult {
  const res: ArrangedResult = { meldPoints: 0, pairCount: 0, blockKinds: orderedHand.map(() => 0) };
  const ciftMode = dizMode === 'cift';
  let i = 0;
  while (i < orderedHand.length) {
    // ÇİFT DİZDE per/seri (≥3) bloğu ARANMAZ (jokerleri sahte küt'e yutup okey sayımını
    // bozuyordu); yalnız gerçek çiftler + okey katkısı. C# ArrangedBlocks birebir.
    let bestLen = 0;
    if (!ciftMode)
      for (let len = 3; i + len <= orderedHand.length; len++) {
        try { if (analyzeCards(orderedHand.slice(i, i + len), rules) != null) bestLen = len; else break; }
        catch { break; }
      }
    if (bestLen >= 3) {
      try { res.meldPoints += meldPoints(orderedHand.slice(i, i + bestLen), rules) ?? 0; } catch { /* karışık */ }
      for (let j = 0; j < bestLen; j++) res.blockKinds[i + j] = 1;
      i += bestLen;
      continue;
    }
    if (i + 2 <= orderedHand.length && !orderedHand[i].joker && !orderedHand[i + 1].joker) {
      // OKEY içeren çift GÖRSEL blok YAPILMAZ (okey boşta dursun); yalnız İKİ GERÇEK kart.
      let isPair = false;
      try { isPair = analyzePair(orderedHand.slice(i, i + 2), rules) != null; } catch { isPair = false; }
      if (isPair) {
        res.pairCount += 1;
        res.blockKinds[i] = 2; res.blockKinds[i + 1] = 2;
        i += 2;
        continue;
      }
    }
    i++;
  }
  // OKEY ÇİFT SAYIMI (görsel eşleme YOK): çift dizde her okey, eşlenebilecek bir çift-dışı/
  // per-dışı gerçek kartı temsil eder → pairCount'a eklenir (okey görsel boşta, blockKind=0).
  // Sayım = gerçek çiftler + min(okey, serbest gerçek kart). MaxJokersPerPair=1, okey-okey YOK.
  if (dizMode === 'cift' && rules?.pairs?.enabled && (rules.pairs.maxJokersPerPair ?? 0) > 0) {
    let jokerCount = 0, freeReals = 0;
    for (let k = 0; k < orderedHand.length; k++) {
      if (res.blockKinds[k] !== 0) continue;
      if (orderedHand[k].joker) jokerCount++; else freeReals++;
    }
    res.pairCount += Math.min(jokerCount, freeReals);
  }
  return res;
}

export function clientViewFor(state: GameState, seat: number): Record<string, unknown> {
  if (!state || !Array.isArray(state.players)) return emptyView(seat);

  const validSeat = typeof seat === 'number' && seat >= 0 && seat < state.players.length;
  if (!validSeat) return emptyView(seat);

  let v: any;
  try { v = viewFor(state, seat); }
  catch (e) { console.error('[clientView] viewFor error:', e); return emptyView(seat); }

  const rules = (state as any).rules;
  const me = state.players.find((p: any) => p.seat === seat) ?? {};

  // Oyun içi olay logu: motorun ürettiği MAÇ LOGU (dinamik puan/çift/çarpan, maç boyu birikir).
  const logMessages = Array.isArray(v.matchLog) ? v.matchLog.slice() : [];

  const mapCard = (c: any) => c == null ? null : {
    id:    c.id    ?? '',
    label: c.label ?? '',
    red:   c.suit === 'H' || c.suit === 'D',
    joker: c.joker ?? false,
    suit:  c.suit  ?? '',
    rank:  c.rank  ?? 0,
    islek: false,
  };

  const mapMeld = (m: any) => {
    const cards = Array.isArray(m.cards) ? m.cards : [];
    let pts = 0;
    try { pts = meldPoints(cards, rules) ?? 0; } catch { /* karışık grup */ }
    return {
      id:        m.id        ?? '',
      ownerSeat: m.ownerSeat ?? m.owner_seat ?? 0,
      type:      m.type      ?? 'run',
      cards:     cards.map(mapCard),
      points:    pts,
    };
  };

  const abandonedArr: number[] = Array.isArray((state as any).abandoned) ? (state as any).abandoned : [];
  const mapSeat = (p: any) => {
    // Rozet: AÇIŞ anındaki SABİT değer (perlemeyle artmaz). El kaçla açıldıysa o gösterilir.
    const omp = p.openingValue ?? 0;
    const opc = p.openingPairs ?? 0;
    return {
      seat:           p.seat          ?? 0,
      // Terk edilen koltuk BOT kimliği alır: isim "Bot (eskiAd)", isBot=true (UI bot gibi gösterir).
      name:           abandonedArr.includes(p.seat ?? -1) ? ('Bot (' + (p.name || '?') + ')') : (p.name ?? ''),
      isBot:          (p.isBot ?? false) || abandonedArr.includes(p.seat ?? -1),
      abandoned:      abandonedArr.includes(p.seat ?? -1), // oyuncu düştü → bot devraldı
      handCount:      p.handCount     ?? 0,
      hasOpened:      p.hasOpened     ?? false,
      isCift:         p.isCift        ?? false,
      totalScore:     p.totalScore    ?? 0,
      barajTokens:    p.barajTokens   ?? 0,
      openMeldPoints: omp,
      openPairCount:  opc,
      // Motorda ayrı "settle" yok → açmış oyuncunun yerdeki grupları rozeti tetikler.
      openSettled:    (p.hasOpened ?? false) && (omp > 0 || opc > 0),
    };
  };

  // İŞLEK: açmamışken kendi en iyi açış perinin kartlarını işlek sayma (C# parity)
  let ownMeldIds = new Set<string>();
  try {
    if (!v.hasOpened) {
      const ins = analyzeHand(v.hand, rules);
      for (const grp of (ins?.melds ?? [])) for (const c of grp) ownMeldIds.add(c.id);
    }
  } catch { /* yoksay */ }
  const islekOf = (c: any) => {
    if (!c || c.joker || ownMeldIds.has(c.id)) return false;
    try { return isIslekCard(c, Array.isArray(v.melds) ? v.melds : [], rules); } catch { return false; }
  };

  // PULSE hedefleri: kartın işlenebileceği açık per id'leri (C# TargetsFor ile aynı: extend + okey-kurtar)
  const targetsOf = (c: any): string[] => {
    if (!c) return [];
    const t: string[] = [];
    try { for (const id of legalExtendTargets(state, seat, c.id)) t.push(id); } catch { /* yoksay */ }
    if (v.openMode === 'melds') {
      for (const m of (Array.isArray(v.melds) ? v.melds : [])) {
        if (!t.includes(m.id)) {
          try { if (canRetrieveJoker(m, c, rules) != null) t.push(m.id); } catch { /* yoksay */ }
        }
      }
    }
    return t;
  };

  let ins2: any = { meldPoints: 0, pairCount: 0 };
  try { ins2 = analyzeHand(v.hand, rules); } catch { /* default */ }

  // El sıralama: DİZ MODU AKTİFSE (seri/cift) her view'da YENİDEN DİZ (STICKY) — çekilen/alınan
  //   kart otomatik olarak perine akar (ör. kupa 10, 9♥-J♥ arasına girip seri kurar; dört 10'u
  //   greedy-set yapıp 9,J'yi boşta bırakma bug'ı biter). Mod 'none' ise handOrder'ı izle (kart sona).
  const dizMode = (state as any).dizModes?.[seat] ?? 'none';
  let handArr: any[];
  if (dizMode === 'seri' || dizMode === 'cift') {
    const orderIds = sortHandOrder(v.hand, rules, dizMode);
    const byId = new Map<string, any>((Array.isArray(v.hand) ? v.hand : []).map((c: any) => [c.id, c]));
    handArr = orderIds.map((id) => byId.get(id)).filter(Boolean);
    (state as any).handOrder = (state as any).handOrder || {};
    (state as any).handOrder[seat] = orderIds; // reconcile/DumpArranged ile tutarlı kalsın
  } else {
    const orderedHand = orderedHandFor(state, seat);
    handArr = orderedHand.length > 0 ? orderedHand : (Array.isArray(v.hand) ? v.hand : []);
  }

  // GÖSTERGE/dizim bloklarını handOrder sırasında hesapla (Unity DTO bekler).
  const arranged = computeArrangedBlocks(handArr, rules, dizMode);

  const pk = v.pickup;
  const sorgu = v.sorgu ?? null;

  return {
    seat:              v.seat            ?? seat,
    phase:             v.phase           ?? 'draw',
    currentSeat:       v.currentSeat     ?? 0,
    yourTurn:          v.currentSeat === seat && (v.phase === 'draw' || v.phase === 'action'),
    handNumber:        v.handNumber      ?? 1,
    totalHands:        rules?.totalHands ?? 5,
    openingMin:        v.currentOpeningMin ?? 0,
    pairsMin:          v.currentPairsMin ?? 0,
    teamMode:          rules?.teamMode ?? false,
    myHand:            handArr.map((c: any) => ({ ...mapCard(c), islek: islekOf(c), targets: targetsOf(c) })),
    handGaps:          [], // C# online misafirde de boş — UI-display (tek cihaz) kavramı
    melds:             Array.isArray(v.melds)   ? v.melds.map(mapMeld)   : [],
    seats:             Array.isArray(v.players) ? v.players.map(mapSeat) : [],
    hasDiscard:        (v.discardCount ?? 0) > 0,
    discardTop:        mapCard(v.discardTop ?? null),
    discardCount:      v.discardCount   ?? 0,
    stockCount:        v.stockCount     ?? 0,
    matchWinnerSeat:   (state as any).matchWinnerSeat ?? -1,
    hasOpened:         v.hasOpened       ?? false,
    openMode:          v.openMode == null ? '' : v.openMode,
    canSor:            safeCanSor(state, seat),
    canCancelPickup:   !!pk && !pk.committed && !pk.zorunlu,
    canCancelOpen:     safeCanCancelOpen(state, seat),
    myMeldPoints:      ins2.meldPoints  ?? 0,
    myPairCount:       ins2.pairCount   ?? 0,
    canSeeDiscardPile: v.discardPileForCift != null,
    discardPile:       Array.isArray(v.discardPileForCift) ? v.discardPileForCift.map(mapCard) : [],
    discardLocked:     v.discardLocked     ?? false,
    canPickupLockedTop: v.canPickupLockedTop ?? false,
    sorguActive:       sorgu != null,
    sorguAskerSeat:    sorgu?.askerSeat    ?? -1,
    sorguSorulanSeat:  sorgu?.sorulanSeat  ?? -1,
    sorguAsama:        sorgu?.asama        ?? '',
    sorguPartnerSeat:  sorgu?.partnerSeat  ?? -1,
    sorguPartnerGorus: sorgu?.partnerGorus ?? '',
    sorguCard:         mapCard(findCardById(state, sorgu?.cardId)),
    logMessages:       logMessages,
    // GÖSTERGE (ilk el, açık deste dibi kartı)
    gostergeKart:      v.gostergeKart ? mapCard(v.gostergeKart) : null,
    gostergeShown:     v.gostergeShown   ?? false,
    gostergeCanShow:   v.gostergeCanShow ?? false,
    gostergeCanTake:   v.gostergeCanTake ?? false,
    sheet:             Array.isArray((state as any).sheet)
                         ? (state as any).sheet.map((e: any) => ({
                             hand: e.hand ?? 0, seat: e.seat ?? 0, kind: e.kind ?? '', amount: e.amount ?? 0,
                           }))
                         : [],
    dizMode:           dizMode,
    // DİZİM GÖSTERGESİ (Unity DTO): handOrder sırasındaki ardışık geçerli bloklar.
    myArrangedMeldPoints: arranged.meldPoints,
    myArrangedPairCount:  arranged.pairCount,
    handBlockKinds:       arranged.blockKinds,  // myHand ile aynı sıra/uzunluk
  };
}

/* ── El sıralama — C# GameSession.SortHandOrder birebir portu ────────────────
   seri: seri blokları + renk grupları; cift: özdeş çiftler önde. Bloklar sola,
   jokerler sağa. Renk birimleri kırmızı-siyah dönüşümlü dizilir. */
export function sortHandOrder(hand: any[], rules: any, mode: 'seri' | 'cift'): string[] {
  const ins = analyzeHand(hand, rules);
  const blocks: any[][] = mode === 'seri' ? (ins.melds ?? []) : (ins.pairs ?? []);
  const used = new Set<string>();

  const blockUnits: { ids: string[]; red: boolean }[] = [];
  for (const block of blocks) {
    const ids = block.map((c: any) => c.id);
    for (const id of ids) used.add(id);
    const firstReal = block.find((c: any) => !c.joker);
    const red = !!firstReal && (firstReal.suit === 'H' || firstReal.suit === 'D');
    blockUnits.push({ ids, red });
  }

  // ÇİFT DİZİM — OKEY GÖRSEL EŞLENMEZ (kullanıcı isteği): okey bir kartla yan yana KONMAZ;
  // serbest kalır (jokerler aşağıda sona eklenir). Çift SAYIMI okeyleri computeArrangedBlocks
  // içinde ayrıca ekler — "okey boşta dursun ama çift dizde sayılsın". C# birebir.

  const singleUnits: { ids: string[]; red: boolean }[] = [];
  for (const suit of ['S', 'H', 'D', 'C']) {
    const grp = hand
      .filter((c: any) => !used.has(c.id) && !c.joker && c.suit === suit)
      .sort((a: any, b: any) => a.rank - b.rank);
    if (grp.length === 0) continue;
    singleUnits.push({ ids: grp.map((c: any) => c.id), red: suit === 'H' || suit === 'D' });
  }

  const ordered = alternateByColor(blockUnits).concat(alternateByColor(singleUnits));
  const jokers = hand.filter((c: any) => !used.has(c.id) && c.joker).map((c: any) => c.id);
  return ordered.flatMap((u) => u.ids).concat(jokers);
}

function alternateByColor(units: { ids: string[]; red: boolean }[]): { ids: string[]; red: boolean }[] {
  const red = units.filter((u) => u.red);
  const black = units.filter((u) => !u.red);
  const res: { ids: string[]; red: boolean }[] = [];
  let prev: boolean | null = null;
  let ri = 0, bi = 0;
  while (ri < red.length || bi < black.length) {
    let takeRed: boolean;
    if (prev === null) takeRed = (red.length - ri) >= (black.length - bi);
    else if (prev === true) takeRed = (black.length - bi) === 0;
    else takeRed = (red.length - ri) > 0;
    res.push(takeRed ? red[ri++]! : black[bi++]!);
    prev = takeRed;
  }
  return res;
}

function safeCanSor(state: any, seat: number): boolean {
  try { return canSor(state, seat); } catch { return false; }
}

function safeCanCancelOpen(state: GameState, seat: number): boolean {
  try { return canCancelOpen(state, seat); } catch { return false; }
}

/** sorgu kartını el/discard/perler içinde id ile çöz (SorguState yalnız cardId tutar). */
function findCardById(state: any, cardId: string | undefined | null): any {
  if (!cardId) return null;
  for (const p of (state.players ?? [])) {
    const c = (p.hand ?? []).find((x: any) => x.id === cardId);
    if (c) return c;
  }
  const d = (state.discard ?? []).find((x: any) => x.id === cardId);
  if (d) return d;
  for (const m of (state.melds ?? [])) {
    const c = (m.cards ?? []).find((x: any) => x.id === cardId);
    if (c) return c;
  }
  return null;
}

/**
 * İZLEYİCİ (spectator) görünümü: seat=-1. Hiçbir gizli el sızdırılmaz —
 * yalnız masadaki AÇIK bilgi (oturanlar/skorlar, sıra, açık perler, ıskarta, deste sayıları).
 * myHand DAİMA boş; kişisel aksiyon bayrakları kapalı. Mevcut oyuncu view'leri etkilenmez.
 */
export function clientViewForSpectator(state: GameState): Record<string, unknown> {
  const base = emptyView(-1);
  if (!state || !Array.isArray((state as any).players)) return base;

  const rules: any = (state as any).rules ?? {};
  // Açık per bilgisi için seat 0 view'ını temel al (gizli el ATILIR, sadece masadaki açık veriler alınır).
  let v: any = null;
  try { v = viewFor(state as any, 0); } catch { v = null; }

  const mapCard = (c: any) => c == null ? null : {
    id: c.id ?? '', label: c.label ?? '',
    red: c.suit === 'H' || c.suit === 'D',
    joker: c.joker ?? false, suit: c.suit ?? '', rank: c.rank ?? 0, islek: false,
  };
  const mapMeld = (m: any) => {
    const cards = Array.isArray(m.cards) ? m.cards : [];
    let pts = 0; try { pts = meldPoints(cards, rules) ?? 0; } catch { /* karışık */ }
    return { id: m.id ?? '', ownerSeat: m.ownerSeat ?? 0, type: m.type ?? 'run', cards: cards.map(mapCard), points: pts };
  };
  const abandonedArr: number[] = Array.isArray((state as any).abandoned) ? (state as any).abandoned : [];
  const mapSeat = (p: any) => {
    const omp = p.openingValue ?? 0;
    const opc = p.openingPairs ?? 0;
    return {
      seat: p.seat ?? 0,
      name: abandonedArr.includes(p.seat ?? -1) ? ('Bot (' + (p.name || '?') + ')') : (p.name ?? ''),
      isBot: (p.isBot ?? false) || abandonedArr.includes(p.seat ?? -1),
      abandoned: abandonedArr.includes(p.seat ?? -1),
      handCount: p.handCount ?? 0,
      hasOpened: p.hasOpened ?? false,
      isCift: p.isCift ?? false,
      totalScore: p.totalScore ?? 0,
      barajTokens: p.barajTokens ?? 0,
      openMeldPoints: omp,
      openPairCount: opc,
      openSettled: (p.hasOpened ?? false) && (omp > 0 || opc > 0),
    };
  };

  return {
    ...base,
    spectator: true,
    phase: state.phase ?? 'draw',
    currentSeat: state.currentSeat ?? 0,
    handNumber: state.handNumber ?? 1,
    totalHands: rules?.totalHands ?? 5,
    teamMode: rules?.teamMode ?? false,
    melds: v && Array.isArray(v.melds) ? v.melds.map(mapMeld) : [],
    seats: Array.isArray((state as any).players) ? (state as any).players.map(mapSeat) : [],
    hasDiscard: ((v?.discardCount ?? state.discard?.length ?? 0) as number) > 0,
    discardTop: mapCard(v?.discardTop ?? (state.discard?.[state.discard.length - 1] ?? null)),
    discardCount: v?.discardCount ?? state.discard?.length ?? 0,
    stockCount: v?.stockCount ?? state.stock?.length ?? 0,
    matchWinnerSeat: (state as any).matchWinnerSeat ?? -1,
    logMessages: Array.isArray((state as any).matchLog) ? (state as any).matchLog.slice() : [],
    gostergeKart: v?.gostergeKart ? mapCard(v.gostergeKart) : null,
    gostergeShown: v?.gostergeShown ?? false,
    sheet: Array.isArray((state as any).sheet)
      ? (state as any).sheet.map((e: any) => ({ hand: e.hand ?? 0, seat: e.seat ?? 0, kind: e.kind ?? '', amount: e.amount ?? 0 }))
      : [],
  };
}

function emptyView(seat: number): Record<string, unknown> {
  return {
    seat, phase: 'draw', currentSeat: 0, yourTurn: false,
    handNumber: 1, totalHands: 5, openingMin: 0, pairsMin: 0, teamMode: false,
    myHand: [], handGaps: [], melds: [], seats: [],
    hasDiscard: false, discardTop: null, discardCount: 0, stockCount: 0,
    matchWinnerSeat: -1, hasOpened: false, openMode: '',
    canSor: false, canCancelPickup: false, canCancelOpen: false, myMeldPoints: 0, myPairCount: 0,
    canSeeDiscardPile: false, discardPile: [], discardLocked: false,
    canPickupLockedTop: false, sorguActive: false, sorguAskerSeat: -1,
    sorguSorulanSeat: -1, sorguAsama: '', sorguPartnerSeat: -1, sorguPartnerGorus: '', sorguCard: null,
    logMessages: [],
    gostergeKart: null, gostergeShown: false, gostergeCanShow: false, gostergeCanTake: false, sheet: [], dizMode: 'none',
    myArrangedMeldPoints: 0, myArrangedPairCount: 0, handBlockKinds: [],
  };
}
