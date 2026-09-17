import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { initialCharacters } from './characters';
import { PopulationStorage, PopulationRpc, PopulationGame, PopulationParticipant } from './storage';

let db: PGlite;
let store: PopulationStorage;
const migration = readFileSync(resolve(__dirname, '../../migrations/20260917_01_bot_population_storage.sql'), 'utf8');
const matchMigration = readFileSync(resolve(__dirname, '../../migrations/20260917_02_bot_population_matches.sql'), 'utf8');
const pool = initialCharacters();
const owner = '00000000-0000-4000-8000-000000000001';
const otherOwner = '00000000-0000-4000-8000-000000000002';
const token = (i: number) => `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const target = (seat = 0) => ({ room: 'ihale:team:1', seat, game: 'ihale' as const, bet: 500 });

// Named arguments exercise exactly the production RPC parameter contract.
const rpc: PopulationRpc = async (name, args) => {
  if (!/^bot_population_[a-z_]+$/.test(name)) throw new Error('invalid_test_rpc');
  const keys = Object.keys(args);
  if (keys.some(k => !/^p_[a-z_]+$/.test(k))) throw new Error('invalid_test_parameter');
  const values = Object.values(args).map(v => typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  const result = await db.query<{ result: any }>(
    `select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) as result`, values);
  return result.rows[0].result;
};

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.role() returns text language sql as $$
      select current_setting('request.jwt.claim.role', true)
    $$;
    select set_config('request.jwt.claim.role', 'service_role', false);`);
  await db.exec(migration);
  await db.exec('create table public.profiles(id text primary key, chips bigint not null)');
  await db.exec(matchMigration);
  store = new PopulationStorage(rpc);
}, 30000);
beforeEach(async () => {
  await db.exec(`reset role; select set_config('request.jwt.claim.role', 'service_role', false);
    truncate bot_population.match_wallet_entries, bot_population.match_seats, bot_population.matches,
      bot_population.ledger, bot_population.leases, bot_population.characters, bot_population.control_events, public.profiles;
    update bot_population.control set mode='off', max_active=16, revision=0;`);
  await store.seed();
});
afterAll(async () => { await db?.close(); });

async function run(max = 16) { await store.control(0, 'running', max, 'local-test-admin'); }
async function expire(id: string) {
  await db.query(`update bot_population.leases set expires_at = now() - interval '1 second' where character_id=$1`, [id]);
}
async function balance(id: string, chips: number) {
  await db.query('update bot_population.characters set chips=$2 where id=$1', [id, chips]);
}

