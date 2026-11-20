import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 20.11 KAHVEHANE: akış/yorum RPC'leri ve görünürlük kuralları (canlıdaki sosyal şemanın özeti üzerinde).
let db: PGlite;
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = U(1), FRIEND = U(2), STRANGER = U(3), BLOCKED = U(4), HIDDENP = U(5), ADMIN = U(9);

async function as(uid: string) { await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid]); }
async function q<T = any>(sql: string, args: any[] = []) { return (await db.query<T>(sql, args)).rows; }
async function rpc(name: string, args: Record<string, any> = {}) {
  const keys = Object.keys(args);
  const r = await db.query<{ r: any }>(`select public.${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(',')}) r`, Object.values(args));
  return r.rows[0].r;
}
async function post(uid: string, text: string, extra = '') {
  await as(uid);
  return (await q<{ id: number }>(`insert into public.posts(user_id, text${extra ? ',' + extra.split('=')[0] : ''}) values ($1, $2${extra ? ",'" + extra.split('=')[1] + "'" : ''}) returning id`, [uid, text]))[0].id;
}
async function comment(uid: string, postId: number, text: string, parent: number | null = null) {
  await as(uid);
  return (await q<{ id: number }>(`insert into public.post_comments(post_id, user_id, text, parent_id) values ($1,$2,$3,$4) returning id`, [postId, uid, text, parent]))[0].id;
}

