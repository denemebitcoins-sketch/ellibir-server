import type { OkeyGameState } from './game';
import type { OkeyColor, OkeyTile } from './types';
import { identityOf } from './deck';

const COLORS: OkeyColor[] = ['R', 'Y', 'B', 'K'];

/** A frozen perception for one decision: own tiles and public observations only. */
export class OkeyBotKnowledge {
  private readonly counts = new Map<string, number>();
  private readonly nextPickups: OkeyTile[] = [];

  constructor(private readonly state: OkeyGameState, seat: number, ownHand: readonly OkeyTile[]) {
    const seen = new Set<string>();
    const table = [...state.discards.flat(), ...state.openMelds.flatMap(m => m.tiles)];
    const exposed = new Set(table.map(t => t.id));
    const own = new Set(ownHand.map(t => t.id));
    const observe = (tile: OkeyTile) => {
      if (seen.has(tile.id)) return;
      seen.add(tile.id);
      const id = identityOf(tile, state.okeyColor, state.okeyRank);
      if (!id.wild) {
        const key = `${id.color}${id.rank}`;
        this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
      }
    };
    for (const tile of [...ownHand, ...table]) observe(tile);
    if (state.gosterge) observe(state.gosterge);
    const riskSeen = new Set<string>();
    for (const p of state.publicPickups ?? []) {
      observe(p.tile);
      if (p.seat === (seat + 1) % 4 && !exposed.has(p.tile.id) && !own.has(p.tile.id) && !riskSeen.has(p.tile.id)) {
        riskSeen.add(p.tile.id);
        this.nextPickups.push(p.tile);
      }
    }
  }

  // Unseen is NOT necessarily in the stock: opponents may have either copy.
  unseen(color: OkeyColor, rank: number): number {
    if (rank < 1 || rank > 13) return 0;
    return Math.max(0, 2 - (this.counts.get(`${color}${rank}`) ?? 0));
  }

  connection(a: OkeyTile, b: OkeyTile): number {
    const x = identityOf(a, this.state.okeyColor, this.state.okeyRank);
    const y = identityOf(b, this.state.okeyColor, this.state.okeyRank);
    if (x.wild || y.wild) return 0;
    if (x.color === y.color && x.rank === y.rank) return 6;
    let outs = 0, weight = 0;
    if (x.color === y.color) {
      const lo = Math.min(x.rank, y.rank), hi = Math.max(x.rank, y.rank);
      const highOne = this.state.rules.variant !== 'yuzbir';
      if (hi - lo === 1) {
        outs = this.unseen(x.color, lo - 1) + this.unseen(x.color, hi + 1);
        if (highOne && hi === 13) outs += this.unseen(x.color, 1);
        weight = 4;
      } else if (hi - lo === 2) {
        outs = this.unseen(x.color, lo + 1); weight = 2;
      } else if (highOne && lo === 1 && hi >= 12) {
        outs = this.unseen(x.color, hi === 13 ? 12 : 13); weight = hi === 13 ? 4 : 2;
      }
    } else if (x.rank === y.rank) {
      outs = COLORS.filter(c => c !== x.color && c !== y.color).reduce((n, c) => n + this.unseen(c, x.rank), 0);
      weight = 3;
    }
    return Math.floor(weight * Math.min(2, outs) / 2);
  }

  // A bounded hint, never a claim to know an opponent's complete meld or hand.
  discardRisk(tile: OkeyTile): number {
    const id = identityOf(tile, this.state.okeyColor, this.state.okeyRank);
    if (id.wild) return 0;
    let risk = 0;
    for (const known of this.nextPickups) {
      const other = identityOf(known, this.state.okeyColor, this.state.okeyRank);
      if (other.wild) continue;
      if (id.color === other.color && id.rank === other.rank) risk += 8;
      else if (id.color === other.color && Math.abs(id.rank - other.rank) <= 2) risk += 3;
      else if (id.rank === other.rank) risk += 2;
      else if (this.state.rules.variant !== 'yuzbir' && id.color === other.color &&
        Math.min(id.rank, other.rank) === 1 && Math.max(id.rank, other.rank) >= 12) risk += 3;
    }
    return Math.min(12, risk);
  }
}
