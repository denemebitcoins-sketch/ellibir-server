import { createRng } from '../deck';

/**
 * TAVLA motoru (Türk tavlası) — saf TS, deterministik (seed + atış sayacı), JSON-serileşebilir.
 * Kurallar: 15 pul, standart diziliş; TEK zarla başlama atışı (büyük atan başlar, kendi çift
 * zarını yeniden atar); çift zar 4 hamle; KAPI (2+ rakip pulu) geçilmez; tek pul KIRILIR (bar'a);
 * kırık rakip evinden girer; tüm pullar evdeyse TOPLAMA (tam sayı; daha büyük zarla en geriden);
 * oyunu ilk toplayan kazanır — rakip HİÇ toplayamadıysa MARS (2 puan), yoksa 1 puan;
 * KATLAMA KÜPÜ (mobil standart): sıra sende + zar atmadan önce, küp ortada/sende ise ×2 teklif;
 * rakip KABUL (küp rakibe geçer) ya da ÇEKİLİR (eski küp değerince kaybeder). TESLİM OL = küp değeri.
 * Oyun puanı = (mars?2:1) × küp. Maç `targetScore` puana (vars. 5).
 *
 * Yön: seat0 23→0 (ev 0-5), seat1 0→23 (ev 18-23). points[i] işaretli: + seat0 adedi, − seat1.
 */

export interface TavlaRuleConfig {
  targetScore: number;      // maç kaç puana (1/3/5)
  turnTimerSeconds: number;
}

export const DEFAULT_TAVLA_RULES: TavlaRuleConfig = { targetScore: 5, turnTimerSeconds: 45 };

export interface TavlaPlayer { seat: number; name: string; isBot: boolean; }

export interface TavlaGameState {
  rules: TavlaRuleConfig;
  seed: number;
  rollCount: number;         // deterministik zar sayacı
  gameNumber: number;        // 1'den başlar
  players: TavlaPlayer[];    // 2 oyuncu (seat 0/1)
  points: number[];          // 24 hane, işaretli pul sayısı
  bar: number[];             // [seat0, seat1] kırık pullar
  off: number[];             // toplanan pullar
  turn: number;
  phase: 'roll' | 'move';
  dice: number[];            // son atılan [d1,d2] (görünüm)
  movesLeft: number[];       // oynanacak zar değerleri (çiftte 4 adet)
  openRoll: number[];        // başlama atışı [seat0zar, seat1zar] (görünüm)
  gameEnded: boolean;
  matchEnded: boolean;
  gameWinner: number;        // -1 yok
  mars: boolean;             // son oyun mars mı bitti
  endReason: string;         // '' | 'normal' | 'drop' (katlamada çekildi) | 'resign' (teslim)
  matchScore: number[];      // [s0, s1]
  gameDeltas: number[][];    // YAZBOZ: oyun başına [p0 kazanç, p1 kazanç]
  matchLog: string[];
  // KATLAMA KÜPÜ
  cubeValue: number;         // 1,2,4,...,64
  cubeOwner: number;         // -1 ortada (ikisi de katlayabilir), 0/1 sahibi
  pendingDouble: number;     // teklifi bekleyen değil TEKLİF EDEN koltuk (-1 yok); rakip cevaplamalı
}

export interface TavlaMoveResult { ok: boolean; error?: string; }

export type TavlaMove =
  | { t: 'roll' }
  | { t: 'move'; from: number; die: number } // from: 0-23 ya da -1 = KIRIK (bar)
  | { t: 'double' }        // KATLAMA teklifi (sıra bende, zar atmadan; küp ortada/bende)
  | { t: 'takeDouble' }    // rakip kabul: küp ×2, sahiplik kabul edene geçer
  | { t: 'dropDouble' }    // rakip çekilir: teklif eden ESKİ küp değerince kazanır
  | { t: 'resign' };       // TESLİM OL: rakip küp değerince kazanır (her an)

function nextDie(state: TavlaGameState): number {
  state.rollCount++;
  const rng = createRng(state.seed + state.rollCount * 7919 + state.gameNumber * 104729);
  return 1 + Math.floor(rng() * 6);
}

