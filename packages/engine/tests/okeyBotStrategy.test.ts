import { describe, expect, it } from 'vitest';
import { createOkeyGame, isYuzbirIslekDiscard } from '../src/okey/game';
import { chooseOkeyBotDiscard, playOkeyBotTurn, shouldTakeOkeyLeft } from '../src/okey/bot';
import type { OkeyColor, OkeyRank, OkeyTile } from '../src/okey/types';
import { bestGrouping, type OkeyGroupingCache } from '../src/okey/melds';

function tiles(...keys: string[]): OkeyTile[] {
  return keys.map((key, i) => ({ id: `${key}-${i}`, fake: false,
    color: key[0] as OkeyColor, rank: Number(key.slice(1)) as OkeyRank }));
}
function game(variant: 'duz' | 'banko' | 'yuzbir' = 'duz') {
  const st = createOkeyGame({ seed: 17, rules: { variant } });
  st.okeyColor = 'K'; st.okeyRank = 13;
  st.turn = 0; st.phase = 'discard';
  st.players[0]!.hand = [];
  st.discards = [[], [], [], []];
  return st;
}
function run(st: ReturnType<typeof game>) {
  st.openMelds = [{ id: 'public-run', ownerSeat: 1, kind: 'run', points: 12,
    tiles: tiles('R3', 'R4', 'R5') }];
}

