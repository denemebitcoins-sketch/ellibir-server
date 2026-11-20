import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AfkGuard } from './afkGuard';

describe('AfkGuard', () => {
  let now = 0; let took: number[] = []; let removed: number[] = [];
  const mk = () => new AfkGuard({ takeOver: s => took.push(s), remove: s => removed.push(s) }, 180_000, 3, () => now);
  beforeEach(() => { vi.useFakeTimers(); now = 0; took = []; removed = []; });
  afterEach(() => vi.useRealTimers());

  it('three late turns hand the seat to a bot; removal after 3 minutes', () => {
    const g = mk();
    for (let i = 0; i < 3; i++) { now = 50_000; g.beforeCommand(1, 40_000); g.afterCommand(1, false); }
    expect(took).toEqual([1]);
    vi.advanceTimersByTime(179_000); expect(removed).toEqual([]);
    vi.advanceTimersByTime(2_000); expect(removed).toEqual([1]);
  });

  it('a timely turn resets the streak; draw then discard counts as one turn', () => {
    const g = mk();
    now = 50_000; g.beforeCommand(2, 40_000); g.afterCommand(2, false);
    g.timedOut(2);
    now = 10_000; g.beforeCommand(2, 40_000); g.afterCommand(2, true); now = 45_000; g.beforeCommand(2, 40_000); g.afterCommand(2, false);
    g.timedOut(2); g.timedOut(2);
    expect(took).toEqual([]);
    g.timedOut(2); expect(took).toEqual([2]);
  });

  it('coming back pauses the clock but does not refill it; a timely turn clears it', () => {
    const g = mk();
    g.away(0, true);
    vi.advanceTimersByTime(150_000); now = 150_000;
    g.away(0, false);                       // döndü: 30 sn kaldı
    vi.advanceTimersByTime(600_000);
    expect(removed).toEqual([]);
    g.away(0, true);                        // yine gitti → kalan 30 sn
    vi.advanceTimersByTime(29_000); expect(removed).toEqual([]);
    vi.advanceTimersByTime(2_000); expect(removed).toEqual([0]);
    g.away(3, true); now = 200_000; g.away(3, false);
    now = 210_000; g.beforeCommand(3, 230_000); g.afterCommand(3, false); // süresinde oynadı
    g.away(3, true); vi.advanceTimersByTime(179_000); expect(removed).toEqual([0]);
  });
});
