import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopulationStorage, PopulationRpc } from './storage';

// 20.11 EGRESS: hafif snapshot, tam snapshot ile birebir aynı veriyi üretmeli; kopyalar paylaşılmamalı.
let db: PGlite;
const sql = (f: string) => readFileSync(resolve(__dirname, '../../migrations/' + f), 'utf8');
const calls: string[] = [];
const rpc: PopulationRpc = async (name, args) => {
  calls.push(name);
  const keys = Object.keys(args);
  const values = Object.values(args).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  const r = await db.query<{ result: any }>(
    `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as result`, values);
  return r.rows[0].result;
};

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role', true) $$;
    select set_config('request.jwt.claim.role', 'service_role', false);`);
  await db.exec(sql('20260917_01_bot_population_storage.sql'));
  await db.exec('create table public.profiles(id text primary key, chips bigint not null)');
  await db.exec(sql('20260917_02_bot_population_matches.sql'));
  await db.exec(sql('20261120_population_snapshot_lite.sql'));
  const seedStore = new PopulationStorage(rpc, { lite: false });
  await seedStore.seed();
  await seedStore.control(0, 'running', 16, 'test');
}, 30000);
afterAll(async () => { await db?.close(); });

describe('population snapshot lite', () => {
  it('matches the full snapshot exactly, then refreshes chips/enabled from the light read', async () => {
    let t = 0;
    const full = new PopulationStorage(rpc, { lite: false });
    const lite = new PopulationStorage(rpc, { lite: true, now: () => t });
    const a = await full.snapshot();
    const id = a.characters[0].id;
    await full.claim(id, '00000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001');
    expect(await lite.snapshot()).toEqual(await full.snapshot()); // ilk çağrı: tam liste
    await db.query('update bot_population.characters set chips = 123456, enabled = false where id = $1', [id]);
    calls.length = 0;
    const b = await lite.snapshot();
    expect(calls).toEqual(['bot_population_snapshot_lite']);
    expect(b).toEqual(await full.snapshot());
    expect(b.characters.find(c => c.id === id)).toMatchObject({ chips: 123456, enabled: false });
    expect(b.leases.map(l => l.character_id)).toEqual([id]);
  });

  it('returns fresh copies (callers mutate chips) and re-reads the full roster after the refresh window', async () => {
    let t = 0;
    const lite = new PopulationStorage(rpc, { lite: true, fullRefreshMs: 1000, now: () => t });
    await lite.snapshot();
    const x = await lite.snapshot(); x.characters[0].chips = -1; x.characters[0].name = 'Bozuk';
    const y = await lite.snapshot();
    expect(y.characters[0].chips).not.toBe(-1);
    expect(y.characters[0].name).not.toBe('Bozuk');
    calls.length = 0; t = 1000;
    await lite.snapshot();
    expect(calls).toEqual(['bot_population_snapshot_lite', 'bot_population_snapshot']);
  });

  it('controlState also returns online real players from presence (last 90 s)', async () => {
    await db.exec(`create table if not exists public.presence(user_id text primary key, last_seen timestamptz not null);
      insert into public.presence values ('a', now()), ('b', now() - interval '30 seconds'), ('c', now() - interval '5 minutes');`);
    await db.exec(sql('20261120_population_online_count.sql'));
    const lite = new PopulationStorage(rpc, { lite: true });
    expect(await lite.controlState()).toMatchObject({ mode: 'running', max_active: 16, online: 2 });
  });

  it('controlState reads only mode/limit', async () => {
    const lite = new PopulationStorage(rpc, { lite: true });
    calls.length = 0;
    expect(await lite.controlState()).toMatchObject({ mode: 'running', max_active: 16 });
    expect(calls).toEqual(['bot_population_control_state']);
  });

  it('light payload is much smaller than the full snapshot', async () => {
    const size = async (fn: string) => (await db.query<{ n: number }>(`select length(public.${fn}()::text) n`)).rows[0].n;
    expect(await size('bot_population_snapshot_lite')).toBeLessThan((await size('bot_population_snapshot')) * 0.4);
  });

  it('falls back to the full snapshot when the light SQL is not deployed yet (404)', async () => {
    const old = vi.fn(async (name: string) => {
      if (name !== 'bot_population_snapshot') throw new Error(`${name}_http_404:{"code":"PGRST202"}`);
      return { control: { mode: 'running', max_active: 5, revision: 1 }, characters: [], leases: [] };
    });
    const s = new PopulationStorage(old, { lite: true });
    expect((await s.controlState()).max_active).toBe(5);
    expect((await s.snapshot()).control.mode).toBe('running');
    old.mockClear(); await s.snapshot();
    expect(old.mock.calls.map(c => c[0])).toEqual(['bot_population_snapshot']); // bir kez düştükten sonra tekrar denemez
  });

  it('does not swallow real errors from the light read', async () => {
    const bad = vi.fn(async () => { throw new Error('bot_population_snapshot_lite_http_500:boom'); });
    await expect(new PopulationStorage(bad, { lite: true }).snapshot()).rejects.toThrow('http_500');
  });
});
