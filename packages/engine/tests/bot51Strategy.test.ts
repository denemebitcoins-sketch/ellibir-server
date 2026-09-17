import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { HeuristicBot, type BotDifficulty, type BotProfile } from '../src/bot';
import { applyMove, createGame, evaluateDiscard, viewFor } from '../src/game';
import type { Card, GameState, Move, PlayerView } from '../src/types';
import { c, joker } from './helpers';
import { solveHand } from '../src/solver';
import { computeHandResult } from '../src/scoring';

const corpus: { label: string; difficulty: BotDifficulty; profile: BotProfile; view: PlayerView; move: Move; state: string }[] = [];
const endings: Record<string, string> = {};
const scoringCases: unknown[] = [];
function snapshot(s: GameState): string {
  return [s.handNumber, s.currentSeat, s.phase, s.turnCount,
    s.players.map(p => `${p.hasOpened ? 1 : 0}:${p.openMode ?? ''}:${p.isCift ? 1 : 0}:${p.totalScore}:${p.hand.map(c => c.id).join(',')}`).join('/'),
    s.stock.map(c => c.id).join(','), s.discard.map(c => c.id).join(','),
    s.melds.map(m => `${m.ownerSeat}:${m.type}:${(m.type === 'set' ? m.cards.map(c => c.id).sort() : m.cards.map(c => c.id)).join(',')}`).join(';')].join('|');
}
function decide(s: GameState, label: string, difficulty: BotDifficulty = 'normal', profile: BotProfile = 'dengeli', seat = 0) {
  const view = viewFor(s, seat);
  const before = JSON.stringify(view);
  const move = new HeuristicBot({ difficulty, profile }).nextMove(view);
  expect(JSON.stringify(view)).toBe(before);
  if (process.env.BOT51_CORPUS_FILE) corpus.push({ label, difficulty, profile, view: structuredClone(view), move, state: snapshot(s) });
  return move;
}
function game(hand: Card[]) {
  const s = createGame({ seed: 29, dealerSeat: 3 });
  s.currentSeat = 0; s.phase = 'action'; s.players[0]!.hand = hand;
  s.melds = [{ id: 'public-run', ownerSeat: 1, type: 'run', cards: [c('S', 6), c('S', 7), c('S', 8)] }];
  return s;
}
afterAll(() => {
  if (process.env.BOT51_CORPUS_FILE) writeFileSync(process.env.BOT51_CORPUS_FILE, JSON.stringify({ decisions: corpus, endings, scoringCases }));
});

