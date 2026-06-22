import { describe, expect, it } from 'vitest';
import { createGame, viewFor } from '../src/game';
import { HeuristicBot } from '../src/bot';
import type { Card, GameState } from '../src/types';
import { c } from './helpers';

/** 92 puanlık açış (A-A-A 33 + K-K-K 30 + 9-10-J 29) + atılacak kart. */
function opening92Hand(): Card[] {
  return [
    c('S', 1), c('H', 1), c('D', 1),
    c('S', 13), c('H', 13), c('D', 13),
    c('D', 9), c('D', 10), c('D', 11),
    c('S', 4),
  ];
}

/**
 * 0. koltuk aksiyon fazında, 92'lik açış elinde; deste boyu ve rakip
 * puanları (geride/önde) ayarlanabilir.
 */
function stateFor(opts: { stock: number; myScore: number; rivalScore: number }): GameState {
  let state = createGame({ seed: 7, dealerSeat: 3 });
  const stock = Array.from({ length: opts.stock }, (_, i) => c('C', ((i % 8) + 2) as 2));
  state = {
    ...state,
    currentSeat: 0,
    phase: 'action',
    stock,
    players: state.players.map((p) => ({
      ...p,
      hand: p.seat === 0 ? opening92Hand() : p.hand,
      totalScore: p.seat === 0 ? opts.myScore : opts.rivalScore,
    })),
  };
  return state;
}

describe('PAKET 8 — bot profilleri (RULES.md §3.5)', () => {
  it('GARANTİCİ erken açar: 92 ≥ 81 → hemen açar', () => {
    const state = stateFor({ stock: 40, myScore: 0, rivalScore: 0 });
    const bot = new HeuristicBot({ difficulty: 'normal', profile: 'garantici' });
    const move = bot.nextMove(viewFor(state, 0));
    expect(move.type).toBe('open');
  });

  it('AVCI önde + deste bolken baraj kovalar: 92 < 111 → AÇMAZ (bekler)', () => {
    // Önde (puanım rakiplerden düşük) ama deste sağlıklı → yine de kovalar.
    const state = stateFor({ stock: 40, myScore: 0, rivalScore: 300 });
    const bot = new HeuristicBot({ difficulty: 'normal', profile: 'avci' });
    const move = bot.nextMove(viewFor(state, 0));
    expect(move.type).not.toBe('open'); // 92, baraj eşiği 111'in altında
  });

  it('AVCI deste tükenirken + öndeyken tabana iner: 92 ≥ 81 → açar (kapı kapanmadan)', () => {
    // Deste az (stockHealthy=false) ve önde (behind=false) → kovalama kapanır.
    const state = stateFor({ stock: 4, myScore: 0, rivalScore: 300 });
    const bot = new HeuristicBot({ difficulty: 'normal', profile: 'avci' });
    const move = bot.nextMove(viewFor(state, 0));
    expect(move.type).toBe('open');
  });

  it('AVCI gerideyken deste azsa da baraj kovalar: 92 < 111 → AÇMAZ', () => {
    // Geride (puanım yüksek) → deste azalsa bile baraj peşinde.
    const state = stateFor({ stock: 4, myScore: 400, rivalScore: 0 });
    const bot = new HeuristicBot({ difficulty: 'normal', profile: 'avci' });
    const move = bot.nextMove(viewFor(state, 0));
    expect(move.type).not.toBe('open');
  });

  it('DENGELİ taban davranışı: eşikte açar (92 ≥ 81), puan/desteye bakmaz', () => {
    const ahead = stateFor({ stock: 40, myScore: 0, rivalScore: 300 });
    const behind = stateFor({ stock: 4, myScore: 400, rivalScore: 0 });
    const bot = new HeuristicBot({ difficulty: 'normal', profile: 'dengeli' });
    expect(bot.nextMove(viewFor(ahead, 0)).type).toBe('open');
    expect(bot.nextMove(viewFor(behind, 0)).type).toBe('open');
  });

  it('geriye dönük yapıcı: string difficulty = dengeli profil (davranış değişmez)', () => {
    const state = stateFor({ stock: 40, myScore: 0, rivalScore: 300 });
    const legacy = new HeuristicBot('normal');
    expect(legacy.nextMove(viewFor(state, 0)).type).toBe('open'); // dengeli gibi açar
  });
});
