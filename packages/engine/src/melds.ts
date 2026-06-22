import type {
  Card,
  JokerSlot,
  MeldAnalysis,
  NormalCard,
  Rank,
  Suit,
} from './types';
import { SUITS } from './types';
import type { RuleConfig } from './rules';

/**
 * Seri pozisyonları 2..14 aralığında çalışır:
 * As YALNIZ üstten oynar = pozisyon 14 (Q-K-A). A-2-3 perisi YOKTUR;
 * serinin en küçük kartı 2'dir. Wrap-around (K-A-2) zaten imkânsızdır.
 */
export type RunPosition = number; // 2..14

/** Serilerde en küçük pozisyon (2 — As alttan oynamaz). */
const RUN_MIN_POS = 2;

export function rankAtPosition(pos: RunPosition): Rank {
  return (pos === 14 ? 1 : pos) as Rank;
}

/** Bir pozisyonun puan değeri (joker de temsil ettiği pozisyonun değerini alır). */
export function positionPoints(pos: RunPosition, rules: RuleConfig): number {
  if (pos === 14) return rules.acePoints;
  if (pos >= 11 && pos <= 13) return rules.facePoints;
  return pos;
}

/** Kütteki / eldeki bir rank'in puan değeri. */
export function rankPoints(rank: Rank, rules: RuleConfig): number {
  if (rank === 1) return rules.acePoints;
  if (rank >= 11) return rules.facePoints;
  return rank;
}

/** Elde kalan kartın ceza değeri. */
export function handCardPenalty(card: Card, rules: RuleConfig): number {
  if (card.joker) return rules.jokerHandPenalty;
  return rankPoints(card.rank, rules);
}

function naturals(cards: readonly Card[]): NormalCard[] {
  return cards.filter((c): c is NormalCard => !c.joker);
}

// RULES.md 1.3: per başına yapay okey sınırı YOKTUR. Geçerlilik yalnız
// set/run tanımından gelir (rank/renk kaynağı için en az 1 gerçek kart
// zaten zorunludur; bunun ötesinde kısıt uygulanmaz).

/**
 * KÜT (SET) analizi: aynı rank, hepsi farklı renk; joker eksik renkleri doldurur.
 * Kart sırası önemsizdir. Geçersizse null.
 */
export function analyzeSet(cards: readonly Card[], rules: RuleConfig): MeldAnalysis | null {
  if (cards.length < rules.minSetSize || cards.length > rules.maxSetSize) return null;

  const reals = naturals(cards);
  const rank = reals[0]?.rank;
  if (rank === undefined) return null;
  if (!reals.every((c) => c.rank === rank)) return null;

  const usedSuits = new Set<Suit>();
  for (const c of reals) {
    if (usedSuits.has(c.suit)) return null; // aynı renkten iki kart olamaz
    usedSuits.add(c.suit);
  }
  const missing = SUITS.filter((s) => !usedSuits.has(s));
  const jokers = cards.filter((c) => c.joker);
  if (jokers.length > missing.length) return null;

  const slots: JokerSlot[] = jokers.map((j) => ({
    jokerId: j.id,
    rank,
    suits: missing.slice(), // küt'te joker eksik renklerden herhangi biri sayılır
  }));

  return {
    type: 'set',
    cards: cards.slice(),
    points: cards.length * rankPoints(rank, rules),
    jokers: slots,
  };
}

/**
 * SERİ (RUN) analizi — kartların VERİLEN SIRASI pozisyon sırası kabul edilir.
 * Jokerler aradaki boşlukları sırayla doldurur. Geçersizse null.
 */
export function analyzeRun(cards: readonly Card[], rules: RuleConfig): MeldAnalysis | null {
  if (cards.length < rules.minRunLength) return null;

  const reals = naturals(cards);
  const suit = reals[0]?.suit;
  if (suit === undefined) return null;
  if (!reals.every((c) => c.suit === suit)) return null;

  // İlk gerçek kartın pozisyonundan başlangıcı türet (As YALNIZ 14'tür).
  const firstRealIdx = cards.findIndex((c) => !c.joker);
  const firstReal = cards[firstRealIdx] as NormalCard;
  const candidates: RunPosition[] = firstReal.rank === 1 ? [14] : [firstReal.rank];

  outer: for (const firstPos of candidates) {
    const start = firstPos - firstRealIdx;
    const end = start + cards.length - 1;
    if (start < RUN_MIN_POS || end > 14) continue;

    const slots: JokerSlot[] = [];
    let points = 0;
    for (let i = 0; i < cards.length; i++) {
      const pos = start + i;
      const card = cards[i]!;
      if (card.joker) {
        slots.push({ jokerId: card.id, rank: rankAtPosition(pos), suits: [suit] });
      } else if (card.rank !== rankAtPosition(pos)) {
        continue outer;
      }
      points += positionPoints(pos, rules);
    }
    return { type: 'run', cards: cards.slice(), points, jokers: slots };
  }
  return null;
}

