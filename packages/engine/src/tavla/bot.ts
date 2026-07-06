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

export function evalPosition(st: TavlaGameState, pl: number): number {
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
      if (c === 1) {
        const shots = directShots(st, pl, i);
        if (shots > 0) {
          // Vurulursa kaybedilecek pip (geriden vurulmak daha acı).
          const pipLoss = pl === 0 ? 25 - (i + 1) : 25 - (24 - i);
          sc -= shots * 3 + pipLoss * 0.35;
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
    gameDeltas: st.gameDeltas,   // salt-okunur kullanılır
    matchLog: [],                // plan simülasyonunda log biriktirme
    players: st.players,
  };
}

interface PlanNode { g: TavlaGameState; steps: TavlaStep[]; }

const BEAM = 24;

/** Bu turda oynanabilecek EN İYİ tam plan (adım listesi). Boş = hamle yok. */
export function bestTavlaTurn(st: TavlaGameState, seat: number): TavlaStep[] {
  if (st.turn !== seat || st.phase !== 'move' || st.movesLeft.length === 0) return [];
  let frontier: PlanNode[] = [{ g: cloneState(st), steps: [] }];
  let bestLeaf: PlanNode | null = null;
  let bestLeafScore = -Infinity;
  let maxDepthReached = 0;

  for (let depth = 0; depth < 4; depth++) {
    const next: PlanNode[] = [];
    for (const node of frontier) {
      const steps = legalSteps(node.g, seat);
      if (steps.length === 0) continue;
      for (const s of steps) {
        const g2 = cloneState(node.g);
        const r = applyTavlaMove(g2, seat, { t: 'move', from: s.from, die: s.die });
        if (!r.ok) continue;
        next.push({ g: g2, steps: [...node.steps, s] });
      }
    }
    if (next.length === 0) break;
    maxDepthReached = depth + 1;
    // Bitmiş (oyun kazanılmış ya da zar tükenmiş/sıra geçmiş) düğümler yaprak adayı.
    for (const n of next) {
      const done = n.g.gameEnded || n.g.turn !== seat || n.g.movesLeft.length === 0
        || legalSteps(n.g, seat).length === 0;
      if (done) {
        const sc = (n.g.gameEnded && n.g.gameWinner === seat ? 10000 : 0) + evalPosition(n.g, seat)
          + n.steps.length * 50; // ZORUNLU MAKSİMUM OYNAMA: daha çok zar kullanan plan üstün
        if (sc > bestLeafScore) { bestLeafScore = sc; bestLeaf = n; }
      }
    }
    // Beam: canlı düğümlerden en iyi BEAM kadarıyla devam.
    const alive = next.filter((n) => !n.g.gameEnded && n.g.turn === seat && n.g.movesLeft.length > 0);
    alive.sort((a, b) => evalPosition(b.g, seat) - evalPosition(a.g, seat));
    frontier = alive.slice(0, BEAM);
    if (frontier.length === 0) break;
  }
  return bestLeaf ? bestLeaf.steps : [];
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
