import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createOkeyGame, type OkeyGameState } from '../../packages/engine/src/okey/game';
import { playOkeyBotTurn } from '../../packages/engine/src/okey/bot';

function snapshot(s: OkeyGameState): string {
  return [s.turn, s.phase, s.elEnded ? 1 : 0, s.elWinner == null || s.elWinner < 0 ? -1 : s.elWinner,
    s.players.map(p => p.hand.map(t => t.id).join(',')).join('/'),
    s.discards.map(p => p.map(t => t.id).join(',')).join('/'),
    // Sets have no directional slots; C# sorts colors by enum, TS by text.
    s.openMelds.map(m => `${m.id}:${m.kind}:${(m.kind === 'set' ? m.tiles.map(t => t.id).sort() : m.tiles.map(t => t.id)).join(',')}`).join(';'),
    s.scores.join(','), s.stock.length,
    (s.publicPickups ?? []).map(p => `${p.seat}:${p.tile.id}`).sort().join(',')].join('|');
}

describe.skipIf(!process.env.OKEY_BOT_PARITY_FILE)('C# / TS bot decisions and public action parity', () => {
  it('matches every turn, hand, open meld, discard and score in 30 full deals', () => {
    const rows = JSON.parse(readFileSync(process.env.OKEY_BOT_PARITY_FILE!, 'utf8')) as {
      variant: 'duz' | 'banko' | 'yuzbir'; seed: number; snapshots: string[];
    }[];
    expect(rows).toHaveLength(30);
    const times: number[] = [];
    for (const row of rows) {
      const s = createOkeyGame({ seed: row.seed, botSeats: [0, 1, 2, 3], rules: { variant: row.variant } });
      expect(snapshot(s), `${row.variant}:${row.seed}:initial`).toBe(row.snapshots[0]);
      for (let turn = 1; turn < row.snapshots.length; turn++) {
        const start = performance.now();
        playOkeyBotTurn(s, s.turn);
        times.push(performance.now() - start);
        expect(snapshot(s), `${row.variant}:${row.seed}:turn ${turn}`).toBe(row.snapshots[turn]);
      }
      expect(s.elEnded).toBe(true);
    }
    times.sort((a, b) => a - b);
    console.log(`TS ${times.length} turns: median=${times[Math.floor(times.length / 2)]!.toFixed(2)}ms p95=${times[Math.floor(times.length * .95)]!.toFixed(2)}ms max=${times.at(-1)!.toFixed(2)}ms`);
  }, 120_000);
});
