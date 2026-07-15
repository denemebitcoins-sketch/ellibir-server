import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../packages/engine/src/rules';
import type { Card } from '../../packages/engine/src/types';
import { sortHandOrder } from './clientView';

describe('51 visual hand arrangement', () => {
  it('reallocates an overlapping ace into its set instead of leaving two aces loose', () => {
    const hand: Card[] = [
      { id: 'h10', joker: false, suit: 'H', rank: 10 },
      { id: 'h11', joker: false, suit: 'H', rank: 11 },
      { id: 'h12', joker: false, suit: 'H', rank: 12 },
      { id: 'okey', joker: true },
      { id: 'ha', joker: false, suit: 'H', rank: 1 },
      { id: 'sa', joker: false, suit: 'S', rank: 1 },
      { id: 'da', joker: false, suit: 'D', rank: 1 },
    ];

    const order = sortHandOrder(hand, DEFAULT_RULES, 'seri');
    const aceIndexes = ['ha', 'sa', 'da'].map((id) => order.indexOf(id)).sort((a, b) => a - b);
    const runIndexes = ['h10', 'h11', 'h12', 'okey'].map((id) => order.indexOf(id)).sort((a, b) => a - b);

    expect(order).toHaveLength(hand.length);
    expect(aceIndexes).toEqual([aceIndexes[0]!, aceIndexes[0]! + 1, aceIndexes[0]! + 2]);
    expect(runIndexes).toEqual([runIndexes[0]!, runIndexes[0]! + 1, runIndexes[0]! + 2, runIndexes[0]! + 3]);
  });
});
