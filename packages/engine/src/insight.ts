import type { Card, CardId, NormalCard } from './types';
import { isNormalCard } from './types';
import type { RuleConfig } from './rules';
import { enumerateCandidateMelds, solveHand } from './solver';
import { meldPoints } from './melds';

/**
 * SADECE GÖSTERİM amaçlı el analizi: oyuncuya elindeki perleri/çiftleri ve
 * açılabilirlik durumunu canlı gösterir. Asla hamle oynamaz.
 */
export interface HandInsight {
  /** Çakışmayan en iyi per kombinasyonu. */
  melds: Card[][];
  meldPoints: number;
  /** Ayrık özdeş çiftler (aynı rank + aynı renk); joker eşleşmeleri hariç. */
  pairs: Card[][];
  /** Joker tamamlama dahil ulaşılabilir çift sayısı (ÇİFT AÇ değerlendirmesi). */
  pairCount: number;
  canOpenMelds: boolean;
  canOpenPairs: boolean;
}

export function analyzeHand(
  hand: readonly Card[],
  rules: RuleConfig,
  /** Etkin per açma sınırı (çift 101'i ve katlamalı çıtası dahil olabilir). */
  openingMin: number = rules.openingMinPoints,
  /** Etkin çift açma adedi (katlamalı çıtası dahil olabilir). */
  pairsMin: number = rules.pairs.pairsToOpen,
): HandInsight {
  const solved = solveHand(hand, rules, 'points');

  // Özdeş çiftler: (renk, sayı) başına ikişerli gruplar.
  const byIdentity = new Map<string, NormalCard[]>();
  for (const c of hand) {
    if (!isNormalCard(c)) continue;
    const key = `${c.suit}${c.rank}`;
    const list = byIdentity.get(key) ?? [];
    list.push(c);
    byIdentity.set(key, list);
  }
  const pairs: Card[][] = [];
  let singles = 0;
  for (const list of byIdentity.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) {
      pairs.push([list[i]!, list[i + 1]!]);
    }
    if (list.length % 2 === 1) singles++;
  }
  const jokers = hand.filter((c) => c.joker).length;
  const jokerPairs = rules.pairs.enabled
    ? Math.min(rules.pairs.maxJokersPerPair > 0 ? jokers : 0, singles)
    : 0;
  const pairCount = pairs.length + jokerPairs;

  return {
    melds: solved.melds,
    meldPoints: solved.totalPoints,
    pairs,
    pairCount,
    canOpenMelds: solved.totalPoints >= openingMin,
    canOpenPairs: rules.pairs.enabled && pairCount >= pairsMin,
  };
}

/* ------------------------------------------------------------------ */
/* Otomatik açış planları — UI'ın "SERİ AÇ / ÇİFT AÇ" hızlı yolu ve     */
/* botlar AYNI fonksiyonları kullanır (ayrıcalıklı yol yok).            */
/* ------------------------------------------------------------------ */

export interface OpeningPlan {
  melds: Card[][];
  points: number;
}

/**
 * En iyi geçerli açış: maksimum puanlı çakışmayan per kombinasyonu.
 * Elde atacak EN AZ BİR kart bırakır (çözüm tüm eli kapsıyorsa en iyi
 * alt kümeyi arar). Eşik kontrolü çağırana aittir.
 */
