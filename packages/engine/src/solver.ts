import type { Card, NormalCard } from './types';
import { isNormalCard } from './types';
import { SUITS } from './types';
import type { RuleConfig } from './rules';
import { analyzeCards } from './melds';

/**
 * El çözücü: eldeki kartlardan birbiriyle çakışmayan en iyi perde
 * kombinasyonunu bulur. Botların açma / bitirme kararlarında kullanılır.
 * Kartlar bit maskesiyle temsil edilir (el <= 16 kart olduğundan ucuz).
 */

export interface CandidateMeld {
  cards: Card[];
  mask: number;
  points: number;
  type: 'set' | 'run';
}

export interface SolveResult {
  melds: Card[][];
  totalPoints: number;
  cardCount: number;
}

function combinations<T>(items: readonly T[], size: number): T[][] {
  if (size === 0) return [[]];
  if (items.length < size) return [];
  const [first, ...rest] = items as [T, ...T[]];
  const withFirst = combinations(rest, size - 1).map((c) => [first, ...c]);
  return [...withFirst, ...combinations(rest, size)];
}

/** Eldeki kartlardan tüm geçerli perde adaylarını üretir. */
export function enumerateCandidateMelds(hand: readonly Card[], rules: RuleConfig): CandidateMeld[] {
  const index = new Map<string, number>(hand.map((c, i) => [c.id, i]));
  const maskOf = (cards: readonly Card[]) =>
    cards.reduce((m, c) => m | (1 << index.get(c.id)!), 0);

  const jokers = hand.filter((c) => c.joker);
  const candidates = new Map<number, CandidateMeld>();

  const tryAdd = (cards: Card[]) => {
    const analysis = analyzeCards(cards, rules);
    if (!analysis) return;
    const mask = maskOf(cards);
    const existing = candidates.get(mask);
    if (!existing || analysis.points > existing.points) {
      candidates.set(mask, { cards: analysis.cards, mask, points: analysis.points, type: analysis.type as 'set' | 'run' });
    }
  };

  // KÜT adayları: rank başına farklı renkler + jokerler.
  const byRank = new Map<number, NormalCard[]>();
  for (const c of hand) {
    if (!isNormalCard(c)) continue;
    const list = byRank.get(c.rank) ?? [];
    list.push(c);
    byRank.set(c.rank, list);
  }
  for (const cards of byRank.values()) {
    // Aynı renkten kopyaları tekille (iki desteden aynı kart gelebilir).
    const bySuit = new Map(cards.map((c) => [c.suit, c]));
    const unique = [...bySuit.values()];
    // Okey sınırı yok (RULES.md 1.3) — yalnız rank kaynağı için ≥1 gerçek kart.
    // ÖNEMLİ: okey alt-kümeleri ayrı adaylar üretir; yoksa iki ayrı per hep
    // AYNI okeye bağlanır ve ikinci okey kullanılamaz (bilinen bug).
    for (let jokerUse = 0; jokerUse <= jokers.length; jokerUse++) {
      for (let size = rules.minSetSize; size <= rules.maxSetSize; size++) {
        const realCount = size - jokerUse;
        if (realCount < 1 || realCount > unique.length) continue;
        for (const combo of combinations(unique, realCount)) {
          for (const js of combinations(jokers, jokerUse)) {
            tryAdd([...combo, ...js]);
          }
        }
      }
    }
  }

  // SERİ adayları: renk başına ardışık pencereler, joker boşluk doldurur.
  for (const suit of SUITS) {
    const ofSuit = hand.filter((c): c is NormalCard => isNormalCard(c) && c.suit === suit);
    if (ofSuit.length === 0) continue;
    const byPos = new Map<number, NormalCard>();
    for (const c of ofSuit) {
      // As YALNIZ üstten (pozisyon 14) — A-2-3 perisi yoktur.
      const pos = c.rank === 1 ? 14 : c.rank;
      if (!byPos.has(pos)) byPos.set(pos, c);
    }
    for (let start = 2; start <= 14; start++) {
      for (let len = rules.minRunLength; start + len - 1 <= 14; len++) {
        // Pencereyi gerçek kartlar + okey gereken boşluk işaretleriyle kur.
        const slots: Array<Card | null> = [];
        let jokerNeed = 0;
        let realCount = 0;
        const usedIds = new Set<string>();
        let ok = true;
        for (let pos = start; pos < start + len; pos++) {
          const real = byPos.get(pos);
          if (real && !usedIds.has(real.id)) {
            slots.push(real);
            usedIds.add(real.id);
            realCount++;
          } else {
            jokerNeed++;
            // Okey sınırı yok — eldeki okey sayısı tek doğal sınırdır.
            if (jokerNeed > jokers.length) {
              ok = false;
              break;
            }
            slots.push(null);
          }
        }
        if (!ok || realCount < 1) continue;
        // Her okey ALT-KÜMESİ ayrı aday (ikinci okeyin de kullanılabilmesi için).
        for (const js of combinations(jokers, jokerNeed)) {
          let ji = 0;
          tryAdd(slots.map((s) => s ?? js[ji++]!));
        }
      }
    }
  }

  return [...candidates.values()];
}

