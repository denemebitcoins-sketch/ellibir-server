import { describe, expect, it } from 'vitest';
import { populationMatchExtras } from './populationExtras';

const ok = (args: any) => ({ ok: true, points: 35, double: false, capped: false, coffee_kind: args.p_won ? null : 'refund', coffee_amount: args.p_won ? 0 : 500 });

describe('canlı botlu masada gerçek oyuncu haftalık puan + Kahve Saati alır', () => {
  it('tekli: yalnız insan gönderilir, kazanç bot sistemi ödemesiyle hesaplanır', async () => {
    const calls: any[] = [];
    const out = await populationMatchExtras({
      match_key: 'pm1', owner_id: 'o', room_key: 'r', game: 'yuzbir', bet: 1000, team_mode: false, state: 'settled', winner_seat: 0, house_amount: 400,
      roster: [{ seat: 0, kind: 'human', id: 'h1' }, { seat: 1, kind: 'bot', id: 'b1', token: 't' }, { seat: 2, kind: 'bot', id: 'b2', token: 't' }, { seat: 3, kind: 'bot', id: 'b3', token: 't' }],
    }, 3, async (fn, args) => { calls.push({ fn, args }); return ok(args); });
    expect(calls).toEqual([{ fn: 'match_extras', args: { p_user: 'h1', p_game: 'yuzbir', p_hands: 3, p_won: true, p_bet: 1000, p_net: 2600, p_key: 'pm1' } }]);
    expect(out).toEqual([{ seat: 0, userId: 'h1', points: 35, double: false, capped: false, coffeeKind: null, coffeeAmount: 0 }]);
  });

  it('eşli: kazanan takımdaki insan ödülün yarısını alır, kaybeden insan iade hakkı için gönderilir', async () => {
    const calls: any[] = [];
    await populationMatchExtras({
      match_key: 'pm2', owner_id: 'o', room_key: 'r', game: 'duz', bet: 1000, team_mode: true, state: 'settled', winner_seat: 1, house_amount: 400,
      roster: [{ seat: 0, kind: 'human', id: 'h0' }, { seat: 1, kind: 'bot', id: 'b1', token: 't' }, { seat: 2, kind: 'bot', id: 'b2', token: 't' }, { seat: 3, kind: 'human', id: 'h3' }],
    }, 5, async (fn, args) => { calls.push(args); return ok(args); });
    expect(calls.map(a => [a.p_user, a.p_won, a.p_net])).toEqual([['h0', false, 0], ['h3', true, 800]]);
  });

  it('iade edilen / sonuçsuz maç puan vermez', async () => {
    let n = 0;
    const out = await populationMatchExtras({
      match_key: 'pm3', owner_id: 'o', room_key: 'r', game: 'tavla', bet: 1000, team_mode: false, state: 'refunded', winner_seat: null, house_amount: 0,
      roster: [{ seat: 0, kind: 'human', id: 'h' }, { seat: 1, kind: 'bot', id: 'b', token: 't' }],
    }, 5, async () => { n++; return {}; });
    expect(n).toBe(0); expect(out).toEqual([]);
    expect(await populationMatchExtras(null, 3, async () => { n++; return {}; })).toEqual([]);
  });

  it('maç bitmeden masadan çıkan gerçek oyuncu puan / Kahve Saati almaz (18.11)', async () => {
    const calls: any[] = [];
    await populationMatchExtras({
      match_key: 'pm4', owner_id: 'o', room_key: 'r', game: 'yuzbir', bet: 5000, team_mode: false, state: 'settled', winner_seat: 0, house_amount: 0,
      roster: [{ seat: 0, kind: 'human', id: 'kalan' }, { seat: 1, kind: 'human', id: 'cikan' }, { seat: 2, kind: 'bot', id: 'b2', token: 't' }, { seat: 3, kind: 'bot', id: 'b3', token: 't' }],
    }, 9, async (fn, args) => { calls.push(args); return ok(args); }, ['kalan']);
    expect(calls.map(a => a.p_user)).toEqual(['kalan']);
    const none: any[] = [];
    await populationMatchExtras({
      match_key: 'pm5', owner_id: 'o', room_key: 'r', game: 'tavla', bet: 1000, team_mode: false, state: 'settled', winner_seat: 1, house_amount: 0,
      roster: [{ seat: 0, kind: 'human', id: 'cikan' }, { seat: 1, kind: 'bot', id: 'b', token: 't' }],
    }, 5, async (fn, args) => { none.push(args); return ok(args); }, []);
    expect(none).toEqual([]);
  });

  it('DB eski sürümdeyse (p_started_at yok → 404) parametresiz tekrar dener', async () => {
    const seen: any[] = [];
    const out = await populationMatchExtras({
      match_key: 'pm6', owner_id: 'o', room_key: 'r', game: 'tavla', bet: 1000, team_mode: false, state: 'settled', winner_seat: 0, house_amount: 0,
      roster: [{ seat: 0, kind: 'human', id: 'h' }, { seat: 1, kind: 'bot', id: 'b', token: 't' }],
    }, 5, async (fn, args) => {
      seen.push({ ...args });
      if ('p_started_at' in args) throw new Error('match_extras_http_404:{"code":"PGRST202"}');
      return ok(args);
    }, ['h'], '2026-11-18T20:10:00+03:00');
    expect(seen.length).toBe(2);
    expect('p_started_at' in seen[1]).toBe(false);
    expect(out.length).toBe(1);
  });
});
