import {
  TavlaGameState, TavlaStep, applyTavlaMove, legalSteps, stepFor,
} from './game';

/** Rakip bu haneye tek zarla vurabilir mi (kaba blot riski)? */
function blotRisk(st: TavlaGameState, pl: number, i: number): boolean {
  const opp = 1 - pl;
  for (let d = 1; d <= 6; d++) {
    if (st.bar[opp]! > 0) {
      const to = opp === 0 ? 24 - d : d - 1;
      if (to === i) return true;
      continue;
    }
    const from = opp === 0 ? i + d : i - d;
    if (from < 0 || from > 23) continue;
    const cnt = opp === 0 ? st.points[from]! : -st.points[from]!;
    if (cnt > 0) return true;
  }
  return false;
}

function scoreStep(st: TavlaGameState, pl: number, s: TavlaStep): number {
  let sc = s.die; // ilerleme
  if (s.bearOff) return 120 + s.die;
  const own = (i: number) => (pl === 0 ? Math.max(0, st.points[i]!) : Math.max(0, -st.points[i]!));
  if (s.hit) {
    // Rakibi ne kadar geriye attık (rakip pip'i)?
    const oppPip = pl === 0 ? 24 - s.to : s.to + 1;
    sc += 55 + oppPip;
  }
  if (s.from !== -1 && own(s.from) === 2) sc -= 12;            // arkada blot bırakma
  const after = own(s.to) + 1;
  if (after >= 2) sc += 25;                                     // kapı yapma/koruma
  else if (blotRisk(st, pl, s.to)) sc -= 18;                    // açığa blot
  const inHome = pl === 0 ? s.to <= 5 : s.to >= 18;
  if (inHome && after >= 2) sc += 6;                            // ev kapısı değerli
  return sc;
}

/** Sıradaki EN İYİ tek hamle (server adım adım oynatır → client animasyonuna yer). */
export function bestTavlaStep(st: TavlaGameState, seat: number): TavlaStep | null {
  const steps = legalSteps(st, seat);
  if (steps.length === 0) return null;
  let best = steps[0]!, bestSc = -1e9;
  for (const s of steps) {
    const sc = scoreStep(st, seat, s);
    if (sc > bestSc) { bestSc = sc; best = s; }
  }
  return best;
}

/** Bot tam turunu oynar: zar atar + kalan zarları sezgisel en iyi hamleyle bitirir. */
export function playTavlaBotTurn(st: TavlaGameState, seat: number): void {
  if (st.gameEnded || st.matchEnded || st.turn !== seat) return;
  if (st.phase === 'roll') applyTavlaMove(st, seat, { t: 'roll' });
  let guard = 0;
  while (!st.gameEnded && st.turn === seat && st.phase === 'move' && guard++ < 8) {
    const steps = legalSteps(st, seat);
    if (steps.length === 0) break; // motor kendisi sıra geçirir
    let best: TavlaStep = steps[0]!, bestSc = -1e9;
    for (const s of steps) {
      const sc = scoreStep(st, seat, s);
      if (sc > bestSc) { bestSc = sc; best = s; }
    }
    const r = applyTavlaMove(st, seat, { t: 'move', from: best.from, die: best.die });
    if (!r.ok) break; // güvenlik: motorla çelişirse kilitlenme yok
  }
}

export { stepFor };
