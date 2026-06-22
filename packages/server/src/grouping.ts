import { enumerateCandidateMelds } from '../../engine/src/solver';
import { analyzePair } from '../../engine/src/melds';
import { analyzeHand } from '../../engine/src/insight';
import type { Card, NormalCard } from '../../engine/src/types';
import type { RuleConfig } from '../../engine/src/rules';

/**
 * RN sortHand birebir: tespit edilen perler/çiftler en sola (bitişik bloklar),
 * kalanlar sıralı, jokerler en sağda. Bloklardan sonra GÖRSEL boşluk (gapAfter).
 * Motorun analyzeHand'i ile GERÇEK perler tanınır (renk/rank uydurması değil).
 */
export function arrangeHand(
  hand: Card[],
  rules: RuleConfig,
  mode: 'seri' | 'cift',
): { order: Card[]; gapAfter: number[] } {
  const insight = analyzeHand(hand, rules);
  const blocks = mode === 'seri' ? insight.melds : insight.pairs;
  const used = new Set<string>();
  const order: Card[] = [];
  const gapAfter: number[] = [];
  for (const block of blocks) {
    for (const c of block) {
      order.push(c);
      used.add(c.id);
    }
    gapAfter.push(order.length - 1); // blok sonrası boşluk
  }
  const suitOrder: Record<string, number> = { S: 0, H: 1, C: 2, D: 3 };
  const rest = hand.filter((c) => !used.has(c.id) && !c.joker) as NormalCard[];
  rest.sort((a, b) => {
    const bySuit = (suitOrder[a.suit] ?? 0) - (suitOrder[b.suit] ?? 0);
    const byRank = a.rank - b.rank;
    return mode === 'seri' ? bySuit || byRank : byRank || bySuit;
  });
  for (const c of rest) order.push(c);
  const jokers = hand.filter((c) => !used.has(c.id) && c.joker);
  if (jokers.length > 0 && order.length > 0) gapAfter.push(order.length - 1);
  for (const c of jokers) order.push(c);
  return { order, gapAfter };
}

/**
 * Seçili kartları (oyuncunun "şunlarla açıyorum" dediği set) GEÇERLİ perlere
 * BÖL — istemci yalnız kart seçer, gruplama sunucuda (motor doğrulamasıyla).
 * Tam bölüm (tüm seçili kartlar kullanılmalı); bulunamazsa null → istemciye ret.
 * "En düşük kapsanmamış kart" budamasıyla permütasyon patlaması önlenir.
 */
export function groupIntoMelds(cards: Card[], rules: RuleConfig): string[][] | null {
  const n = cards.length;
  if (n === 0) return null;
  const cands = enumerateCandidateMelds(cards, rules); // mask = bu dizinin indeksleri
  cands.sort((a, b) => popcount(b.mask) - popcount(a.mask));
  const full = (1 << n) - 1;
  let result: Card[][] | null = null;

  const bt = (used: number, chosen: Card[][]): boolean => {
    if (used === full) {
      result = chosen.map((g) => g.slice());
      return true;
    }
    let bit = 0;
    while (used & (1 << bit)) bit++; // en düşük kapsanmamış kart
    for (const c of cands) {
      if ((c.mask & used) !== 0) continue;
      if ((c.mask & (1 << bit)) === 0) continue; // o kartı kapsamalı
      chosen.push(c.cards);
      if (bt(used | c.mask, chosen)) return true;
      chosen.pop();
    }
    return false;
  };

  bt(0, []);
  return result ? result.map((g) => g.map((card) => card.id)) : null;
}

/** Seçili kartları geçerli ÇİFTlere böl (her çift 2 kart). */
export function groupIntoPairs(cards: Card[], rules: RuleConfig): string[][] | null {
  const n = cards.length;
  if (n === 0 || n % 2 !== 0) return null;
  const full = (1 << n) - 1;
  let result: string[][] | null = null;

  const bt = (used: number, chosen: string[][]): boolean => {
    if (used === full) {
      result = chosen.map((g) => g.slice());
      return true;
    }
    let a = 0;
    while (used & (1 << a)) a++;
    for (let b = a + 1; b < n; b++) {
      if (used & (1 << b)) continue;
      if (analyzePair([cards[a]!, cards[b]!], rules)) {
        chosen.push([cards[a]!.id, cards[b]!.id]);
        if (bt(used | (1 << a) | (1 << b), chosen)) return true;
        chosen.pop();
      }
    }
    return false;
  };

  bt(0, []);
  return result;
}

function popcount(x: number): number {
  let c = 0;
  while (x) {
    x &= x - 1;
    c++;
  }
  return c;
}
