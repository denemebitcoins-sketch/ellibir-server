import type { TavlaGameState } from '../../packages/engine/src/tavla';

/** Animation waits belong to the room, not the deterministic rules engine. */
export class TavlaPresentationGate {
  private game: TavlaGameState | null = null;
  private roll = -1;
  private turn = -1;
  private until = 0;

  observe(game: TavlaGameState, now: number): number {
    if (game !== this.game) {
      this.until = game.gameNumber === 1 && game.openRoll.every(d => d > 0) ? now + 3100 : 0;
    } else if (game.rollCount !== this.roll && game.turn !== this.turn && !game.gameEnded) {
      // Roll animation (850ms), then a brief blocked-roll notice (550ms).
      this.until = now + 1400;
    }
    this.game = game; this.roll = game.rollCount; this.turn = game.turn;
    return this.remaining(now);
  }
  remaining(now: number): number { return Math.max(0, this.until - now); }
}
