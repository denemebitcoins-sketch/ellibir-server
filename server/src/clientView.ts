/**
 * TS PlayerView → C# ClientView DTO formatına dönüştürür (ClientViewBuilder ile PARITY).
 * C# JsonUtility'nin beklediği alan adları (myHand, seats, vb.) kullanılır.
 */
import { viewFor, isIslekCard, canSor, canCancelOpen, legalExtendTargets, canRetrieveJoker } from '../../packages/engine/src/game';
import { analyzeHand } from '../../packages/engine/src/insight';
import { meldPoints } from '../../packages/engine/src/melds';
import type { GameState } from '../../packages/engine/src/game';

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
  const allMelds: any[] = Array.isArray((state as any).melds) ? (state as any).melds : [];
  const mapSeat = (p: any) => {
    // Perin solundaki rozet: oyuncunun yere açtığı grupların toplam puanı (çift modunda çift adedi).
    const seatMelds = allMelds.filter((m) => (m.ownerSeat ?? m.owner_seat) === p.seat);
    let omp = 0, opc = 0;
    for (const m of seatMelds) {
      const n = Array.isArray(m.cards) ? m.cards.length : 0;
      if (n === 2) opc++;
      else { try { omp += meldPoints(m.cards, rules) ?? 0; } catch { /* karışık */ } }
    }
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

  // El sıralama (per-koltuk dizMode): seri/çift → motor SortHandOrder ile diz
  const dizMode = (state as any).dizModes?.[seat] ?? 'none';
  let handArr: any[] = Array.isArray(v.hand) ? v.hand : [];
  if (dizMode === 'seri' || dizMode === 'cift') {
    try {
      const order = sortHandOrder(handArr, rules, dizMode);
      const byId = new Map(handArr.map((c: any) => [c.id, c]));
      const reord = order.map((id) => byId.get(id)).filter(Boolean);
      if (reord.length === handArr.length) handArr = reord as any[];
    } catch { /* sırasız bırak */ }
  }

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

function emptyView(seat: number): Record<string, unknown> {
  return {
    seat, phase: 'draw', currentSeat: 0, yourTurn: false,
    handNumber: 1, totalHands: 5, openingMin: 0, teamMode: false,
    myHand: [], handGaps: [], melds: [], seats: [],
    hasDiscard: false, discardTop: null, discardCount: 0, stockCount: 0,
    matchWinnerSeat: -1, hasOpened: false, openMode: '',
    canSor: false, canCancelPickup: false, canCancelOpen: false, myMeldPoints: 0, myPairCount: 0,
    canSeeDiscardPile: false, discardPile: [], discardLocked: false,
    canPickupLockedTop: false, sorguActive: false, sorguAskerSeat: -1,
    sorguSorulanSeat: -1, sorguAsama: '', sorguPartnerSeat: -1, sorguPartnerGorus: '', sorguCard: null,
    logMessages: [],
    gostergeKart: null, gostergeShown: false, gostergeCanShow: false, gostergeCanTake: false, sheet: [], dizMode: 'none',
  };
}
