import type { NormalOkeyTile, OkeyColor, OkeyFinishKind, OkeyRank, OkeyTile } from './types';
import { isNormalOkeyTile } from './types';
import type { OkeyRuleConfig } from './rules';
import { DEFAULT_OKEY_RULES } from './rules';
import { dealOkey, isOkeyTile, identityOf } from './deck';
import { createRng } from '../deck';
import { canFinishMelds, canFinishPairs, bestGrouping, isValidPair, isValidRun, isValidSet } from './melds';

/**
 * DÜZ OKEY oyun makinesi (otoriter). 51 motoruyla aynı ilkeler:
 * saf TS, ortam bağımsız, JSON-serileşebilir state, deterministik (seed).
 *
 * Akış: eli başlatan oyuncu ekstra taşla başlar, ÇEKMEDEN atar. Sıra saat yönünün TERSİNE
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
  hasOpened: boolean;      // 101: orta alana açtı mı
  openMode: 'melds' | 'pairs' | null; // 101: seri/küt mü, çift mi açtı
  openingPoints: number;   // 101: açtığı seri/küt toplamı
  openingPairs: number;    // 101: açtığı çift sayısı
  yuzbirPendingLeftTileId?: string; // 101: soldan alınan taş bu tur açma/işlemede kullanılmalı
}

export type OkeyPublicMeldKind = 'run' | 'set' | 'pair';

export interface OkeyPublicMeld {
  id: string;
  ownerSeat: number;
  kind: OkeyPublicMeldKind;
  tiles: OkeyTile[];
  points: number;
}

export interface OkeyGameState {
  rules: OkeyRuleConfig;
  seed: number;
  elNumber: number;          // 1'den başlar
  dealerSeat: number;        // ekstra taşı alan (eli başlatan)
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
  openMelds: OkeyPublicMeld[]; // 101: orta alanda açılmış per/çiftler
  nextMeldId: number;
  yuzbirMaxOpenPoints: number; // 101 katlamalı: masadaki en yüksek seri açış
  yuzbirMaxOpenPairs: number;  // 101 katlamalı: masadaki en yüksek çift açışı
  yuzbirMeldProcessCounts: Record<string, number>; // 101: aynı elde oyuncu+per başına işlenen taş sayısı
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
    scoring: { ...DEFAULT_OKEY_RULES.scoring, ...(opts.rules?.scoring ?? {}) },
    yuzbir: { ...DEFAULT_OKEY_RULES.yuzbir, ...(opts.rules?.yuzbir ?? {}) } };
  if (rules.variant === 'yuzbir' && opts.rules?.scoring?.startScore == null)
    rules.scoring.startScore = 0;
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
      hasOpened: false, openMode: null, openingPoints: 0, openingPairs: 0,
      yuzbirPendingLeftTileId: undefined,
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
    openMelds: [],
    nextMeldId: 1,
    yuzbirMaxOpenPoints: 0,
    yuzbirMaxOpenPairs: 0,
    yuzbirMeldProcessCounts: {},
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
  // MECBURİYET (revize, kullanıcı kuralı): yalnız SON dağıtılacak elde, hakkı duran HERKESE
  // (bot dahil) otomatik yazılır. Eski grup-sayımı (kalan<=dememiş sayısı) botlar yüzünden
  // 2. elde tetiklenip İNSANLARIN (eşin!) hakkını sessizce yakıyordu — "eş banko diyemiyor" bug'ı.
  if (remaining <= 1) {
    for (let si = 0; si < 4; si++) {
      if (state.bankoUsed[si]) continue;
      state.bankoUsed[si] = true;
      state.bankoChoice[si] = 1;
      state.matchLog.push(`${state.players[si]!.name} için OTOMATİK BANKO (son el mecburiyeti)`);
    }
  }
  // Botlar KARARSIZ başlar — oda onları rastgele gecikmeyle botBankoDecide ile karar verdirir
  // (listeye canlı düşer; %35 banko / %65 pas — kullanıcı ayarı).
}

/** Bot banko kararı (deterministik: seed+el+koltuk): hakkı varsa %35 BANKO, %65 PAS. */
export function botBankoDecide(state: OkeyGameState, seat: number): void {
  if (!state.bankoPhase || state.bankoChoice[seat] !== -1) return;
  if (state.bankoUsed[seat]) { state.bankoChoice[seat] = 0; return; }
  const rng = createRng(state.seed + state.elNumber * 7919 + seat * 104729 + 4242);
  if (rng() < 0.35) {
    state.bankoUsed[seat] = true;
    state.bankoChoice[seat] = 1;
    state.matchLog.push(`${state.players[seat]!.name} BANKO dedi! 🔥`);
  } else {
    state.bankoChoice[seat] = 0;
  }
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
  const isYuzbir = state.rules.variant === 'yuzbir';
  const deal = dealOkey(state.seed + state.elNumber * 7919, state.dealerSeat, isYuzbir
    ? { starterCount: 22, otherCount: 21 }
    : undefined); // el başına farklı ama deterministik dağıtım
  for (let s = 0; s < 4; s++) {
    const p = state.players[s]!;
    p.hand = deal.hands[s]!;
    p.showedGosterge = false;
    p.discardCount = 0;
    p.hasOpened = false;
    p.openMode = null;
    p.openingPoints = 0;
    p.openingPairs = 0;
    p.yuzbirPendingLeftTileId = undefined;
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
  state.openMelds = [];
  state.nextMeldId = 1;
  state.yuzbirMaxOpenPoints = 0;
  state.yuzbirMaxOpenPairs = 0;
  state.yuzbirMeldProcessCounts = {};
  state.elStartScores = [...state.scores]; // yazboz delta tabanı
  // Taahhütler bu elde devreye girer (el DAĞITILMADAN söylenmişti).
  state.bankoThisEl = [...(state.bankoPending ?? [false, false, false, false])];
  state.bankoPending = [false, false, false, false];
  // (otomatik-banko mecburiyeti beginBankoPhase'te uygulanır — seçim listesi herkes görsün diye)
  state.matchLog.push(state.rules.variant === 'yuzbir'
    ? `El ${state.elNumber} başladı — 101, dağıtan: ${state.players[state.dealerSeat]!.name}`
    : `El ${state.elNumber} başladı — gösterge: ${state.gosterge.color}${state.gosterge.rank}, dağıtan: ${state.players[state.dealerSeat]!.name}`);
}

const tileById = (p: OkeyPlayer, id: string) => p.hand.findIndex((t) => t.id === id);

const rankAtPos = (pos: number): number => (pos === 14 ? 1 : pos);

function tilePenaltyValue(t: OkeyTile, state: OkeyGameState): number {
  const id = identityOf(t, state.okeyColor, state.okeyRank);
  return id.wild ? state.okeyRank : id.rank;
}

function runPoints(tiles: readonly OkeyTile[], state: OkeyGameState): number | null {
  if (!isValidRun(tiles, state.okeyColor, state.okeyRank)) return null;
  const ids = tiles.map((t) => identityOf(t, state.okeyColor, state.okeyRank));
  const reals = ids.filter((i) => !i.wild);
  if (reals.length === 0) return null;
  const color = reals[0]!.color;
  if (!reals.every((r) => r.color === color)) return null;
  const wilds = ids.length - reals.length;
  const ones = reals.filter((r) => r.rank === 1).length;
  const rest = reals.filter((r) => r.rank !== 1).map((r) => r.rank as number);
  const oneChoices: number[][] = ones === 0 ? [[]] : ones === 1 ? [[1], [14]] : [[1, 14]];
  let best: number | null = null;
  for (const oc of oneChoices) {
    const pos = [...rest, ...oc].sort((a, b) => a - b);
    if (new Set(pos).size !== pos.length) continue;
    const span = pos[pos.length - 1]! - pos[0]! + 1;
    if (span > tiles.length) continue;
    const gapWilds = span - pos.length;
    const extWilds = tiles.length - span;
    if (gapWilds > wilds) continue;
    for (let left = 0; left <= extWilds; left++) {
      const start = pos[0]! - left;
      const end = pos[pos.length - 1]! + (extWilds - left);
      if (start < 1 || end > 14 || gapWilds + extWilds !== wilds) continue;
      let sum = 0;
      for (let p = start; p <= end; p++) sum += rankAtPos(p);
      if (best == null || sum > best) best = sum;
    }
  }
  return best;
}

function setPoints(tiles: readonly OkeyTile[], state: OkeyGameState): number | null {
  if (!isValidSet(tiles, state.okeyColor, state.okeyRank)) return null;
  const real = tiles.map((t) => identityOf(t, state.okeyColor, state.okeyRank)).find((i) => !i.wild);
  return real ? real.rank * tiles.length : null;
}

function classifyMeld(tiles: readonly OkeyTile[], state: OkeyGameState): { kind: OkeyPublicMeldKind; points: number } | null {
  const rp = runPoints(tiles, state);
  if (rp != null) return { kind: 'run', points: rp };
  const sp = setPoints(tiles, state);
  if (sp != null) return { kind: 'set', points: sp };
  if (isValidPair(tiles, state.okeyColor, state.okeyRank))
    return { kind: 'pair', points: tiles.reduce((a, t) => a + tilePenaltyValue(t, state), 0) };
  return null;
}

export function yuzbirOpeningMin(state: OkeyGameState): number {
  const cfg = state.rules.yuzbir;
  if (!cfg.katlamali || state.yuzbirMaxOpenPoints < cfg.openingMin) return cfg.openingMin;
  return state.yuzbirMaxOpenPoints + 1;
}

export function yuzbirPairOpeningMin(state: OkeyGameState): number {
  const cfg = state.rules.yuzbir;
  if (!cfg.katlamali || state.yuzbirMaxOpenPairs < cfg.pairOpeningMin) return cfg.pairOpeningMin;
  return state.yuzbirMaxOpenPairs + 1;
}

function pickGroupsFromHand(p: OkeyPlayer, groups: string[][]): OkeyTile[][] | string {
  const used = new Set<string>();
  const out: OkeyTile[][] = [];
  for (const g of groups ?? []) {
    if (!Array.isArray(g) || g.length === 0) return 'geçersiz grup';
    const tiles: OkeyTile[] = [];
    for (const id of g) {
      if (used.has(id)) return 'aynı taş iki kez seçilemez';
      const idx = tileById(p, id);
      if (idx < 0) return 'taş elinde değil';
      used.add(id);
      tiles.push(p.hand[idx]!);
    }
    out.push(tiles);
  }
  return out;
}

function removeTiles(p: OkeyPlayer, ids: Iterable<string>): void {
  const rm = new Set(ids);
  p.hand = p.hand.filter((t) => !rm.has(t.id));
}

function pendingLeftError(p: OkeyPlayer, usedIds: Iterable<string>): string | null {
  const id = p.yuzbirPendingLeftTileId;
  if (!id) return null;
  for (const used of usedIds) if (used === id) return null;
  return 'soldan aldığın taşı aynı turda açmalı veya işlemelisin';
}

function clearPendingLeftIfUsed(p: OkeyPlayer, usedIds: Iterable<string>): void {
  const id = p.yuzbirPendingLeftTileId;
  if (!id) return;
  for (const used of usedIds) {
    if (used === id) {
      p.yuzbirPendingLeftTileId = undefined;
      return;
    }
  }
}

function yuzbirProcessKey(seat: number, meldId: string): string {
  return `${seat}:${meldId}`;
}

function bestMeldCoverage(tiles: OkeyTile[], state: OkeyGameState): number {
  return bestGrouping([...tiles], state.okeyColor, state.okeyRank).reduce((n, g) => n + g.length, 0);
}

function canLayAllRemaining(tiles: OkeyTile[], state: OkeyGameState, mode: 'melds' | 'pairs' | null): boolean {
  if (tiles.length === 0) return true;
  if (mode === 'pairs') {
    if (tiles.length % 2 !== 0) return false;
    const groups = pairGroupsFor(tiles, state);
    return groups.reduce((n, g) => n + g.length, 0) === tiles.length;
  }
  return bestMeldCoverage(tiles, state) === tiles.length;
}

export function pairGroupsFor(tiles: readonly OkeyTile[], state: OkeyGameState): OkeyTile[][] {
  const pool = [...tiles];
  const groups: OkeyTile[][] = [];
  const wilds = pool.filter((t) => isOkeyTile(t, state.okeyColor, state.okeyRank));
  for (const w of wilds) pool.splice(pool.indexOf(w), 1);
  const byKey = new Map<string, OkeyTile[]>();
  for (const t of pool) {
    const id = identityOf(t, state.okeyColor, state.okeyRank);
    const k = `${id.color}:${id.rank}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(t);
  }
  const singles: OkeyTile[] = [];
  for (const list of [...byKey.values()].sort((a, b) => a[0]!.id.localeCompare(b[0]!.id))) {
    let i = 0;
    for (; i + 1 < list.length; i += 2) groups.push([list[i]!, list[i + 1]!]);
    if (i < list.length) singles.push(list[i]!);
  }
  while (wilds.length > 0 && singles.length > 0) groups.push([singles.shift()!, wilds.shift()!]);
  while (wilds.length >= 2) groups.push([wilds.shift()!, wilds.shift()!]);
  return groups;
}

export function bestYuzbirMeldOpening(state: OkeyGameState, seat: number): { groups: string[][]; points: number } {
  const groups = bestGrouping([...state.players[seat]!.hand], state.okeyColor, state.okeyRank);
  let points = 0;
  const picked: string[][] = [];
  for (const g of groups) {
    const c = classifyMeld(g, state);
    if (!c || c.kind === 'pair') continue;
    points += c.points;
    picked.push(g.map((t) => t.id));
  }
  return { groups: picked, points };
}

export function bestYuzbirPairOpening(state: OkeyGameState, seat: number): { pairs: string[][]; count: number } {
  const pairs = pairGroupsFor(state.players[seat]!.hand, state);
  return { pairs: pairs.map((g) => g.map((t) => t.id)), count: pairs.length };
}

function sameTileIdentity(a: OkeyTile, b: OkeyTile, state: OkeyGameState): boolean {
  const ia = identityOf(a, state.okeyColor, state.okeyRank);
  const ib = identityOf(b, state.okeyColor, state.okeyRank);
  if (ia.wild || ib.wild) return true;
  return ia.color === ib.color && ia.rank === ib.rank;
}

function canExtendYuzbirMeldWithTile(state: OkeyGameState, meld: OkeyPublicMeld, tile: OkeyTile): boolean {
  if (meld.kind === 'pair') return meld.tiles.some((t) => sameTileIdentity(t, tile, state));
  const test = [...meld.tiles, tile];
  if (meld.kind === 'set') return isValidSet(test, state.okeyColor, state.okeyRank);
  return isValidRun(test, state.okeyColor, state.okeyRank);
}

function canOpenAdditionalWithTile(state: OkeyGameState, seat: number, tile: OkeyTile): boolean {
  const p = state.players[seat]!;
  const groups = bestGrouping([...p.hand, tile], state.okeyColor, state.okeyRank);
  if (p.openMode === 'pairs') {
    return pairGroupsFor([...p.hand, tile], state).some((g) => g.some((t) => t.id === tile.id));
  }
  return groups.some((g) => {
    const c = classifyMeld(g, state);
    return g.some((t) => t.id === tile.id) && !!c && c.kind !== 'pair';
  });
}

function canOpenInitialWithTile(state: OkeyGameState, seat: number, tile: OkeyTile): boolean {
  const p = state.players[seat]!;
  const old = p.hand;
  p.hand = [...p.hand, tile];
  try {
    const meld = bestYuzbirMeldOpening(state, seat);
    if (meld.points >= yuzbirOpeningMin(state) && meld.groups.some((g) => g.includes(tile.id))) return true;
    const pair = bestYuzbirPairOpening(state, seat);
    if (pair.count >= yuzbirPairOpeningMin(state) && pair.pairs.some((g) => g.includes(tile.id))) return true;
    return false;
  } finally {
    p.hand = old;
  }
}

function canTakeYuzbirLeft(state: OkeyGameState, seat: number, tile: OkeyTile): boolean {
  const p = state.players[seat]!;
  if (!p.hasOpened) return canOpenInitialWithTile(state, seat, tile);
  if (state.openMelds.some((m) => canExtendYuzbirMeldWithTile(state, m, tile))) return true;
  return canOpenAdditionalWithTile(state, seat, tile);
}

function openYuzbirMelds(state: OkeyGameState, seat: number, groups: string[][]): OkeyMoveResult {
  if (state.rules.variant !== 'yuzbir') return { ok: false, error: 'bu masa 101 değil' };
  if (state.phase !== 'discard') return { ok: false, error: 'açmak için önce taş çekmelisin' };
  const p = state.players[seat]!;
  const alreadyOpened = p.hasOpened;
  if (p.hasOpened && p.openMode === 'pairs') return { ok: false, error: 'çift açan seri açamaz' };
  const picked = pickGroupsFromHand(p, groups);
  if (typeof picked === 'string') return { ok: false, error: picked };
  if (picked.length === 0) return { ok: false, error: 'açmak için per seç' };
  const pickedIds = picked.flatMap((g) => g.map((t) => t.id));
  const pendingErr = pendingLeftError(p, pickedIds);
  if (pendingErr) return { ok: false, error: pendingErr };
  let total = 0;
  const melds: OkeyPublicMeld[] = [];
  for (const g of picked) {
    const c = classifyMeld(g, state);
    if (!c || c.kind === 'pair') return { ok: false, error: 'seri açışı yalnız geçerli seri/küt gruplarıyla olur' };
    total += c.points;
    melds.push({ id: `m${state.nextMeldId++}`, ownerSeat: seat, kind: c.kind, tiles: g, points: c.points });
  }
  if (!p.hasOpened) {
    const min = yuzbirOpeningMin(state);
    if (total < min) return { ok: false, error: `açmak için en az ${min} gerek` };
  }
  removeTiles(p, pickedIds);
  clearPendingLeftIfUsed(p, pickedIds);
  if (!p.hasOpened) {
    p.hasOpened = true;
    p.openMode = 'melds';
    p.openingPoints = total;
    p.openingPairs = 0;
    state.yuzbirMaxOpenPoints = Math.max(state.yuzbirMaxOpenPoints, total);
  }
  state.openMelds.push(...melds);
  state.matchLog.push(alreadyOpened ? `${p.name} per ekledi` : `${p.name} ${total} ile seri açtı`);
  return { ok: true };
}

function openYuzbirPairs(state: OkeyGameState, seat: number, pairs: string[][]): OkeyMoveResult {
  if (state.rules.variant !== 'yuzbir') return { ok: false, error: 'bu masa 101 değil' };
  if (state.phase !== 'discard') return { ok: false, error: 'açmak için önce taş çekmelisin' };
  const p = state.players[seat]!;
  const alreadyOpened = p.hasOpened;
  if (p.hasOpened && p.openMode !== 'pairs') return { ok: false, error: 'seri açan çift açamaz' };
  const picked = pickGroupsFromHand(p, pairs);
  if (typeof picked === 'string') return { ok: false, error: picked };
  const pickedIds = picked.flatMap((g) => g.map((t) => t.id));
  const pendingErr = pendingLeftError(p, pickedIds);
  if (pendingErr) return { ok: false, error: pendingErr };
  if (!p.hasOpened) {
    const min = yuzbirPairOpeningMin(state);
    if (picked.length < min) return { ok: false, error: `çift açmak için en az ${min} çift gerek` };
  }
  const melds: OkeyPublicMeld[] = [];
  for (const g of picked) {
    if (g.length !== 2 || !isValidPair(g, state.okeyColor, state.okeyRank))
      return { ok: false, error: 'çift açışı yalnız geçerli çiftlerle olur' };
    const c = classifyMeld(g, state)!;
    melds.push({ id: `m${state.nextMeldId++}`, ownerSeat: seat, kind: 'pair', tiles: g, points: c.points });
  }
  removeTiles(p, pickedIds);
  clearPendingLeftIfUsed(p, pickedIds);
  if (!p.hasOpened) {
    p.hasOpened = true;
    p.openMode = 'pairs';
    p.openingPoints = 0;
    p.openingPairs = melds.length;
    state.yuzbirMaxOpenPairs = Math.max(state.yuzbirMaxOpenPairs, melds.length);
  }
  state.openMelds.push(...melds);
  state.matchLog.push(alreadyOpened ? `${p.name} çift ekledi` : `${p.name} ${melds.length} çift ile açtı`);
  return { ok: true };
}

function preferPrependRun(tiles: readonly OkeyTile[], tile: OkeyTile, state: OkeyGameState): boolean {
  const id = identityOf(tile, state.okeyColor, state.okeyRank);
  if (id.wild) return false;
  const real = tiles.map((t) => identityOf(t, state.okeyColor, state.okeyRank)).filter((i) => !i.wild);
  if (real.length === 0) return false;
  const pos = (rank: number) => rank === 1 && real.some((x) => x.rank >= 10) ? 14 : rank;
  return pos(id.rank) < Math.min(...real.map((x) => pos(x.rank)));
}

function extendYuzbirMeld(state: OkeyGameState, seat: number, meldId: string, tileId: string): OkeyMoveResult {
  if (state.rules.variant !== 'yuzbir') return { ok: false, error: 'bu masa 101 değil' };
  if (state.phase !== 'discard') return { ok: false, error: 'işlemek için önce taş çekmelisin' };
  const p = state.players[seat]!;
  if (!p.hasOpened) return { ok: false, error: 'işlemek için önce açmalısın' };
  const meld = state.openMelds.find((m) => m.id === meldId);
  if (!meld) return { ok: false, error: 'per bulunamadı' };
  const idx = tileById(p, tileId);
  if (idx < 0) return { ok: false, error: 'taş elinde değil' };
  const pendingErr = pendingLeftError(p, [tileId]);
  if (pendingErr) return { ok: false, error: pendingErr };
  const processKey = yuzbirProcessKey(seat, meldId);
  const processCount = state.yuzbirMeldProcessCounts[processKey] ?? 0;
  if (processCount >= 2) return { ok: false, error: 'bu pere aynı elde en fazla 2 taş işleyebilirsin' };
  const tile = p.hand[idx]!;
  if (meld.kind === 'pair') {
    if (!canExtendYuzbirMeldWithTile(state, meld, tile)) return { ok: false, error: 'taş bu çifte işlenemez' };
    meld.tiles.push(tile);
  } else if (meld.kind === 'set') {
    const test = [...meld.tiles, tile];
    if (!isValidSet(test, state.okeyColor, state.okeyRank)) return { ok: false, error: 'taş bu küte işlenemez' };
    meld.tiles.push(tile);
  } else {
    const test = [...meld.tiles, tile];
    if (!isValidRun(test, state.okeyColor, state.okeyRank)) return { ok: false, error: 'taş bu seriye işlenemez' };
    if (preferPrependRun(meld.tiles, tile, state)) meld.tiles.unshift(tile);
    else meld.tiles.push(tile);
  }
  const c = classifyMeld(meld.tiles, state);
  if (c) meld.points = c.points;
  p.hand.splice(idx, 1);
  state.yuzbirMeldProcessCounts[processKey] = processCount + 1;
  clearPendingLeftIfUsed(p, [tileId]);
  state.matchLog.push(`${p.name} taş işledi`);
  return { ok: true };
}

export type OkeyMove =
  | { t: 'draw'; from: 'pile' | 'left' }
  | { t: 'open'; groups: string[][] }
  | { t: 'openPairs'; pairs: string[][] }
  | { t: 'extend'; meldId: string; tileId: string }
  | { t: 'discard'; tileId: string }
  | { t: 'finish'; tileId: string }
  | { t: 'gosterge' }
  | { t: 'banko' }    // BANKO varyantı: SEÇİM FAZINDA banko de (maçta 1 hak; geri alınmaz)
  | { t: 'pas' };     // SEÇİM FAZINDA pas geç (liste kapanana dek banko'ya yükseltilebilir)

export function applyOkeyMove(state: OkeyGameState, seat: number, move: OkeyMove): OkeyMoveResult {
  if (state.matchEnded) return { ok: false, error: 'maç bitti' };
  // BANKO FAZI elEnded kontrolünden ÖNCE: faz eller ARASINDA (elEnded=true iken) koşar.
  // Eski sıra ilk el (maç başı) hariç TÜM insan banko/pas komutlarını 'el bitti' diye reddediyordu.
  if (state.bankoPhase) {
    if (move.t === 'banko') return chooseBanko(state, seat);
    if (move.t === 'pas') return choosePas(state, seat);
    return { ok: false, error: 'banko seçimi sürüyor' };
  }
  if (state.elEnded) return { ok: false, error: 'el bitti' };
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
        const top = leftPile[leftPile.length - 1];
        if (!top) return { ok: false, error: 'solda atılmış taş yok' };
        if (state.rules.variant === 'yuzbir' && !canTakeYuzbirLeft(state, seat, top))
          return { ok: false, error: 'soldan taşı ancak hemen açacak veya işleyeceksen alabilirsin' };
        leftPile.pop();
        p.hand.push(top);
        if (state.rules.variant === 'yuzbir') p.yuzbirPendingLeftTileId = top.id;
      } else {
        const top = state.stock.pop();
        if (!top) { endElDraw(state); return { ok: true }; } // deste bitti → berabere
        p.hand.push(top);
        p.yuzbirPendingLeftTileId = undefined;
      }
      state.phase = 'discard';
      return { ok: true };
    }
    case 'open':
      return openYuzbirMelds(state, seat, move.groups);
    case 'openPairs':
      return openYuzbirPairs(state, seat, move.pairs);
    case 'extend':
      return extendYuzbirMeld(state, seat, move.meldId, move.tileId);
    case 'discard': {
      if (state.phase !== 'discard') return { ok: false, error: 'önce taş çekmelisin' };
      if (state.rules.variant === 'yuzbir' && p.yuzbirPendingLeftTileId)
        return { ok: false, error: 'soldan aldığın taşı açmadan/işlemeden taş atamazsın' };
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
      if (state.rules.variant === 'yuzbir' && p.yuzbirPendingLeftTileId)
        return { ok: false, error: 'soldan aldığın taşı açmadan/işlemeden bitemezsin' };
      const idx = tileById(p, move.tileId);
      if (idx < 0) return { ok: false, error: 'taş elinde değil' };
      const thrown = p.hand[idx]!;
      const remaining = p.hand.filter((_, i) => i !== idx);
      let melds = canFinishMelds(remaining, state.okeyColor, state.okeyRank);
      let pairs = !melds && canFinishPairs(remaining, state.okeyColor, state.okeyRank);
      if (state.rules.variant === 'yuzbir') {
        if (p.hasOpened) {
          melds = p.openMode !== 'pairs' && canLayAllRemaining(remaining, state, 'melds');
          pairs = !melds && p.openMode === 'pairs' && canLayAllRemaining(remaining, state, 'pairs');
        } else {
          // 101 elden bitiş: atılan taştan sonra kalan 21 taş tamamen perlere yatmalı.
          melds = canLayAllRemaining(remaining, state, 'melds');
          pairs = false;
        }
      }
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
  if (state.rules.variant === 'yuzbir') return { ok: false, error: '101 masasında gösterge yok' };
  if (p.showedGosterge) return { ok: false, error: 'zaten gösterdin' };
  if (p.discardCount > 0) return { ok: false, error: 'gösterge yalnız ilk taşını atmadan önce gösterilir' };
  const has = p.hand.some((t) => isNormalOkeyTile(t) && t.color === state.gosterge.color && t.rank === state.gosterge.rank);
  if (!has) return { ok: false, error: 'gösterge teki elinde yok' };
  p.showedGosterge = true;
  // KAHVE USULÜ: gösteren KENDİ cezasından düşer (rakiplere ceza yazılmaz).
  state.scores[p.seat] = state.scores[p.seat]! - state.rules.scoring.gosterge;
  state.matchLog.push(`${p.name} göstergeyi gösterdi (kendi cezasından -${state.rules.scoring.gosterge})`);
  return { ok: true };
}

/** KAHVE USULÜ el sonu cezası: rakipler +points CEZA yer; kazanan -points düşer.
 *  EŞLİ KURAL (kullanıcı): biri bitince ORTAĞI DA BİTMİŞ SAYILIR — o da AYNI düşüşü (-points) alır. */
function applyElPoints(state: OkeyGameState, winnerSeat: number, points: number): void {
  for (let s = 0; s < 4; s++) {
    if (s === winnerSeat) { state.scores[s] = state.scores[s]! - points; continue; }
    if (state.rules.teamMode && s % 2 === winnerSeat % 2) {
      state.scores[s] = state.scores[s]! - points; // ortak da düşer (bitmiş sayılır)
      continue;
    }
    state.scores[s] = state.scores[s]! + points;
  }
}

function yuzbirFinishMultiplier(state: OkeyGameState, kind: OkeyFinishKind): number {
  const cfg = state.rules.yuzbir;
  return (kind === 'pairs' || kind === 'pairsOkey' ? cfg.pairPenaltyX : 1)
    * (kind === 'okey' || kind === 'pairsOkey' ? cfg.okeyFinishX : 1);
}

function yuzbirLeftPenalty(state: OkeyGameState, seat: number): number {
  const p = state.players[seat]!;
  const cfg = state.rules.yuzbir;
  if (!p.hasOpened) return cfg.unopenedPenalty;
  const sum = p.hand.reduce((a, t) => a + tilePenaltyValue(t, state), 0);
  return sum * (p.openMode === 'pairs' ? cfg.pairPenaltyX : 1);
}

function endElWinYuzbir(state: OkeyGameState, seat: number, kind: OkeyFinishKind): void {
  const cfg = state.rules.yuzbir;
  const mult = yuzbirFinishMultiplier(state, kind);
  for (let s = 0; s < 4; s++) {
    if (s === seat) {
      state.scores[s] = state.scores[s]! + cfg.winnerBonus * mult;
      continue;
    }
    if (state.rules.teamMode && s % 2 === seat % 2) {
      state.scores[s] = state.scores[s]! + cfg.winnerBonus * mult;
      continue;
    }
    state.scores[s] = state.scores[s]! + yuzbirLeftPenalty(state, s) * mult;
  }
  const kindTxt = kind === 'pairsOkey' ? 'çift + okey' : kind === 'pairs' ? 'çiften' : kind === 'okey' ? 'okey atarak' : 'seri';
  state.matchLog.push(`${state.players[seat]!.name} 101 elini ${kindTxt} bitirdi (çarpan ×${mult})`);
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
    if (state.rules.teamMode && s2 % 2 === seat % 2) {
      // EŞLİ: ortak da bitmiş sayılır — kazananla AYNI düşüşü alır (leftover cezası yok).
      state.scores[s2] = state.scores[s2]! - winPts;
      state.matchLog.push(`${state.players[s2]!.name} (ortak) da bitti sayıldı → −${winPts}`);
      continue;
    }
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
  if (state.rules.variant === 'yuzbir') {
    endElWinYuzbir(state, seat, kind);
    state.elEnded = true;
    state.elWinner = seat;
    state.finishKind = kind;
    pushElDelta(state);
    maybeEndMatchYuzbir(state);
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
  if (state.rules.variant === 'yuzbir') {
    for (let s2 = 0; s2 < 4; s2++) state.scores[s2] = state.scores[s2]! + yuzbirLeftPenalty(state, s2);
    state.matchLog.push('Taşlar bitti — 101 yazbozda herkes elde kalanını ödedi');
    pushElDelta(state);
    maybeEndMatchYuzbir(state);
    return;
  }
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

function maybeEndMatchYuzbir(state: OkeyGameState): void {
  if (state.elNumber < state.rules.totalEls) return;
  state.matchEnded = true;
  const best = Math.min(...state.scores);
  const winners = [0, 1, 2, 3].filter((s2) => state.scores[s2] === best);
  const names = winners.map((s2) => state.players[s2]!.name).join(' & ');
  state.matchLog.push(`101 MAÇ BİTTİ — kazanan: ${names} (${best} puan)`);
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
function tryAutoOpenYuzbir(state: OkeyGameState, seat: number): void {
  if (state.rules.variant !== 'yuzbir') return;
  const p = state.players[seat]!;
  if (p.hasOpened || state.phase !== 'discard') return;
  const pair = bestYuzbirPairOpening(state, seat);
  if (pair.count >= yuzbirPairOpeningMin(state)) {
    applyOkeyMove(state, seat, { t: 'openPairs', pairs: pair.pairs });
    return;
  }
  const meld = bestYuzbirMeldOpening(state, seat);
  if (meld.points >= yuzbirOpeningMin(state))
    applyOkeyMove(state, seat, { t: 'open', groups: meld.groups });
}

export function autoOkeyMove(state: OkeyGameState, seat: number): void {
  if (state.elEnded || state.matchEnded || state.turn !== seat) return;
  if (state.phase === 'draw') {
    applyOkeyMove(state, seat, { t: 'draw', from: 'pile' });
    if (state.elEnded) return;
  }
  tryAutoOpenYuzbir(state, seat);
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
