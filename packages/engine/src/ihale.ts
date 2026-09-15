import { buildDeck, createRng, deal, shuffle, type Rng } from './deck';
import { DEFAULT_RULES, type RuleConfig } from './rules';
import type { NormalCard, Suit } from './types';

export const IHALE_SUITS: readonly Suit[] = ['S', 'H', 'C', 'D'];
export type IhalePhase = 'bid' | 'trump' | 'play' | 'trickEnd' | 'ended';
export interface IhalePlayer {
  seat: number; name: string; isBot: boolean; abandoned?: boolean;
  hand: NormalCard[]; totalScore: number;
}
export interface IhaleTrickCard { seat: number; card: NormalCard }
export interface IhaleHandResult {
  hand: number; bidder: number; bid: number; trump: Suit;
  tricks: number[]; points: number[]; totals: number[]; scorePending: boolean;
}
export interface IhaleState {
  random?: Rng;
  seed: number; rules: RuleConfig; players: IhalePlayer[];
  phase: 'action' | 'handEnded' | 'matchEnded'; currentSeat: number;
  handNumber: number; dealerSeat: number; revision: number;
  matchWinnerSeat: number; matchDraw: boolean; matchLog: string[];
  lastHandResult: IhaleHandResult | null; history: IhaleHandResult[];
  ihale: {
    phase: IhalePhase; bid: number; bidder: number; opened: boolean;
    passed: boolean[]; bids: number[]; trump: Suit | null; dummySeat: number;
    trick: IhaleTrickCard[]; played?: IhaleTrickCard[]; tricks: number[]; trickWinner: number;
    overtrumpRequired: boolean;
  };
}
export type IhaleCommand =
  | { t: 'ihaleBid'; revision: number; bid: number }
  | { t: 'ihalePass'; revision: number }
  | { t: 'ihaleTrump'; revision: number; suit: Suit }
  | { t: 'ihalePlay'; revision: number; cardId: string };

