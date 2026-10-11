import { describe, it, expect } from 'vitest';
import { createTavlaGame, applyTavlaMove, autoTavlaMove, playableSteps, legalSteps, bestTavlaStep, TavlaGameState } from '../src/tavla';

/**
 * Regresyon: ZORUNLU ZAR KURALI. Eskiden motor herhangi bir geçerli tekil adımı kabul ediyordu:
 * oyuncu bir zarı, diğerini oynanamaz bırakacak şekilde oynayabiliyor; tek zar oynanabilirken
 * küçük zarı seçebiliyordu. Standart tavla: en çok zar oynanır; tek zar oynanabiliyorsa büyüğü.
 */
function board(dice: [number, number]): TavlaGameState {
  const st = createTavlaGame({ seed: 5, names: ['A', 'B'] });
  st.points = new Array(24).fill(0);
  st.bar = [0, 0]; st.off = [0, 0];
  st.turn = 0; st.phase = 'move';
  st.dice = [...dice];
  st.movesLeft = dice[0] === dice[1] ? [dice[0], dice[0], dice[0], dice[0]] : [...dice];
  st.pendingDouble = -1; st.pendingResign = -1;
  return st;
}

/** seat0 pulları: idx10 ve idx7 (13 toplanmış); rakip kapıları idx4, idx1, idx0. Zar 6-1.
 *  7→6 (1) oynanırsa 6 hiçbir yerde oynanamaz; 10→9 (1) sonra 9→3 (6) iki zarı da oynatır. */
function trap(): TavlaGameState {
  const st = board([6, 1]);
  st.points[10] = 1; st.points[7] = 1; st.off[0] = 13;
  st.points[4] = -2; st.points[1] = -2; st.points[0] = -2; st.points[20] = -9;
  return st;
}

describe('tavla zorunlu zar kuralı', () => {
  it('iki zar oynanabiliyorsa diğer zarı engelleyen adım reddedilir', () => {
    const st = trap();
    expect(legalSteps(st, 0).some((s) => s.from === 7 && s.die === 1)).toBe(true); // ham kural izin verirdi
    expect(playableSteps(st, 0).map((s) => `${s.from}/${s.die}`)).toEqual(['10/1']);
    const bad = applyTavlaMove(st, 0, { t: 'move', from: 7, die: 1 });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/hepsini oynamalısın/);
    expect(st.points[7]).toBe(1);
    expect(applyTavlaMove(st, 0, { t: 'move', from: 10, die: 1 }).ok).toBe(true);
    expect(applyTavlaMove(st, 0, { t: 'move', from: 9, die: 6 }).ok).toBe(true);
    expect(st.points[3]).toBe(1);
    expect(st.turn).toBe(1);
  });

  it('yalnız bir zar oynanabiliyorsa büyük zar zorunlu', () => {
    const st = board([6, 2]);
    st.points[10] = 1; st.off[0] = 14;
    st.points[2] = -2; st.points[20] = -13; // 10→4→2 ve 10→8→2 kapalı
    expect(playableSteps(st, 0).map((s) => s.die)).toEqual([6]);
    const small = applyTavlaMove(st, 0, { t: 'move', from: 10, die: 2 });
    expect(small.ok).toBe(false);
    expect(small.error).toMatch(/büyük zar/);
    expect(applyTavlaMove(st, 0, { t: 'move', from: 10, die: 6 }).ok).toBe(true);
    expect(st.turn).toBe(1); // kalan 2 oynanamaz → sıra geçer
  });

  it('son pulu toplayan (oyunu bitiren) adım, zar artsa da serbesttir', () => {
    const st = board([6, 1]);
    st.points[1] = 1; st.off[0] = 14; st.points[20] = -15;
    expect(applyTavlaMove(st, 0, { t: 'move', from: 1, die: 6 }).ok).toBe(true);
    expect(st.gameEnded).toBe(true);
    expect(st.gameWinner).toBe(0);
  });

  it('süre-doldu otomatik hamlesi ve bot da kurala uyar', () => {
    const auto = trap();
    autoTavlaMove(auto, 0);
    expect(auto.points[7]).toBe(1);
    expect(auto.points[3]).toBe(1);
    expect(auto.turn).toBe(1);

    const bot = trap();
    const s = bestTavlaStep(bot, 0)!;
    expect(`${s.from}/${s.die}`).toBe('10/1');
  });
});
