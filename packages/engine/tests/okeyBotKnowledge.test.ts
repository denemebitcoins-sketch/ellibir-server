import { describe, expect, it } from 'vitest';
import { applyOkeyMove, createOkeyGame, startNextEl } from '../src/okey/game';
import { chooseOkeyBotDiscard } from '../src/okey/bot';
import { OkeyBotKnowledge } from '../src/okey/knowledge';
import type { OkeyColor, OkeyRank, OkeyTile } from '../src/okey/types';

function tiles(...keys: string[]): OkeyTile[] {
  return keys.map((key, i) => ({ id: `${key}-${i}`, fake: false,
    color: key[0] as OkeyColor, rank: Number(key.slice(1)) as OkeyRank }));
}
function game(variant: 'duz' | 'yuzbir' = 'duz') {
  const s = createOkeyGame({ seed: 17, rules: { variant } });
  s.okeyColor = 'K'; s.okeyRank = 13;
  s.gosterge = { id: 'indicator', fake: false, color: 'K', rank: 12 };
  s.turn = 0; s.phase = 'draw'; s.players[0]!.hand = tiles('B1', 'Y10');
  s.discards = [[], [], [], tiles('R6')];
  return s;
}
const knowledge = (s: ReturnType<typeof game>) => new OkeyBotKnowledge(s, 0, s.players[0]!.hand);

