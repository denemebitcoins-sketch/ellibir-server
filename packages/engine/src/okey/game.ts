import type { NormalOkeyTile, OkeyColor, OkeyFinishKind, OkeyRank, OkeyTile } from './types';
import type { OkeyRuleConfig } from './rules';
import { DEFAULT_OKEY_RULES } from './rules';
import { dealOkey, isOkeyTile, identityOf } from './deck';
import { canFinishMelds, canFinishPairs, bestGrouping } from './melds';

/**
 * DÜZ OKEY oyun makinesi (otoriter). 51 motoruyla aynı ilkeler:
 * saf TS, ortam bağımsız, JSON-serileşebilir state, deterministik (seed).
 *
 * Akış: dağıtıcı 15 taşla başlar, ÇEKMEDEN atar. Sıra saat yönünün TERSİNE
 * 0→1→2→3 döner; oyuncu ya ortadan çeker ya SOL komşusunun (bir önceki
 * oyuncunun) attığı son taşı alır; sonra kendi atık yığınına (sağ köşesi) atar.
 * Bitiş: 15. taşı bitiş alanına atıp kalan 14'ü seri/küt (veya 7 çift) dizmek.
 */

export interface OkeyPlayer {
  seat: number;
  name: string;
  isBot: boolean;
  hand: OkeyTile[];
  showedGosterge: boolean; // bu el gösterge tekini gösterdi mi
  discardCount: number;    // bu el kaç taş attı (gösterge yalnız ilk atıştan önce)
}

export interface OkeyGameState {
  rules: OkeyRuleConfig;
  seed: number;
  elNumber: number;          // 1'den başlar
  dealerSeat: number;        // 15 taş alan (eli başlatan)
  players: OkeyPlayer[];
  stock: OkeyTile[];         // kapalı yığın; çekiş dizinin SONUNDAN (pop)
  discards: OkeyTile[][];    // koltuk başına atık yığını (son eleman = üstteki)
  gosterge: NormalOkeyTile;
  okeyColor: OkeyColor;
  okeyRank: OkeyRank;
  turn: number;
  phase: 'draw' | 'discard'; // sıradaki oyuncunun beklenen hamlesi
  elEnded: boolean;
  matchEnded: boolean;
  elWinner: number | null;   // -1 = berabere (deste bitti)
  finishKind: OkeyFinishKind | null;
  scores: number[];          // koltuk başına CEZA birikimi (0'dan başlar, düşük iyi; kazanan eksiye düşer)
  elDeltas: number[][];      // YAZBOZ: el başına puan değişimi (gösterge dahil)
  elStartScores: number[];   // el başı skor (delta tabanı)
  // BANKO varyantı: maçta 1 kez "banko" hakkı; EL DAĞITILMADAN taahhüt edilir
  // (el içinde denen banko SONRAKİ el için kilitlenir), o el çarpanı ×2'ler.
  bankoUsed: boolean[];      // hak harcandı mı (maçta 1; geri alınamaz)
  bankoPending: boolean[];   // seçim fazı sonucu (el başında bankoThisEl'e döner)
  bankoPhase: boolean;       // SEÇİM FAZI: el dağıtılmadan 5sn — herkes kararını verir, HERKES GÖRÜR
  bankoChoice: number[];     // faz içi canlı seçim: -1 kararsız, 0 pas, 1 BANKO
  bankoThisEl: boolean[];    // bu el banko OLAN koltuklar (çarpan 2^adet)
  bankoRows: number[][];     // YAZBOZ: el başına koltuk sonucu — 0 yok, 1 TAMAMLADI, 2 PATLADI
  matchLog: string[];
}

export interface OkeyMoveResult {
  ok: boolean;
  error?: string;
}

export interface OkeyCreateOptions {
  /** false → ilk el HEMEN dağıtılmaz (banko seçim fazı önce koşar; oda resolve sonrası startNextEl çağırır). */
  dealFirst?: boolean;
  seed: number;
  names?: string[];
  botSeats?: number[];
  rules?: Partial<OkeyRuleConfig>;
  dealerSeat?: number;
}

