import type { Card, JokerCard, NormalCard, Rank, Suit } from '../src/types';

let copyCounter = 0;

/** Test kartı üretir; copy verilmezse benzersiz id için sayaç kullanılır. */
export function c(suit: Suit, rank: Rank, copy?: number): NormalCard {
  const n = copy ?? copyCounter++;
  return { id: `${suit}${rank}-t${n}`, joker: false, suit, rank };
}

export function joker(n = 0): JokerCard {
  return { id: `JOKER-t${n}`, joker: true };
}

export function ids(cards: readonly Card[]): string[] {
  return cards.map((card) => card.id);
}
