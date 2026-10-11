import { describe, expect, it } from 'vitest';
import { applyMove, canSor, createGame } from '../src/game';
import type { Card, GameState, Meld } from '../src/types';
import { c } from './helpers';

/**
 * Regresyon: AÇMIŞ oyuncu yandan denemeye aldığı, KULLANAMAYACAĞI kartı SORARSA ve
 * VER çıkarsa kart zorunlu olur; açık oyuncu kullanmadan atamaz (pickupUnused), kartı
 * geri atamaz (zorunluAlim), geri bırakamaz → tur KİLİTLENİRDİ.
 */
function opened(top: Card, hand0: Card[], melds: Meld[] = []): GameState {
  const s = createGame({ seed: 9, dealerSeat: 3 });
  return {
    ...s,
    currentSeat: 0,
    phase: 'draw',
    discard: [top],
    log: [{ seat: 3, type: 'discard', cardId: top.id }],
    melds,
    players: s.players.map((p) => p.seat === 0
      ? { ...p, hand: hand0, hasOpened: true, openMode: 'melds' as const, openedOnTurn: 1 }
      : p),
  };
}

describe('51 sorgu: açık oyuncu kullanamayacağı kartı soramaz (kilit önleme)', () => {
  it('kullanılamayan kart için SOR kapalı; geri bırakma yolu açık kalır', () => {
    const top = c('C', 9);
    let st = opened(top, [c('S', 2), c('H', 7), c('D', 4)]);
    st = applyMove(st, { type: 'pickupDiscard' });
    expect(canSor(st, 0)).toBe(false);
    expect(() => applyMove(st, { type: 'sor' })).toThrowError();
    const back = applyMove(st, { type: 'cancelPickup' });
    expect(back.phase).toBe('draw');
  });

  it('işlenebilir kart için SOR açık; VER sonrası işleyip normal atarak devam eder', () => {
    const top = c('C', 9);
    const run: Meld = { id: 'mx', ownerSeat: 2, type: 'run', cards: [c('C', 6), c('C', 7), c('C', 8)] };
    let st = opened(top, [c('S', 2), c('H', 7), c('D', 4)], [run]);
    st = applyMove(st, { type: 'pickupDiscard' });
    expect(canSor(st, 0)).toBe(true);
    st = applyMove(st, { type: 'sor' });
    st = applyMove(st, { type: 'sorguCevap', cevap: 'ver' });
    expect(st.pickup?.zorunlu).toBe(true);
    st = applyMove(st, { type: 'extend', meldId: 'mx', cardId: top.id });
    st = applyMove(st, { type: 'discard', cardId: st.players[0]!.hand[0]!.id });
    expect(st.currentSeat).not.toBe(0);
  });
});

import { HeuristicBot } from '../src/bot';
import { viewFor } from '../src/game';

describe('51 bot: açıkken kullanamayacağı denemeyi sormaz, geri bırakır', () => {
  it('açık bot kullanılamaz deneme kartını SOR yerine GERİ BIRAKIR', () => {
    const top = c('C', 9);
    let st = opened(top, [c('S', 2), c('H', 7), c('D', 4)]);
    st = applyMove(st, { type: 'pickupDiscard' });
    const mv = new HeuristicBot('normal').nextMove(viewFor(st, 0));
    expect(mv.type).toBe('cancelPickup');
  });
});