export class IhaleError extends Error {
  constructor(public code: string) { super(code); this.name = 'MoveError'; }
}
const requireRule = (ok: unknown, code: string) => { if (!ok) throw new IhaleError(code); };
export const ihaleRank = (c: NormalCard) => c.rank === 1 ? 14 : c.rank;
export function sortIhaleHand(cards: readonly NormalCard[]): NormalCard[] {
  return [...cards].sort((a, b) => IHALE_SUITS.indexOf(a.suit) - IHALE_SUITS.indexOf(b.suit) || ihaleRank(b) - ihaleRank(a));
}
export function createIhaleGame(opts: {
  seed: number; playerNames?: string[]; botSeats?: number[];
  rules?: Partial<RuleConfig>; overtrumpRequired?: boolean;
  random?: Rng;
}): IhaleState {
  const rules = { ...DEFAULT_RULES, ...opts.rules, deckCount: 1, jokerCount: 0,
    playerCount: 4, handSize: 13, dealerExtraCards: 0 };
  requireRule([1, 3, 5, 7, 9, 11].includes(rules.totalHands), 'invalid_hands');
  const s: IhaleState = {
    seed: opts.seed | 0, random: opts.random, rules, players: Array.from({ length: 4 }, (_, seat) => ({
      seat, name: opts.playerNames?.[seat] || `Oyuncu ${seat + 1}`,
      isBot: opts.botSeats?.includes(seat) ?? false, hand: [], totalScore: 0,
    })), phase: 'action', currentSeat: 0, handNumber: 1, dealerSeat: 0, revision: 0,
    matchWinnerSeat: -1, matchDraw: false, matchLog: [], lastHandResult: null, history: [],
    ihale: { phase: 'bid', bid: 7, bidder: 0, opened: false, passed: [false, false, false, false], bids: [7, 0, 0, 0],
      trump: null, dummySeat: -1, trick: [], tricks: [0, 0, 0, 0], trickWinner: -1,
      overtrumpRequired: opts.overtrumpRequired ?? true },
  };
  return dealIhaleHand(s);
}
function dealIhaleHand(s: IhaleState): IhaleState {
  const hands = deal(shuffle(buildDeck(s.rules), s.random ?? createRng((s.seed + s.handNumber - 1) | 0)), s.rules, s.dealerSeat).hands;
  s.players = s.players.map((p, seat) => ({ ...p, hand: sortIhaleHand(hands[seat] as NormalCard[]) }));
  s.currentSeat = s.dealerSeat;
  s.phase = 'action';
  s.ihale = { ...s.ihale, phase: 'bid', bid: s.rules.teamMode ? 7 : 4, bidder: s.dealerSeat, opened: false,
    passed: [false, false, false, false], bids: [0, 0, 0, 0], trump: null, dummySeat: -1,
    trick: [], played: [], tricks: [0, 0, 0, 0], trickWinner: -1 };
  s.ihale.bids[s.dealerSeat] = s.ihale.bid;
  return s;
}
function clone(s: IhaleState): IhaleState {
  return { ...s, players: s.players.map(p => ({ ...p, hand: [...p.hand] })),
    matchLog: [...s.matchLog], history: [...s.history], ihale: { ...s.ihale,
      passed: [...s.ihale.passed], bids: [...s.ihale.bids], trick: [...s.ihale.trick], played: [...(s.ihale.played ?? s.ihale.trick)], tricks: [...s.ihale.tricks] } };
}
export function ihaleController(s: IhaleState): number {
  return s.ihale.phase === 'play' && s.currentSeat === s.ihale.dummySeat ? s.ihale.bidder : s.currentSeat;
}
export function ihaleBidOptions(s: IhaleState): number[] {
  if (s.ihale.phase !== 'bid') return [];
  const min = s.ihale.opened ? s.ihale.bid + 1 : s.rules.teamMode ? 7 : 4;
  return Array.from({ length: 14 - min }, (_, n) => min + n);
}
export function ihaleTrickWinner(trick: IhaleTrickCard[], trump: Suit): number {
  requireRule(trick.length > 0, 'empty_trick');
  const lead = trick[0].card.suit;
  const weight = (c: NormalCard) => (c.suit === trump ? 100 : c.suit === lead ? 50 : 0) + ihaleRank(c);
  return trick.reduce((best, x) => weight(x.card) > weight(best.card) ? x : best).seat;
}
export function legalIhaleCards(s: IhaleState): NormalCard[] {
  if (s.phase !== 'action' || s.ihale.phase !== 'play') return [];
  return legalFromHand(s.players[s.currentSeat].hand, s.ihale.trick, s.ihale.trump!, s.ihale.overtrumpRequired);
}
function legalFromHand(hand: NormalCard[], trick: IhaleTrickCard[], trump: Suit, overtrump: boolean): NormalCard[] {
  if (!trick.length) return [...hand];
  const lead = trick[0].card.suit;
  const same = hand.filter(c => c.suit === lead);
  if (same.length) {
    // A ruff removes the raise obligation, but never the obligation to follow suit.
    if (lead !== trump && trick.some(x => x.card.suit === trump)) return same;
    const high = Math.max(...trick.filter(x => x.card.suit === lead).map(x => ihaleRank(x.card)));
    const above = same.filter(c => ihaleRank(c) > high);
    return above.length ? above : same;
  }
  const trumps = hand.filter(c => c.suit === trump);
  if (!trumps.length) return [...hand];
  const highTrump = Math.max(0, ...trick.filter(x => x.card.suit === trump).map(x => ihaleRank(x.card)));
  const above = trumps.filter(c => ihaleRank(c) > highTrump);
  return overtrump && above.length ? above : trumps;
}
export function applyIhaleCommand(original: IhaleState, cmd: IhaleCommand, actor: number): IhaleState {
  requireRule(cmd && Number.isInteger(cmd.revision) && cmd.revision === original.revision, 'stale_move');
  requireRule(original.phase === 'action' && actor >= 0 && actor === ihaleController(original), 'not_your_turn');
  const s = clone(original), i = s.ihale;
  switch (cmd.t) {
    case 'ihaleBid':
      requireRule(i.phase === 'bid' && Number.isInteger(cmd.bid) && ihaleBidOptions(s).includes(cmd.bid), 'invalid_bid');
      i.bid = cmd.bid; i.bidder = actor; i.opened = true;
      i.bids[actor] = cmd.bid;
      s.matchLog.push(`${s.players[actor].name} ihale: ${cmd.bid}`);
      if (cmd.bid === 13) { i.phase = 'trump'; s.currentSeat = actor; }
      else advanceAuction(s);
      break;
    case 'ihalePass':
      requireRule(i.phase === 'bid' && i.opened && actor !== i.bidder, 'compulsory_bid');
      s.matchLog.push(`${s.players[actor].name} pas dedi.`);
      i.passed[actor] = true; advanceAuction(s);
      break;
    case 'ihaleTrump':
      requireRule(i.phase === 'trump' && IHALE_SUITS.includes(cmd.suit), 'invalid_trump');
      i.trump = cmd.suit; i.phase = 'play';
      s.matchLog.push(`${s.players[actor].name} koz: ${{ S: 'Maça', H: 'Kupa', C: 'Sinek', D: 'Karo' }[cmd.suit]}`);
      i.dummySeat = s.rules.teamMode ? (i.bidder + 2) % 4 : -1;
      s.currentSeat = i.bidder;
      break;
    case 'ihalePlay': {
      requireRule(i.phase === 'play', 'wrong_phase');
      const card = legalIhaleCards(s).find(c => c.id === cmd.cardId);
      requireRule(card, 'illegal_card');
      s.players[s.currentSeat].hand = s.players[s.currentSeat].hand.filter(c => c.id !== card!.id);
      i.trick.push({ seat: s.currentSeat, card: card! });
      i.played!.push({ seat: s.currentSeat, card: card! });
      if (i.trick.length === 4) {
        i.trickWinner = ihaleTrickWinner(i.trick, i.trump!);
        i.tricks[i.trickWinner]++;
        s.matchLog.push(`${s.players[i.trickWinner].name} aldı. Alış: ${i.tricks[i.trickWinner]}`);
        i.phase = 'trickEnd'; s.currentSeat = i.trickWinner;
      } else s.currentSeat = (s.currentSeat + 1) % 4;
      break;
    }
    default: throw new IhaleError('invalid_command');
  }
  s.revision++;
  s.matchLog = s.matchLog.slice(-80);
  return s;
}
function advanceAuction(s: IhaleState) {
  const i = s.ihale;
  if (i.passed.filter(Boolean).length === 3) { i.phase = 'trump'; s.currentSeat = i.bidder; return; }
  do { s.currentSeat = (s.currentSeat + 1) % 4; } while (i.passed[s.currentSeat]);
}
export function scoreIhaleTeams(tricks: number[], bidder: number, bid: number): number[] {
  requireRule(tricks.length === 4 && tricks.every(n => Number.isInteger(n) && n >= 0) && tricks.reduce((a, b) => a + b, 0) === 13, 'invalid_tricks');
  const taken = [tricks[0] + tricks[2], tricks[1] + tricks[3]];
  const points = taken.map((n, team) => n === 13 ? 130 : taken[1 - team] === 13 ? -130 : team === bidder % 2 && n < bid ? -bid * 10 : n * 10);
  return [points[0], points[1], points[0], points[1]];
}
export function scoreIhaleSolo(tricks: number[], bidder: number, bid: number): number[] {
  requireRule(tricks.length === 4 && tricks.every(n => Number.isInteger(n) && n >= 0) && tricks.reduce((a, b) => a + b, 0) === 13, 'invalid_tricks');
  requireRule(Number.isInteger(bidder) && bidder >= 0 && bidder < 4 && Number.isInteger(bid) && bid >= 4 && bid <= 13, 'invalid_bid');
  return tricks.map((taken, seat) => taken === 0 || seat === bidder && taken < bid ? -bid * 10 : taken * 10);
}
// Authority-only transition: leave all four cards visible until the room/local timer collects them.
export function collectIhaleTrick(original: IhaleState): IhaleState {
  requireRule(original.ihale.phase === 'trickEnd', 'wrong_phase');
  const s = clone(original), i = s.ihale;
  s.revision++;
  if (i.tricks.reduce((a, b) => a + b, 0) < 13) { i.trick = []; i.phase = 'play'; return s; }
  const points = s.rules.teamMode ? scoreIhaleTeams(i.tricks, i.bidder, i.bid) : scoreIhaleSolo(i.tricks, i.bidder, i.bid);
  s.players.forEach((p, seat) => { p.totalScore += points[seat]; });
  s.lastHandResult = { hand: s.handNumber, bidder: i.bidder, bid: i.bid, trump: i.trump!,
    tricks: [...i.tricks], points, totals: s.players.map(p => p.totalScore), scorePending: false };
  s.history.push(s.lastHandResult);
  i.phase = 'ended';
  const contenders = s.players.slice(0, s.rules.teamMode ? 2 : 4);
  const highest = Math.max(...contenders.map(p => p.totalScore));
  const leaders = contenders.filter(p => p.totalScore === highest);
  if (s.handNumber >= s.rules.totalHands && leaders.length > 1)
    s.rules = { ...s.rules, totalHands: s.handNumber + 1 };
  s.phase = s.handNumber >= s.rules.totalHands ? 'matchEnded' : 'handEnded';
  if (s.phase === 'matchEnded') {
    s.matchDraw = false;
    s.matchWinnerSeat = leaders[0].seat;
  }
  return s;
}
export function nextIhaleHand(original: IhaleState): IhaleState {
  requireRule(original.phase === 'handEnded', 'wrong_phase');
  const s = clone(original);
  s.handNumber++; s.dealerSeat = (s.dealerSeat + 1) % 4; s.revision++;
  return dealIhaleHand(s);
}
export function ihaleBotCommand(s: IhaleState): IhaleCommand {
  const revision = s.revision, i = s.ihale;
  const hand = s.players[s.currentSeat].hand;
  if (i.phase === 'bid') {
    if (!i.opened) return { t: 'ihaleBid', revision, bid: s.rules.teamMode ? 7 : 4 };
    const plan = ihaleBotContract(hand);
    const partnerLeading = s.rules.teamMode && i.bidder % 2 === s.currentSeat % 2;
    // At most one prospective partner trick; never treat it as guaranteed.
    const enter = !partnerLeading && plan.strong && plan.tricks >= (s.rules.teamMode ? 7 : 5)
      && i.bid < 13 && plan.tricks + (s.rules.teamMode ? 1 : 0) >= i.bid + 1;
    return enter ? { t: 'ihaleBid', revision, bid: i.bid + 1 } : { t: 'ihalePass', revision };
  }
  if (i.phase === 'trump') return { t: 'ihaleTrump', revision, suit: ihaleBotContract(hand).trump };
  const actor = ihaleController(s);
  // Never copy hidden opponents' hands into the decision model.
  const known = new Map<number, NormalCard[]>([[actor, s.players[actor].hand]]);
  if (i.dummySeat >= 0) known.set(i.dummySeat, s.players[i.dummySeat].hand);
  const cards = legalIhaleCards(s).sort((a, b) => botCardCost(s, known, a) - botCardCost(s, known, b));
  requireRule(cards.length, 'no_legal_move');
  let best = cards[0], bestValue = -1;
  for (const card of cards) {
    const trick = [...i.trick, { seat: s.currentSeat, card }];
    const value = visibleTrickValue(known, trick, (s.currentSeat + 1) % 4, 3 - i.trick.length,
      actor, s.currentSeat, s.rules.teamMode, i.trump!, i.overtrumpRequired, i.trick.length === 0);
    if (value > bestValue) { best = card; bestValue = value; }
  }
  return { t: 'ihalePlay', revision, cardId: best.id };
}

