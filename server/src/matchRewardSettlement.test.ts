import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
beforeEach(() => {
  vi.resetModules();
  calls.length = 0;
  vi.stubEnv('SUPABASE_URL', 'https://unit-test.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const fn = new URL(url).pathname.split('/rpc/')[1];
    if (!fn) throw new Error(`Unexpected external request: ${url}`);
    const args = JSON.parse(String(init.body));
    calls.push({ fn, args });
    const result = fn === 'grant_account_xp' ? { ok: true, xp_awarded: 25, level_before: 1, level_after: 1 }
      : fn === 'canak_add' ? 1000 : true;
    return { ok: true, status: 200, text: async () => JSON.stringify(result), json: async () => result };
  }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('actual settlement RPC reward isolation', () => {
  it.each(['51', 'okey', 'ihale', 'tavla'])('%s: mixed-start suppresses deferred canak and event rewards but keeps human winnings/stats/XP', async game => {
    const { settleMatch } = await import('./supabase');
    const totalSeats = game === 'tavla' ? 2 : 4;
    const awards = await settleMatch({
      seatUsers: new Map([[0, 'human-winner']]), winnerSeat: 0, bet: 1000, teamMode: false,
      totalSeats, game, entryHousePaid: false, matchRewardsEligible: false, progressionKey: 'mixed-match',
    });
    expect(calls.filter(c => c.fn === 'canak_add' || c.fn === 'quest_event_for')).toEqual([]);
    expect(calls.filter(c => c.fn === 'add_chips')).toEqual([
      { fn: 'add_chips', args: { p_user_id: 'human-winner', p_amount: totalSeats * 900 } },
    ]);
    expect(calls.filter(c => c.fn === 'record_match_stats')).toHaveLength(1);
    expect(awards).toHaveLength(1);
  });

  it.each([false, true])('human-start preserves rewards after a seat has disconnected, entry already paid=%s', async entryHousePaid => {
    const { settleMatch } = await import('./supabase');
    await settleMatch({
      seatUsers: new Map([[0, 'remaining-human'], [1, 'other-human']]), winnerSeat: 0,
      bet: 1000, teamMode: false, totalSeats: 4, game: 'okey', entryHousePaid,
      matchRewardsEligible: true, progressionKey: 'human-match',
    });
    expect(calls.filter(c => c.fn === 'canak_add')).toEqual(entryHousePaid ? [] : [
      { fn: 'canak_add', args: { p_game: 'okey', p_amount: 200 } },
    ]);
    expect(calls.filter(c => c.fn === 'quest_event_for').map(c => c.args)).toEqual([
      { p_user_id: 'remaining-human', p_kind: 'play', p_game: 'okey' },
      { p_user_id: 'remaining-human', p_kind: 'win', p_game: 'okey' },
      { p_user_id: 'other-human', p_kind: 'play', p_game: 'okey' },
    ]);
  });

  it('fails closed when a legacy/untyped caller omits the captured eligibility', async () => {
    const { settleMatch } = await import('./supabase');
    await settleMatch({ seatUsers: new Map([[0, 'human']]), winnerSeat: 0, bet: 500,
      teamMode: false, game: '51', progressionKey: 'legacy' } as any);
    expect(calls.some(c => c.fn === 'canak_add' || c.fn === 'quest_event_for')).toBe(false);
  });

  it('a fully bot roster cannot send human economy/stat/event RPCs', async () => {
    const { settleMatch } = await import('./supabase');
    await settleMatch({ seatUsers: new Map(), winnerSeat: 0, bet: 5000, totalSeats: 4,
      teamMode: true, game: 'ihale', progressionKey: 'bot-match', matchRewardsEligible: false });
    expect(calls).toEqual([]);
  });

  it('entry without a canak target only charges actual human participants', async () => {
    const { deductEntry } = await import('./supabase');
    const result = await deductEntry(new Map([[0, 'human']]), 1000, undefined, 400);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'deduct_chips', args: { p_user_id: 'human', p_amount: 1000 } }]);
  });
});