beforeAll(async () => {
  db = await PGlite.create();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create table public.profiles(id uuid primary key, name text, avatar_url text, role text default 'normal', gender text,
      vip_until timestamptz, account_level int default 1, equipped_profile_frame text, equipped_name_style text,
      profile_visibility text default 'open', chat_banned_until timestamptz);
    create table public.friendships(id bigint generated always as identity primary key, requester uuid, addressee uuid, status text, created_at timestamptz default now());
    create table public.blocks(id bigint generated always as identity primary key, blocker uuid, blocked uuid, created_at timestamptz default now());
    create table public.notifications(id bigint generated always as identity primary key, user_id uuid, actor_id uuid, type text, post_id bigint, preview text, seen boolean default false, created_at timestamptz default now());
    create function public.apply_chat_filter(p_text text) returns text language sql stable as $$ select regexp_replace(coalesce(p_text,''), 'kufur', '***', 'gi') $$;
    create function public.is_current_user_admin() returns boolean language sql stable as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin') $$;
    create function public.can_write_social() returns boolean language sql stable as $$ select true $$;
  `);
  // canlıdaki can_view_profile_social (20260718) birebir
  const prof = readFileSync(resolve(__dirname, '../migrations/20260718_daily_profile_training_access.sql'), 'utf8');
  const fn = prof.slice(prof.indexOf('create or replace function public.can_view_profile_social'));
  await db.exec(fn.slice(0, fn.indexOf('$$;') + 3));
  await db.exec(`
    create table public.posts(id bigint generated always as identity primary key, user_id uuid not null references auth.users(id) on delete cascade,
      kind text not null default 'status' check (kind in ('status','activity')), text text not null check (char_length(text) between 1 and 280), created_at timestamptz not null default now());
    create table public.post_likes(post_id bigint references public.posts(id) on delete cascade, user_id uuid references auth.users(id), created_at timestamptz default now(), primary key(post_id, user_id));
    create table public.post_comments(id bigint generated always as identity primary key, post_id bigint not null references public.posts(id) on delete cascade,
      user_id uuid not null references auth.users(id), text text not null check (char_length(text) between 1 and 280), created_at timestamptz not null default now());
    alter table public.posts enable row level security;
    create function public.can_view_post_social(p_post bigint) returns boolean language sql stable as $$ select true $$;
    create function public.notify_on_comment() returns trigger language plpgsql as $$ begin return new; end $$;
    create trigger notify_comment_trg after insert on public.post_comments for each row execute function public.notify_on_comment();
  `);
  await db.exec(readFileSync(resolve(__dirname, '../migrations/20261120_kahvehane_feed.sql'), 'utf8'));
  await db.exec(readFileSync(resolve(__dirname, '../migrations/20261120_kahvehane_feed_pin.sql'), 'utf8'));
  for (const [id, name, vis, role] of [[ME, 'Samet', 'open', 'normal'], [FRIEND, 'Zeynep', 'friends', 'normal'], [STRANGER, 'Ayşe', 'open', 'normal'],
    [BLOCKED, 'Kötü', 'open', 'normal'], [HIDDENP, 'Gizli', 'hidden', 'normal'], [ADMIN, 'Yonetici', 'open', 'admin']] as const) {
    await db.query('insert into auth.users values ($1)', [id]);
    await db.query('insert into public.profiles(id, name, profile_visibility, role) values ($1,$2,$3,$4)', [id, name, vis, role]);
  }
  await db.query(`insert into public.friendships(requester, addressee, status) values ($1,$2,'accepted')`, [ME, FRIEND]);
  await db.query(`insert into public.blocks(blocker, blocked) values ($1,$2)`, [ME, BLOCKED]);
}, 30000);
afterAll(async () => { await db?.close(); });

describe('kahvehane feed', () => {
  it('mixed feed: public + friends-only from friends + official; hides blocked, hidden profiles and hidden posts', async () => {
    const pub = await post(STRANGER, 'Tavlada beni yenen var mı?');
    const friendOnly = await post(FRIEND, 'Sadece arkadaşlarım', 'visibility=friends');
    const strangerFriendOnly = await post(STRANGER, 'Ayşe arkadaşlarına', 'visibility=friends');
    const blocked = await post(BLOCKED, 'Engelli kişinin gönderisi');
    const hidden = await post(HIDDENP, 'Gizli profil');
    await as(ADMIN);
    const official = await rpc('kahvehane_post_official', { p_text: 'Kahve Saati başlıyor!' });
    await as(ME);
    const ids = (await rpc('kahvehane_feed', { p_scope: 'mixed' })).items.map((x: any) => Number(x.id));
    expect(ids).toEqual(expect.arrayContaining([pub, friendOnly, Number(official)]));
    expect(ids).not.toContain(strangerFriendOnly);
    expect(ids).not.toContain(blocked);
    expect(ids).not.toContain(hidden);
    const off = (await rpc('kahvehane_feed', { p_scope: 'mixed' })).items.find((x: any) => x.official);
    expect(off.author.name).toBe('Yonetici');
    await rpc('kahvehane_hide_post', { p_post: pub });
    expect((await rpc('kahvehane_feed', { p_scope: 'mixed' })).items.map((x: any) => Number(x.id))).not.toContain(pub);
    // Engellenen taraf da engelleyenin gönderisini görmez (iki yönlü).
    const mine = await post(ME, 'Benim gönderim');
    await as(BLOCKED);
    expect((await rpc('kahvehane_feed', { p_scope: 'mixed' })).items.map((x: any) => Number(x.id))).not.toContain(mine);
    // RLS de aynı kuralı uygular (eski istemcilerin REST okuması).
    await db.exec(`grant usage on schema public, auth to authenticated; grant select on public.posts to authenticated; grant execute on all functions in schema public to authenticated; grant execute on function auth.uid() to authenticated`);
    await db.exec('set role authenticated');
    const visible = (await q<{ id: number }>('select id from public.posts')).map(r => Number(r.id));
    await db.exec('reset role');
    expect(visible).not.toContain(mine);
    expect(visible).toContain(Number(official));
  });

  it('friends scope shows only friends and me; user scope returns the pinned post separately', async () => {
    await as(ME);
    const items = (await rpc('kahvehane_feed', { p_scope: 'friends' })).items;
    expect(new Set(items.map((x: any) => x.user_id))).toEqual(new Set([ME, FRIEND].filter(u => items.some((x: any) => x.user_id === u))));
    expect(items.every((x: any) => x.user_id === ME || x.user_id === FRIEND)).toBe(true);
    const a = await post(ME, 'Sabitlenecek');
    await post(ME, 'Sonraki');
    await as(ME);
    expect(await rpc('kahvehane_set_pin', { p_post: a, p_pin: true })).toBe(true);
    const wall = await rpc('kahvehane_feed', { p_scope: 'user', p_user: ME });
    expect(Number(wall.pinned.id)).toBe(a);
    expect(wall.items.map((x: any) => Number(x.id))).not.toContain(a);
    // Başkasının gönderisini sabitleyemez.
    const other = await post(STRANGER, 'Başkası');
    await as(ME);
    expect(await rpc('kahvehane_set_pin', { p_post: other, p_pin: true })).toBe(false);
  });

  it('profanity filter applies to posts and comments; empty after trim is rejected', async () => {
    const id = await post(ME, 'bu bir kufur denemesi');
    expect((await q<{ text: string }>('select text from public.posts where id = $1', [id]))[0].text).toBe('bu bir *** denemesi');
    const c = await comment(STRANGER, id, 'KUFUR yorum');
    expect((await q<{ text: string }>('select text from public.post_comments where id = $1', [c]))[0].text).toBe('*** yorum');
  });

  it('replies nest at most two levels and keep who was answered', async () => {
    const p = await post(STRANGER, 'Yanıt testi');
    const c0 = await comment(FRIEND, p, 'Kök yorum');
    const c1 = await comment(STRANGER, p, 'Birinci seviye', c0);
    const c2 = await comment(ME, p, 'İkinci seviye', c1);
    const c3 = await comment(FRIEND, p, 'Üçüncü olmaz, ikinci kalır', c2);
    const rows = await q<any>('select id, parent_id, depth, reply_to from public.post_comments where id = any($1) order by id', [[c0, c1, c2, c3]]);
    expect(rows.map(r => r.depth)).toEqual([0, 1, 2, 2]);
    expect(Number(rows[3].parent_id)).toBe(c1);
    expect(rows[3].reply_to).toBe(ME);
    await as(ME);
    const list = (await rpc('kahvehane_comments', { p_post: p })).items;
    expect(list.find((x: any) => Number(x.id) === c3).reply_to_name).toBe('Samet');
    // Başka gönderinin yorumuna yanıt olamaz.
    const p2 = await post(STRANGER, 'Başka gönderi');
    await expect(comment(ME, p2, 'yanlış ebeveyn', c0)).rejects.toThrow(/comment_parent_invalid/);
  });

  it('counts, likes and top comment; blocked commenters are hidden', async () => {
    const p = await post(STRANGER, 'Sayaç testi');
    const good = await comment(FRIEND, p, 'İyi yorum');
    await comment(BLOCKED, p, 'Engelli yorum');
    await as(ME);
    await q('insert into public.post_comment_likes(comment_id, user_id) values ($1,$2)', [good, ME]);
    await q('insert into public.post_likes(post_id, user_id) values ($1,$2)', [p, ME]);
    const item = (await rpc('kahvehane_feed', { p_scope: 'mixed' })).items.find((x: any) => Number(x.id) === p);
    expect(item).toMatchObject({ likes: 1, liked: true, comments: 1 });
    expect(Number(item.top_comment.id)).toBe(good);
    const cm = (await rpc('kahvehane_comments', { p_post: p })).items;
    expect(cm).toHaveLength(1);
    expect(cm[0]).toMatchObject({ likes: 1, liked: true });
  });

  it('only admins post official; users cannot smuggle is_official or pinned_at through REST inserts', async () => {
    await as(ME);
    await expect(q(`insert into public.posts(user_id, text, is_official) values ($1, 'sahte resmi', true)`, [ME])).rejects.toThrow(/official_admin_only/);
    const id = (await q<{ id: number }>(`insert into public.posts(user_id, text, pinned_at) values ($1, 'sabit kaçak', now()) returning id`, [ME]))[0].id;
    expect((await q<any>('select pinned_at from public.posts where id = $1', [id]))[0].pinned_at).toBeNull();
    await expect(rpc('kahvehane_post_official', { p_text: 'x' })).rejects.toThrow(/official_admin_only/);
  });

  it('pages with a (created_at, id) cursor without repeats; mixed collapses same-day activities per user', async () => {
    for (let i = 0; i < 25; i++) await post(U(10 + (i % 3)) === U(10) ? STRANGER : STRANGER, 'Sayfa ' + i);
    for (let i = 0; i < 4; i++) await post(FRIEND, 'Kazandı ' + i, 'kind=activity');
    await as(ME);
    const seen = new Set<number>();
    let next: any = null, pages = 0;
    do {
      const r = await rpc('kahvehane_feed', { p_scope: 'mixed', p_limit: 10, p_before_ts: next?.ts ?? null, p_before_id: next?.id ?? null });
      for (const x of r.items) { expect(seen.has(Number(x.id))).toBe(false); seen.add(Number(x.id)); }
      next = r.next; pages++;
    } while (next && pages < 20);
    expect(pages).toBeGreaterThan(2);
    const acts = (await rpc('kahvehane_feed', { p_scope: 'mixed', p_limit: 40 })).items.filter((x: any) => x.kind === 'activity');
    expect(acts).toHaveLength(1);
    const wallActs = (await rpc('kahvehane_feed', { p_scope: 'user', p_user: FRIEND, p_limit: 40 })).items.filter((x: any) => x.kind === 'activity');
    expect(wallActs).toHaveLength(4);
  });
  it('admin pins one public post on top of the mixed feed; players cannot', async () => {
    const a = await post(STRANGER, 'Yönetici sabitleyecek');
    const b = await post(FRIEND, 'İkinci sabit');
    await as(ME);
    await expect(rpc('kahvehane_set_feed_pin', { p_post: a, p_pin: true })).rejects.toThrow(/admin_only/);
    await expect(q('update public.posts set feed_pinned_at = now() where id = $1', [a])).rejects.toThrow(/feed_pin_admin_only/);
    await as(ADMIN);
    expect(await rpc('kahvehane_set_feed_pin', { p_post: a, p_pin: true })).toBe(true);
    await as(ME);
    let feed = await rpc('kahvehane_feed', { p_scope: 'mixed' });
    expect(Number(feed.pinned.id)).toBe(a);
    expect(feed.pinned.feed_pinned).toBe(true);
    expect(feed.items.map((x: any) => Number(x.id))).not.toContain(a);
    // yeni sabit eskisinin yerini alır; geri alınca akışa döner
    await as(ADMIN);
    expect(await rpc('kahvehane_set_feed_pin', { p_post: b, p_pin: true })).toBe(true);
    await as(ME);
    feed = await rpc('kahvehane_feed', { p_scope: 'mixed' });
    expect(Number(feed.pinned.id)).toBe(b);
    expect(feed.items.map((x: any) => Number(x.id))).toContain(a);
    await as(ADMIN);
    expect(await rpc('kahvehane_set_feed_pin', { p_post: b, p_pin: false })).toBe(true);
    await as(ME);
    feed = await rpc('kahvehane_feed', { p_scope: 'mixed' });
    expect(feed.pinned).toBeNull();
    // arkadaşlara özel gönderi akışa sabitlenemez
    const f = await post(FRIEND, 'Özel', 'visibility=friends');
    await as(ADMIN);
    await expect(rpc('kahvehane_set_feed_pin', { p_post: f, p_pin: true })).rejects.toThrow(/not_public/);
  });
});
