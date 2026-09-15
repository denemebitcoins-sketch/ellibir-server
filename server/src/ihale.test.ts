import { describe, expect, it } from 'vitest';
import { applyIhaleCommand, collectIhaleTrick, createIhaleGame, ihaleBotCommand, ihaleController,
  ihaleBidOptions, ihaleTrickWinner, legalIhaleCards, nextIhaleHand, scoreIhaleTeams, scoreIhaleSolo } from '../../packages/engine/src/ihale';
import type { IhaleState } from '../../packages/engine/src/ihale';
import type { NormalCard, Rank, Suit } from '../../packages/engine/src/types';
const card = (suit: Suit, rank: number): NormalCard => ({ id: `${suit}${rank}-0`, suit, rank: rank as Rank, joker: false });
const game = () => createIhaleGame({ seed: 42, rules: { teamMode: true, totalHands: 1 } });
function playState(): IhaleState {
  let s = game();
  s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 7, revision: s.revision }, 0);
  for (const actor of [1, 2, 3]) s = applyIhaleCommand(s, { t: 'ihalePass', revision: s.revision }, actor);
  return applyIhaleCommand(s, { t: 'ihaleTrump', suit: 'S', revision: s.revision }, 0);
}
describe('Ihale rules and authority', () => {
  it('deals 52 unique cards with descending alternating suit groups', () => {
    const s = game(), cards = s.players.flatMap(p => p.hand);
    expect(new Set(cards.map(c => c.id)).size).toBe(52);
    for (const p of s.players) {
      expect(p.hand.length).toBe(13);
      const weights = p.hand.map(c => ['S', 'H', 'C', 'D'].indexOf(c.suit) * 100 - (c.rank === 1 ? 14 : c.rank));
      expect(weights).toEqual([...weights].sort((a, b) => a - b));
    }
    expect(game()).toEqual(s);
  });
  it('dealer must open at 7 or higher; everybody else starts at 8', () => {
    let s = game();
    expect(() => applyIhaleCommand(s, { t: 'ihalePass', revision: 0 }, 0)).toThrow('compulsory_bid');
    s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 7, revision: 0 }, 0);
    expect(ihaleBidOptions(s)).toEqual([8, 9, 10, 11, 12, 13]);
    expect(playState().currentSeat).toBe(0);
  });
  it('13 ends bidding immediately and trump owner leads', () => {
    let s = applyIhaleCommand(game(), { t: 'ihaleBid', bid: 7, revision: 0 }, 0);
    s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 13, revision: 1 }, 1);
    expect(s.ihale.phase).toBe('trump');
    s = applyIhaleCommand(s, { t: 'ihaleTrump', suit: 'D', revision: 2 }, 1);
    expect(s.currentSeat).toBe(1); expect(s.ihale.dummySeat).toBe(3);
  });
  it('passed players cannot re-enter and lower bids are rejected without mutation', () => {
    let s = applyIhaleCommand(game(), { t: 'ihaleBid', bid: 8, revision: 0 }, 0);
    const before = JSON.stringify(s);
    expect(() => applyIhaleCommand(s, { t: 'ihaleBid', bid: 8, revision: 1 }, 1)).toThrow('invalid_bid');
    expect(JSON.stringify(s)).toBe(before);
    s = applyIhaleCommand(s, { t: 'ihalePass', revision: 1 }, 1);
    s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 9, revision: 2 }, 2);
    s = applyIhaleCommand(s, { t: 'ihalePass', revision: 3 }, 3);
    s = applyIhaleCommand(s, { t: 'ihaleBid', bid: 10, revision: 4 }, 0);
    expect(s.currentSeat).toBe(2);
  });
  it('requires following and overtaking, otherwise allows lower same suit', () => {
    const s = playState(); s.ihale.trick = [{ seat: 3, card: card('H', 8) }];
    s.players[0].hand = [card('H', 5), card('H', 10), card('S', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['H10-0']);
    s.players[0].hand = [card('H', 5), card('S', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['H5-0']);
  });
  it('requires trump and overtrump, permits undertrump only when unable to beat', () => {
    const s = playState(); s.ihale.trick = [{ seat: 2, card: card('H', 1) }, { seat: 3, card: card('S', 8) }];
    s.players[0].hand = [card('S', 3), card('S', 9), card('C', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['S9-0']);
    s.players[0].hand = [card('S', 3), card('C', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['S3-0']);
    s.players[0].hand = [card('C', 1)]; expect(legalIhaleCards(s).length).toBe(1);
  });
  it.each(['S', 'H', 'C', 'D'] as Suit[])('allows any led-suit card after a ruff with %s, but still requires following', trump => {
    const lead = (['S', 'H', 'C', 'D'] as Suit[]).find(suit => suit !== trump)!;
    const s = playState(); s.ihale.trump = trump; s.currentSeat = 2;
    s.ihale.trick = [{ seat: 0, card: card(lead, 5) }, { seat: 1, card: card(trump, 3) }];
    s.players[2].hand = [card(lead, 2), card(lead, 10), card(trump, 1)];
    const before = JSON.stringify(s);
    expect(legalIhaleCards(s).map(c => c.id)).toEqual([`${lead}2-0`, `${lead}10-0`]);
    expect(() => applyIhaleCommand(s, { t: 'ihalePlay', revision: s.revision, cardId: `${trump}1-0` }, 0)).toThrow('illegal_card');
    const next = applyIhaleCommand(s, { t: 'ihalePlay', revision: s.revision, cardId: `${lead}2-0` }, 0);
    expect(ihaleTrickWinner(next.ihale.trick, trump)).toBe(1);
    expect(JSON.stringify(s)).toBe(before);
  });
  it('still requires raising when trump itself was led', () => {
    const s = playState(); s.ihale.trick = [{ seat: 3, card: card('S', 5) }];
    s.players[0].hand = [card('S', 2), card('S', 10), card('H', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['S10-0']);
  });
  it('matches H5 / S3: overtrump, otherwise undertrump, otherwise discard without winning', () => {
    const s = playState(); s.currentSeat = 2;
    s.ihale.trick = [{ seat: 0, card: card('H', 5) }, { seat: 1, card: card('S', 3) }];
    s.players[2].hand = [card('S', 2), card('S', 4), card('C', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['S4-0']);
    s.players[2].hand = [card('S', 2), card('C', 1)];
    expect(legalIhaleCards(s).map(c => c.id)).toEqual(['S2-0']);
    const under = applyIhaleCommand(s, { t: 'ihalePlay', revision: s.revision, cardId: 'S2-0' }, 0);
    expect(ihaleTrickWinner(under.ihale.trick, 'S')).toBe(1);
    s.players[2].hand = [card('C', 1), card('D', 1)];
    expect(legalIhaleCards(s)).toEqual(s.players[2].hand);
    for (const choice of s.players[2].hand) {
      const next = applyIhaleCommand(s, { t: 'ihalePlay', revision: s.revision, cardId: choice.id }, 0);
      next.players[3].hand = [card('H', 2), card('H', 1)];
      expect(legalIhaleCards(next).map(c => c.id)).toEqual(['H2-0', 'H1-0']);
      const end = applyIhaleCommand(next, { t: 'ihalePlay', revision: next.revision, cardId: 'H1-0' }, 3);
      expect(end.ihale.trickWinner).toBe(1); expect(end.ihale.tricks).toEqual([0, 1, 0, 0]);
    }
  });
  it('trump beats ace; highest trump wins', () => {
    expect(ihaleTrickWinner([{ seat: 0, card: card('H', 1) }, { seat: 1, card: card('S', 2) },
      { seat: 2, card: card('S', 9) }, { seat: 3, card: card('C', 1) }], 'S')).toBe(2);
  });
  it('dummy is controlled by bidder only, without altering seat order', () => {
    let s = playState();
    for (const actor of [0, 1]) s = applyIhaleCommand(s, ihaleBotCommand(s), actor);
    expect(s.currentSeat).toBe(2); expect(ihaleController(s)).toBe(0);
    expect(() => applyIhaleCommand(s, ihaleBotCommand(s), 2)).toThrow('not_your_turn');
    const original = s, cmd = ihaleBotCommand(s);
    s = applyIhaleCommand(s, cmd, 0);
    expect(s.currentSeat).toBe(3); expect(original.players[2].hand.length).toBe(13);
    expect(() => applyIhaleCommand(s, cmd, 0)).toThrow('stale_move');
    expect(() => applyIhaleCommand(s, ihaleBotCommand(s), -1)).toThrow('not_your_turn');
  });
  it.each([
    [[4, 3, 4, 2], 8, [80, 50, 80, 50]],
    [[4, 3, 3, 3], 8, [-80, 60, -80, 60]],
    [[5, 1, 5, 2], 8, [100, 30, 100, 30]],
    [[7, 0, 6, 0], 8, [130, -130, 130, -130]],
    [[0, 7, 0, 6], 8, [-130, 130, -130, 130]],
  ])('scores team examples %j', (tricks, bid, points) => {
    expect(scoreIhaleTeams(tricks as number[], 0, bid as number)).toEqual(points);
  });
  it('adds an extra hand on a team draw', () => {
    let s = playState(); s.ihale.phase = 'trickEnd'; s.ihale.tricks = [4, 3, 4, 2]; s.ihale.bid = 8;
    s.players[1].totalScore = 30; s.players[3].totalScore = 30;
    s = collectIhaleTrick(s);
    expect(s.phase).toBe('handEnded'); expect(s.rules.totalHands).toBe(2);
    s = nextIhaleHand(s); expect(s.dealerSeat).toBe(1); expect(s.currentSeat).toBe(1);
  });
  it.each([
    [[5, 0, 4, 4], 5, [50, -50, 40, 40]],
    [[4, 0, 5, 4], 5, [-50, -50, 50, 40]],
    [[0, 1, 6, 6], 5, [-50, 10, 60, 60]],
    [[7, 0, 0, 6], 5, [70, -50, -50, 60]],
    [[13, 0, 0, 0], 5, [130, -50, -50, -50]],
    [[13, 0, 0, 0], 13, [130, -130, -130, -130]],
    [[4, 3, 3, 3], 4, [40, 30, 30, 30]],
  ])('scores solo tricks %j without team bonuses or double penalties', (tricks, bid, points) => {
    for (let rotation = 0; rotation < 4; rotation++) {
      const rotate = (a: number[]) => a.map((_, seat) => a[(seat - rotation + 4) % 4]);
      expect(scoreIhaleSolo(rotate(tricks as number[]), rotation, bid as number)).toEqual(rotate(points as number[]));
    }
  });
  it('extends a solo first-place tie, but not a lower-place tie', () => {
    const s = createIhaleGame({ seed: 2, rules: { totalHands: 1, teamMode: false } });
    s.ihale.phase = 'trickEnd'; s.ihale.trump = 'H'; s.ihale.bid = 5; s.ihale.tricks = [0, 1, 6, 6];
    const next = collectIhaleTrick(s);
    expect(next.phase).toBe('handEnded'); expect(next.rules.totalHands).toBe(2);
    expect(s.rules.totalHands).toBe(1); expect(nextIhaleHand(next).ihale.dummySeat).toBe(-1);
    s.ihale.tricks = [6, 1, 3, 3];
    const done = collectIhaleTrick(s);
    expect(done.phase).toBe('matchEnded'); expect(done.matchWinnerSeat).toBe(0);
  });
  it('scores a complete solo hand and awards the highest cumulative score', () => {
    let s = createIhaleGame({ seed: 2, rules: { totalHands: 1, teamMode: false } });
    expect(ihaleBidOptions(s)[0]).toBe(4);
    s = applyIhaleCommand(s, { t: 'ihaleBid', revision: 0, bid: 4 }, 0);
    expect(ihaleBidOptions(s)[0]).toBe(5);
    while (s.phase !== 'matchEnded') s = s.phase === 'handEnded' ? nextIhaleHand(s) : s.ihale.phase === 'trickEnd' ? collectIhaleTrick(s) : applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
    expect(s.lastHandResult!.scorePending).toBe(false);
    expect(s.players[s.matchWinnerSeat].totalScore).toBe(Math.max(...s.players.map(p => p.totalScore)));
    for (const h of s.history) expect(h.points).toEqual(scoreIhaleSolo(h.tricks, h.bidder, h.bid));
    expect(s.players.map(p => p.totalScore)).toEqual([0, 1, 2, 3].map(seat => s.history.reduce((n, h) => n + h.points[seat], 0)));
  });
  it('completes seeded bot matches without illegal moves or missing cards', () => {
    for (let seed = 0; seed < 100; seed++) {
      let s = createIhaleGame({ seed, rules: { totalHands: 3, teamMode: true } });
      let steps = 0;
      while (s.phase !== 'matchEnded' && steps++ < 2000) {
        s = s.phase === 'handEnded' ? nextIhaleHand(s) : s.ihale.phase === 'trickEnd' ? collectIhaleTrick(s) : applyIhaleCommand(s, ihaleBotCommand(s), ihaleController(s));
      }
      expect(s.phase).toBe('matchEnded'); expect(s.players.every(p => p.hand.length === 0)).toBe(true);
      expect(s.history.every(h => h.tricks.reduce((a, b) => a + b, 0) === 13)).toBe(true);
    }
  });
});
