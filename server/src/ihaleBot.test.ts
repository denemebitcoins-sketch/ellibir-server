import { describe, expect, it } from 'vitest';
import { applyIhaleCommand, collectIhaleTrick, createIhaleGame, ihaleBotCommand, ihaleBotContract, ihaleController, IHALE_SUITS, legalIhaleCards, nextIhaleHand } from '../../packages/engine/src/ihale';
import type { IhaleState } from '../../packages/engine/src/ihale';
import type { NormalCard, Rank, Suit } from '../../packages/engine/src/types';
import { ihaleRuntime } from './cardRoomRuntime';

const card = (suit: Suit, rank: number): NormalCard => ({ id: `${suit}${rank}-0`, suit, rank: rank as Rank, joker: false });
function position(): IhaleState {
  const s = createIhaleGame({ seed: 42, rules: { teamMode: true, totalHands: 3 } });
  s.ihale.phase = 'play'; s.ihale.trump = 'H'; s.ihale.bidder = 0; s.ihale.dummySeat = 2; s.currentSeat = 1;
  s.players.forEach(p => { p.hand = []; });
  s.ihale.trick = [{ seat: 0, card: card('S', 7) }];
  return s;
}
function choose(s: IhaleState): string {
  const before = JSON.stringify(s);
  const cmd = ihaleBotCommand(s);
  expect(cmd.t).toBe('ihalePlay');
  if (cmd.t !== 'ihalePlay') throw new Error('Expected play');
  expect(legalIhaleCards(s).map(c => c.id)).toContain(cmd.cardId);
  expect(() => applyIhaleCommand(s, cmd, ihaleController(s))).not.toThrow();
  expect(JSON.stringify(s)).toBe(before);
  return cmd.cardId;
}

