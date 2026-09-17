import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { applyTavlaMove, createTavlaGame, legalSteps, type TavlaGameState, type TavlaStep } from '../src/tavla/game';
import { bestTavlaTurn, evalPosition, isTavlaRace, tavlaHitRolls } from '../src/tavla/bot';

const cases: { label: string; state: TavlaGameState; seat: number; plan: TavlaStep[]; hits: number[]; score: number }[] = [];
const games: { seed: number; snapshots: string[] }[] = [];
function empty(): TavlaGameState {
  const s = createTavlaGame({ seed: 7 });
  s.points.fill(0); s.bar = [0, 0]; s.off = [0, 0];
  s.turn = 0; s.phase = 'move'; s.movesLeft = [3, 1]; s.dice = [3, 1];
  return s;
}
function inspect(s: TavlaGameState, label: string) {
  const before = JSON.stringify(s), seat = s.turn;
  const plan = bestTavlaTurn(s, seat), hits = tavlaHitRolls(s, seat), score = evalPosition(s, seat);
  expect(JSON.stringify(s)).toBe(before);
  if (process.env.TAVLA_BOT_CORPUS_FILE) cases.push({ label, state: structuredClone(s), seat, plan, hits, score });
  return plan;
}
function snapshot(s: TavlaGameState): string {
  return [s.turn, s.phase, +s.gameEnded, s.gameWinner, s.rollCount, s.points.join(','), s.bar.join(','),
    s.off.join(','), s.movesLeft.join(','), s.matchScore.join(','), s.gameDeltas.map(r => r.join(',')).join('/')].join('|');
}
function applyPlan(s: TavlaGameState, steps: TavlaStep[]) {
  for (const step of steps) expect(applyTavlaMove(s, s.turn, { t: 'move', from: step.from, die: step.die }).ok).toBe(true);
}
afterAll(() => {
  if (process.env.TAVLA_BOT_CORPUS_FILE) writeFileSync(process.env.TAVLA_BOT_CORPUS_FILE, JSON.stringify({ cases, games }));
});

