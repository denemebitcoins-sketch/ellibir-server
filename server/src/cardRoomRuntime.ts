import { createGame, startNextHand } from '../../packages/engine/src/game';
import { applyClientCommand, stepOnce } from './gameCommands';
import { clientViewFor, clientViewForSpectator } from './clientView';
import { randomInt } from 'node:crypto';
import { applyIhaleCommand, collectIhaleTrick, createIhaleGame, ihaleBidOptions, ihaleBotCommand,
  ihaleController, legalIhaleCards, nextIhaleHand, type IhaleState } from '../../packages/engine/src/ihale';
import type { NormalCard } from '../../packages/engine/src/types';

function cardView(c: NormalCard) {
  return { ...c, red: c.suit === 'H' || c.suit === 'D', label: `${c.rank}${c.suit}` };
}
export function ihaleClientView(s: IhaleState | null, seat: number): any {
  if (!s) return { seat, spectator: seat < 0, phase: 'action', seats: [], myHand: [], melds: [], waitingForPlayers: true };
  const i = s.ihale;
  const yours = seat >= 0 && s.phase === 'action' && ['bid', 'trump', 'play'].includes(i.phase) && ihaleController(s) === seat;
  return { seat, spectator: seat < 0, phase: s.phase, currentSeat: s.currentSeat, yourTurn: yours,
    handNumber: s.handNumber, totalHands: s.rules.totalHands, teamMode: s.rules.teamMode,
    matchWinnerSeat: s.matchWinnerSeat, handWinnerSeat: -1,
    myHand: seat >= 0 ? s.players[seat].hand.map(cardView) : [],
    seats: s.players.map(p => ({ seat: p.seat, name: p.name, isBot: p.isBot, totalScore: p.totalScore,
      handCount: p.hand.length, abandoned: ((s as any).abandoned ?? []).includes(p.seat) })),
    melds: [], sheet: [], logMessages: s.matchLog,
    ihale: { phase: i.phase, revision: s.revision, bidder: i.bidder, bid: i.bid, trump: i.trump ?? '',
      dummySeat: i.dummySeat, controllerSeat: ihaleController(s), trickWinner: i.trickWinner,
      tricks: [...i.tricks], passed: [...i.passed], bids: [...i.bids], scorePending: false,
      canPass: yours && i.phase === 'bid' && i.opened && seat !== i.bidder,
      bidOptions: yours ? ihaleBidOptions(s) : [], legalCards: yours ? legalIhaleCards(s).map(c => c.id) : [],
      dummyHand: i.dummySeat >= 0 ? s.players[i.dummySeat].hand.map(cardView) : [],
      bidderHand: seat >= 0 && seat === i.dummySeat ? s.players[i.bidder].hand.map(cardView) : [],
      trick: i.trick.map(x => ({ seat: x.seat, card: cardView(x.card) })), history: s.history },
  };
}
export const ellibirRuntime = {
  create: createGame, next: startNextHand, apply: applyClientCommand, step: stepOnce,
  controller: (s: any) => s.currentSeat,
  view: (s: any, seat: number) => seat < 0 ? clientViewForSpectator(s) : clientViewFor(s, seat),
};
export const ihaleRuntime: typeof ellibirRuntime = {
  create: ((opts: any) => createIhaleGame({ ...opts, seed: randomInt(0x7fffffff),
    random: () => randomInt(0x100000000) / 0x100000000 })) as any,
  next: nextIhaleHand as any,
  apply: (s, cmd, seat) => ({ state: applyIhaleCommand(s, cmd, seat), skipBots: false }),
  step: (s: any, human) => {
    if (s.phase !== 'action') return { state: s, moved: false };
    if (s.ihale.phase === 'trickEnd') return { state: collectIhaleTrick(s), moved: true };
    const actor = ihaleController(s);
    return human(actor) ? { state: s, moved: false } : { state: applyIhaleCommand(s, ihaleBotCommand(s), actor), moved: true };
  },
  controller: ihaleController, view: ihaleClientView,
};