function topRun(cards: NormalCard[]): number {
  const ranks = new Set<number>(cards.map(ihaleRank));
  let n = 0;
  for (let rank = 14; rank >= 2 && ranks.has(rank); rank--) n++;
  return n;
}
export function ihaleBotContract(hand: NormalCard[]): { trump: Suit; tricks: number; strong: boolean } {
  let best: Suit = IHALE_SUITS[0], bestScore = -1, bestTricks = 0, bestStrong = false;
  for (const suit of IHALE_SUITS) {
    const trumps = hand.filter(c => c.suit === suit);
    const top = topRun(trumps), honors = trumps.filter(c => ihaleRank(c) >= 12).length;
    const tricks = Math.max(top, Math.max(0, trumps.length - 2 - (3 - honors)))
      + IHALE_SUITS.filter(x => x !== suit).reduce((n, x) => n + topRun(hand.filter(c => c.suit === x)), 0);
    const strong = trumps.length >= 5 && honors >= 2;
    const score = (strong ? 100 : 0) + tricks * 3 + top * 4 + trumps.length * 3 + honors * 3;
    if (score > bestScore) { best = suit; bestTricks = tricks; bestStrong = strong; bestScore = score; }
  }
  return { trump: best, tricks: bestTricks, strong: bestStrong };
}
function botCardCost(s: IhaleState, known: Map<number, NormalCard[]>, card: NormalCard): number {
  const i = s.ihale;
  let cost = ihaleRank(card) + (card.suit === i.trump ? 20 : 0);
  if (i.trick.length) return cost;
  const actor = ihaleController(s), ally = (seat: number) => seat === actor || s.rules.teamMode && seat % 2 === actor % 2;
  const seen = new Set<string>();
  const observed = [...(i.played ?? []), ...i.trick].filter(x => {
    if (seen.has(x.card.id)) return false;
    seen.add(x.card.id); return true;
  });
  const safe = [...observed.map(x => x.card), ...[...known].filter(([seat]) => ally(seat)).flatMap(([, cards]) => cards)];
  let higher = 0;
  for (let rank = ihaleRank(card) + 1; rank <= 14; rank++)
    if (!safe.some(c => c.suit === card.suit && ihaleRank(c) === rank)) higher++;
  // Do not volunteer an unsupported honor while its higher cards remain unaccounted for.
  if (ihaleRank(card) >= 11 && higher > 0) cost += 50 + higher * 2;
  const hand = s.players[s.currentSeat].hand;
  const develop = hand.some(c => c.suit !== i.trump && ihaleRank(c) <= 10
    && hand.filter(x => x.suit === c.suit).length >= 3 && hand.some(x => x.suit === c.suit && ihaleRank(x) >= 11));
  if (higher === 0 && develop) cost += 14;
  if (ihaleRank(card) <= 10 && card.suit !== i.trump) cost -= Math.min(4, hand.filter(c => c.suit === card.suit).length - 1) * 3;
  const voids = Array.from({ length: 4 }, () => new Set<Suit>());
  observed.forEach((play, n) => {
    const lead = observed[n - n % 4].card.suit;
    if (play.card.suit === lead) return;
    voids[play.seat].add(lead);
    if (play.card.suit !== i.trump) voids[play.seat].add(i.trump!);
  });
  if (card.suit !== i.trump && Array.from({ length: 13 }, (_, n) => n + 2).some(rank => !safe.some(c => c.suit === i.trump && ihaleRank(c) === rank)))
    for (let seat = 0; seat < 4; seat++)
      if (!ally(seat) && voids[seat].has(card.suit) && !voids[seat].has(i.trump!)) cost += 35;
  return cost;
}