describe('51 shared bot strategy and penalty contract', () => {
  it('avoids an islek discard even when the safe card belongs to a later usefulness bucket', () => {
    const danger = c('S', 9), safe = c('H', 6);
    const s = game([danger, c('H', 5), safe]);
    const move = decide(s, 'safe semi-useful before penalized disposable');
    expect(move).toEqual({ type: 'discard', cardId: safe.id });
    expect(applyMove(s, move).players[0]!.totalScore).toBe(0);
  });

  it.each([false, true])('does not invent a penalty with enabled=%s and zero penalty points', enabled => {
    const danger = c('S', 9), s = game([danger, c('H', 5), c('H', 6)]);
    s.rules = { ...s.rules, islek: { ...s.rules.islek, penaltyEnabled: enabled, penaltyPoints: 0 } };
    expect(decide(s, `disabled/zero penalty ${enabled}`)).toEqual({ type: 'discard', cardId: danger.id });
  });

  it('uses the identical-copy exemption without confusing it with pair mode', () => {
    const a = c('S', 9), b = c('S', 9), s = game([a, b, c('H', 5), c('H', 6)]);
    expect(evaluateDiscard(a, s.players[0]!.hand, s.melds, s.rules)).toMatchObject({ penalty: 0, duplicate: true, locked: true });
    const move = decide(s, 'identical card exemption');
    expect(move).toEqual({ type: 'discard', cardId: a.id });
    expect(applyMove(s, move).players[0]!.totalScore).toBe(0);
  });

  it('uses the real full hand when a mandatory pickup is excluded from discard choices', () => {
    const a = c('S', 9), b = c('S', 9), s = game([a, b, c('H', 5), c('H', 6)]);
    s.pickup = { cardId: a.id, committed: true, wasOpened: false, zorunlu: true, sorguUsed: true };
    expect(decide(s, 'protected pickup still counts as duplicate')).toEqual({ type: 'discard', cardId: b.id });
  });

  it.each([false, true])('keeps the finish exemption for joker=%s', wild => {
    const card = wild ? joker() : c('S', 9), s = game([card]);
    Object.assign(s.players[0]!, { hasOpened: true, openMode: 'pairs' });
    expect(evaluateDiscard(card, [card], s.melds, s.rules)).toMatchObject({ finish: true, penalty: 0, locked: false });
    const move = decide(s, `finish ${wild}`);
    expect(move).toEqual({ type: 'discard', cardId: card.id });
    expect(applyMove(s, move).sheet.some(row => row.kind === 'islek')).toBe(false);
  });

  it('chooses the smaller unavoidable penalty instead of throwing a joker', () => {
    const danger = c('S', 9), s = game([danger, joker()]);
    const move = decide(s, 'forced penalty minimum');
    expect(move).toEqual({ type: 'discard', cardId: danger.id });
    expect(applyMove(s, move).players[0]!.totalScore).toBe(s.rules.islek.penaltyPoints);
  });

  it('pair-open bot uses exactly one layoff and reserves its final discard', () => {
    let s = game([c('S', 9), c('S', 10), c('D', 3)]);
    Object.assign(s.players[0]!, { hasOpened: true, openMode: 'pairs' });
    const first = decide(s, 'pair one layoff');
    expect(first.type).toBe('extend');
    s = applyMove(s, first);
    expect(s.ciftIslekUsed).toBe(true);
    const second = decide(s, 'pair quota exhausted');
    expect(second).toEqual({ type: 'discard', cardId: s.players[0]!.hand.find(x => !x.joker && x.suit === 'D')!.id });
    expect(() => applyMove(s, second)).not.toThrow();
  });

  it('lays off from a two-card pair hand and then finishes', () => {
    let s = game([c('S', 9), c('D', 3)]);
    Object.assign(s.players[0]!, { hasOpened: true, openMode: 'pairs' });
    s = applyMove(s, decide(s, 'pair penultimate layoff'));
    expect(s.players[0]!.hand).toHaveLength(1);
    s = applyMove(s, decide(s, 'pair last discard'));
    expect(s.lastHandResult?.winnerSeat).toBe(0);
  });

  it('a cift-locked normal bot opens pairs, never a forbidden run', () => {
    const s = game([c('S', 3), c('S', 3), c('H', 6), c('H', 6), c('D', 9), c('D', 9),
      c('C', 11), c('C', 11), c('D', 13), c('D', 13), c('H', 2)]);
    s.players[0]!.isCift = true; s.melds = [];
    const move = decide(s, 'cift locked pair opening');
    expect(move.type).toBe('openPairs');
    expect(() => applyMove(s, move)).not.toThrow();
  });

  it('treats ace as high, not as an A-2-3 prospect', () => {
    const ace = c('H', 1), s = game([ace, c('H', 2), c('D', 8)]);
    s.melds = [];
    expect(decide(s, 'ace not low')).toEqual({ type: 'discard', cardId: ace.id });
    s.players[0]!.hand = [ace, c('H', 13), c('D', 8)];
    expect(decide(s, 'ace king prospect')).toEqual({ type: 'discard', cardId: s.players[0]!.hand[2]!.id });
  });

  it('keeps both physical copies when they complete two independent sets', () => {
    const hand = [c('S', 10), c('H', 10), c('D', 10), c('S', 10), c('H', 10), c('D', 10), c('C', 2)];
    const solved = solveHand(hand, game([]).rules, 'cards');
    expect(solved.cardCount).toBe(6);
    expect(new Set(solved.melds.flat().map(c => c.id)).size).toBe(6);
    const s = game(hand); s.melds = [];
    expect(decide(s, 'two independent same-rank sets')).toEqual({ type: 'discard', cardId: hand[6]!.id });
  });

  it('cannot distinguish changed hidden hands or stock order through the public view', () => {
    const s = game([c('S', 9), c('H', 5), c('H', 6)]);
    const a = decide(s, 'hidden state baseline');
    const changed = structuredClone(s);
    changed.seed = 9999;
    changed.stock.reverse();
    for (let seat = 1; seat < 4; seat++) changed.players[seat]!.hand.reverse();
    expect(decide(changed, 'hidden state permutation')).toEqual(a);
    expect(viewFor(changed, 0)).toEqual(viewFor(s, 0));
  });

  it('agrees with authoritative discard scoring across enabled, duplicate, finish and joker cases', () => {
    for (const enabled of [false, true]) for (const wild of [false, true]) for (const duplicate of [false, true]) for (const finish of [false, true]) {
      const card = wild ? joker(0) : c('S', 9);
      const hand = finish ? [card] : [card, ...(duplicate ? [wild ? joker(1) : c('S', 9)] : [c('D', 2)])];
      const s = game(hand);
      Object.assign(s.players[0]!, { hasOpened: true, openMode: 'melds' });
      s.rules = { ...s.rules, islek: { ...s.rules.islek, penaltyEnabled: enabled } };
      const predicted = evaluateDiscard(card, hand, s.melds, s.rules);
      const next = applyMove(s, { type: 'discard', cardId: card.id });
      expect(next.sheet.filter(row => row.kind === 'islek').reduce((sum, row) => sum + row.amount, 0)).toBe(predicted.penalty);
      expect(next.log.filter(e => e.type === 'discard').at(-1)?.islek === true).toBe(predicted.locked);
    }
  });

  it('records authoritative solo/team, stock-out, closed-base and finish scoring cases', () => {
    for (const team of [false, true]) for (const winner of [null, 0]) for (const opened of [0, 1, 2, 15])
      for (const cift of [0, 1, 2]) for (const handFinish of [false, true]) for (const okeyFinish of [false, true]) for (const pairFinish of [false, true]) {
        const s = game([]);
        s.rules = { ...s.rules, teamMode: team };
        s.players = s.players.map(p => ({ ...p, hand: [c('S', 4)], hasOpened: !!(opened & (1 << p.seat)),
          isCift: !!(cift & (1 << p.seat)), openMode: pairFinish && p.seat === winner ? 'pairs' : 'melds' }));
        const expected = computeHandResult(s, winner, handFinish, okeyFinish);
        expect(expected.penalties).toHaveLength(4);
        if (winner !== null && team) expect(expected.penalties[2]).toBe(0);
        scoringCases.push({ state: { rules: s.rules, players: s.players }, winner, handFinish, okeyFinish, expected });
      }
  });

  it('finishes seeded games legally for all difficulty/style combinations', () => {
    let actions = 0;
    for (const difficulty of ['kolay', 'normal', 'zor'] as const) for (const profile of ['garantici', 'dengeli', 'avci'] as const) for (let seed = 0; seed < 4; seed++) {
      let s = createGame({ seed, botSeats: [0, 1, 2, 3] });
      for (let step = 0; s.phase === 'draw' || s.phase === 'action'; step++) {
        expect(step).toBeLessThan(1500);
        const sg = s.sorgu;
        const actor = sg ? sg.asama === 'ortakGorus' ? sg.partnerSeat! : sg.asama === 'cevap' ? sg.sorulanSeat : sg.askerSeat : s.currentSeat;
        const move = decide(s, `${difficulty}/${profile}/${seed}/${step}`, difficulty, profile, actor);
        s = applyMove(s, move);
        const count = s.stock.length + s.discard.length + s.players.reduce((n, p) => n + p.hand.length, 0) + s.melds.reduce((n, m) => n + m.cards.length, 0);
        expect(count).toBe(106);
        actions++;
      }
      endings[`${difficulty}/${profile}/${seed}`] = snapshot(s);
    }
    expect(actions).toBeGreaterThan(1000);
    console.log(`51: 36 full deals, ${actions} legal decisions`);
  }, 120_000);
});
