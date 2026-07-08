import { describe, expect, it } from 'vitest';
import { planYuzbirSoloPayout } from './supabase';

const scoresOf = (rows: Array<[number, number]>) => new Map<number, number>(rows);

describe('101 Okey tekli payout planı', () => {
  it('yalnız bir oyuncu el açtıysa dağıtılabilir havuzun tamamını alır', () => {
    const plan = planYuzbirSoloPayout({
      bet: 1000,
      totalSeats: 4,
      scores: scoresOf([[0, 60], [1, 120], [2, 202], [3, 202]]),
      openedSeats: [1],
    });
    expect(plan.house).toBe(100);
    expect(plan.prizePool).toBe(3900);
    expect(plan.payouts.get(1)).toBe(3900);
    expect(plan.winners.has(1)).toBe(true);
  });

  it('birden fazla açan varsa en düşük ceza 3/4, ikinci 1/4 alır', () => {
    const plan = planYuzbirSoloPayout({
      bet: 1000,
      totalSeats: 4,
      scores: scoresOf([[0, 34], [1, 78], [2, 110], [3, 202]]),
      openedSeats: [0, 1, 2],
    });
    expect(plan.payouts.get(0)).toBe(2925);
    expect(plan.payouts.get(1)).toBe(975);
    expect(plan.payouts.has(2)).toBe(false);
    expect(plan.winners.has(0)).toBe(true);
    expect(plan.winners.has(1)).toBe(false);
  });

  it('aynı cezadaki birinciler birinci payını eşit böler', () => {
    const plan = planYuzbirSoloPayout({
      bet: 1000,
      totalSeats: 4,
      scores: scoresOf([[0, 44], [1, 44], [2, 90], [3, 120]]),
      openedSeats: [0, 1, 2, 3],
    });
    expect(plan.payouts.get(0)).toBe(1463);
    expect(plan.payouts.get(1)).toBe(1462);
    expect(plan.payouts.get(2)).toBe(975);
    expect(plan.winners.has(0)).toBe(true);
    expect(plan.winners.has(1)).toBe(true);
  });

  it('tüm açanlar aynı cezada kalırsa havuz tamamen eşit bölünür', () => {
    const plan = planYuzbirSoloPayout({
      bet: 1000,
      totalSeats: 4,
      scores: scoresOf([[0, 55], [1, 55], [2, 202], [3, 202]]),
      openedSeats: [0, 1],
    });
    expect(plan.payouts.get(0)).toBe(1950);
    expect(plan.payouts.get(1)).toBe(1950);
    expect(plan.winners.has(0)).toBe(true);
    expect(plan.winners.has(1)).toBe(true);
  });

  it('maç sonu ödeme final elde açanlara değil toplam skor sıralamasına göre yapılır', () => {
    const plan = planYuzbirSoloPayout({
      bet: 1000,
      totalSeats: 4,
      scores: scoresOf([[0, 20], [1, 120], [2, 70], [3, 202]]),
      openedSeats: [1, 3],
      eligibleSeats: [0, 1, 2, 3],
    });
    expect(plan.eligibleSeats).toEqual([0, 2, 1, 3]);
    expect(plan.payouts.get(0)).toBe(2925);
    expect(plan.payouts.get(2)).toBe(975);
    expect(plan.payouts.has(1)).toBe(false);
    expect(plan.winners.has(0)).toBe(true);
  });
});
