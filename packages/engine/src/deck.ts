import type { Card, NormalCard, Rank, Suit } from './types';
import { RANKS, SUITS } from './types';
import type { RuleConfig } from './rules';

/** Deterministik, taşınabilir RNG (mulberry32). Testler ve sunucu replay için. */
export type Rng = () => number;

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeCardId(suit: Suit, rank: Rank, copy: number): string {
  return `${suit}${rank}-${copy}`;
}

/** 2 deste + 4 joker = 108 kart (kurallara göre). */
export function buildDeck(rules: RuleConfig): Card[] {
  const cards: Card[] = [];
  for (let copy = 0; copy < rules.deckCount; copy++) {
    for (const suit of SUITS) {
      for (const rank of RANKS) {
        cards.push({ id: makeCardId(suit, rank, copy), joker: false, suit, rank });
      }
    }
  }
  for (let j = 0; j < rules.jokerCount; j++) {
    cards.push({ id: `JOKER-${j}`, joker: true });
  }
  return cards;
}

/** Fisher-Yates; verilen RNG ile deterministik. Yeni dizi döndürür. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const arr = items.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = arr[i]!;
    arr[i] = arr[j]!;
    arr[j] = tmp;
  }
  return arr;
}

export interface DealResult {
  hands: Card[][];
  stock: Card[];
}

/**
 * Kartları dağıtır: herkese handSize, dağıtıcıya +dealerExtraCards.
 * Açık yığın başlatılmaz — dağıtıcı ilk kartı atarak oyunu başlatır.
 */
export function deal(deck: Card[], rules: RuleConfig, dealerSeat: number): DealResult {
  const hands: Card[][] = Array.from({ length: rules.playerCount }, () => []);
  const stock = deck.slice();
  for (let i = 0; i < rules.handSize; i++) {
    for (let p = 0; p < rules.playerCount; p++) {
      hands[p]!.push(stock.pop()!);
    }
  }
  for (let i = 0; i < rules.dealerExtraCards; i++) {
    hands[dealerSeat]!.push(stock.pop()!);
  }
  return { hands, stock };
}