/**
 * ÇİFT analizi: aynı rank VE aynı renk iki özdeş kart (çift desteden gelir).
 * Joker eksik eşi tutabilir (en fazla maxJokersPerPair). Geçersizse null.
 */
export function analyzePair(cards: readonly Card[], rules: RuleConfig): MeldAnalysis | null {
  if (!rules.pairs.enabled) return null;
  if (cards.length !== 2) return null;

  const reals = naturals(cards);
  const jokers = cards.filter((c) => c.joker);
  if (jokers.length > rules.pairs.maxJokersPerPair || reals.length === 0) return null;

  const base = reals[0]!;
  if (reals.length === 2) {
    const other = reals[1]!;
    if (other.rank !== base.rank || other.suit !== base.suit) return null;
  }

  return {
    type: 'pair',
    cards: cards.slice(),
    points: 2 * rankPoints(base.rank, rules),
    jokers: jokers.map((j) => ({ jokerId: j.id, rank: base.rank, suits: [base.suit] })),
  };
}

/**
 * Kart seçimini otomatik düzene sokarak geçerli bir perde arar.
 * RULES.md 1.3: okeyler PUAN ÖNCELİĞİYLE yerleştirilir — küt ve tüm seri
 * dizilimleri denenir, EN YÜKSEK PUANLI geçerli dizilim seçilir
 * (örn. [7,★,★]: küt 21 yerine 7-8-9 serisi 24).
 */
export function analyzeCards(cards: readonly Card[], rules: RuleConfig): MeldAnalysis | null {
  let best: MeldAnalysis | null = analyzeSet(cards, rules);

  for (const arrangement of arrangeRunCandidates(cards)) {
    const asRun = analyzeRun(arrangement, rules);
    if (asRun && (!best || asRun.points > best.points)) best = asRun;
  }
  return best;
}

/**
 * Verilen kartlardan olası seri dizilimleri üretir: gerçek kartlar sıralanır,
 * jokerler boşluklara, artanlar uçlara yerleştirilir. As YALNIZ üsttedir (14);
 * okey de pozisyon 1'i (var olmayan "As altı") tutamaz.
 */
export function arrangeRunCandidates(cards: readonly Card[]): Card[][] {
  const reals = naturals(cards);
  const jokers = cards.filter((c) => c.joker);
  if (reals.length === 0) return [];
  const suit = reals[0]!.suit;
  if (!reals.every((c) => c.suit === suit)) return [];

  const positioned = reals
    .map((c) => ({
      card: c as Card,
      pos: c.rank === 1 ? 14 : (c.rank as number),
    }))
    .sort((a, b) => a.pos - b.pos);

  // Aynı pozisyondan iki kart varsa seri olamaz.
  if (positioned.some((p, i) => i > 0 && p.pos === positioned[i - 1]!.pos)) return [];

  const jokerPool = jokers.slice();
  const seq: Array<{ card: Card; pos: number }> = [];
  for (let i = 0; i < positioned.length; i++) {
    const cur = positioned[i]!;
    if (i > 0) {
      const prev = seq[seq.length - 1]!;
      for (let p = prev.pos + 1; p < cur.pos; p++) {
        const j = jokerPool.pop();
        if (!j) return [];
        seq.push({ card: j, pos: p });
      }
    }
    seq.push(cur);
  }

  // Artan jokerleri önce sona, sığmazsa başa ekle (baş sınırı pozisyon 2).
  let head = seq[0]!.pos;
  let tail = seq[seq.length - 1]!.pos;
  while (jokerPool.length > 0 && tail < 14) {
    seq.push({ card: jokerPool.pop()!, pos: ++tail });
  }
  while (jokerPool.length > 0 && head > RUN_MIN_POS) {
    seq.unshift({ card: jokerPool.pop()!, pos: --head });
  }
  if (jokerPool.length > 0) return [];

  return [seq.map((s) => s.card)];
}

/** Perde puanı + analiz; UI ve açma barajı hesabı için tek kapı. */
export function meldPoints(cards: readonly Card[], rules: RuleConfig): number | null {
  return analyzeCards(cards, rules)?.points ?? null;
}
