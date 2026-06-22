import type { Card, Meld, PlayerView } from '../../engine/src/types';
import { isIslekCard } from '../../engine/src/game';
import { analyzeHand } from '../../engine/src/insight';
import { meldPoints } from '../../engine/src/melds';

/**
 * İstemciye (Unity) gönderilen DÜZ görünüm. Motorun karmaşık PlayerView'i
 * yerine yalnız primitive + dizi alanlar — Unity JsonUtility sözlük/union
 * sevmez. Böylece istemci motor iç tiplerine bağlanmaz (temiz seam).
 */
export interface ClientCard {
  id: string;
  /** "A♠" / "10♥" / "★" (joker) — yedek metin gösterimi. */
  label: string;
  red: boolean;
  joker: boolean;
  /** Sprite anahtarı için: 'S'|'H'|'D'|'C' (joker: ''). */
  suit: string;
  /** 1-13 (A=1, J=11, Q=12, K=13); joker: 0. */
  rank: number;
  /** İŞLEK: bu kart masadaki bir pere işlenebilir/jokeri kurtarır (yardım). */
  islek: boolean;
}

export interface ClientMeld {
  id: string;
  ownerSeat: number;
  type: string; // 'set' | 'run' | 'pair'
  cards: ClientCard[];
}

export interface ClientSeat {
  seat: number;
  name: string;
  isBot: boolean;
  handCount: number;
  hasOpened: boolean;
  isCift: boolean;
  totalScore: number;
  barajTokens: number;
  /** YERDEKİ (açtığı) perlerin toplam puanı (çift olmayan) ve çift adedi. */
  openMeldPoints: number;
  openPairCount: number;
}

export interface ClientView {
  seat: number;
  phase: string; // 'draw' | 'action' | 'handEnded' | 'matchEnded'
  currentSeat: number;
  yourTurn: boolean;
  handNumber: number;
  totalHands: number;
  openingMin: number;
  teamMode: boolean;
  myHand: ClientCard[];
  /** Elde, bu indekslerden SONRA görsel boşluk (DİZ blok sınırları). */
  handGaps: number[];
  melds: ClientMeld[];
  seats: ClientSeat[];
  /** JsonUtility null nesneyi default'a çevirir → varlık bayrağı + her zaman dolu alan. */
  hasDiscard: boolean;
  discardTop: ClientCard;
  discardCount: number;
  stockCount: number;
  matchWinnerSeat: number; // -1 = yok
  hasOpened: boolean; // ben açtım mı (işle/indir için)
  openMode: string;   // 'melds' | 'pairs' | '' (açış tarzım)
  canSor: boolean;
  canCancelPickup: boolean;
  /** ELİMDEKİ açış potansiyeli: en iyi seri puanı + ulaşılabilir çift adedi. */
  myMeldPoints: number;
  myPairCount: number;
}

const SUIT: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };

function rankLabel(r: number): string {
  return r === 1 ? 'A' : r === 11 ? 'J' : r === 12 ? 'Q' : r === 13 ? 'K' : String(r);
}

function toCard(c: Card): ClientCard {
  if (c.joker) return { id: c.id, label: '★', red: true, joker: true, suit: '', rank: 0, islek: false };
  return {
    id: c.id,
    label: rankLabel(c.rank) + SUIT[c.suit],
    red: c.suit === 'H' || c.suit === 'D',
    joker: false,
    suit: c.suit,
    rank: c.rank,
    islek: false,
  };
}

const EMPTY_CARD: ClientCard = { id: '', label: '', red: false, joker: false, suit: '', rank: 0, islek: false };

export function toClientView(
  v: PlayerView,
  matchWinnerSeat: number,
  canSor: boolean,
  handCards: Card[] = v.hand,
  handGaps: number[] = [],
): ClientView {
  const pk = v.pickup;
  const insight = analyzeHand(v.hand, v.rules);
  return {
    seat: v.seat,
    phase: v.phase,
    currentSeat: v.currentSeat,
    yourTurn: v.currentSeat === v.seat && (v.phase === 'draw' || v.phase === 'action'),
    handNumber: v.handNumber,
    totalHands: v.rules.totalHands,
    openingMin: v.currentOpeningMin,
    teamMode: v.rules.teamMode,
    myHand: handCards.map((c) => {
      const cc = toCard(c);
      cc.islek = isIslekCard(c, v.melds, v.rules);
      return cc;
    }),
    handGaps,
    melds: v.melds.map((m: Meld) => ({
      id: m.id,
      ownerSeat: m.ownerSeat,
      type: m.type,
      cards: m.cards.map(toCard),
    })),
    seats: v.players.map((p) => {
      const mine = v.melds.filter((m) => m.ownerSeat === p.seat);
      return {
        seat: p.seat,
        name: p.name,
        isBot: p.isBot,
        handCount: p.handCount,
        hasOpened: p.hasOpened,
        isCift: p.isCift,
        totalScore: p.totalScore,
        barajTokens: p.barajTokens,
        openMeldPoints: mine
          .filter((m) => m.type !== 'pair')
          .reduce((s, m) => s + (meldPoints(m.cards, v.rules) ?? 0), 0),
        openPairCount: mine.filter((m) => m.type === 'pair').length,
      };
    }),
    hasDiscard: v.discardTop !== null,
    discardTop: v.discardTop ? toCard(v.discardTop) : EMPTY_CARD,
    discardCount: v.discardCount,
    stockCount: v.stockCount,
    matchWinnerSeat,
    hasOpened: v.hasOpened,
    openMode: v.openMode ?? '',
    canSor,
    canCancelPickup: pk != null && !pk.committed && !pk.zorunlu,
    myMeldPoints: insight.meldPoints,
    myPairCount: insight.pairCount,
  };
}