export function createOkeyGame(opts: OkeyCreateOptions): OkeyGameState {
  const rules: OkeyRuleConfig = { ...DEFAULT_OKEY_RULES, ...(opts.rules ?? {}),
    scoring: { ...DEFAULT_OKEY_RULES.scoring, ...(opts.rules?.scoring ?? {}) } };
  const dealerSeat = opts.dealerSeat ?? 0;
  const names = opts.names ?? ['Oyuncu 1', 'Oyuncu 2', 'Oyuncu 3', 'Oyuncu 4'];
  const bots = new Set(opts.botSeats ?? []);
  const state: OkeyGameState = {
    rules,
    seed: opts.seed,
    elNumber: 0,
    dealerSeat,
    players: [0, 1, 2, 3].map((s) => ({
      seat: s, name: names[s] ?? `Oyuncu ${s + 1}`, isBot: bots.has(s),
      hand: [], showedGosterge: false, discardCount: 0,
    })),
    stock: [], discards: [[], [], [], []],
    gosterge: null as unknown as NormalOkeyTile, okeyColor: 'R', okeyRank: 1,
    turn: dealerSeat, phase: 'discard',
    elEnded: false, matchEnded: false, elWinner: null, finishKind: null,
    scores: [rules.scoring.startScore, rules.scoring.startScore, rules.scoring.startScore, rules.scoring.startScore], // DÜŞME: 0'a inen kazanır
    matchLog: [],
    elDeltas: [],
    elStartScores: [0, 0, 0, 0],
    bankoUsed: [false, false, false, false],
    bankoPending: [false, false, false, false],
    bankoPhase: false,
    bankoChoice: [-1, -1, -1, -1],
    bankoThisEl: [false, false, false, false],
    bankoRows: [],
  };
  if (opts.dealFirst !== false) startNextEl(state);
  return state;
}

/* ── BANKO SEÇİM FAZI (el dağıtılmadan): herkes kararını verir, kararlar HERKESE canlı görünür.
   Kurallar: hak maçta 1; BANKO geri alınamaz (hak anında yanar); PAS liste kapanana dek BANKO'ya
   yükseltilebilir; süre bitince kararsız = PAS; SON kullanılabilir ellerde hak dolmamışlara OTOMATİK
   BANKO (mecburiyet). Botlar anında PAS der. ── */

export function beginBankoPhase(state: OkeyGameState): void {
  if (state.rules.variant !== 'banko' || state.matchEnded) return;
  state.bankoPhase = true;
  for (let s2 = 0; s2 < 4; s2++)
    state.bankoChoice[s2] = state.bankoUsed[s2] ? 0 : -1; // hakkı yok → PAS kilitli
  // Son eller mecburiyeti: kalan el (dağıtılacak dahil) hak dolmamış sayısına eşit/azsa hepsi BANKO.
  const remaining = state.rules.totalEls - state.elNumber; // dağıtılacak el = elNumber+1
  const nonUsers = [0, 1, 2, 3].filter((si) => !state.bankoUsed[si]);
  if (nonUsers.length > 0 && remaining <= nonUsers.length) {
    for (const si of nonUsers) {
      state.bankoUsed[si] = true;
      state.bankoChoice[si] = 1;
      state.matchLog.push(`${state.players[si]!.name} için OTOMATİK BANKO (son eller mecburiyeti)`);
    }
  }
  // Botlar anında PAS (kararsız kalmasınlar).
  for (let s2 = 0; s2 < 4; s2++)
    if (state.players[s2]!.isBot && state.bankoChoice[s2] === -1) state.bankoChoice[s2] = 0;
}

export function chooseBanko(state: OkeyGameState, seat: number): OkeyMoveResult {
  if (!state.bankoPhase) return { ok: false, error: 'banko yalnız el arası seçim ekranında denir' };
  if (state.bankoUsed[seat]) return { ok: false, error: 'banko hakkın yok' };
  state.bankoUsed[seat] = true;      // hak anında yanar, geri alınamaz
  state.bankoChoice[seat] = 1;
  state.matchLog.push(`${state.players[seat]!.name} BANKO dedi! 🔥`);
  return { ok: true };
}

export function choosePas(state: OkeyGameState, seat: number): OkeyMoveResult {
  if (!state.bankoPhase) return { ok: false, error: 'seçim ekranı kapalı' };
  if (state.bankoChoice[seat] === 1) return { ok: false, error: 'BANKO geri alınmaz' };
  state.bankoChoice[seat] = 0;
  return { ok: true };
}