describe('public-information Okey bot strategy', () => {
  it.each(['duz', 'banko'] as const)('%s refuses an equivalent left draw/discard cycle', variant => {
    const st = game(variant);
    st.phase = 'draw';
    st.players[0]!.hand = tiles('Y10', 'R1', 'R2', 'R3', 'B1', 'B2', 'B3',
      'K1', 'K2', 'K3', 'Y5', 'Y6', 'Y7', 'Y8');
    const left = { ...tiles('Y10')[0]!, id: 'left-Y10' };
    st.discards[3] = [left];
    expect(shouldTakeOkeyLeft(st, 0, left)).toBe(false);
    const count = st.stock.length;
    playOkeyBotTurn(st, 0);
    expect(st.stock.length).toBe(count - 1);
    expect(st.discards[3]).toEqual([left]);
    expect(st.turn !== 0 || st.elEnded).toBe(true);
  });

  it('takes a left tile that completes the hand', () => {
    const st = game();
    st.phase = 'draw';
    st.players[0]!.hand = tiles('R1', 'R2', 'R3', 'R4', 'B1', 'B2', 'B3', 'B4', 'K1', 'K2', 'K3',
      'Y5', 'Y6', 'R10');
    const left = tiles('Y7')[0]!;
    st.discards[3] = [left];
    expect(shouldTakeOkeyLeft(st, 0, left)).toBe(true);
    playOkeyBotTurn(st, 0);
    expect(st.elEnded).toBe(true);
    expect(st.elWinner).toBe(0);
  });

  it('does not break a complete meld just to retain a duplicate', () => {
    const st = game();
    st.players[0]!.hand = tiles('R1', 'R2', 'R3', 'Y10', 'Y10');
    expect(chooseOkeyBotDiscard(st, 0)?.id).toMatch(/^Y10/);
  });

  it('unopened 101 does not throw a playable tile when a safe discard exists', () => {
    const st = game('yuzbir'); run(st);
    st.players[0]!.hand = tiles('R6', 'Y2', 'B9');
    expect(isYuzbirIslekDiscard(st, chooseOkeyBotDiscard(st, 0)!)).toBe(false);
    playOkeyBotTurn(st, 0);
    expect(st.scores[0]).toBe(0);
    expect(st.players[0]!.hand.some(t => t.id.startsWith('R6'))).toBe(true);
  });

  it('opened 101 lays off before discarding and finishes with the last tile', () => {
    const st = game('yuzbir'); run(st);
    Object.assign(st.players[0]!, { hasOpened: true, openMode: 'melds', hand: tiles('R6', 'Y2') });
    playOkeyBotTurn(st, 0);
    expect(st.openMelds[0]!.tiles).toHaveLength(4);
    expect(st.elWinner).toBe(0);
    expect(st.discards[0]!.map(t => t.id)).toEqual(['Y2-1']);
  });

  it('respects the two extensions per meld limit and avoids the third as a discard', () => {
    const st = game('yuzbir'); run(st);
    Object.assign(st.players[0]!, { hasOpened: true, openMode: 'pairs', hand: tiles('R6', 'R7', 'R8', 'Y2') });
    playOkeyBotTurn(st, 0);
    expect(st.openMelds[0]!.tiles).toHaveLength(5);
    expect(st.players[0]!.hand.map(t => t.id)).toEqual(['R8-2']);
    expect(st.scores[0]).toBe(0);
    expect(st.turn).toBe(1);
  });

  it('opened 101 uses a useful left tile rather than drawing blindly', () => {
    const st = game('yuzbir'); run(st);
    Object.assign(st.players[0]!, { hasOpened: true, openMode: 'melds', hand: tiles('Y2', 'B9') });
    const left = { ...tiles('R6')[0]!, id: 'left-R6' };
    st.phase = 'draw'; st.discards[3] = [left];
    const count = st.stock.length;
    expect(shouldTakeOkeyLeft(st, 0, left)).toBe(true);
    playOkeyBotTurn(st, 0);
    expect(st.stock.length).toBe(count);
    expect(st.openMelds[0]!.tiles.some(t => t.id === left.id)).toBe(true);
    expect(st.players[0]!.yuzbirPendingLeftTileId).toBeUndefined();
    expect(st.turn).toBe(1);
  });

  it('adds later pairs after opening rather than keeping every new pair forever', () => {
    const st = game('yuzbir');
    Object.assign(st.players[0]!, { hasOpened: true, openMode: 'pairs', hand: tiles('B4', 'B4', 'R1', 'Y2', 'K8') });
    playOkeyBotTurn(st, 0);
    expect(st.openMelds.some(m => m.kind === 'pair')).toBe(true);
    expect(st.turn).toBe(1);
  });

  it('decision helpers do not inspect other hands, stock identities, or mutate state', () => {
    const st = game();
    st.players[0]!.hand = tiles('R1', 'R2', 'R3', 'B9', 'Y10');
    for (let seat = 1; seat < 4; seat++)
      Object.defineProperty(st.players[seat]!, 'hand', { get: () => { throw Error('hidden hand'); } });
    Object.defineProperty(st, 'stock', { get: () => { throw Error('hidden stock'); } });
    const before = JSON.stringify(st.players[0]!.hand);
    const left = tiles('Y11')[0]!;
    const first = chooseOkeyBotDiscard(st, 0)?.id;
    expect(first).toBeDefined();
    shouldTakeOkeyLeft(st, 0, left);
    expect(chooseOkeyBotDiscard(st, 0)?.id).toBe(first);
    expect(JSON.stringify(st.players[0]!.hand)).toBe(before);
  });

  it('takes a legal 101 elden finish before opening loses the kafa status', () => {
    const st = game('yuzbir');
    st.players[0]!.hand = tiles(...['R', 'B', 'Y'].flatMap(c => Array.from({ length: 7 }, (_, i) => c + (i + 1))), 'K12');
    playOkeyBotTurn(st, 0);
    expect(st.elWinner).toBe(0);
    expect(st.kafaFinish).toBe(true);
  });

  it('shared grouping cache preserves answers across hands, IDs and rule variants', () => {
    const cache: OkeyGroupingCache = new Map();
    const hands = [tiles('R12', 'R13', 'R1', 'K13'), tiles('B2', 'B3', 'B4', 'K13'),
      tiles('Y4', 'R4', 'K4', 'B4'), tiles('Y4', 'R4', 'K4', 'B4').map(t => ({ ...t, id: t.id + '-other' }))];
    for (const hand of hands) for (const high of [true, false]) for (const score of [true, false])
      expect(bestGrouping(hand, 'K', 13, high, score, cache)).toEqual(bestGrouping(hand, 'K', 13, high, score));
  });
});