export function createTavlaGame(opts: {
  seed: number; names?: string[]; botSeats?: number[]; rules?: Partial<TavlaRuleConfig>;
}): TavlaGameState {
  const rules: TavlaRuleConfig = { ...DEFAULT_TAVLA_RULES, ...(opts.rules ?? {}) };
  const bots = new Set(opts.botSeats ?? []);
  const names = opts.names ?? ['Oyuncu 1', 'Oyuncu 2'];
  const st: TavlaGameState = {
    rules, seed: opts.seed, rollCount: 0, gameNumber: 0,
    players: [0, 1].map((s) => ({ seat: s, name: names[s] ?? `Oyuncu ${s + 1}`, isBot: bots.has(s) })),
    points: new Array(24).fill(0), bar: [0, 0], off: [0, 0],
    turn: 0, phase: 'roll', dice: [0, 0], movesLeft: [], openRoll: [0, 0],
    gameEnded: false, matchEnded: false, gameWinner: -1, mars: false, endReason: '',
    matchScore: [0, 0], gameDeltas: [], matchLog: [],
    cubeValue: 1, cubeOwner: -1, pendingDouble: -1,
  };
  startNextGame(st);
  return st;
}

/** Yeni oyun: standart diziliş + TEK ZARLA başlama atışı (büyük atan başlar). */
export function startNextGame(st: TavlaGameState): void {
  if (st.matchEnded) return;
  st.gameNumber += 1;
  st.points = new Array(24).fill(0);
  // seat0 (+): 23:2, 12:5, 7:3, 5:5 · seat1 (−) aynanın simetriği.
  st.points[23] = 2; st.points[12] = 5; st.points[7] = 3; st.points[5] = 5;
  st.points[0] = -2; st.points[11] = -5; st.points[16] = -3; st.points[18] = -5;
  st.bar = [0, 0]; st.off = [0, 0];
  st.dice = [0, 0]; st.movesLeft = [];
  st.gameEnded = false; st.gameWinner = -1; st.mars = false; st.endReason = '';
  st.cubeValue = 1; st.cubeOwner = -1; st.pendingDouble = -1;
  // Başlama atışı: eşitse yeniden.
  let a = 0, b = 0;
  do { a = nextDie(st); b = nextDie(st); } while (a === b);
  st.openRoll = [a, b];
  st.turn = a > b ? 0 : 1;
  st.phase = 'roll'; // Türk usulü: başlayan KENDİ çift zarını yeniden atar
  st.matchLog.push(`Oyun ${st.gameNumber} — başlama atışı ${a}-${b}: ${st.players[st.turn]!.name} başlıyor`);
}

const ownCount = (st: TavlaGameState, pl: number, i: number) =>
  pl === 0 ? Math.max(0, st.points[i]!) : Math.max(0, -st.points[i]!);
const oppCount = (st: TavlaGameState, pl: number, i: number) => ownCount(st, 1 - pl, i);

/** Tüm pullar evde mi (toplama şartı)? Ev: seat0 0-5, seat1 18-23. */
function allHome(st: TavlaGameState, pl: number): boolean {
  if (st.bar[pl]! > 0) return false;
  for (let i = 0; i < 24; i++) {
    const inHome = pl === 0 ? i <= 5 : i >= 18;
    if (!inHome && ownCount(st, pl, i) > 0) return false;
  }
  return true;
}

export interface TavlaStep { from: number; to: number; die: number; hit: boolean; bearOff: boolean; }

/** Tek zarlık hamle geçerli mi? from=-1 → kırıktan giriş. Geçerliyse adım döner. */
export function stepFor(st: TavlaGameState, pl: number, from: number, die: number): TavlaStep | null {
  if (die < 1 || die > 6) return null;
  if (st.bar[pl]! > 0) {
    if (from !== -1) return null; // önce kırık girer
    const to = pl === 0 ? 24 - die : die - 1;
    if (oppCount(st, pl, to) >= 2) return null; // kapı
    return { from: -1, to, die, hit: oppCount(st, pl, to) === 1, bearOff: false };
  }
  if (from < 0 || from > 23 || ownCount(st, pl, from) === 0) return null;
  const to = pl === 0 ? from - die : from + die;
  if (to >= 0 && to <= 23) {
    if (oppCount(st, pl, to) >= 2) return null;
    return { from, to, die, hit: oppCount(st, pl, to) === 1, bearOff: false };
  }
  // TOPLAMA: tüm pullar evde olmalı.
  if (!allHome(st, pl)) return null;
  const exact = pl === 0 ? from === die - 1 : from === 24 - die;
  if (exact) return { from, to: -1, die, hit: false, bearOff: true };
  // Daha büyük zarla yalnız EN GERİDEKİ pul toplanır.
  if (pl === 0) {
    if (to >= 0) return null; // zar yetmiyor (normal hamleydi zaten)
    for (let i = from + 1; i <= 5; i++) if (ownCount(st, pl, i) > 0) return null;
    return { from, to: -1, die, hit: false, bearOff: true };
  } else {
    if (to <= 23) return null;
    for (let i = from - 1; i >= 18; i--) if (ownCount(st, pl, i) > 0) return null;
    return { from, to: -1, die, hit: false, bearOff: true };
  }
}

