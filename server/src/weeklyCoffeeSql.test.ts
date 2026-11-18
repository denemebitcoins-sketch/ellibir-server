/**
 * 6.9 Haftanın Kahvecisi + Kayıpsız Kahve Saati — migration'ın GERÇEK Postgres (PGlite) üzerinde simülasyonu.
 * Saat test.now ayarıyla sürülür (tr_now yeniden tanımlanır); kullanıcı test.uid ile (auth.uid()).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let db: PGlite;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const today = () => db.query<{ d: string }>(`select ((now() at time zone 'Europe/Istanbul')::date)::text d`).then(r => r.rows[0].d);

async function at(hhmm: string) { await db.exec(`select set_config('test.now', '${await today()} ${hhmm}:00', false)`); }
async function as(uid: string | null) { await db.exec(`select set_config('test.uid', '${uid ?? ''}', false)`); }
async function extras(user: string, o: { game?: string; hands?: number; won?: boolean; bet?: number; net?: number; key: string }) {
  const r = await db.query<{ v: any }>(`select public.match_extras($1,$2,$3,$4,$5,$6,$7) v`,
    [user, o.game ?? 'okey', o.hands ?? 1, o.won ?? false, o.bet ?? 0, o.net ?? 0, o.key]);
  return r.rows[0].v;
}
const chips = (uid: string) => db.query<{ c: string }>('select chips::text c from public.profiles where id=$1', [uid]).then(r => Number(r.rows[0].c));
const weekly = (uid: string) => db.query<{ p: number }>('select coalesce(sum(points),0)::int p from public.weekly_points where user_id=$1', [uid]).then(r => r.rows[0].p);

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table public.profiles(id uuid primary key, name text, avatar_url text, avatar_status text, role text default 'normal', gender text, chips bigint not null default 0);
    create table public.presence(user_id uuid primary key, status text, last_seen timestamptz);
    create table public.admin_rewards(id serial primary key, user_id text, message text, chips bigint, diamonds int, admin_name text);
    create function public.add_chips(p_user_id text, p_amount bigint) returns boolean language plpgsql as $$
    begin update public.profiles set chips = chips + p_amount where id::text = p_user_id; return found; end $$;`);
  await db.exec(readFileSync(resolve(__dirname, '../migrations/20261118_weekly_coffee.sql'), 'utf8'));
  // saat simülasyonu
  await db.exec(`create or replace function public.tr_now() returns timestamp language sql stable as
    $$ select coalesce(nullif(current_setting('test.now', true), '')::timestamp, now() at time zone 'Europe/Istanbul') $$;`);
}, 60000);
afterAll(async () => { await db?.close(); });
beforeEach(async () => {
  await db.exec(`truncate public.weekly_points, public.daily_points, public.match_extras_log, public.weekly_rewards, public.admin_rewards, public.profiles, public.presence;`);
  for (let i = 1; i <= 12; i++) await db.query('insert into public.profiles(id,name,chips) values($1,$2,100000)', [U(i), 'Oyuncu' + i]);
  await as(null);
});

describe('Haftanın Kahvecisi puanları', () => {
  it('el sayısına göre 10 / 35 / 60 (kahve saati dışında)', async () => {
    await at('15:00');
    expect((await extras(U(1), { hands: 1, key: 'a' })).points).toBe(10);
    expect((await extras(U(1), { hands: 3, key: 'b' })).points).toBe(35);
    expect((await extras(U(1), { hands: 5, key: 'c' })).points).toBe(60);
    expect(await weekly(U(1))).toBe(105);
  });

  it('Kahve Saati (20-23) puanı 2 katı', async () => {
    await at('21:15');
    const r = await extras(U(1), { hands: 3, key: 'k1' });
    expect(r.points).toBe(70); expect(r.double).toBe(true);
    await at('23:00');
    expect((await extras(U(1), { hands: 3, key: 'k2' })).double).toBe(false);
  });

  it('günlük puan tavanı 600', async () => {
    await at('14:00');
    let total = 0, capped = false;
    for (let i = 0; i < 15; i++) { const r = await extras(U(2), { hands: 5, key: 'cap' + i }); total += r.points; capped ||= r.capped; }
    expect(total).toBe(600); expect(capped).toBe(true);
    expect((await extras(U(2), { hands: 5, key: 'cap99' })).points).toBe(0);
  });

  it('aynı maç iki kez sayılmaz, botlar hariç', async () => {
    await at('21:00');
    const a = await extras(U(3), { hands: 3, won: false, bet: 10000, key: 'dup' });
    const b = await extras(U(3), { hands: 3, won: false, bet: 10000, key: 'dup' });
    expect(b.dup).toBe(true); expect(b.points).toBe(a.points);
    expect(await weekly(U(3))).toBe(a.points);
    expect(await chips(U(3))).toBe(105000); // iade bir kez
    expect((await extras('bot:arzu', { hands: 3, key: 'bot' })).ok).toBe(false);
  });
});

describe('Kayıpsız Kahve Saati', () => {
  it('kayıpta bahsin %50 iadesi, kazançta net kazancın %30 bonusu, maç başı 50.000 tavanı', async () => {
    await at('20:30');
    const r1 = await extras(U(4), { won: false, bet: 10000, key: 'l1' });
    expect(r1).toMatchObject({ coffee_kind: 'refund', coffee_amount: 5000 });
    const r2 = await extras(U(5), { won: true, bet: 10000, net: 20000, key: 'w1' });
    expect(r2).toMatchObject({ coffee_kind: 'bonus', coffee_amount: 6000 });
    const r3 = await extras(U(6), { won: false, bet: 250000, key: 'big' });
    expect(r3.coffee_amount).toBe(50000);
    expect(await chips(U(4))).toBe(105000);
    expect(await chips(U(5))).toBe(106000);
    expect(await chips(U(6))).toBe(150000);
  });

  it('günde ilk 5 maç; saat dışında yok', async () => {
    await at('21:00');
    const kinds: (string | null)[] = [];
    for (let i = 0; i < 7; i++) kinds.push((await extras(U(7), { won: false, bet: 1000, key: 'd' + i })).coffee_kind);
    expect(kinds.filter(k => k === 'refund').length).toBe(5);
    expect(kinds.slice(5)).toEqual([null, null]);
    await at('19:59');
    expect((await extras(U(8), { won: false, bet: 1000, key: 'early' })).coffee_kind).toBeNull();
  });

  it('coffee_hour_state: kullanım ve son seansın kazananları', async () => {
    await at('21:00');
    await extras(U(1), { won: true, bet: 10000, net: 30000, key: 's1' });
    await extras(U(2), { won: true, bet: 10000, net: 10000, key: 's2' });
    await extras(U(1), { won: true, bet: 10000, net: 10000, key: 's3' });
    await extras(U(3), { won: false, bet: 10000, key: 's4' });
    await as(U(1));
    const st = (await db.query<{ v: any }>('select public.coffee_hour_state() v')).rows[0].v;
    expect(st.used_today).toBe(2);
    expect(st.winners.map((w: any) => w.name)).toEqual(['Oyuncu1', 'Oyuncu2']); // yalnız bonus alanlar, çoktan aza
    expect(st.winners[0].amount).toBe(12000);
    expect(st.total_bonus).toBe(15000);
  });
});

describe('Haftalık sıralama ve kapanış', () => {
  it('weekly_leaderboard: sıra, "Sen" satırı ve 3.lüğe kalan puan', async () => {
    await at('15:00');
    for (let i = 1; i <= 5; i++) for (let k = 0; k < i; k++) await extras(U(i), { hands: 3, key: `lb${i}-${k}` });
    await as(U(2));
    const b = (await db.query<{ v: any }>('select public.weekly_leaderboard(10) v')).rows[0].v;
    expect(b.rows.map((r: any) => r.name)).toEqual(['Oyuncu5', 'Oyuncu4', 'Oyuncu3', 'Oyuncu2', 'Oyuncu1']);
    expect(b.rows[0].points).toBe(175);
    expect(b.me).toMatchObject({ rank: 4, points: 70, to_third: 36 });
    expect(b.rewards[0]).toMatchObject({ chips: 400000, diamonds: 100 });
  });

  it('weekly_close_due: geçen haftanın ilk 10\'u ödül alır, ikinci çağrıda tekrar vermez', async () => {
    const prev = (await db.query<{ d: string }>(`select (public.tr_week_start() - 7)::text d`)).rows[0].d;
    for (let i = 1; i <= 12; i++)
      await db.query('insert into public.weekly_points(week_start,user_id,points,matches,updated_at) values($1,$2,$3,1,now())', [prev, U(i), 1000 - i * 10]);
    const n = (await db.query<{ v: number }>('select public.weekly_close_due() v')).rows[0].v;
    expect(n).toBe(10);
    const rw = (await db.query<{ rank: number; chips: string; diamonds: number }>('select rank, chips::text, diamonds from public.weekly_rewards where rank > 0 order by rank')).rows;
    expect(rw.map(r => Number(r.chips))).toEqual([400000, 200000, 150000, 35000, 35000, 35000, 35000, 35000, 35000, 35000]);
    expect(rw.map(r => r.diamonds)).toEqual([100, 75, 50, 10, 10, 10, 10, 10, 10, 10]);
    expect(rw.reduce((a, r) => a + Number(r.chips), 0)).toBe(995000);
    const ar = (await db.query<{ user_id: string; message: string }>('select user_id, message from public.admin_rewards order by id')).rows;
    expect(ar).toHaveLength(10); expect(ar[0].user_id).toBe(U(1)); expect(ar[0].message).toMatch(/Haftanın Kahvecisi 1\. oldun/);
    expect((await db.query<{ v: number }>('select public.weekly_close_due() v')).rows[0].v).toBe(0);
    expect((await db.query('select 1 from public.admin_rewards')).rows).toHaveLength(10);
  });
});