/** Faz kapanışı: kararsızlar PAS; seçimler pending'e döner (startNextEl tüketir). */
export function resolveBankoPhase(state: OkeyGameState): void {
  if (!state.bankoPhase) return;
  for (let s2 = 0; s2 < 4; s2++) {
    if (state.bankoChoice[s2] === -1) state.bankoChoice[s2] = 0;
    state.bankoPending[s2] = state.bankoChoice[s2] === 1;
  }
  state.bankoPhase = false;
}

/** Yeni el kur: dağıtıcı döner, taşlar yeniden dağıtılır. */
export function startNextEl(state: OkeyGameState): void {
  if (state.matchEnded) return;
  state.elNumber += 1;
  if (state.elNumber > 1) state.dealerSeat = (state.dealerSeat + 1) % 4;
  const deal = dealOkey(state.seed + state.elNumber * 7919, state.dealerSeat); // el başına farklı ama deterministik dağıtım
  for (let s = 0; s < 4; s++) {
    const p = state.players[s]!;
    p.hand = deal.hands[s]!;
    p.showedGosterge = false;
    p.discardCount = 0;
  }
  state.stock = deal.stock;
  state.discards = [[], [], [], []];
  state.gosterge = deal.gosterge;
  state.okeyColor = deal.okeyColor;
  state.okeyRank = deal.okeyRank;
  state.turn = state.dealerSeat;
  state.phase = 'discard';
  state.elEnded = false;
  state.elWinner = null;
  state.finishKind = null;
  state.elStartScores = [...state.scores]; // yazboz delta tabanı
  // Taahhütler bu elde devreye girer (el DAĞITILMADAN söylenmişti).
  state.bankoThisEl = [...(state.bankoPending ?? [false, false, false, false])];
  state.bankoPending = [false, false, false, false];
  // (otomatik-banko mecburiyeti beginBankoPhase'te uygulanır — seçim listesi herkes görsün diye)
  state.matchLog.push(`El ${state.elNumber} başladı — gösterge: ${state.gosterge.color}${state.gosterge.rank}, dağıtan: ${state.players[state.dealerSeat]!.name}`);
}

const tileById = (p: OkeyPlayer, id: string) => p.hand.findIndex((t) => t.id === id);

export type OkeyMove =
  | { t: 'draw'; from: 'pile' | 'left' }
  | { t: 'discard'; tileId: string }
  | { t: 'finish'; tileId: string }
  | { t: 'gosterge' }
  | { t: 'banko' }    // BANKO varyantı: SEÇİM FAZINDA banko de (maçta 1 hak; geri alınmaz)
  | { t: 'pas' };     // SEÇİM FAZINDA pas geç (liste kapanana dek banko'ya yükseltilebilir)

export function applyOkeyMove(state: OkeyGameState, seat: number, move: OkeyMove): OkeyMoveResult {
  if (state.matchEnded) return { ok: false, error: 'maç bitti' };
  if (state.elEnded) return { ok: false, error: 'el bitti' };
  if (state.bankoPhase) {
    if (move.t === 'banko') return chooseBanko(state, seat);
    if (move.t === 'pas') return choosePas(state, seat);
    return { ok: false, error: 'banko seçimi sürüyor' };
  }
  if (move.t === 'banko' || move.t === 'pas')
    return { ok: false, error: 'banko yalnız el arası SEÇİM ekranında denir' };
  const p = state.players[seat];
  if (!p) return { ok: false, error: 'geçersiz koltuk' };

  // GÖSTERGE göstermek sıra beklemez ama yalnız İLK atıştan önce geçerlidir.
  if (move.t === 'gosterge') return showGosterge(state, p);

  if (state.turn !== seat) return { ok: false, error: 'sıra sende değil' };

  switch (move.t) {
    case 'draw': {
      if (state.phase !== 'draw') return { ok: false, error: 'önce taş atmalısın' };
      if (move.from === 'left') {
        const leftPile = state.discards[(seat + 3) % 4]!;
        const top = leftPile.pop();
        if (!top) return { ok: false, error: 'solda atılmış taş yok' };
        p.hand.push(top);
      } else {
        const top = state.stock.pop();
        if (!top) { endElDraw(state); return { ok: true }; } // deste bitti → berabere
        p.hand.push(top);
      }
      state.phase = 'discard';
      return { ok: true };
    }
    case 'discard': {
      if (state.phase !== 'discard') return { ok: false, error: 'önce taş çekmelisin' };
      const idx = tileById(p, move.tileId);
      if (idx < 0) return { ok: false, error: 'taş elinde değil' };
      const tile = p.hand.splice(idx, 1)[0]!;
      state.discards[seat]!.push(tile);
      p.discardCount++;
      state.turn = (seat + 1) % 4;
      state.phase = 'draw';
      // KLASİK KURAL: ortadaki taşlar bitti ve atan da bitiremedi → el berabere.
      if (state.stock.length === 0) endElDraw(state);
      return { ok: true };
    }
    case 'finish': {
      if (state.phase !== 'discard') return { ok: false, error: 'önce taş çekmelisin' };
      const idx = tileById(p, move.tileId);
      if (idx < 0) return { ok: false, error: 'taş elinde değil' };
      const thrown = p.hand[idx]!;
      const remaining = p.hand.filter((_, i) => i !== idx);
      const melds = canFinishMelds(remaining, state.okeyColor, state.okeyRank);
      const pairs = !melds && canFinishPairs(remaining, state.okeyColor, state.okeyRank);
      if (!melds && !pairs) return { ok: false, error: 'el bitmiyor — taşlar geçerli perlere dizilemiyor' };
      p.hand.splice(idx, 1);
      const okeyThrown = isOkeyTile(thrown, state.okeyColor, state.okeyRank);
      const kind: OkeyFinishKind = pairs ? (okeyThrown ? 'pairsOkey' : 'pairs') : (okeyThrown ? 'okey' : 'normal');
      endElWin(state, seat, kind);
      return { ok: true };
    }
  }
  return { ok: false, error: 'bilinmeyen hamle' };
}

