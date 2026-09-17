import {
  TavlaGameState, TavlaStep, applyTavlaMove, legalSteps, stepFor, pipCount,
} from './game';

/** Bot KATLAMA teklif etsin mi? Belirgin pip üstünlüğü + küp erişilebilir + tavan altı. */
export function shouldOfferDouble(st: TavlaGameState, seat: number): boolean {
  if (st.phase !== 'roll' || st.pendingDouble >= 0 || st.pendingResign >= 0) return false;
  if (st.cubeOwner !== -1 && st.cubeOwner !== seat) return false;
  if (st.cubeValue >= 8) return false; // bot küpü aşırı şişirmesin
  const my = pipCount(st, seat), opp = pipCount(st, 1 - seat);
  return my < opp * 0.8 && opp - my >= 20;
}

/** Bot katlamayı KABUL etsin mi? Umutsuz değilse al (standart ~%25 kural yaklaşığı). */
export function shouldTakeDouble(st: TavlaGameState, seat: number): boolean {
  const my = pipCount(st, seat), opp = pipCount(st, 1 - seat);
  return my <= opp * 1.35 + 8;
}

/** Bot teslim teklifini kabul etsin mi? Mars şansı belirginse reddeder. */
export function shouldAcceptResign(st: TavlaGameState, seat: number): boolean {
  const offerer = 1 - seat;
  if (st.off[offerer]! > 0) return true; // Mars zaten kaçtı, oyun olsun.
  const my = pipCount(st, seat), opp = pipCount(st, offerer);
  const strongMarsChance = my + 18 < opp || st.bar[offerer]! > 0 || st.off[seat]! >= 8;
  return !strongMarsChance;
}

/* ════════ POZİSYON DEĞERLENDİRME (tur-seviyesi arama için) ════════
   Yüksek skor = `seat` için iyi. Tavla bilgisi:
   - KAPI (2+ pul) değerlidir; EV kapıları ve özellikle 5-HANE + BAR-HANE en değerli (gele/prime).
   - BLOT (tek pul) rakibin vuruş menzilindeyse cezalıdır (kırılan pul 25 pip kaybettirir).
   - Rakip evinde ÇAPA (anchor) güvenlik sağlar; ardışık kapılar (prime) rakibi hapseder.
   - Aşırı yığılma (5+) hamle esnekliğini öldürür. */

const own = (st: TavlaGameState, pl: number, i: number) =>
  pl === 0 ? Math.max(0, st.points[i]!) : Math.max(0, -st.points[i]!);

/** Rakip bu haneyi TEK zarla vurabilir mi (bar dahil)? → kaç farklı zar vurur. */
function directShots(st: TavlaGameState, pl: number, i: number): number {
  const opp = 1 - pl;
  let shots = 0;
  for (let d = 1; d <= 6; d++) {
    if (st.bar[opp]! > 0) {
      const to = opp === 0 ? 24 - d : d - 1;
      if (to === i) shots++;
      continue;
    }
    const from = opp === 0 ? i + d : i - d;
    if (from < 0 || from > 23) continue;
    if (own(st, opp, from) > 0) shots++;
  }
  return shots;
}

/** Hanenin `pl` için değeri (kapı yapıldığında). Kendi ev bölgesi + bar-hane premium. */
function pointValue(pl: number, i: number): number {
  // pl perspektifinde hane numarası 1..24 (1 = en ev)
  const n = pl === 0 ? i + 1 : 24 - i;
  if (n === 5) return 14;      // 5-HANE (altın nokta)
  if (n === 7) return 12;      // BAR-HANE
  if (n === 4) return 10;
  if (n === 6) return 9;
  if (n === 3) return 7;
  if (n === 2) return 4;
  if (n === 1) return 3;
  if (n === 20) return 11;     // rakip 5-hanesinde ÇAPA
  if (n >= 19 && n <= 24) return 7; // rakip evinde çapa
  if (n >= 8 && n <= 12) return 5;  // dış bölge kapısı
  return 3;
}

export function isTavlaRace(st: TavlaGameState): boolean {
  if (st.bar[0]! > 0 || st.bar[1]! > 0) return false;
  let last0 = -1, first1 = 24;
  for (let i = 0; i < 24; i++) {
    if (st.points[i]! > 0) last0 = i;
    if (st.points[i]! < 0 && first1 === 24) first1 = i;
  }
  return last0 < first1;
}

