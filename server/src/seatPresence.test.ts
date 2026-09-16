import { afterEach, expect, it, vi } from 'vitest';
import { reconcileHandOrder } from './clientView';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

it('serializes reservation/release and scopes both writes to the original Ihale table', async () => {
  vi.stubEnv('SUPABASE_URL', 'https://presence.invalid');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-only');
  let finish!: (value: any) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', fetcher); vi.resetModules();
  const { keepSeatPresence, clearSeatPresence } = await import('./supabase');
  const reserve = keepSeatPresence('player-a', 9, 'ihale-duo');
  await Promise.resolve();
  const release = clearSeatPresence('player-a', 9, 'ihale-duo');
  await Promise.resolve(); expect(fetcher).toHaveBeenCalledOnce();
  finish({ ok: true }); await Promise.all([reserve, release]);
  expect(fetcher).toHaveBeenCalledTimes(2);
  for (const call of fetcher.mock.calls) {
    const url = new globalThis.URL(call[0]);
    expect(url.searchParams.get('user_id')).toBe('eq.player-a');
    expect(url.searchParams.get('table_mode')).toBe('eq.ihale-duo');
    expect(url.searchParams.get('table_no')).toBe('eq.9');
  }
  expect(JSON.parse(fetcher.mock.calls[0][1].body).status).toBe('reconnecting');
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({ status: 'lobi', table_no: 0, table_seat: -1 });
});

it('51 new cards enter on the left without re-sorting an explicitly arranged hand', () => {
  const state: any = { players: [{ seat: 0, hand: ['a', 'b', 'c'].map(id => ({ id })) }] };
  expect(reconcileHandOrder(state, 0)).toEqual(['a', 'b', 'c']);
  state.handOrder[0] = ['c', 'a', 'b']; state.players[0].hand.push({ id: 'new' });
  expect(reconcileHandOrder(state, 0)).toEqual(['new', 'c', 'a', 'b']);
  expect(reconcileHandOrder(state, 0)).toEqual(['new', 'c', 'a', 'b']);
});