function showGosterge(state: OkeyGameState, p: OkeyPlayer): OkeyMoveResult {
  if (p.showedGosterge) return { ok: false, error: 'zaten gösterdin' };
  if (p.discardCount > 0) return { ok: false, error: 'gösterge yalnız ilk taşını atmadan önce gösterilir' };
  const has = p.hand.some((t) => !t.fake && t.color === state.gosterge.color && t.rank === state.gosterge.rank);
  if (!has) return { ok: false, error: 'gösterge teki elinde yok' };
  p.showedGosterge = true;
  // KAHVE USULÜ: gösteren KENDİ cezasından düşer (rakiplere ceza yazılmaz).
  state.scores[p.seat] = state.scores[p.seat]! - state.rules.scoring.gosterge;
  state.matchLog.push(`${p.name} göstergeyi gösterdi (kendi cezasından -${state.rules.scoring.gosterge})`);
  return { ok: true };
}

/** KAHVE USULÜ el sonu cezası: rakipler +points CEZA yer; kazanan kendi cezasından -points düşer.
 *  Eşli'de ortak muaf (ceza yemez); rakip takımın İKİ üyesi de yer. */
function applyElPoints(state: OkeyGameState, winnerSeat: number, points: number): void {
  for (let s = 0; s < 4; s++) {
    if (s === winnerSeat) { state.scores[s] = state.scores[s]! - points; continue; }
    if (state.rules.teamMode && s % 2 === winnerSeat % 2) continue; // ortak muaf
    state.scores[s] = state.scores[s]! + points;
  }
}

/** El kapanırken YAZBOZ satırı: bu eldeki toplam puan değişimi (gösterge dahil). */
function pushElDelta(state: OkeyGameState): void {
  state.elDeltas.push(state.scores.map((v, i) => v - (state.elStartScores[i] ?? 0)));
  // bankoRows her el için hizalı kalsın (banko yolu kendi satırını zaten attıysa atlama).
  if (state.bankoRows.length < state.elDeltas.length) state.bankoRows.push([0, 0, 0, 0]);
}

/** BANKO: gösterge rengi çarpanı — siyah 5, kırmızı 4, sarı 3, mavi 2 (kullanıcı kuralı). */
function colorMultOf(state: OkeyGameState): number {
  const c = state.gosterge?.color;
  return c === 'K' ? 5 : c === 'R' ? 4 : c === 'Y' ? 3 : 2;
}

/** BANKO el çarpanı: renk × 2^(bu el banko diyen sayısı). */
export function elMultOf(state: OkeyGameState): number {
  let m = colorMultOf(state);
  for (let s2 = 0; s2 < 4; s2++) if (state.bankoThisEl[s2]) m *= 2;
  return m;
}

