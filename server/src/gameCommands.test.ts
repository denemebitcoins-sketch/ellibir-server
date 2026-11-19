import { describe, expect, it } from 'vitest';
import { applyClientCommand } from './gameCommands';
import { createGame } from '../../packages/engine/src/game';
import type { Card, GameState, Meld, Rank, Suit } from '../../packages/engine/src/types';

let seq = 0;

function c(suit: Suit, rank: Rank): Card {
  return { id: `${suit}${rank}-cmd-${seq++}`, joker: false, suit, rank };
}

function joker(n = 0): Card {
  return { id: `JOKER-cmd-${n}-${seq++}`, joker: true };
}

function meld(id: string, type: Meld['type'], cards: Card[], ownerSeat = 1): Meld {
  return { id, ownerSeat, type, cards };
}

function rig(
  state: GameState,
  patch: Partial<GameState> & { hands?: Record<number, Card[]>; opened?: number[] },
): GameState {
  const next: GameState = { ...state, ...patch };
  next.players = state.players.map((p) => ({
    ...p,
    hand: patch.hands?.[p.seat] ?? p.hand,
    hasOpened: patch.opened?.includes(p.seat) ?? p.hasOpened,
    openMode: patch.opened?.includes(p.seat) ? ('melds' as const) : p.openMode,
    openedOnTurn: patch.opened?.includes(p.seat) ? 1 : p.openedOnTurn,
  }));
  return next;
}

describe('gameCommands processAllIslek', () => {
  it('joker kurtaran işlek kartı toplu işlemde retrieveJoker olarak uygular', () => {
    const jk = joker(1);
    const replacement = c('D', 12);
    const filler = c('S', 2);
    const state = rig(createGame({ seed: 3, dealerSeat: 3 }), {
      currentSeat: 0,
      phase: 'action',
      opened: [0],
      // küt jokeri ancak tek eksik renk kalınca kurtarılır (♠ ♥ ♣ ★ → ♦)
      melds: [meld('set-joker', 'set', [c('S', 12), c('H', 12), c('C', 12), jk])],
      hands: { 0: [replacement, filler] },
    });

    const result = applyClientCommand(state, { t: 'processAllIslek', cards: [replacement.id] }, 0);
    const next = result.state;

    expect(next.melds[0]!.cards.map((card: Card) => card.id)).toContain(replacement.id);
    expect(next.melds[0]!.cards.some((card: Card) => card.id === jk.id)).toBe(false);
    expect(next.players[0]!.hand.some((card: Card) => card.id === jk.id)).toBe(true);
    expect(next.players[0]!.hand.some((card: Card) => card.id === replacement.id)).toBe(false);
  });

  it('19.11: elde boşta duran jokeri toplu işlemde İŞLEMEZ, diğer işlekleri işler', () => {
    const jk = joker(2);
    const seven = c('H', 7);
    const state = rig(createGame({ seed: 5, dealerSeat: 3 }), {
      currentSeat: 0,
      phase: 'action',
      opened: [0],
      melds: [meld('run', 'run', [c('H', 4), c('H', 5), c('H', 6)])],
      hands: { 0: [jk, seven, c('S', 2)] },
    });
    const next = applyClientCommand(state, { t: 'processAllIslek', cards: [jk.id, seven.id] }, 0).state;
    expect(next.players[0]!.hand.some((card: Card) => card.id === jk.id)).toBe(true);   // joker elde
    expect(next.melds[0]!.cards.some((card: Card) => card.id === seven.id)).toBe(true); // 7 işlendi
  });
});