/**
 * Çakışmayan perde alt kümesini seçer.
 * objective 'points': toplam puanı maksimize eder (açma kararı).
 * objective 'cards' : önce eritilen kart sayısını, sonra puanı maksimize eder (bitirme).
 * objective 'arrange': önce dizilen kart sayısını; eşitlikte okeyi gereksiz yere
 * kütlere bağlamamayı, ardından puanı tercih eder (oyuncu eli görsel dizimi).
 */
export function solveHand(
  hand: readonly Card[],
  rules: RuleConfig,
  objective: 'points' | 'cards' | 'arrange' = 'points',
): SolveResult {
  const candidates = enumerateCandidateMelds(hand, rules).sort((a, b) => b.points - a.points);
  const memo = new Map<number, { points: number; cards: number; setJokers: number; picks: CandidateMeld[] }>();

  const better = (
    a: { points: number; cards: number; setJokers: number },
    b: { points: number; cards: number; setJokers: number },
  ) => {
    if (objective === 'points') {
      return a.points > b.points || (a.points === b.points && a.cards > b.cards);
    }
    if (objective === 'arrange') {
      return a.cards > b.cards
        || (a.cards === b.cards && a.setJokers < b.setJokers)
        || (a.cards === b.cards && a.setJokers === b.setJokers && a.points > b.points);
    }
    return a.cards > b.cards || (a.cards === b.cards && a.points > b.points);
  };

  const dfs = (used: number, startIdx: number): { points: number; cards: number; setJokers: number; picks: CandidateMeld[] } => {
    const key = used; // startIdx'ten bağımsız en iyi; küçük el için yeterince doğru ve hızlı
    const cached = memo.get(key);
    if (cached) return cached;
    let best = { points: 0, cards: 0, setJokers: 0, picks: [] as CandidateMeld[] };
    for (let i = 0; i < candidates.length; i++) {
      const cand = candidates[i]!;
      if ((cand.mask & used) !== 0) continue;
      const sub = dfs(used | cand.mask, i + 1);
      const total = {
        points: cand.points + sub.points,
        cards: cand.cards.length + sub.cards,
        setJokers: sub.setJokers + (cand.type === 'set' ? cand.cards.filter((c) => c.joker).length : 0),
        picks: [cand, ...sub.picks],
      };
      if (better(total, best)) best = total;
    }
    memo.set(key, best);
    return best;
  };

  const result = dfs(0, 0);
  return {
    melds: result.picks.map((p) => p.cards),
    totalPoints: result.points,
    cardCount: result.cards,
  };
}

/**
 * SEÇİLEN kartları TAMAMINI kullanacak şekilde geçerli per/küt (≥3 kart) gruplarına böler.
 * GERİ İZLEMELİ (backtracking): aday perler arasından, HER kartı tam bir kez kapsayan bir
 * bölümleme aranır; varsa gruplar (puan büyükten küçüğe), yoksa null döner.
 * (Client GameClient.PartitionMelds/SolvePartition'ın TS/engine karşılığı — açış komutunda
 * seçili kart id'lerini çoklu meld'e bölmek için. Çift bu yolla AÇILMAZ; çift açış openPairs ile.)
 */
export function partitionSelectedMelds(
  cards: readonly Card[],
  rules: RuleConfig,
): Card[][] | null {
  const n = cards.length;
  if (n < rules.minSetSize) return null; // en küçük per minSetSize/minRunLength
  const all = (1 << n) - 1;
  // Tüm aday perleri (≥3 kart; çift değil) maske olarak üret.
  const candidates = enumerateCandidateMelds(cards, rules)
    .sort((a, b) => b.points - a.points);

  const memo = new Map<number, Card[][] | null>();
  const solve = (used: number): Card[][] | null => {
    if (used === all) return [];
    if (memo.has(used)) return memo.get(used)!;
    // Henüz kapanmamış EN KÜÇÜK indeksli kartı kapsayan bir aday seçmeye zorla
    // (deterministik + dallanmayı kırpar).
    let firstFree = 0;
    while (firstFree < n && (used & (1 << firstFree)) !== 0) firstFree++;
    const firstBit = 1 << firstFree;
    for (const cand of candidates) {
      if ((cand.mask & used) !== 0) continue;
      if ((cand.mask & firstBit) === 0) continue;
      const sub = solve(used | cand.mask);
      if (sub) {
        const ans = [cand.cards, ...sub];
        memo.set(used, ans);
        return ans;
      }
    }
    memo.set(used, null);
    return null;
  };

  return solve(0);
}
