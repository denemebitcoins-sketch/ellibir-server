import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopulationRpc, PopulationStorage } from './storage';
import { handsInfo, populationAdoptionPlan } from './roomBinding';

// 19.11: devralınan masanın salon etiketi gerçek el/puan sayısını göstermeli.
let db: PGlite; let storage: PopulationStorage;
const owner = '00000000-0000-4000-8000-000000000001';
const token = '00000000-0000-4000-8000-0000000000aa';
const rpc: PopulationRpc = async (name, args) => {
  const keys = Object.keys(args);
  const r = await db.query<{ value: any }>(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) value`,
    Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  return r.rows[0].value;
};
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql as $$select 'service_role'::text$$;
    create table public.profiles(id uuid primary key, chips bigint not null);`);
  for (const f of ['20260917_01_bot_population_storage.sql', '20260917_02_bot_population_matches.sql', '20260917_03_bot_population_room_hosts.sql',
    '20260917_08_bot_population_lock_time.sql', '20261119_adopted_table_hands.sql'])
    await db.exec(readFileSync(resolve(__dirname, '../../migrations', f), 'utf8'));
  storage = new PopulationStorage(rpc);
  await storage.seed(); await storage.control(0, 'running', 16, 'test');
}, 30000);
afterAll(async () => { await db?.close(); });

describe('devralınan masa el etiketi', () => {
  it('plan masanın kendi el/puan sayısını taşır', () => {
    expect(handsInfo(7, 'el')).toBe('7 el');
    expect(handsInfo(3, 'puan')).toBe('3 puan');
    expect(handsInfo(undefined, 'el')).toBeUndefined();
    expect(populationAdoptionPlan('duz', false, 4, 5000, '3 el')?.info).toBe('3 el');
  });
  it('etiket yalnız sahibi tarafından yazılır ve salon görünümüne yansır', async () => {
    await storage.claimRoom('duz:solo:4', owner, token, 'duz', false, 4, 1000);
    expect(await storage.setRoomInfo('duz:solo:4', owner, '00000000-0000-4000-8000-0000000000bb', '1 el')).toBe(false);
    expect(await storage.setRoomInfo('duz:solo:4', owner, token, '3 el')).toBe(true);
    const ch = (await db.query<{ id: string }>(`select id from bot_population.characters order by id limit 1`)).rows[0].id;
    await storage.claim(ch, owner, '00000000-0000-4000-8000-0000000000cc', { room: 'duz:solo:4', seat: 1, game: 'duz', bet: 1000 });
    const rows = (await db.query<{ p: any }>(`select p from public.bot_population_public_presence() p`)).rows.map(r => r.p);
    expect(rows.find(p => p.status === 'masada')?.table_info).toBe('KLASIK · TEK · 1000 çip · 3 el');
    await storage.setRoomInfo('duz:solo:4', owner, token, null);
    const again = (await db.query<{ p: any }>(`select p from public.bot_population_public_presence() p`)).rows.map(r => r.p);
    expect(again.find(p => p.status === 'masada')?.table_info).toBe('KLASIK · TEK · 1000 çip · 9 el');
  });
});