export function bestOpening(hand: readonly Card[], rules: RuleConfig): OpeningPlan {
  const solved = solveHand(hand, rules, 'points');
  if (solved.cardCount < hand.length) {
    return { melds: solved.melds, points: solved.totalPoints };
  }
  // Tüm el perde: bir kart ATILACAK, kalan açılacak. Hedef EN YÜKSEK PUAN DEĞİL,
  // BİTİŞ GARANTİSİ: atılan kart sonrası KALANIN TAMAMI geçerli per olmalı (elde
  // geçersiz kalıntı bırakma — yoksa oyuncu o turda bitemez). Örn 5-5-5 + 7-8-9-10-J:
  // bir 5 atılırsa 5-5 kalıntısı kalır (bitemez); doğrusu seriden uçtaki 7'yi atıp
  // 8-9-10-J + 5-5-5'i açmak. Temiz bitiş yoksa eski davranışa (max puan) düş.
  let best: OpeningPlan = { melds: [], points: 0 };
  let clean: OpeningPlan | null = null;
  for (const excluded of hand) {
    const rest = hand.filter((c) => c.id !== excluded.id);
    const sub = solveHand(rest, rules, 'points');
    if (sub.totalPoints > best.points) best = { melds: sub.melds, points: sub.totalPoints };
    // Temiz bitiş: atılan kart hariç kalan kartların HEPSİ perde.
    if (sub.cardCount === rest.length) {
      if (!clean || sub.totalPoints > clean.points) {
        clean = { melds: sub.melds, points: sub.totalPoints };
      }
    }
  }
  return clean ?? best;
}

/**
 * Belirli bir kartı İÇEREN en iyi açış planı (yerden alma doğrulaması:
 * "bu kartı bu tur açışta kullanabilir miyim?"). Atacak kart bırakır.
 */
export function bestOpeningWithCard(
  hand: readonly Card[],
  card: Card,
  rules: RuleConfig,
): OpeningPlan {
  const candidates = enumerateCandidateMelds(hand, rules).filter((c) =>
    c.cards.some((x) => x.id === card.id),
  );
  let best: OpeningPlan = { melds: [], points: 0 };
  for (const cand of candidates) {
    const rest = hand.filter((h) => !cand.cards.some((x) => x.id === h.id));
    const sub = solveHand(rest, rules, 'points');
    let subMelds = sub.melds;
    let subPts = sub.totalPoints;
    if (cand.cards.length + sub.cardCount >= hand.length) {
      // Atacak kart kalmıyor: en düşük puanlı yan perdeyi bırak.
      if (subMelds.length === 0) continue;
      let worstIdx = 0;
      let worstPts = Infinity;
      subMelds.forEach((m, i) => {
        const pts = meldPoints(m, rules) ?? 0;
        if (pts < worstPts) {
          worstPts = pts;
          worstIdx = i;
        }
      });
      subPts -= worstPts;
      subMelds = subMelds.filter((_, i) => i !== worstIdx);
    }
    const points = cand.points + subPts;
    if (points > best.points) best = { melds: [cand.cards, ...subMelds], points };
  }
  return best;
}

export interface PairPlan {
  pairs: CardId[][];
  count: number;
}

/**
 * Eldeki tüm özdeş çift grupları (jokerler en değerli tekleri tamamlar);
 * atacak en az bir kart kalacak şekilde sınırlanır.
 */
export function bestPairOpening(hand: readonly Card[], rules: RuleConfig): PairPlan {
  if (!rules.pairs.enabled) return { pairs: [], count: 0 };
  const byIdentity = new Map<string, NormalCard[]>();
  for (const c of hand) {
    if (!isNormalCard(c)) continue;
    const key = `${c.suit}${c.rank}`;
    const list = byIdentity.get(key) ?? [];
    list.push(c);
    byIdentity.set(key, list);
  }
  const groups: CardId[][] = [];
  const singles: NormalCard[] = [];
  for (const list of byIdentity.values()) {
    for (let i = 0; i + 1 < list.length; i += 2) groups.push([list[i]!.id, list[i + 1]!.id]);
    if (list.length % 2 === 1) singles.push(list[list.length - 1]!);
  }
  if (rules.pairs.maxJokersPerPair > 0) {
    const jokers = hand.filter((c) => c.joker);
    // En değerli tekleri jokerle çifte çevir (elde ceza bırakmaz).
    singles.sort((a, b) => b.rank - a.rank);
    for (let i = 0; i < jokers.length && i < singles.length; i++) {
      groups.push([singles[i]!.id, jokers[i]!.id]);
    }
  }
  const maxPairs = Math.min(groups.length, Math.floor((hand.length - 1) / 2));
  return { pairs: groups.slice(0, maxPairs), count: Math.min(groups.length, maxPairs) };
}