function visibleTrickValue(known: Map<number, NormalCard[]>, trick: IhaleTrickCard[], next: number,
  remaining: number, actor: number, playedSeat: number, team: boolean, trump: Suit, overtrump: boolean, opening: boolean): number {
  if (!remaining) {
    const winner = ihaleTrickWinner(trick, trump);
    if (winner !== actor && !(team && winner % 2 === actor % 2)) return 0;
    const winning = trick.find(x => x.seat === winner)!.card;
    // Prefer a low lead into the visible partner's void; this is not a hidden-hand prediction.
    return opening && winner !== playedSeat && winning.suit === trump && trick[0].card.suit !== trump
      && ihaleRank(trick[0].card) <= 11 ? 2 : 1;
  }
  const hand = known.get(next);
  if (!hand?.length) return visibleTrickValue(known, trick, (next + 1) % 4, remaining - 1,
    actor, playedSeat, team, trump, overtrump, opening);
  const ally = next === actor || team && next % 2 === actor % 2;
  let result = ally ? -1 : 3;
  for (const card of legalFromHand(hand, trick, trump, overtrump)) {
    trick.push({ seat: next, card });
    const value = visibleTrickValue(known, trick, (next + 1) % 4, remaining - 1,
      actor, playedSeat, team, trump, overtrump, opening);
    trick.pop();
    result = ally ? Math.max(result, value) : Math.min(result, value);
  }
  return result;
}
