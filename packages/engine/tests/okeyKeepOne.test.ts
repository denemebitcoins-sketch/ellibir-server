import { describe, expect, it } from 'vitest';
import { createOkeyGame, applyOkeyMove, autoOkeyMove, playOkeyBotTurn } from '../src/okey';
import type { NormalOkeyTile, OkeyColor, OkeyRank, OkeyGameState } from '../src/okey';

/**
 * Regresyon: 101'de açma/işleme eli BOŞALTAMAZ — bitiş her zaman son taşı atarak olur.
 * Eski hata: elde R1,R2 + çekilen R3 → AÇ → el boşaldı, atılacak taş yok, sıra kilitlendi.
 */
let seq = 0;
const t = (color: OkeyColor, rank: number): NormalOkeyTile =>
  ({ id: `${color}${rank}-k${seq++}`, fake: false, color, rank: rank as OkeyRank });

function g101(): OkeyGameState {
  const st = createOkeyGame({ seed: 7, dealerSeat: 0, rules: { variant: 'yuzbir', totalEls: 1 } as any });
  st.gosterge = t('K', 12);
  st.okeyColor = 'K';
  st.okeyRank = 13 as OkeyRank;
  st.phase = 'discard';
  st.turn = 0;
  return st;
}

function openedWith(st: OkeyGameState, mode: 'melds' | 'pairs', hand: NormalOkeyTile[]) {
  const p = st.players[0]!;
  p.hasOpened = true;
  p.openMode = mode;
  p.hand = hand;
  return p;
}

const KEEP = 'Elinde atacak en az bir taş kalmalı.';

describe('101: elde atacak en az bir taş kalmalı', () => {
  it('rapor edilen senaryo: R1,R2 + çekilen R3 ile tüm eli açmak reddedilir, el ve sıra korunur', () => {
    const st = g101();
    const r1 = t('R', 1), r2 = t('R', 2), r3 = t('R', 3);
    const p = openedWith(st, 'melds', [r1, r2]);
    st.phase = 'draw';
    st.stock.push(r3);
    expect(applyOkeyMove(st, 0, { t: 'draw', from: 'pile' }).ok).toBe(true);

    const r = applyOkeyMove(st, 0, { t: 'open', groups: [[r1.id, r2.id, r3.id]] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(KEEP);
    expect(p.hand).toHaveLength(3);
    expect(st.openMelds).toHaveLength(0);
    expect(st.phase).toBe('discard');
    // Oyun kilitlenmez: oyuncu bir taş atıp sırayı devreder.
    expect(applyOkeyMove(st, 0, { t: 'discard', tileId: r3.id }).ok).toBe(true);
    expect(st.turn).toBe(1);
  });

  it('bir taş eldeyken açmaya izin verilir, son taşı atınca el biter', () => {
    const st = g101();
    const r1 = t('R', 1), r2 = t('R', 2), r3 = t('R', 3), y9 = t('Y', 9);
    openedWith(st, 'melds', [r1, r2, r3, y9]);
    expect(applyOkeyMove(st, 0, { t: 'open', groups: [[r1.id, r2.id, r3.id]] }).ok).toBe(true);
    expect(applyOkeyMove(st, 0, { t: 'discard', tileId: y9.id }).ok).toBe(true);
    expect(st.elEnded).toBe(true);
    expect(st.elWinner).toBe(0);
  });

  it('ilk açışta (101 barajı) da tüm taşları açmak reddedilir', () => {
    const st = g101();
    // 3 × (11-12-13 değil; okey K13) → yüksek seriler: R/Y/B 10-11-12-13 = 46 her biri → 138
    const groups = (['R', 'Y', 'B'] as OkeyColor[]).map((c) => [t(c, 10), t(c, 11), t(c, 12), t(c, 13)]);
    const p = st.players[0]!;
    p.hasOpened = false;
    p.hand = groups.flat();
    const r = applyOkeyMove(st, 0, { t: 'open', groups: groups.map((g) => g.map((x) => x.id)) });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(KEEP);
    expect(p.hasOpened).toBe(false);
  });

  it('çift açma / çift ekleme eli boşaltamaz', () => {
    const st = g101();
    const a = t('R', 5), a2 = t('R', 5);
    const p = openedWith(st, 'pairs', [a, a2]);
    const r = applyOkeyMove(st, 0, { t: 'openPairs', pairs: [[a.id, a2.id]] });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(KEEP);
    expect(p.hand).toHaveLength(2);
    // Çiftçi bu durumda bitir hamlesiyle (bir taşı atarak) bitebilir — kilit yok.
    expect(applyOkeyMove(st, 0, { t: 'finish', tileId: a.id }).ok).toBe(true);
    expect(st.elEnded).toBe(true);
  });

  it('işleme (extend) son taşı tüketemez', () => {
    const st = g101();
    const r4 = t('R', 4);
    const p = openedWith(st, 'melds', [r4]);
    st.openMelds = [{ id: 'm1', ownerSeat: 1, kind: 'run', points: 6, tiles: [t('R', 1), t('R', 2), t('R', 3)] }];
    const r = applyOkeyMove(st, 0, { t: 'extend', meldId: 'm1', tileId: r4.id });
    expect(r.ok).toBe(false);
    expect(r.error).toBe(KEEP);
    expect(p.hand).toHaveLength(1);
    expect(st.openMelds[0]!.tiles).toHaveLength(3);
    // Son taş atılarak el biter — işlek olsa da BİTİŞ atışı işlek cezası almaz.
    const before = st.scores[0]!;
    expect(applyOkeyMove(st, 0, { t: 'discard', tileId: r4.id }).ok).toBe(true);
    expect(st.elEnded).toBe(true);
    expect(st.scores[0]).toBe(before + st.rules.yuzbir.winnerBonus);
    expect(st.matchLog.some((l) => l.includes('işlek taş attı'))).toBe(false);
  });

  it('okey kurtarma işlemesi eli küçültmediği için tek taşla da yapılabilir', () => {
    const st = g101();
    const r2 = t('R', 2), okey = t('K', 13);
    const p = openedWith(st, 'melds', [r2]);
    st.openMelds = [{ id: 'm1', ownerSeat: 1, kind: 'run', points: 6, tiles: [t('R', 1), okey, t('R', 3)] }];
    expect(applyOkeyMove(st, 0, { t: 'extend', meldId: 'm1', tileId: r2.id }).ok).toBe(true);
    expect(p.hand.map((x) => x.id)).toEqual([okey.id]);
  });

  it('bot ve süre-doldu otomatik hamlesi aynı durumda eli boşaltmadan turu bitirir', () => {
    for (const mover of ['bot', 'auto'] as const) {
      const st = g101();
      const r1 = t('R', 1), r2 = t('R', 2), r3 = t('R', 3);
      const p = openedWith(st, 'melds', [r1, r2]);
      st.players[0]!.isBot = mover === 'bot';
      st.phase = 'draw';
      st.stock.push(r3);
      if (mover === 'bot') playOkeyBotTurn(st, 0); else autoOkeyMove(st, 0);
      expect(st.turn).toBe(1);
      expect(st.phase).toBe('draw');
      expect(p.hand.length).toBe(2);
      expect(st.elEnded).toBe(false);
    }
  });
});
