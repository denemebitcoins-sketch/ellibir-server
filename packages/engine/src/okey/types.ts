/** OKEY taş türleri. Renkler: R=kırmızı, Y=sarı, B=mavi, K=siyah. */
export type OkeyColor = 'R' | 'Y' | 'B' | 'K';
export const OKEY_COLORS: readonly OkeyColor[] = ['R', 'Y', 'B', 'K'];

/** 1..13 taş sayıları. */
export type OkeyRank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export const OKEY_RANKS: readonly OkeyRank[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

export interface NormalOkeyTile {
  id: string;
  fake: false;
  color: OkeyColor;
  rank: OkeyRank;
}

/** SAHTE OKEY (numarasız joker taşı): okeyin GERÇEK kimliğiyle oynanır (joker DEĞİLDİR). */
export interface FakeOkeyTile {
  id: string;
  fake: true;
}

export type OkeyTile = NormalOkeyTile | FakeOkeyTile;

/** Bir taşın oyun içi "etkin kimliği": okey taşı = joker (her şey yerine),
 *  sahte okey = okeyin renk+sayısı, diğerleri kendisi. */
export interface TileIdentity {
  wild: boolean;          // gerçek okey taşı mı (her taş yerine geçer)
  color: OkeyColor;
  rank: OkeyRank;
}

export type OkeyFinishKind = 'normal' | 'okey' | 'pairs' | 'pairsOkey';