describe('bounded public Okey observation memory', () => {
  it('records only successful public transfers, not hidden stock draws', () => {
    const s = game();
    expect(applyOkeyMove(s, 1, { t: 'draw', from: 'left' }).ok).toBe(false);
    expect(s.publicPickups).toEqual([]);
    const tile = s.discards[3]![0]!;
    expect(applyOkeyMove(s, 0, { t: 'draw', from: 'left' }).ok).toBe(true);
    expect(s.publicPickups).toEqual([{ seat: 0, tile }]);
    expect(applyOkeyMove(s, 0, { t: 'returnLeft' }).ok).toBe(true);
    expect(s.publicPickups).toEqual([]);
    expect(applyOkeyMove(s, 0, { t: 'draw', from: 'pile' }).ok).toBe(true);
    expect(s.publicPickups).toEqual([]);
  });

  it('forgets a discarded pickup and updates ownership on a later public pickup', () => {
    const s = game();
    const tile = s.discards[3]![0]!;
    applyOkeyMove(s, 0, { t: 'draw', from: 'left' });
    expect(applyOkeyMove(s, 0, { t: 'discard', tileId: tile.id }).ok).toBe(true);
    expect(s.publicPickups).toEqual([]);
    expect(applyOkeyMove(s, 1, { t: 'draw', from: 'left' }).ok).toBe(true);
    expect(s.publicPickups).toEqual([{ seat: 1, tile }]);
  });

  it('is bounded under repeated take/return and starts empty next deal', () => {
    const s = game();
    for (let i = 0; i < 150; i++) {
      applyOkeyMove(s, 0, { t: 'draw', from: 'left' });
      expect(s.publicPickups).toHaveLength(1);
      applyOkeyMove(s, 0, { t: 'returnLeft' });
    }
    applyOkeyMove(s, 0, { t: 'draw', from: 'left' });
    startNextEl(s);
    expect(s.publicPickups).toEqual([]);
  });

  it('survives JSON roundtrip and handles legacy snapshots without fabricated history', () => {
    const s = game();
    applyOkeyMove(s, 0, { t: 'draw', from: 'left' });
    const restored = JSON.parse(JSON.stringify(s)) as typeof s;
    expect(restored.publicPickups).toEqual(s.publicPickups);
    expect(chooseOkeyBotDiscard(restored, 0)?.id).toBe(chooseOkeyBotDiscard(s, 0)?.id);
    delete restored.publicPickups;
    expect(() => knowledge(restored)).not.toThrow();
    applyOkeyMove(restored, 0, { t: 'returnLeft' });
    applyOkeyMove(restored, 0, { t: 'draw', from: 'left' });
    expect(restored.publicPickups).toHaveLength(1);
  });

  it('counts physical copies once across own hand, pickup memory, board and indicator', () => {
    const s = game();
    const tile = s.discards[3]![0]!;
    s.publicPickups = [{ seat: 1, tile }, { seat: 1, tile }];
    const k = knowledge(s);
    expect(k.unseen('R', 6)).toBe(1);
    expect(k.unseen('K', 12)).toBe(1);
    expect(k.discardRisk(tiles('R7')[0]!)).toBe(0);
    s.discards[3] = [];
    expect(knowledge(s).discardRisk(tiles('R7')[0]!)).toBe(3);
  });

  it('abandons an exhausted natural wait rather than a live equivalent wait', () => {
    const s = game(); s.discards[3] = [];
    s.players[0]!.hand = tiles('Y2', 'Y4', 'R5', 'R7');
    expect(chooseOkeyBotDiscard(s, 0)?.id).toBe('Y2-0');
    s.discards[1] = tiles('R6', 'R6');
    expect(knowledge(s).unseen('R', 6)).toBe(0);
    expect(chooseOkeyBotDiscard(s, 0)?.id).toBe('R5-2');
  });

  it('weights the next player public interest without breaking a complete group', () => {
    const s = game(); s.discards[3] = [];
    s.players[0]!.hand = tiles('Y9', 'B2', 'R12');
    expect(chooseOkeyBotDiscard(s, 0)?.id).toBe('Y9-0');
    s.publicPickups = [{ seat: 1, tile: tiles('Y10')[0]! }];
    expect(chooseOkeyBotDiscard(s, 0)?.id).toBe('B2-1');
    s.players[0]!.hand = tiles('B1', 'B2', 'B3', 'Y9');
    expect(chooseOkeyBotDiscard(s, 0)?.id).toBe('Y9-3');
    s.publicPickups[0]!.seat = 2;
    expect(knowledge(s).discardRisk(tiles('Y9')[0]!)).toBe(0);
  });

  it('uses missing-copy knowledge but never other hands, stock or seed', () => {
    const s = game();
    s.publicPickups = [{ seat: 1, tile: tiles('Y9')[0]! }];
    for (const seat of [1, 2, 3]) Object.defineProperty(s.players[seat]!, 'hand', { get() { throw Error('private hand'); } });
    for (const key of ['stock', 'seed']) Object.defineProperty(s, key, { get() { throw Error('private deck'); } });
    expect(knowledge(s).unseen('Y', 9)).toBe(1);
    expect(chooseOkeyBotDiscard(s, 0)).not.toBeNull();
  });

  it('counts fake okeys as natural copies and does not wrap 13-1-2', () => {
    const s = game();
    s.publicPickups = [{ seat: 1, tile: { id: 'fake-a', fake: true } }];
    expect(knowledge(s).unseen('K', 13)).toBe(1);
    const [one, twelve, thirteen, two] = tiles('R1', 'R12', 'R13', 'R2');
    s.discards[1] = tiles('R12', 'R12');
    expect(knowledge(s).connection(one!, thirteen!)).toBe(0);
    expect(knowledge(s).connection(one!, two!)).toBe(4);
    expect(knowledge(s).connection(one!, twelve!)).toBe(2);
    s.rules.variant = 'yuzbir';
    expect(knowledge(s).connection(one!, twelve!)).toBe(0);
  });

  it('tracks rescued/returned public tiles without double-counting the exposed meld', () => {
    const s = game('yuzbir'); s.phase = 'discard'; s.discards[3] = [];
    s.players[0]!.hasOpened = true;
    s.players[0]!.hand = tiles('R4', 'Y2');
    s.openMelds = [{ id: 'm1', kind: 'run', ownerSeat: 1, points: 12, tiles: tiles('R3', 'K13', 'R5') }];
    expect(applyOkeyMove(s, 0, { t: 'extend', meldId: 'm1', tileId: 'R4-0' }).ok).toBe(true);
    expect(s.publicPickups?.map(p => p.tile.id)).toEqual(['K13-1']);
    expect(applyOkeyMove(s, 0, { t: 'retrieveTile' }).ok).toBe(true);
    expect(s.publicPickups?.some(p => p.tile.id === 'R4-0')).toBe(true);
    expect(knowledge(s).unseen('R', 4)).toBe(1);
    expect(knowledge(s).discardRisk(tiles('K12')[0]!)).toBe(0);
  });
});