/** BANKO: elde per/çift OLUŞTURMAYAN taşların sayı toplamı (+ çift değerlendirmesi bilgisi).
 *  ≥5 çifti olan ÇİFT sayılır: çift-dışı toplam alınır ve ceza ×2 uygulanır. */
function leftoverFor(state: OkeyGameState, seat: number): { sum: number; cift: boolean } {
  const p = state.players[seat]!;
  const oc = state.okeyColor, orr = state.okeyRank;
  const val = (t: any) => identityOf(t, oc, orr).rank;
  // ÇİFT değerlendirmesi: kimlik bazlı eşler + okey joker eşleri (client ExtractPairs mantığı).
  const wilds = p.hand.filter((t) => isOkeyTile(t, oc, orr));
  const rest = p.hand.filter((t) => !isOkeyTile(t, oc, orr));
  const byKey = new Map<string, any[]>();
  for (const t of rest) {
    const id = identityOf(t, oc, orr);
    const k = id.color + ':' + id.rank;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(t);
  }
  let pairs = 0; const singles: any[] = [];
  for (const list of byKey.values()) {
    pairs += Math.floor(list.length / 2);
    if (list.length % 2 === 1) singles.push(list[list.length - 1]);
  }
  let w = wilds.length; let si = 0;
  while (w > 0 && si < singles.length) { pairs++; w--; singles[si] = null; si++; }
  pairs += Math.floor(w / 2);
  const pairLeftover = singles.filter(Boolean).reduce((a, t) => a + val(t), 0) + (w % 2) * orr;
  if (pairs >= 5) return { sum: pairLeftover, cift: true };
  // PER değerlendirmesi: kapsama-maksimum gruplar (BestGrouping) dışında kalanların toplamı.
  const groups = bestGrouping(p.hand, oc, orr);
  const used = new Set<string>();
  for (const g of groups) for (const t of g) used.add(t.id);
  const sum = p.hand.filter((t) => !used.has(t.id)).reduce((a, t) => a + val(t), 0);
  return { sum, cift: false };
}

/** BANKO el sonu: kazanan −10×mult×(bitiş çarpanı); kaybedenler elde kalan × mult (çifte ×2). */
function endElWinBanko(state: OkeyGameState, seat: number, kind: OkeyFinishKind): void {
  const sc = state.rules.scoring;
  const mult = elMultOf(state);
  const finX = (kind === 'pairs' || kind === 'pairsOkey' ? sc.pairsX : 1)
    * (kind === 'okey' || kind === 'pairsOkey' ? sc.okeyX : 1);
  const winPts = 10 * mult * finX;
  state.scores[seat] = state.scores[seat]! - winPts;
  for (let s2 = 0; s2 < 4; s2++) {
    if (s2 === seat) continue;
    if (state.rules.teamMode && s2 % 2 === seat % 2) continue; // ortak muaf
    const lo = leftoverFor(state, s2);
    const pts = lo.sum * mult * (lo.cift ? 2 : 1);
    state.scores[s2] = state.scores[s2]! + pts;
    state.matchLog.push(`${state.players[s2]!.name} elde ${lo.sum} bıraktı${lo.cift ? ' (çift ×2)' : ''} → +${pts}`);
  }
  state.matchLog.push(`Çarpan ×${mult} (gösterge${state.bankoThisEl.some(Boolean) ? ' + banko' : ''}) — ${state.players[seat]!.name} −${winPts}`);
  pushBankoRow(state, seat);
}

/** YAZBOZ banko satırı: banko diyenler için 1=TAMAMLADI (kendisi/takımı kazandı) 2=PATLADI. */
function pushBankoRow(state: OkeyGameState, winnerSeat: number): void {
  const row = [0, 0, 0, 0];
  for (let s2 = 0; s2 < 4; s2++) {
    if (!state.bankoThisEl[s2]) continue;
    const won = winnerSeat >= 0
      && (s2 === winnerSeat || (state.rules.teamMode && s2 % 2 === winnerSeat % 2));
    row[s2] = won ? 1 : 2;
    state.matchLog.push(`${state.players[s2]!.name} bankosunu ${won ? 'TAMAMLADI ✓' : 'PATLATTI ✗'}`);
  }
  state.bankoRows.push(row);
}