/** Kalan zarlarla oynanabilecek TÜM tekil hamleler. */
export function legalSteps(st: TavlaGameState, pl: number): TavlaStep[] {
  const out: TavlaStep[] = [];
  const dies = [...new Set(st.movesLeft)];
  for (const d of dies) {
    if (st.bar[pl]! > 0) {
      const s = stepFor(st, pl, -1, d);
      if (s) out.push(s);
      continue;
    }
    for (let i = 0; i < 24; i++) {
      if (ownCount(st, pl, i) === 0) continue;
      const s = stepFor(st, pl, i, d);
      if (s) out.push(s);
    }
  }
  return out;
}

/** Kırık pulu var VE rakip evinin 6 kapısı da kapalı → hiçbir zar giremez (tam kilit). */
function barLocked(st: TavlaGameState, pl: number): boolean {
  if (st.bar[pl]! <= 0) return false;
  for (let d = 1; d <= 6; d++) {
    const to = pl === 0 ? 24 - d : d - 1;
    if (oppCount(st, pl, to) < 2) return false;
  }
  return true;
}

function endTurn(st: TavlaGameState): void {
  st.movesLeft = [];
  const next = 1 - st.turn;
  // KULLANICI KURALI: kırık + TÜM kapılar kapalıysa rakibe zar attırıp vakit kaybettirme —
  // sıra otomatik geri döner. (Emniyet: iki taraf birden kilitliyse normal devir → deadlock yok.)
  if (barLocked(st, next) && !barLocked(st, st.turn)) {
    st.matchLog.push(`${st.players[next]!.name} kırık ve tüm kapılar kapalı — sıra otomatik geçti`);
    st.phase = 'roll';
    return; // turn değişmez
  }
  st.turn = next;
  st.phase = 'roll';
}

function applyStep(st: TavlaGameState, pl: number, s: TavlaStep): void {
  if (s.from === -1) st.bar[pl] = st.bar[pl]! - 1;
  else st.points[s.from] = st.points[s.from]! + (pl === 0 ? -1 : 1);
  if (s.bearOff) { st.off[pl] = st.off[pl]! + 1; return; }
  if (s.hit) {
    st.points[s.to] = 0;
    st.bar[1 - pl] = st.bar[1 - pl]! + 1;
    st.matchLog.push(`${st.players[pl]!.name} kırdı!`);
  }
  st.points[s.to] = st.points[s.to]! + (pl === 0 ? 1 : -1);
}

export function applyTavlaMove(st: TavlaGameState, seat: number, move: TavlaMove): TavlaMoveResult {
  if (st.matchEnded) return { ok: false, error: 'maç bitti' };
  if (st.gameEnded) return { ok: false, error: 'oyun bitti' };

  // ── KATLAMA / TESLİM (sıra şartından bağımsız hamleler önce) ──
  if (move.t === 'resign') {
    endGameWin(st, 1 - seat, st.cubeValue, 'resign');
    st.matchLog.push(`${st.players[seat]!.name} TESLİM OLDU`);
    return { ok: true };
  }
  if (move.t === 'takeDouble' || move.t === 'dropDouble') {
    if (st.pendingDouble < 0) return { ok: false, error: 'katlama teklifi yok' };
    if (seat === st.pendingDouble) return { ok: false, error: 'cevabı rakip verir' };
    if (move.t === 'takeDouble') {
      st.cubeValue = Math.min(64, st.cubeValue * 2);
      st.cubeOwner = seat;
      st.pendingDouble = -1;
      st.matchLog.push(`${st.players[seat]!.name} katlamayı KABUL etti — küp ×${st.cubeValue}`);
      return { ok: true };
    }
    // RED = TESLİM DEĞİL (kullanıcı kuralı): teklif düşer, oyun MEVCUT değerle sürer.
    // Küp reddedene geçer — aynı oyuncu üst üste teklifle taciz edemez; reddeden ileride katlayabilir.
    st.pendingDouble = -1;
    st.cubeOwner = seat;
    st.matchLog.push(`${st.players[seat]!.name} katlamayı KABUL ETMEDİ — oyun ×${st.cubeValue} sürüyor`);
    return { ok: true };
  }
  if (st.pendingDouble >= 0) return { ok: false, error: 'katlama cevabı bekleniyor' };
  if (st.turn !== seat) return { ok: false, error: 'sıra sende değil' };
  if (move.t === 'double') {
    if (st.phase !== 'roll') return { ok: false, error: 'katlama zar atmadan önce yapılır' };
    if (st.cubeOwner !== -1 && st.cubeOwner !== seat) return { ok: false, error: 'küp rakipte' };
    if (st.cubeValue >= 64) return { ok: false, error: 'küp tavanda' };
    st.pendingDouble = seat;
    st.matchLog.push(`${st.players[seat]!.name} KATLADI — teklif ×${st.cubeValue * 2}`);
    return { ok: true };
  }

  if (move.t === 'roll') {
    if (st.phase !== 'roll') return { ok: false, error: 'zaten attın — hamleni oyna' };
    const d1 = nextDie(st), d2 = nextDie(st);
    st.dice = [d1, d2];
    st.movesLeft = d1 === d2 ? [d1, d1, d1, d1] : [d1, d2];
    st.phase = 'move';
    if (legalSteps(st, seat).length === 0) {
      st.matchLog.push(`${st.players[seat]!.name} ${d1}-${d2} attı — oynayacak hamle yok`);
      endTurn(st);
    }
    return { ok: true };
  }

  // move
  if (st.phase !== 'move') return { ok: false, error: 'önce zar at' };
  if (!st.movesLeft.includes(move.die)) return { ok: false, error: 'bu zar elinde yok' };
  const s = stepFor(st, seat, move.from, move.die);
  if (!s) return { ok: false, error: 'geçersiz hamle' };
  applyStep(st, seat, s);
  st.movesLeft.splice(st.movesLeft.indexOf(move.die), 1);

  // Oyun bitti mi?
  if (st.off[seat] === 15) { endGameWin(st, seat); return { ok: true }; }
  // Kalan zarla hamle yoksa sıra geçer.
  if (st.movesLeft.length === 0 || legalSteps(st, seat).length === 0) endTurn(st);
  return { ok: true };
}

