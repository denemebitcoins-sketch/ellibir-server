import { createRng, shuffle } from '../deck';
import type { Rng } from '../deck';
import type { FakeOkeyTile, NormalOkeyTile, OkeyColor, OkeyRank, OkeyTile, TileIdentity } from './types';
import { OKEY_COLORS, OKEY_RANKS } from './types';

export { createRng, shuffle };
export type { Rng };

export function makeTileId(color: OkeyColor, rank: OkeyRank, copy: number): string {
  return `${color}${rank}-${copy}`;
}

/** 106 taş: 4 renk × 13 sayı × 2 kopya (104) + 2 sahte okey. */
export function buildOkeyDeck(): OkeyTile[] {
  const tiles: OkeyTile[] = [];
  for (let copy = 0; copy < 2; copy++)
    for (const color of OKEY_COLORS)
      for (const rank of OKEY_RANKS)
        tiles.push({ id: makeTileId(color, rank, copy), fake: false, color, rank } as NormalOkeyTile);
  tiles.push({ id: 'FAKE-0', fake: true } as FakeOkeyTile);
  tiles.push({ id: 'FAKE-1', fake: true } as FakeOkeyTile);
  return tiles;
}

/** Göstergenin bir üstü okeydir; 13'ün üstü 1'e döner. */
export function nextRank(rank: OkeyRank): OkeyRank {
  return (rank === 13 ? 1 : rank + 1) as OkeyRank;
}

/** Taşın etkin kimliği: okey → joker; sahte okey → okeyin renk+sayısı; diğerleri kendisi. */
export function identityOf(tile: OkeyTile, okeyColor: OkeyColor, okeyRank: OkeyRank): TileIdentity {
  if (tile.fake) return { wild: false, color: okeyColor, rank: okeyRank };
  if (tile.color === okeyColor && tile.rank === okeyRank) return { wild: true, color: okeyColor, rank: okeyRank };
  return { wild: false, color: tile.color, rank: tile.rank };
}

export function isOkeyTile(tile: OkeyTile, okeyColor: OkeyColor, okeyRank: OkeyRank): boolean {
  return !tile.fake && tile.color === okeyColor && tile.rank === okeyRank;
}

export interface OkeyDealResult {
  hands: OkeyTile[][];       // 4 el: dağıtıcı 15, diğerleri 14
  stock: OkeyTile[];         // ortadaki kapalı yığın (çekiş sırası = dizinin sonundan)
  gosterge: NormalOkeyTile;  // açık gösterge (çekilemez)
  okeyColor: OkeyColor;
  okeyRank: OkeyRank;
}

/** Karıştır + gösterge seç (sahte okey gösterge OLAMAZ) + dağıt (dağıtıcıya 15). */
export function dealOkey(seed: number, dealerSeat: number): OkeyDealResult {
  const rng = createRng(seed);
  const deck = shuffle(buildOkeyDeck(), rng);

  // Gösterge: karışık desteden sahte olmayan İLK taş (deterministik).
  let gIdx = -1;
  for (let i = 0; i < deck.length; i++) if (!deck[i]!.fake) { gIdx = i; break; }
  const gosterge = deck[gIdx] as NormalOkeyTile;
  deck.splice(gIdx, 1);

  const okeyColor = gosterge.color;
  const okeyRank = nextRank(gosterge.rank);

  const hands: OkeyTile[][] = [[], [], [], []];
  let cursor = 0;
  for (let s = 0; s < 4; s++) {
    const count = s === dealerSeat ? 15 : 14;
    hands[s] = deck.slice(cursor, cursor + count);
    cursor += count;
  }
  return { hands, stock: deck.slice(cursor), gosterge, okeyColor, okeyRank };
}