describe('Tavla public-board strategy', () => {
  it('does not write simulation moves into the live undo history', () => {
    const s = createTavlaGame({ seed: 21 });
    s.turnHistory = [{ points: [...s.points], bar: [...s.bar], off: [...s.off], movesLeft: [...s.movesLeft] }];
    expect(inspect(s, 'undo isolation').length).toBeGreaterThan(0);
    expect(s.turnHistory).toHaveLength(1);
  });

  it('does not append simulated wins into the real score sheet', () => {
    const s = empty(); s.points[0] = 1; s.off[0] = 14; s.points[20] = -14; s.off[1] = 1;
    s.movesLeft = [1, 2];
    const plan = inspect(s, 'winning simulation isolation');
    expect(s.gameDeltas).toEqual([]);
    applyPlan(s, plan);
    expect(s.gameWinner).toBe(0);
    expect(s.gameDeltas).toHaveLength(1);
  });

  it('counts a one-pip direct hit in 11 of 36 rolls', () => {
    const s = empty(); s.points[8] = 1; s.points[20] = 14; s.points[7] = -1; s.points[23] = -14;
    expect(tavlaHitRolls(s, 0)[8]).toBe(11);
    inspect(s, 'direct eleven rolls');
  });

  it('counts indirect hits and doubles, respecting blocked intermediate points', () => {
    const s = empty(); s.points[8] = 1; s.points[20] = 14; s.points[0] = -1; s.points[23] = -14;
    expect(tavlaHitRolls(s, 0)[8]).toBe(6);
    inspect(s, 'indirect eight pips');
    s.points[4] = 2; s.points[20] = 12;
    expect(tavlaHitRolls(s, 0)[8]).toBe(4);
    inspect(s, 'blocked double routes');
    for (const i of [2, 3, 5, 6]) s.points[i] = 2;
    s.points[20] = 4;
    expect(tavlaHitRolls(s, 0)[8]).toBe(0);
  });

  it('does not let an opponent attack from the board before clearing the bar', () => {
    const s = empty(); s.points[8] = 1; s.points[20] = 14; s.points[7] = -1; s.points[23] = -12; s.bar[1] = 2;
    expect(tavlaHitRolls(s, 0)[8]).toBe(2);
    inspect(s, 'two bar checkers');
    s.points[23] = -10; s.bar[1] = 4;
    expect(tavlaHitRolls(s, 0)[8]).toBe(0);
  });

  it('separates racing from contact and bears off instead of building decorative doors', () => {
    const s = empty(); s.points[5] = 1; s.points[4] = 1; s.points[0] = 13; s.points[18] = -15;
    s.movesLeft = [6, 5];
    expect(isTavlaRace(s)).toBe(true);
    expect(tavlaHitRolls(s, 0).every(n => n === 0)).toBe(true);
    const plan = inspect(s, 'race bearoff');
    applyPlan(s, plan);
    expect(s.off[0]).toBe(2);
    s.bar[1] = 1; s.points[18] = -14;
    expect(isTavlaRace(s)).toBe(false);
  });

  it('uses the higher die when only one of two dice can be played', () => {
    const s = empty(); s.bar[0] = 1; s.points[0] = 14; s.points[21] = -2; s.points[18] = -13;
    s.movesLeft = [1, 2];
    const plan = inspect(s, 'forced higher die');
    expect(plan).toHaveLength(1);
    expect(plan[0]!.die).toBe(2);
  });

  it('is independent of hidden future RNG state and remains deterministic', () => {
    const s = createTavlaGame({ seed: 19 });
    const plan = inspect(s, 'rng baseline');
    const changed = structuredClone(s); changed.seed = 983456; changed.rollCount += 400;
    expect(inspect(changed, 'rng permutation')).toEqual(plan);
    expect(bestTavlaTurn(s, s.turn)).toEqual(plan);
  });

  it('mirrors hit exposure across seats', () => {
    const s = empty(); s.points[8] = 1; s.points[20] = 14; s.points[0] = -1; s.points[23] = -14;
    const mirror = structuredClone(s);
    mirror.points = [...s.points].reverse().map(n => -n); mirror.bar.reverse(); mirror.off.reverse(); mirror.turn = 1;
    expect(tavlaHitRolls(mirror, 1)).toEqual([...tavlaHitRolls(s, 0)].reverse());
    expect(evalPosition(mirror, 1)).toBe(evalPosition(s, 0));
    inspect(mirror, 'mirrored exposure');
  });

  it('preserves the maximum playable dice compared with exhaustive small-board plans', () => {
    function maxSteps(s: TavlaGameState, seat: number): number {
      if (s.gameEnded || s.turn !== seat || s.phase !== 'move') return 0;
      let best = 0;
      for (const step of legalSteps(s, seat)) {
        const n = structuredClone(s);
        applyTavlaMove(n, seat, { t: 'move', from: step.from, die: step.die });
        best = Math.max(best, 1 + maxSteps(n, seat));
      }
      return best;
    }
    for (let a = 1; a <= 6; a++) for (let b = a; b <= 6; b++) {
      const s = empty(); s.points[5] = 3; s.points[0] = 12; s.points[21] = -3; s.points[23] = -12;
      s.movesLeft = a === b ? [a, a, a, a] : [a, b];
      const plan = inspect(s, `max dice ${a}-${b}`);
      expect(plan.length).toBe(maxSteps(s, 0));
    }
  });

  it('plays complete seeded games legally with 15 checkers per side', () => {
    for (let seed = 0; seed < 8; seed++) {
      const s = createTavlaGame({ seed, botSeats: [0, 1] });
      const snapshots = [snapshot(s)];
      for (let turn = 0; !s.gameEnded; turn++) {
        expect(turn).toBeLessThan(1200);
        if (s.phase === 'roll') expect(applyTavlaMove(s, s.turn, { t: 'roll' }).ok).toBe(true);
        if (s.phase === 'move') {
          const plan = inspect(s, `game ${seed} turn ${turn}`);
          expect(plan.length).toBeGreaterThan(0);
          applyPlan(s, plan);
        }
        for (let seat = 0; seat < 2; seat++) expect(s.bar[seat]! + s.off[seat]! + s.points.reduce((n, p) => n + Math.max(0, seat === 0 ? p : -p), 0)).toBe(15);
        snapshots.push(snapshot(s));
      }
      games.push({ seed, snapshots });
    }
  }, 120_000);
});
