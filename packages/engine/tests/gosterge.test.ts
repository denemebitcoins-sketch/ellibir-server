import { describe, it, expect } from 'vitest';
import { createGame, viewFor, applyMove } from '../src/game';
import type { Card } from '../src/types';

/** İlk el için gösterge state'i kurulu mu, viewFor doğru yansıtıyor mu. */
describe('gösterge — kurulum ve görünürlük', () => {
  it('ilk el destenin dibinde (stock[0]) AÇIK gösterge kartı vardır', () => {
    const s = createGame({ seed: 42 });
    expect(s.handNumber).toBe(1);
    expect(s.gostergeKart).toBeTruthy();
    expect(s.gostergeKart).toEqual(s.stock[0]);
    expect(s.gostergeTaken).toBe(false);
    expect(s.gostergeShown).toEqual([]);
  });

  it('gösterge kartı viewFor ile HERKESE görünür (ilk el)', () => {
    const s = createGame({ seed: 42 });
    for (let seat = 0; seat < s.rules.playerCount; seat++) {
      const v = viewFor(s, seat);
      expect(v.gostergeKart).toBeTruthy();
    }
  });

  it('kart çeken oyuncunun gösterge hakkı KİLİTLENİR (artık gösteremez)', () => {
    const s = createGame({ seed: 7 });
    // Dağıtıcı action'da; bir sonraki oyuncu draw'da. Sırayı draw fazına getir:
    // dağıtıcı bir kart atsın (advanceTurn → sonraki draw).
    const dealer = s.players[s.currentSeat]!;
    const after = applyMove(s, { type: 'discard', cardId: dealer.hand[dealer.hand.length - 1]!.id });
    // Sıradaki oyuncu draw fazında; çeksin → kilitlensin.
    const drawer = after.currentSeat;
    const drawn = applyMove(after, { type: 'drawStock' });
    expect(drawn.gostergeLocked).toContain(drawer);
    // Kilitliyken göster denemesi reddedilir.
    const v = viewFor(drawn, drawer);
    expect(v.gostergeCanShow).toBe(false);
  });
});
