import type { NormalOkeyTile, OkeyColor, OkeyFinishKind, OkeyRank, OkeyTile } from './types';
import type { OkeyRuleConfig } from './rules';
import { DEFAULT_OKEY_RULES } from './rules';
import { dealOkey, isOkeyTile } from './deck';
import { canFinishMelds, canFinishPairs } from './melds';

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
  matchLog: string[];
}

export interface OkeyMoveResult {
  ok: boolean;
  error?: string;
}

export interface OkeyCreateOptions {
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
  };
  startNextEl(state);
  return state;
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
  state.matchLog.push(`El ${state.elNumber} başladı — gösterge: ${state.gosterge.color}${state.gosterge.rank}, dağıtan: ${state.players[state.dealerSeat]!.name}`);
}

const tileById = (p: OkeyPlayer, id: string) => p.hand.findIndex((t) => t.id === id);

export type OkeyMove =
  | { t: 'draw'; from: 'pile' | 'left' }
  | { t: 'discard'; tileId: string }
  | { t: 'finish'; tileId: string }
  | { t: 'gosterge' };

export function applyOkeyMove(state: OkeyGameState, seat: number, move: OkeyMove): OkeyMoveResult {
  if (state.matchEnded) return { ok: false, error: 'maç bitti' };
  if (state.elEnded) return { ok: false, error: 'el bitti' };
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

function endElWin(state: OkeyGameState, seat: number, kind: OkeyFinishKind): void {
  const sc = state.rules.scoring;
  const points = sc.base
    * (kind === 'pairs' || kind === 'pairsOkey' ? sc.pairsX : 1)
    * (kind === 'okey' || kind === 'pairsOkey' ? sc.okeyX : 1);
  applyElPoints(state, seat, points);
  state.elEnded = true;
  state.elWinner = seat;
  state.finishKind = kind;
  const kindTxt = kind === 'pairsOkey' ? 'ÇİFT + OKEY atarak' : kind === 'pairs' ? 'ÇİFTTEN' : kind === 'okey' ? 'OKEY atarak' : 'düz';
  state.matchLog.push(`${state.players[seat]!.name} eli ${kindTxt} bitirdi (rakipler +${points} ceza, kendisi -${points})`);
  maybeEndMatch(state);
}

function endElDraw(state: OkeyGameState): void {
  state.elEnded = true;
  state.elWinner = -1;
  state.finishKind = null;
  state.matchLog.push('Ortadaki taşlar bitti — el berabere (puan yok)');
  maybeEndMatch(state);
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
