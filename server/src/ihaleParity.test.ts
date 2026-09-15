import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyIhaleCommand, collectIhaleTrick, createIhaleGame, ihaleBotCommand, ihaleController, nextIhaleHand } from '../../packages/engine/src/ihale';

// Optional explicit artifact from Unity IhaleAudit.Run; CI without Unity still runs the rule suite.
describe.skipIf(!process.env.IHALE_PARITY_FILE)('Unity / server deterministic parity', () => {
  it.each([true, false])('matches all deals, commands, trick totals and scores across 100 matches, team=%s', teamMode => {
    const lines = readFileSync(process.env.IHALE_PARITY_FILE! + (teamMode ? '' : '.solo'), 'utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    expect(lines.length).toBe(100);
    for (const line of lines) {
      const seed = Number(line.split('\t')[0]);
      let s = createIhaleGame({ seed, rules: { teamMode, totalHands: 3 } });
      const initial = s.players.map(p => p.hand.map(c => c.id).join(',')).join('/');
      while (s.phase !== 'matchEnded') s = s.phase === 'handEnded' ? nextIhaleHand(s) : s.ihale.phase === 'trickEnd' ? collectIhaleTrick(s) : applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
      const history = s.history.map(h => `${h.bidder}:${h.bid}:${h.trump}:${h.tricks.join(',')}:${h.points.join(',')}`).join(';');
      expect(`${seed}\t${initial}\t${s.revision}\t${history}`).toBe(line);
    }
  });
});