function endElWin(state: OkeyGameState, seat: number, kind: OkeyFinishKind): void {
  const sc = state.rules.scoring;
  if (state.rules.variant === 'banko') {
    endElWinBanko(state, seat, kind);
    state.elEnded = true;
    state.elWinner = seat;
    state.finishKind = kind;
    pushElDelta(state);
    maybeEndMatchBanko(state);
    return;
  }
  const points = sc.base
    * (kind === 'pairs' || kind === 'pairsOkey' ? sc.pairsX : 1)
    * (kind === 'okey' || kind === 'pairsOkey' ? sc.okeyX : 1);
  applyElPoints(state, seat, points);
  state.elEnded = true;
  state.elWinner = seat;
  state.finishKind = kind;
  const kindTxt = kind === 'pairsOkey' ? 'ÇİFT + OKEY atarak' : kind === 'pairs' ? 'ÇİFTTEN' : kind === 'okey' ? 'OKEY atarak' : 'düz';
  state.matchLog.push(`${state.players[seat]!.name} eli ${kindTxt} bitirdi (rakipler +${points} ceza, kendisi -${points})`);
  pushElDelta(state);
  maybeEndMatch(state);
}

function endElDraw(state: OkeyGameState): void {
  state.elEnded = true;
  state.elWinner = -1;
  state.finishKind = null;
  if (state.rules.variant === 'banko') {
    const mult = elMultOf(state);
    for (let s2 = 0; s2 < 4; s2++) {
      const lo = leftoverFor(state, s2);
      const pts = lo.sum * mult * (lo.cift ? 2 : 1);
      state.scores[s2] = state.scores[s2]! + pts;
    }
    state.matchLog.push(`Taşlar bitti — herkes elinde kalanı ödedi (çarpan ×${mult})`);
    pushBankoRow(state, -1);
    pushElDelta(state);
    maybeEndMatchBanko(state);
    return;
  }
  state.matchLog.push('Ortadaki taşlar bitti — el berabere (puan yok)');
  pushElDelta(state);
  maybeEndMatch(state);
}

/** BANKO maç sonu: sabit el sayısı oynanır (0'a inme kuralı YOK); en düşük toplam kazanır. */
function maybeEndMatchBanko(state: OkeyGameState): void {
  if (state.elNumber < state.rules.totalEls) return;
  state.matchEnded = true;
  const best = Math.min(...state.scores);
  const winners = [0, 1, 2, 3].filter((s2) => state.scores[s2] === best);
  const names = winners.map((s2) => state.players[s2]!.name).join(' & ');
  state.matchLog.push(`MAÇ BİTTİ — kazanan: ${names} (${best} puan)`);
}

function maybeEndMatch(state: OkeyGameState): void {
  // DÜŞME modeli: 0'a (veya altına) İNEN maçı kazanır ve maç HEMEN biter.
  const reachedZero = state.scores.some((s) => s <= 0);
  if (!reachedZero && state.elNumber < state.rules.totalEls) return;
  state.matchEnded = true;
  const best = Math.min(...state.scores); // 0'a inen; yoksa el tavanında EN DÜŞÜK kalan
  const winners = [0, 1, 2, 3].filter((s) => state.scores[s] === best);
  const names = winners.map((s) => state.players[s]!.name).join(' & ');
  state.matchLog.push(`MAÇ BİTTİ — kazanan: ${names} (${best} puan${reachedZero ? ' — sıfıra indi' : ''})`);
}

/** Süre dolunca odanın çağıracağı otomatik hamle: çek → son çekileni/rastgele olmayanı at. */
export function autoOkeyMove(state: OkeyGameState, seat: number): void {
  if (state.elEnded || state.matchEnded || state.turn !== seat) return;
  if (state.phase === 'draw') {
    applyOkeyMove(state, seat, { t: 'draw', from: 'pile' });
    if (state.elEnded) return;
  }
  const p = state.players[seat]!;
  // Okey atma: asla otomatik atılmaz; en son ele gelen (dizilim bozmaz) okey-dışı taş atılır.
  for (let i = p.hand.length - 1; i >= 0; i--) {
    const t = p.hand[i]!;
    if (!isOkeyTile(t, state.okeyColor, state.okeyRank)) {
      applyOkeyMove(state, seat, { t: 'discard', tileId: t.id });
      return;
    }
  }
  applyOkeyMove(state, seat, { t: 'discard', tileId: p.hand[p.hand.length - 1]!.id });
}