function structuralScore(st: TavlaGameState, pl: number, quickRisk: boolean): number {
  const opp = 1 - pl;
  let sc = 0;

  // 1) Yarış: pip farkı (temel itici).
  sc += (pipCount(st, opp) - pipCount(st, pl)) * 1.0;

  // 2) Kırıklar: rakibinki iyi, benimki kötü (pip zaten sayıyor; ek taktik ağırlık).
  sc += st.bar[opp]! * 14;
  sc -= st.bar[pl]! * 8;

  // 3) Toplananlar (pip'in ötesinde bitirme momentumu).
  sc += st.off[pl]! * 4;
  sc -= st.off[opp]! * 4;

  if (isTavlaRace(st)) {
    // With no contact, doors/anchors cannot block anyone. Prefer efficient bearing off.
    sc += (st.off[pl]! - st.off[opp]!) * 4;
    for (let n = 1; n <= 2; n++) {
      const i = pl === 0 ? n - 1 : 24 - n;
      sc -= Math.max(0, own(st, pl, i) - (n + 1)) * (3 - n);
    }
    return sc;
  }

  // 4) Haneler: kapılar + prime + blot riski + yığılma.
  let primeRun = 0;
  for (let i = 0; i < 24; i++) {
    const c = own(st, pl, i);
    if (c >= 2) {
      sc += pointValue(pl, i);
      if (c > 4) sc -= (c - 4) * 2;         // aşırı yığılma
      primeRun++;
      if (primeRun >= 2) sc += (primeRun - 1) * 4; // ardışık kapı (prime) büyür
    } else {
      primeRun = 0;
      if (c === 1 && quickRisk) {
        const shots = directShots(st, pl, i);
        if (shots > 0) {
          // Vurulursa kaybedilecek pip (geriden vurulmak daha acı).
          const pipLoss = pl === 0 ? 25 - (i + 1) : 25 - (24 - i);
          sc -= shots * 3 + Math.floor(pipLoss / 3);
        } else {
          sc -= 1; // menzil dışı blot yine de küçük risk
        }
      }
    }
  }

  // 5) Rakip kapıları benim giriş şansımı kısar (gele riski) — rakip evi kapalılığı.
  let oppHomeClosed = 0;
  for (let i = 0; i < 24; i++) {
    const n = opp === 0 ? i + 1 : 24 - i;
    if (n <= 6 && own(st, opp, i) >= 2) oppHomeClosed++;
  }
  if (st.bar[pl]! > 0) sc -= oppHomeClosed * 6; // kırığım varken kapalı ev felaket

  return sc;
}

/** Number of the 36 equally likely rolls that offer a hit on each current blot.
 * Paths include bar priority, both die orders and repeated doubles, using the real move engine.
 * Multiple blot counts are conservative exposures, not mutually compatible hit choices.
 */
export function tavlaHitRolls(st: TavlaGameState, defender: number): number[] {
  const result = new Array<number>(24).fill(0);
  if (isTavlaRace(st)) return result;
  const attacker = 1 - defender;
  for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) {
    const root = cloneState(st);
    root.turn = attacker; root.phase = 'move'; root.gameEnded = false; root.matchEnded = false;
    root.pendingDouble = -1; root.pendingResign = -1;
    root.movesLeft = a === b ? [a, a, a, a] : [a, b];
    let hitMask = 0;
    const advance = (g: TavlaGameState, from: number, die: number) => {
      const step = stepFor(g, attacker, from, die);
      if (!step) return null;
      const next = cloneState(g);
      if (!applyTavlaMove(next, attacker, { t: 'move', from, die }).ok) return null;
      if (step.hit && own(st, defender, step.to) === 1) hitMask |= 1 << step.to;
      return { next, step };
    };
    const active = (g: TavlaGameState) => !g.gameEnded && g.phase === 'move' && g.turn === attacker;
    const follow = (g: TavlaGameState, from: number): void => {
      if (!active(g)) return;
      for (const die of new Set(g.movesLeft)) {
        const n = advance(g, from, die);
        if (n && !n.step.bearOff) follow(n.next, n.step.to);
      }
    };
    const enter = (g: TavlaGameState): void => {
      if (!active(g)) return;
      if (g.bar[attacker]! === 0) {
        for (let i = 0; i < 24; i++) if (own(g, attacker, i) > 0) follow(g, i);
      } else {
        for (const die of new Set(g.movesLeft)) {
          const n = advance(g, -1, die);
          if (n) enter(n.next);
        }
      }
    };
    enter(root);
    const weight = a === b ? 1 : 2;
    for (let i = 0; i < 24; i++) if (hitMask & (1 << i)) result[i] = result[i]! + weight;
  }
  return result;
}

function detailedScore(st: TavlaGameState, pl: number): number {
  let score = structuralScore(st, pl, false) * 36;
  const rolls = tavlaHitRolls(st, pl);
  let closed = 0;
  for (let n = 1; n <= 6; n++) if (own(st, 1 - pl, pl === 0 ? 24 - n : n - 1) >= 2) closed++;
  for (let i = 0; i < 24; i++) if (rolls[i]! > 0) {
    const loss = pl === 0 ? 24 - i : i + 1;
    score -= rolls[i]! * (loss + 8 + closed * 3);
  }
  return score;
}

export function evalPosition(st: TavlaGameState, pl: number): number {
  return detailedScore(st, pl) / 36;
}

/* ════════ TUR-SEVİYESİ ARAMA: tüm zar dizilimleri beam-search ile ════════ */