describe('Ihale bot visible-hand tactics', () => {
  const strongHand = () => [1, 13, 12, 11, 10].map(n => card('H', n)).concat(
    [card('S', 1), card('D', 1), card('S', 3), card('S', 5), card('D', 4), card('D', 6), card('C', 2), card('C', 7)]);
  it('passes with four trumps despite many scattered honors; compulsory bid stays at the minimum', () => {
    const s = position(); s.ihale.phase = 'bid'; s.ihale.opened = true;
    s.players[1].hand = [1, 13, 12, 2].map(n => card('H', n)).concat(
      [card('S', 1), card('S', 13), card('S', 2), card('D', 1), card('D', 12), card('D', 2), card('C', 13), card('C', 12), card('C', 2)]);
    expect(ihaleBotContract(s.players[1].hand).strong).toBe(false);
    expect(ihaleBotCommand(s).t).toBe('ihalePass');
    const runtime = ihaleRuntime.step(s as any, () => false);
    expect((runtime.state as unknown as IhaleState).ihale.passed[1]).toBe(true);
    s.ihale.opened = false;
    expect(ihaleBotCommand(s)).toMatchObject({ t: 'ihaleBid', bid: 7 });
    s.rules.teamMode = false;
    expect(ihaleBotCommand(s)).toMatchObject({ t: 'ihaleBid', bid: 4 });
  });
  it('enters minimally with seven estimated own tricks, respects the budget and never raises its partner', () => {
    const s = position(); s.ihale.phase = 'bid'; s.ihale.opened = true; s.players[1].hand = strongHand();
    expect(ihaleBotContract(s.players[1].hand)).toEqual({ trump: 'H', tricks: 7, strong: true });
    expect(ihaleBotCommand(s)).toMatchObject({ t: 'ihaleBid', bid: 8 });
    s.ihale.bid = 8; expect(ihaleBotCommand(s).t).toBe('ihalePass');
    s.ihale.bid = 7; s.ihale.bidder = 3; expect(ihaleBotCommand(s).t).toBe('ihalePass');
    s.ihale.phase = 'trump'; expect(ihaleBotCommand(s)).toMatchObject({ t: 'ihaleTrump', suit: 'H' });
  });
  it('does not enter with five strong trumps but no reliable side winners', () => {
    const s = position(); s.ihale.phase = 'bid'; s.ihale.opened = true;
    s.players[1].hand = strongHand().map(c => c.rank === 1 && c.suit !== 'H' ? card(c.suit, 9) : c);
    expect(ihaleBotCommand(s).t).toBe('ihalePass');
  });
  it('protects an unsupported king, then promotes it once the ace has appeared', () => {
    const s = position(); s.currentSeat = 0; s.ihale.trick = []; s.ihale.dummySeat = -1;
    s.players[0].hand = [card('C', 13), card('H', 3)];
    expect(choose(s)).toBe('H3-0');
    s.ihale.played = [1, 2, 3, 0].map((seat, n) => ({ seat, card: card('C', [1, 4, 5, 6][n]) }));
    expect(choose(s)).toBe('C13-0');
  });
  it('develops a low long-suit card without cashing the ace or volunteering the king', () => {
    const s = position(); s.currentSeat = 0; s.ihale.trick = []; s.ihale.dummySeat = -1;
    s.players[0].hand = [card('C', 13), card('C', 7), card('C', 9), card('S', 1), card('D', 2)];
    expect(choose(s)).toBe('C7-0');
  });
  it('remembers an enemy ruff and avoids leading that suit, but distinguishes an enemy without trumps', () => {
    const s = position(); s.currentSeat = 0; s.ihale.trick = []; s.ihale.dummySeat = -1;
    s.players[0].hand = [card('C', 2), card('D', 5)];
    expect(choose(s)).toBe('C2-0');
    s.ihale.played = [{ seat: 0, card: card('C', 3) }, { seat: 1, card: card('H', 2) },
      { seat: 2, card: card('C', 4) }, { seat: 3, card: card('C', 5) }];
    expect(choose(s)).toBe('D5-0');
    s.ihale.played[1].card = card('S', 2);
    expect(choose(s)).toBe('C2-0');
  });
  it('keeps a complete public hand history without mutating earlier states, then clears it on the next deal', () => {
    let s = createIhaleGame({ seed: 13, rules: { teamMode: true, totalHands: 3 } });
    for (let steps = 0; s.phase === 'action' && steps < 200; steps++) {
      const before = s, json = JSON.stringify(before), count = s.ihale.played!.length;
      if (s.ihale.phase === 'trickEnd') {
        s = collectIhaleTrick(s); expect(s.ihale.played!.length).toBe(count);
      } else {
        const cmd = ihaleBotCommand(s); s = applyIhaleCommand(s, cmd, ihaleController(s));
        expect(s.ihale.played!.length).toBe(count + (cmd.t === 'ihalePlay' ? 1 : 0));
      }
      expect(JSON.stringify(before)).toBe(json);
    }
    expect(s.ihale.played).toHaveLength(52);
    expect(new Set(s.ihale.played!.map(x => x.card.id)).size).toBe(52);
    expect(nextIhaleHand(s).ihale.played).toEqual([]);
    expect(s.ihale.played).toHaveLength(52);
  });
  it('does not inspect closed hands during bidding, trump selection or opening leads', () => {
    const s = position(); s.players[1].hand = strongHand(); s.ihale.trick = []; s.ihale.dummySeat = -1;
    for (const seat of [0, 2, 3]) Object.defineProperty(s.players[seat], 'hand', {
      get() { throw new Error('Bot read a hidden hand'); },
    });
    s.ihale.phase = 'bid'; s.ihale.opened = true; expect(ihaleBotCommand(s).t).toBe('ihaleBid');
    s.ihale.phase = 'trump'; expect(ihaleBotCommand(s).t).toBe('ihaleTrump');
    s.ihale.phase = 'play'; expect(ihaleBotCommand(s).t).toBe('ihalePlay');
  });
  it('starts legacy-state memory with the current trick, preserving the lead for void inference', () => {
    const s = position(); delete s.ihale.played; s.players[1].hand = [card('H', 3)];
    const next = applyIhaleCommand(s, ihaleBotCommand(s), 1);
    expect(next.ihale.played?.map(x => x.card.id)).toEqual(['S7-0', 'H3-0']);
    expect(s.ihale.played).toBeUndefined();
  });
  it('uses the same ruff decision through the server runtime step', () => {
    const s = position(); s.players[1].hand = [card('H', 3), card('H', 11)];
    s.players[2].hand = [card('H', 5), card('H', 8), card('H', 10)];
    const result = ihaleRuntime.step(s as any, () => false);
    expect(result.moved).toBe(true);
    expect((result.state as unknown as IhaleState).ihale.trick.at(-1)?.card.id).toBe('H11-0');
  });
  it.each(IHALE_SUITS)('ruffs above the exposed 5/8/10 with J, across every seat and trump %s', trump => {
    for (let rotation = 0; rotation < 4; rotation++) {
      const s = position(), seat = (n: number) => (n + rotation) % 4;
      s.ihale.trump = trump; s.ihale.bidder = seat(0); s.ihale.dummySeat = seat(2); s.currentSeat = seat(1);
      s.ihale.trick = [{ seat: seat(0), card: card(IHALE_SUITS.find(x => x !== trump)!, 7) }];
      s.players[seat(1)].hand = [card(trump, 3), card(trump, 11)];
      s.players[seat(2)].hand = [card(trump, 5), card(trump, 8), card(trump, 10)];
      expect(choose(s)).toBe(`${trump}11-0`);
    }
  });
  it('uses the smallest sufficient ruff and respects the dummy following suit', () => {
    const s = position(); s.players[1].hand = [card('H', 3), card('H', 11)];
    s.players[2].hand = [card('H', 2)];
    expect(choose(s)).toBe('H3-0');
    s.players[2].hand = [card('S', 2), card('H', 10)];
    expect(choose(s)).toBe('H3-0');
  });
  it('does not waste J when the visible enemy can beat either trump', () => {
    const s = position(); s.players[1].hand = [card('H', 3), card('H', 11)];
    s.players[2].hand = [card('H', 12), card('H', 1)];
    expect(choose(s)).toBe('H3-0');
  });
  it.each([7, 8, 9, 10, 11])('plays Q under A against a %i lead, keeping A over the exposed K', lead => {
    const s = position(); s.ihale.dummySeat = 0; s.ihale.bidder = 2;
    s.ihale.trick = [{ seat: 0, card: card('S', lead) }];
    s.players[0].hand = [card('S', 13)]; s.players[1].hand = [card('S', 1), card('S', 12)];
    expect(choose(s)).toBe('S12-0');
  });
  it('uses A when an exposed K is still to play, or when raising K is mandatory', () => {
    const s = position(); s.players[1].hand = [card('S', 1), card('S', 12)];
    s.players[2].hand = [card('S', 7), card('S', 13)];
    expect(choose(s)).toBe('S1-0');
    s.ihale.trick = [{ seat: 0, card: card('S', 13) }]; s.players[2].hand = [card('S', 2)];
    expect(choose(s)).toBe('S1-0');
  });
  it('leads a low card into the visible partner void instead of spending a trump', () => {
    const s = position(); s.currentSeat = 0; s.ihale.trick = [];
    s.players[0].hand = [card('D', 2), card('S', 7), card('H', 3)];
    s.players[2].hand = [card('D', 5), card('H', 8)];
    expect(choose(s)).toBe('S7-0');
  });
  it('does not overtake a partners winning ruff with an unnecessary honor', () => {
    const s = position(); s.currentSeat = 3;
    s.ihale.trick = [{ seat: 0, card: card('S', 5) }, { seat: 1, card: card('H', 10) }, { seat: 2, card: card('S', 7) }];
    s.players[3].hand = [card('S', 2), card('S', 1)];
    expect(choose(s)).toBe('S2-0');
  });
  it('uses the controllers own visible hand while playing the dummy', () => {
    const s = position(); s.currentSeat = 2;
    s.ihale.trick = [{ seat: 1, card: card('S', 7) }];
    s.players[2].hand = [card('S', 1), card('S', 12)]; s.players[0].hand = [card('S', 13)];
    expect(ihaleController(s)).toBe(0);
    expect(choose(s)).toBe('S12-0');
  });
  it('never reads the closed hands, even if they contain the perfect counter', () => {
    const s = position(); s.players[1].hand = [card('H', 3), card('H', 11)];
    s.players[2].hand = [card('H', 5), card('H', 8), card('H', 10)];
    for (const seat of [0, 3]) Object.defineProperty(s.players[seat], 'hand', {
      get() { throw new Error('Bot read a hidden hand'); },
    });
    const cmd = ihaleBotCommand(s);
    expect(cmd.t === 'ihalePlay' && cmd.cardId).toBe('H11-0');
  });
});
