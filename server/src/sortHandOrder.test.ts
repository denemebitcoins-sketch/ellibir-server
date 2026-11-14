import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../packages/engine/src/rules';
import type { Card, NormalCard } from '../../packages/engine/src/types';
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

  it('groups duplicate-rank hands into two separate sets', () => {
    const hand: Card[] = [
      { id: 'c10a', joker: false, suit: 'C', rank: 10 },
      { id: 'c10b', joker: false, suit: 'C', rank: 10 },
      { id: 'd10a', joker: false, suit: 'D', rank: 10 },
      { id: 'd10b', joker: false, suit: 'D', rank: 10 },
      { id: 's10a', joker: false, suit: 'S', rank: 10 },
      { id: 's10b', joker: false, suit: 'S', rank: 10 },
    ];

    const order = sortHandOrder(hand, DEFAULT_RULES, 'seri');
    expect(order).toHaveLength(hand.length);
    // solveHand arrange ile 2 ayrı 3'lü küt bulunmalı; her küt ardışık 3 indeks kaplar.
    for (let i = 0; i < order.length; i += 3) {
      const group = order.slice(i, i + 3);
      expect(group).toHaveLength(3);
      const ranks = new Set(group.map((id) => (hand.find((c) => c.id === id)! as NormalCard).rank));
      const suits = new Set(group.map((id) => (hand.find((c) => c.id === id)! as NormalCard).suit));
      expect(ranks.size).toBe(1);
      expect(suits.size).toBe(3);
    }
  });
  it('puts the okey into the highest-scoring meld (9-9-okey 27, not 2-okey-4 9)', () => {
    const hand: Card[] = [
      { id: 'h2', joker: false, suit: 'H', rank: 2 },
      { id: 'h4', joker: false, suit: 'H', rank: 4 },
      { id: 's9', joker: false, suit: 'S', rank: 9 },
      { id: 'h9', joker: false, suit: 'H', rank: 9 },
      { id: 'okey', joker: true },
      { id: 'ck', joker: false, suit: 'C', rank: 13 },
    ];
    const order = sortHandOrder(hand, DEFAULT_RULES, 'seri');
    const nines = ['s9', 'h9', 'okey'].map((id) => order.indexOf(id)).sort((a, b) => a - b);
    expect(nines).toEqual([nines[0]!, nines[0]! + 1, nines[0]! + 2]);
    const i2 = order.indexOf('h2'), i4 = order.indexOf('h4'), io = order.indexOf('okey');
    expect(Math.abs(i2 - io) === 1 && Math.abs(i4 - io) === 1).toBe(false);
  });
});