describe('executable Postgres population storage', () => {
  it('seeds 100 persistent ordinary names, diverse balances/genders/VIP, while staying off', async () => {
    const s = await store.snapshot();
    expect(s.control).toMatchObject({ mode: 'off', max_active: 16, revision: 0 });
    expect(s.leases).toEqual([]);
    expect(s.characters).toHaveLength(100);
    expect(new Set(s.characters.map(c => c.id)).size).toBe(100);
    expect(new Set(s.characters.map(c => c.name.toLowerCase())).size).toBe(100);
    expect(s.characters.some(c => /^b_/i.test(c.name))).toBe(false);
    expect(s.characters.filter(c => c.gender === 'k')).toHaveLength(50);
    expect(s.characters.filter(c => c.cosmetic_vip)).toHaveLength(20);
    expect(s.characters.every(c => c.chips >= 100000 && c.chips <= 300000)).toBe(true);
    expect(new Set(s.characters.map(c => c.chips)).size).toBeGreaterThan(90);
    const rows = await db.query<{ n: number }>('select count(*)::int as n from bot_population.ledger');
    expect(rows.rows[0].n).toBe(100);
  });

  it('repeated seed and migration never reset balances or activate the module', async () => {
    await balance(pool[0].id, 412345);
    expect(await store.seed()).toEqual({ ok: true, added: 0 });
    await db.exec(migration);
    const s = await store.snapshot();
    expect(s.characters[0].chips).toBe(412345);
    expect(s.control.mode).toBe('off');
    expect((await db.query('select * from bot_population.ledger')).rows).toHaveLength(100);
  });

  it('rolls back an invalid replacement pool instead of half-seeding new identities', async () => {
    const changed = initialCharacters(); changed[0].id = owner; changed[0].name = 'Different';
    await expect(rpc('bot_population_seed', { p_characters: changed })).rejects.toThrow('pool_identity_mismatch');
    expect((await store.snapshot()).characters).toHaveLength(100);
    expect((await db.query('select * from bot_population.ledger')).rows).toHaveLength(100);
  });

  it('rejects claims while off; control changes use optimistic revision plus audit trail', async () => {
    await expect(store.claim(pool[0].id, owner, token(1))).rejects.toThrow('population_not_running');
    await run(3);
    await expect(store.control(0, 'off', 3, 'stale-admin')).rejects.toThrow('control_revision_conflict');
    const events = await db.query('select * from bot_population.control_events');
    expect(events.rows).toHaveLength(1);
    expect(await store.control(1, 'draining', 3, 'admin')).toMatchObject({ mode: 'draining', revision: 2 });
  });

  it('enforces capacity, exclusive seats, idempotent claim and immutable claim payload', async () => {
    await run(2);
    const a = await store.claim(pool[0].id, owner, token(1), target());
    expect(a.active_match).toBeNull();
    expect(await store.claim(pool[0].id, owner, token(1), target())).toMatchObject({ token: token(1) });
    await expect(store.claim(pool[0].id, otherOwner, token(2), target())).rejects.toThrow('character_busy');
    await expect(store.claim(pool[0].id, owner, token(1), target(1))).rejects.toThrow('lease_payload_conflict');
    await expect(store.claim(pool[1].id, owner, token(2), target())).rejects.toThrow('leases_room_seat_idx');
    await store.claim(pool[1].id, owner, token(2));
    await expect(store.claim(pool[2].id, owner, token(3))).rejects.toThrow('population_capacity');
    expect((await store.snapshot()).leases).toHaveLength(2);
  });

  it('serializes competing local calls so only one character owns a seat', async () => {
    await run();
    const results = await Promise.allSettled([
      store.claim(pool[0].id, owner, token(1), target()),
      store.claim(pool[1].id, otherOwner, token(2), target()),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect((await store.snapshot()).leases).toHaveLength(1);
  });

  it.each([0, 250, 501, 5500])('rejects bet %i and rolls back the attempted reservation', async bet => {
    await run();
    await expect(store.claim(pool[0].id, owner, token(1), { ...target(), bet })).rejects.toThrow();
    expect((await store.snapshot()).leases).toEqual([]);
  });

  it('rejects unsupported games, invalid seats and partial lobby payloads', async () => {
    await run();
    await expect(store.claim(pool[0].id, owner, token(1), { ...target(2), game: 'tavla' })).rejects.toThrow();
    await expect(rpc('bot_population_claim', { p_character: pool[0].id, p_owner: owner, p_token: token(1), p_seat: 0 })).rejects.toThrow();
    await expect(store.claim(pool[0].id, owner, token(1), { ...target(), game: 'other' as any })).rejects.toThrow();
    expect((await store.snapshot()).leases).toEqual([]);
  });

  it('reclaims expired idle leases without accepting an old owner heartbeat or release', async () => {
    await run();
    await store.claim(pool[0].id, owner, token(1), target());
    await expire(pool[0].id);
    await expect(store.heartbeat(pool[0].id, owner, token(1))).rejects.toThrow('lease_lost');
    await store.claim(pool[0].id, otherOwner, token(2), target());
    await expect(store.release(pool[0].id, owner, token(1))).rejects.toThrow('lease_lost');
    await expect(store.heartbeat(pool[0].id, owner, token(1))).rejects.toThrow('lease_lost');
    expect(await store.release(pool[0].id, otherOwner, token(2))).toBe(true);
    expect(await store.release(pool[0].id, otherOwner, token(2))).toBe(true);
  });

  it('drains idle reservations but never evicts or steals a playing lease', async () => {
    await run();
    await store.claim(pool[0].id, owner, token(1), target());
    await store.claim(pool[1].id, owner, token(2));
    // The match transaction will set this field; claim RPC cannot forge it.
    await db.query('update bot_population.leases set active_match=$2 where character_id=$1', [pool[0].id, 'match-1']);
    await store.control(1, 'off', 16, 'admin');
    await expect(store.heartbeat(pool[1].id, owner, token(2))).rejects.toThrow('population_draining');
    expect(await store.heartbeat(pool[0].id, owner, token(1))).toMatchObject({ active_match: 'match-1' });
    await expect(store.release(pool[0].id, owner, token(1))).rejects.toThrow('match_in_progress');
    await expire(pool[0].id);
    await store.control(2, 'running', 16, 'admin');
    await expect(store.claim(pool[0].id, otherOwner, token(3), target())).rejects.toThrow('character_busy');
    await expect(store.claim(pool[0].id, owner, token(1), target())).rejects.toThrow('lease_lost');
    expect((await store.snapshot()).leases.find(l => l.character_id === pool[0].id)?.active_match).toBe('match-1');
  });

  it('refills only below 100k once per Istanbul day, preserving richer balances', async () => {
    await balance(pool[0].id, 99999);
    const first = await store.refill(pool[0].id);
    expect(first.refilled).toBe(true); expect(first.chips).toBeGreaterThanOrEqual(100000); expect(first.chips).toBeLessThanOrEqual(300000);
    await balance(pool[0].id, 1000);
    expect(await store.refill(pool[0].id)).toMatchObject({ refilled: false, chips: 1000 });
    await balance(pool[1].id, 100000);
    expect(await store.refill(pool[1].id)).toMatchObject({ refilled: false, chips: 100000 });
    await balance(pool[2].id, 999999);
    expect(await store.refill(pool[2].id)).toMatchObject({ refilled: false, chips: 999999 });
    const rows = await db.query<{ delta: number; event_key: string; balance_after: number }>(
      "select * from bot_population.ledger where reason='daily_refill'");
    expect(rows.rows).toHaveLength(1);
    expect(Number(rows.rows[0].delta)).toBe(first.chips - 99999);
    const day = await db.query<{ day: string }>("select ((clock_timestamp() at time zone 'Europe/Istanbul')::date)::text as day");
    expect(rows.rows[0].event_key).toBe(`daily_refill:${day.rows[0].day}`);
  });

  it('does not refill occupied/playing characters; expired waiting leases are idle', async () => {
    await run();
    await store.claim(pool[0].id, owner, token(1), target());
    await balance(pool[0].id, 5000);
    await expect(store.refill(pool[0].id)).rejects.toThrow('character_not_idle');
    await expire(pool[0].id);
    expect((await store.refill(pool[0].id)).refilled).toBe(true);
    await db.query('update bot_population.leases set active_match=$2 where character_id=$1', [pool[0].id, 'match-1']);
    await expect(store.refill(pool[0].id)).rejects.toThrow('character_not_idle');
  });

  it('permits idle lobby refill but records only one concurrent credit', async () => {
    await run();
    await store.claim(pool[0].id, owner, token(1));
    await balance(pool[0].id, 5000);
    const result = await Promise.all([store.refill(pool[0].id), store.refill(pool[0].id)]);
    expect(result.filter(r => r.refilled)).toHaveLength(1);
    expect(result[0].chips).toBe(result[1].chips);
  });

  it('protects tables and RPCs from authenticated clients, not merely from the UI', async () => {
    await db.exec("set role authenticated; select set_config('request.jwt.claim.role', 'authenticated', false);");
    await expect(store.snapshot()).rejects.toThrow('permission denied');
    await expect(db.query('select * from bot_population.characters')).rejects.toThrow('permission denied');
    await db.exec('reset role');
    // Even a function permission accidentally granted later still checks the JWT role.
    await expect(store.snapshot()).rejects.toThrow('service_required');
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false); set role service_role;");
    expect((await store.snapshot()).characters).toHaveLength(100);
    await expect(db.query("update bot_population.characters set chips=1")).rejects.toThrow('permission denied');
    await db.exec('reset role');
  });

  it('persists identities, ledger and fenced reservations across database restart', async () => {
    await run();
    await store.claim(pool[0].id, owner, token(1), target());
    await balance(pool[1].id, 999);
    const refilled = await store.refill(pool[1].id);
    const blob = await db.dumpDataDir();
    await db.close();
    db = await PGlite.create({ loadDataDir: blob });
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
    const s = await store.snapshot();
    expect(s.characters[1].chips).toBe(refilled.chips);
    expect(s.leases[0].token).toBe(token(1));
    await expect(store.claim(pool[0].id, otherOwner, token(2), target())).rejects.toThrow('character_busy');
    expect((await store.refill(pool[1].id)).refilled).toBe(false);
  }, 30000);
});

async function matchFixture(game: PopulationGame = 'ihale', bots = 2, bet = 1000) {
  await run();
  const count = game === 'tavla' ? 2 : 4;
  const room = `${game}:solo:1`;
  const roster: PopulationParticipant[] = [];
  for (let seat = 0; seat < count; seat++) {
    if (seat < count - bots) {
      const id = `human-${seat}`;
      await db.query('insert into public.profiles(id,chips) values($1,20000)', [id]);
      roster.push({ seat, kind: 'human', id });
    } else {
      const id = pool[seat].id;
      await store.claim(id, owner, token(seat + 1), { room, seat, game, bet });
      roster.push({ seat, kind: 'bot', id, token: token(seat + 1) });
    }
  }
  return { room, game, bet, roster };
}
async function begin(f: Awaited<ReturnType<typeof matchFixture>>, key = 'match-1', team = false) {
  return store.beginMatch(key, owner, f.room, f.game, f.bet, team, f.roster);
}
async function totalChips() {
  const r = await db.query<{ chips: string }>(`select (
    (select coalesce(sum(chips),0) from public.profiles) +
    (select coalesce(sum(chips),0) from bot_population.characters))::text as chips`);
  return Number(r.rows[0].chips);
}

describe('atomic population-match economy in PostgreSQL', () => {
  it.each(['51', 'duz', 'banko', 'yuzbir', 'ihale', 'tavla'] as const)('%s debits every real wallet, pays winner, burns only 10 percent, never a synthetic pot', async game => {
    const f = await matchFixture(game, game === 'tavla' ? 1 : 2);
    const before = await totalChips();
    const m = await begin(f);
    expect(m.state).toBe('active');
    expect(await totalChips()).toBe(before - f.roster.length * 1000);
    const final = await store.finishMatch(m.match_key, owner, 0);
    expect(final.state).toBe('settled');
    expect(final.house_amount).toBe(f.roster.length * 100);
    expect(await totalChips()).toBe(before - final.house_amount);
    const human = await db.query<{ chips: number }>("select chips from public.profiles where id='human-0'");
    expect(Number(human.rows[0].chips)).toBe(19000 + f.roster.length * 900);
    const events = await db.query<{ n: number; delta: string }>(
      'select count(*)::int n, sum(delta)::text delta from bot_population.match_wallet_entries');
    expect(events.rows[0].n).toBe(f.roster.length + 1);
    expect(Number(events.rows[0].delta)).toBe(-final.house_amount);
    expect((await store.snapshot()).leases.every(l => l.active_match === null)).toBe(true);
  });

  it('pays a bot and its human partner equally; balances never reset to the initial seed', async () => {
    const f = await matchFixture('ihale', 2);
    const initialBot = pool[2].initial_chips;
    await begin(f, 'team-match', true);
    await store.finishMatch('team-match', owner, 2);
    const s = await store.snapshot();
    expect(s.characters[2].chips).toBe(initialBot - 1000 + 1800);
    const human = await db.query<{ chips: number }>("select chips from public.profiles where id='human-0'");
    expect(Number(human.rows[0].chips)).toBe(20800);
    await store.seed();
    expect((await store.snapshot()).characters[2].chips).toBe(initialBot + 800);
  });

  it('settles an all-bot table against real character bankrolls and no human profiles', async () => {
    const f = await matchFixture('yuzbir', 4, 5000);
    const before = await totalChips();
    await begin(f);
    await store.finishMatch('match-1', owner, 3);
    expect((await db.query('select * from public.profiles')).rows).toEqual([]);
    expect(await totalChips()).toBe(before - 2000);
    expect((await store.snapshot()).characters[3].chips).toBe(pool[3].initial_chips + 13000);
  });

  it('replayed entry with reordered seats and repeated settlement are single-effect', async () => {
    const f = await matchFixture();
    await begin(f);
    const afterEntry = await totalChips();
    await begin({ ...f, roster: [...f.roster].reverse() });
    expect(await totalChips()).toBe(afterEntry);
    await store.finishMatch('match-1', owner, 0);
    const afterFinish = await totalChips();
    await store.control(1, 'off', 16, 'admin');
    expect((await begin(f)).state).toBe('settled');
    await store.finishMatch('match-1', owner, 0);
    expect(await totalChips()).toBe(afterFinish);
    await expect(store.finishMatch('match-1', owner, 1)).rejects.toThrow('settlement_payload_conflict');
    await expect(store.finishMatch('match-1', owner, null)).rejects.toThrow('settlement_payload_conflict');
    await expect(begin({ ...f, bet: 2000 })).rejects.toThrow('match_payload_conflict');
  });

  it('rolls back earlier bot charges, ledgers and match fences when a human cannot pay', async () => {
    const f = await matchFixture();
    await db.query("update public.profiles set chips=499 where id='human-1'");
    const before = await totalChips();
    await expect(begin(f)).rejects.toThrow('insufficient_chips');
    expect(await totalChips()).toBe(before);
    expect((await db.query('select * from bot_population.matches')).rows).toEqual([]);
    expect((await db.query("select * from bot_population.ledger where reason='entry'")).rows).toEqual([]);
    expect((await store.snapshot()).leases.every(l => l.active_match === null)).toBe(true);
  });

  it('rejects expired/replaced/incorrect leases before charging anyone', async () => {
    const f = await matchFixture();
    const before = await totalChips();
    await expire(pool[3].id);
    await expect(begin(f)).rejects.toThrow('match_lease_lost');
    expect(await totalChips()).toBe(before);
    expect((await db.query('select * from bot_population.match_wallet_entries')).rows).toEqual([]);
  });

  it('refuses all-human, duplicate-identity and forged human-as-bot rosters', async () => {
    const f = await matchFixture('ihale', 0);
    await expect(begin(f)).rejects.toThrow('population_match_requires_bot');
    const bad = [...f.roster]; bad[3] = { seat: 3, kind: 'bot', id: f.roster[0].id, token: token(1) };
    await expect(begin({ ...f, roster: bad })).rejects.toThrow('roster_identity');
    bad[3] = { seat: 3, kind: 'bot', id: owner, token: token(1) };
    await expect(begin({ ...f, roster: bad })).rejects.toThrow('character_unavailable');
  });

  it('does not allow one human to pay into two active population matches', async () => {
    const f = await matchFixture('ihale', 3);
    await begin(f);
    const roster: PopulationParticipant[] = [{ seat: 0, kind: 'human', id: 'human-0' }];
    for (let seat = 1; seat < 4; seat++) {
      const id = pool[seat + 10].id;
      await store.claim(id, owner, token(seat + 10), { ...target(seat), room: 'room-2', bet: 1000 });
      roster.push({ seat, kind: 'bot', id, token: token(seat + 10) });
    }
    const before = await totalChips();
    await expect(begin({ ...f, room: 'room-2', roster }, 'match-2')).rejects.toThrow('match_seats_active_identity_idx');
    expect(await totalChips()).toBe(before);
  });

  it('refunds an aborted match once even while automation is disabled', async () => {
    const f = await matchFixture();
    const before = await totalChips();
    await begin(f);
    await store.control(1, 'off', 16, 'admin');
    const result = await store.finishMatch('match-1', owner, null);
    expect(result).toMatchObject({ state: 'refunded', house_amount: 0, winner_seat: null });
    expect(await totalChips()).toBe(before);
    await store.finishMatch('match-1', owner, null);
    expect(await totalChips()).toBe(before);
    await expect(store.finishMatch('match-1', owner, 0)).rejects.toThrow('settlement_payload_conflict');
  });

  it('failed settlement rolls back previously credited bots and can retry after repair', async () => {
    const f = await matchFixture('ihale', 2);
    await begin(f, 'team-match', true);
    // Missing human profile stands in for a failing wallet write. No bot may be credited first and kept.
    await db.query("delete from public.profiles where id='human-0'");
    const before = await totalChips();
    await expect(store.finishMatch('team-match', owner, 2)).rejects.toThrow('human_profile_missing');
    expect(await totalChips()).toBe(before);
    expect((await db.query("select * from bot_population.ledger where reason='prize'")).rows).toEqual([]);
    expect((await store.snapshot()).leases.every(l => l.active_match === 'team-match')).toBe(true);
    await db.query("insert into public.profiles(id,chips) values('human-0',19000)");
    expect((await store.finishMatch('team-match', owner, 2)).state).toBe('settled');
  });

  it('rejects the wrong match owner and survives restart without double settlement', async () => {
    const f = await matchFixture();
    await begin(f);
    await expect(store.finishMatch('match-1', otherOwner, 0)).rejects.toThrow('match_owner_lost');
    const blob = await db.dumpDataDir(); await db.close();
    db = await PGlite.create({ loadDataDir: blob });
    await db.exec("select set_config('request.jwt.claim.role', 'service_role', false)");
    expect((await begin(f)).state).toBe('active');
    await store.finishMatch('match-1', owner, 0);
    const total = await totalChips();
    await store.finishMatch('match-1', owner, 0);
    expect(await totalChips()).toBe(total);
  }, 30000);
});