function cloneState(st: TavlaGameState): TavlaGameState {
  return {
    ...st,
    points: st.points.slice(),
    bar: st.bar.slice(),
    off: st.off.slice(),
    dice: st.dice.slice(),
    movesLeft: st.movesLeft.slice(),
    openRoll: st.openRoll.slice(),
    pendingResign: st.pendingResign,
    matchScore: st.matchScore.slice(),
    gameDeltas: st.gameDeltas.map(row => row.slice()),
    turnHistory: [],
    turnSnap: null,
    matchLog: [],                // plan simülasyonunda log biriktirme
    players: st.players,
  };
}

interface PlanNode { g: TavlaGameState; steps: TavlaStep[]; score: number; order: number; }

const BEAM = 24;

/** Bu turda oynanabilecek EN İYİ tam plan (adım listesi). Boş = hamle yok. */
export function bestTavlaTurn(st: TavlaGameState, seat: number): TavlaStep[] {
  if (st.gameEnded || st.matchEnded || st.turn !== seat || st.phase !== 'move' || st.movesLeft.length === 0) return [];
  let order = 0;
  let frontier: PlanNode[] = [{ g: cloneState(st), steps: [], score: 0, order: order++ }];
  const leaves: PlanNode[] = [];
  const maxMemo = new Map<string, number>();
  const key = (g: TavlaGameState) => `${g.points.join(',')}|${g.bar}|${g.off}|${[...g.movesLeft].sort()}|${g.phase}|${g.turn}`;
  const active = (g: TavlaGameState) => !g.gameEnded && g.turn === seat && g.phase === 'move' && g.movesLeft.length > 0;
  const maxPlayable = (g: TavlaGameState): number => {
    if (!active(g)) return 0;
    const k = key(g), cached = maxMemo.get(k);
    if (cached !== undefined) return cached;
    let best = 0;
    for (const step of legalSteps(g, seat)) {
      const next = cloneState(g);
      if (!applyTavlaMove(next, seat, { t: 'move', from: step.from, die: step.die }).ok) continue;
      best = Math.max(best, 1 + maxPlayable(next));
      if (best === g.movesLeft.length) break;
    }
    maxMemo.set(k, best);
    return best;
  };
  const required = maxPlayable(st);

  for (let depth = 0; depth < 4; depth++) {
    const next: PlanNode[] = [];
    const seen = new Set<string>();
    for (const node of frontier) {
      const steps = legalSteps(node.g, seat);
      if (steps.length === 0) continue;
      for (const s of steps) {
        const g2 = cloneState(node.g);
        const r = applyTavlaMove(g2, seat, { t: 'move', from: s.from, die: s.die });
        if (!r.ok) continue;
        const steps = [...node.steps, s];
        if (!g2.gameEnded && steps.length + maxPlayable(g2) < required) continue;
        const k = key(g2) + (node.steps.length === 0 ? `|${s.die}` : '');
        if (seen.has(k)) continue;
        seen.add(k);
        next.push({ g: g2, steps, score: structuralScore(g2, seat, true), order: order++ });
      }
    }
    if (next.length === 0) break;
    // Bitmiş (oyun kazanılmış ya da zar tükenmiş/sıra geçmiş) düğümler yaprak adayı.
    for (const n of next) {
      if (!active(n.g) || legalSteps(n.g, seat).length === 0) leaves.push(n);
    }
    // Beam: canlı düğümlerden en iyi BEAM kadarıyla devam.
    const alive = next.filter(n => active(n.g));
    alive.sort((a, b) => b.score - a.score || a.order - b.order);
    frontier = alive.slice(0, BEAM);
    if (frontier.length === 0) break;
  }
  const priority = (n: PlanNode) => n.g.gameEnded && n.g.gameWinner === seat ? 100 :
    n.steps.length * 10 + (n.steps.length === 1 ? n.steps[0]!.die : 0);
  leaves.sort((a, b) => priority(b) - priority(a) || b.score - a.score || a.order - b.order);
  let bestLeaf: PlanNode | null = null, bestScore = -Infinity;
  for (const n of leaves.filter(n => priority(n) === priority(leaves[0]!)).slice(0, BEAM)) {
    const score = detailedScore(n.g, seat);
    if (score > bestScore) { bestScore = score; bestLeaf = n; }
  }
  return bestLeaf?.steps ?? [];
}

/** Sıradaki EN İYİ tek hamle = en iyi tam planın İLK adımı (server adım adım oynatır). */
export function bestTavlaStep(st: TavlaGameState, seat: number): TavlaStep | null {
  const plan = bestTavlaTurn(st, seat);
  return plan.length > 0 ? plan[0]! : null;
}

/** Bot tam turunu oynar: zar atar + planın tamamını uygular. */
export function playTavlaBotTurn(st: TavlaGameState, seat: number): void {
  if (st.gameEnded || st.matchEnded || st.turn !== seat) return;
  if (st.phase === 'roll') applyTavlaMove(st, seat, { t: 'roll' });
  let guard = 0;
  while (!st.gameEnded && st.turn === seat && st.phase === 'move' && guard++ < 8) {
    const s = bestTavlaStep(st, seat);
    if (s == null) break; // motor kendisi sıra geçirir
    const r = applyTavlaMove(st, seat, { t: 'move', from: s.from, die: s.die });
    if (!r.ok) break;
  }
}

export { stepFor };
