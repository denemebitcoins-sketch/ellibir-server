import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PopulationStorage, PopulationRpc } from './storage';
import { initialCharacters } from './characters';

let db: PGlite;
let store: PopulationStorage;
const owner = '00000000-0000-4000-8000-000000000001';
const next = '00000000-0000-4000-8000-000000000002';
const uuid = (i: number) => `30000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const room = 'ihale:team:1';
const pool = initialCharacters();
const migrations = ['20260917_01_bot_population_storage.sql', '20260917_02_bot_population_matches.sql', '20260917_03_bot_population_room_hosts.sql']
  .map(f => readFileSync(resolve(__dirname, '../../migrations', f), 'utf8'));
const rpc: PopulationRpc = async (name, args) => {
  if (!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_rpc');
  const keys = Object.keys(args);
  const r = await db.query<{ value: any }>(`select public.${name}(${keys.map((k, i) => `${k}=>$${i + 1}`).join(',')}) value`,
    Object.values(args).map(v => v !== null && typeof v === 'object' ? JSON.stringify(v) : v));
  return r.rows[0].value;
};
beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
    select set_config('request.jwt.claim.role','service_role',false);
    create table public.profiles(id uuid primary key, chips bigint not null);`);
  for (const sql of migrations) await db.exec(sql);
  store = new PopulationStorage(rpc);
}, 30000);
beforeEach(async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.role','service_role',false);
    truncate bot_population.match_wallet_entries, bot_population.match_seats, bot_population.matches,
      bot_population.leases, bot_population.ledger, bot_population.characters, bot_population.control_events,
      bot_population.room_hosts, bot_population.room_host_events, public.profiles;
    update bot_population.control set mode='off', max_active=16, revision=0;`);
  await store.seed(); await store.control(0, 'running', 16, 'test');
});
afterAll(async () => { await db?.close(); });
const claim = (who = owner, token = uuid(1)) => store.claimRoom(room, who, token, 'ihale', true, 1, 500);
async function expireAll() {
  // Fault fixture changes timestamps, not production recovery logic.
  await db.exec("update bot_population.room_hosts set expires_at=now()+interval '45 seconds'");
  await db.exec("update bot_population.leases set expires_at=now()-interval '1 second'");
  await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
}
async function mixedMatch() {
  await claim(); await store.publishRoom(room, owner, uuid(1), 'old-colyseus-room');
  await db.query('insert into public.profiles(id,chips) values($1,20000),($2,20000)', [uuid(10), uuid(11)]);
  await store.claim(pool[0].id, owner, uuid(20), { room, seat: 0, game: 'ihale', bet: 500 });
  await store.claim(pool[1].id, owner, uuid(21), { room, seat: 1, game: 'ihale', bet: 500 });
  await store.beginMatch('orphan-match', owner, room, 'ihale', 500, true, [
    { seat: 0, kind: 'bot', id: pool[0].id, token: uuid(20) },
    { seat: 1, kind: 'bot', id: pool[1].id, token: uuid(21) },
    { seat: 2, kind: 'human', id: uuid(10) }, { seat: 3, kind: 'human', id: uuid(11) },
  ]);
}

describe('room ownership and orphan recovery with UUID human profiles', () => {
  it('is service-only and keeps migration replay idempotent/off by default', async () => {
    await store.control(1, 'off', 16, 'test');
    await db.exec(migrations[2]);
    expect(await store.rooms()).toEqual([]);
    await expect(claim()).rejects.toThrow('population_not_running');
    await db.exec("set role authenticated; select set_config('request.jwt.claim.role','authenticated',false)");
    await expect(store.rooms()).rejects.toThrow('permission denied');
  });
  it('exclusively owns one logical table even if a second worker uses a different room key', async () => {
    await claim();
    expect(await claim()).toMatchObject({ owner_id: owner, token: uuid(1) });
    await expect(claim(next, uuid(2))).rejects.toThrow('room_host_busy');
    await expect(store.claimRoom('different-key', next, uuid(2), 'ihale', true, 1, 500)).rejects.toThrow('room_hosts_game_team_mode_table_no_key');
    await expect(store.claimRoom(room, owner, uuid(1), 'ihale', true, 1, 1000)).rejects.toThrow('room_payload_conflict');
  });
  it('publishes a single room ID and rejects stale publication, heartbeat and release', async () => {
    await claim();
    await store.publishRoom(room, owner, uuid(1), 'room-one');
    await store.publishRoom(room, owner, uuid(1), 'room-one');
    await expect(store.publishRoom(room, owner, uuid(1), 'room-two')).rejects.toThrow('room_publish_conflict');
    await expect(store.heartbeatRoom(room, next, uuid(2))).rejects.toThrow('room_lease_lost');
    await expect(store.releaseRoom(room, next, uuid(2))).rejects.toThrow('room_lease_lost');
    expect((await db.query("select * from bot_population.room_host_events where action='publish'")).rows).toHaveLength(1);
  });
  it('rejects unowned/wrong-owner/wrong-game bot seats and invalid team entry', async () => {
    const target = { room, seat: 0, game: 'ihale' as const, bet: 500 };
    await expect(store.claim(pool[0].id, owner, uuid(20), target)).rejects.toThrow('room_lease_lost');
    await claim();
    await expect(store.claim(pool[0].id, next, uuid(20), target)).rejects.toThrow('room_lease_lost');
    await expect(store.claim(pool[0].id, owner, uuid(20), { ...target, game: '51' })).rejects.toThrow('room_lease_lost');
    const roster = [];
    for (let seat = 0; seat < 4; seat++) {
      await store.claim(pool[seat].id, owner, uuid(20 + seat), { ...target, seat });
      roster.push({ seat, kind: 'bot' as const, id: pool[seat].id, token: uuid(20 + seat) });
    }
    await expect(store.beginMatch('bad-team', owner, room, 'ihale', 500, false, roster)).rejects.toThrow('room_match_conflict');
    expect(await store.match('bad-team')).toBeNull();
  });
  it('cannot steal an expired room while any character still has live authority', async () => {
    await mixedMatch();
    await db.exec("update bot_population.room_hosts set expires_at=now()-interval '1 second'");
    await expect(claim(next, uuid(2))).rejects.toThrow('room_character_lease_alive');
    await expect(store.heartbeat(pool[0].id, owner, uuid(20))).rejects.toThrow('room_lease_lost');
    expect((await store.match('orphan-match'))?.state).toBe('active');
  });
  it('refunds orphan escrow exactly once before a new incarnation claims the table', async () => {
    await mixedMatch(); await expireAll();
    const recovered = await claim(next, uuid(2));
    expect(recovered).toMatchObject({ owner_id: next, previous_room_id: 'old-colyseus-room', room_id: null });
    expect((await store.match('orphan-match'))?.state).toBe('refunded');
    expect((await store.snapshot()).leases).toEqual([]);
    const humans = await db.query<{ chips: number }>('select chips from public.profiles');
    expect(humans.rows.map(r => Number(r.chips))).toEqual([20000, 20000]);
    const bots = (await store.snapshot()).characters;
    expect(bots.find(c => c.id === pool[0].id)!.chips).toBe(pool[0].initial_chips);
    await claim(next, uuid(2));
    expect((await db.query("select * from bot_population.match_wallet_entries where phase='refund'")).rows).toHaveLength(4);
    expect((await db.query("select refunded_matches from bot_population.room_host_events where action='recover'")).rows).toEqual([{ refunded_matches: 1 }]);
    await expect(store.finishMatch('orphan-match', owner, 0)).rejects.toThrow('settlement_payload_conflict');
  });
  it('rolls back takeover and every refund if an account needed for recovery is missing', async () => {
    await mixedMatch(); await expireAll();
    await db.query('delete from public.profiles where id=$1', [uuid(11)]);
    await expect(claim(next, uuid(2))).rejects.toThrow('human_profile_missing');
    expect((await store.rooms())[0].owner_id).toBe(owner);
    expect((await store.match('orphan-match'))?.state).toBe('active');
    expect((await db.query("select * from bot_population.match_wallet_entries where phase='refund'")).rows).toEqual([]);
    await db.query('insert into public.profiles(id,chips) values($1,19500)', [uuid(11)]);
    await claim(next, uuid(2));
    expect((await store.match('orphan-match'))?.state).toBe('refunded');
  });
  it('keeps active matches alive while draining, then permits normal settle/release', async () => {
    await mixedMatch();
    await store.control(1, 'draining', 16, 'test');
    await store.heartbeatRoom(room, owner, uuid(1));
    await store.heartbeat(pool[0].id, owner, uuid(20));
    await expect(store.releaseRoom(room, owner, uuid(1))).rejects.toThrow('room_still_occupied');
    await store.finishMatch('orphan-match', owner, 2);
    await store.release(pool[0].id, owner, uuid(20)); await store.release(pool[1].id, owner, uuid(21));
    await store.releaseRoom(room, owner, uuid(1));
    expect(await store.rooms()).toEqual([]);
    const winner = await db.query<{ chips: number }>('select chips from public.profiles where id=$1', [uuid(10)]);
    expect(Number(winner.rows[0].chips)).toBe(20400);
  });
  it('cannot resurrect an expired owner token, but a fresh token recovers idle seats', async () => {
    await claim(); await store.claim(pool[0].id, owner, uuid(20), { room, seat: 0, game: 'ihale', bet: 500 });
    await expireAll();
    await expect(claim()).rejects.toThrow('room_lease_lost');
    await claim(owner, uuid(2));
    expect((await store.snapshot()).leases).toEqual([]);
    expect((await store.rooms())[0].token).toBe(uuid(2));
  });
});
