import { describe, expect, it } from 'vitest';
import { buildDeck, createRng, deal, shuffle } from '../src/deck';
import { DEFAULT_RULES } from '../src/rules';

describe('deste', () => {
  it('RULES.md 1.1 invariant: 2 deste + 2 okey = 106 kart; her kart tam 2 kez', () => {
    const deck = buildDeck(DEFAULT_RULES);
    expect(deck).toHaveLength(106);
    expect(deck.filter((c) => c.joker)).toHaveLength(2);
    // Her suit+rank kombinasyonundan tam 2 adet.
    const counts = new Map<string, number>();
    for (const card of deck) {
      if (card.joker) continue;
      const key = `${card.suit}${card.rank}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(52);
    expect([...counts.values()].every((n) => n === 2)).toBe(true);
  });

  it('aynı seed aynı karışımı, farklı seed farklı karışımı verir', () => {
    const deck = buildDeck(DEFAULT_RULES);
    const a = shuffle(deck, createRng(42)).map((c) => c.id);
    const b = shuffle(deck, createRng(42)).map((c) => c.id);
    const c2 = shuffle(deck, createRng(43)).map((c) => c.id);
    expect(a).toEqual(b);
    expect(a).not.toEqual(c2);
  });

  it('dağıtım: herkese 14, dağıtıcıya 15', () => {
    const deck = shuffle(buildDeck(DEFAULT_RULES), createRng(7));
    const { hands, stock } = deal(deck, DEFAULT_RULES, 2);
    expect(hands[0]).toHaveLength(14);
    expect(hands[1]).toHaveLength(14);
    expect(hands[2]).toHaveLength(15);
    expect(hands[3]).toHaveLength(14);
    // Dağıtım sonrası invariant: eller + deste = 106.
    expect(stock).toHaveLength(106 - 14 * 4 - 1);
  });
});