function endGameWin(st: TavlaGameState, seat: number, ptsOverride?: number, reason: string = 'normal'): void {
  // ptsOverride: katlamada çekilme / teslim — mars sayılmaz, puan doğrudan küp değeri.
  const mars = ptsOverride == null && st.off[1 - seat] === 0;
  const pts = ptsOverride != null ? ptsOverride : (mars ? 2 : 1) * st.cubeValue;
  st.matchScore[seat] = st.matchScore[seat]! + pts;
  const delta = [0, 0]; delta[seat] = pts;
  st.gameDeltas.push(delta);
  st.gameEnded = true;
  st.gameWinner = seat;
  st.mars = mars;
  st.endReason = reason;
  st.matchLog.push(`${st.players[seat]!.name} oyunu ${mars ? 'MARS ile' : 'kazandı'} (${pts} puan${st.cubeValue > 1 ? ', küp ×' + st.cubeValue : ''}) — skor ${st.matchScore[0]}-${st.matchScore[1]}`);
  if (st.matchScore[seat]! >= st.rules.targetScore) {
    st.matchEnded = true;
    st.matchLog.push(`MAÇ BİTTİ — ${st.players[seat]!.name} ${st.matchScore[seat]} puanla kazandı`);
  }
}

/** PIP sayısı: tüm pulların eve uzaklık toplamı (küçük = önde). Kırık = 25 pip. */
export function pipCount(st: TavlaGameState, pl: number): number {
  let pip = st.bar[pl]! * 25;
  for (let i = 0; i < 24; i++) {
    const c = pl === 0 ? Math.max(0, st.points[i]!) : Math.max(0, -st.points[i]!);
    if (c > 0) pip += c * (pl === 0 ? i + 1 : 24 - i);
  }
  return pip;
}

/** Süre dolunca: zar at (gerekirse) + kalan zarları ilk geçerli hamleyle oyna. */
export function autoTavlaMove(st: TavlaGameState, seat: number): void {
  if (st.gameEnded || st.matchEnded) return;
  if (st.pendingDouble >= 0 && st.pendingDouble !== seat) {
    applyTavlaMove(st, seat, { t: 'takeDouble' }); // süre doldu → oto-kabul
    return;
  }
  if (st.turn !== seat) return;
  if (st.phase === 'roll') applyTavlaMove(st, seat, { t: 'roll' });
  let guard = 0;
  while (!st.gameEnded && st.turn === seat && st.phase === 'move' && guard++ < 8) {
    const steps = legalSteps(st, seat);
    if (steps.length === 0) { endTurn(st); break; }
    applyTavlaMove(st, seat, { t: 'move', from: steps[0]!.from, die: steps[0]!.die });
  }
}
