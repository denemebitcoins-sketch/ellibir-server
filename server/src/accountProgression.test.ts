import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { matchProgressionBaseXp } from './supabase';

const migration = readFileSync(resolve(__dirname, '../migrations/20260813_account_progression_core.sql'), 'utf8');
const dailyProgressionRestoreMigration = readFileSync(resolve(__dirname, '../migrations/20260825_restore_daily_progression_bonus.sql'), 'utf8');
const supabaseBridge = readFileSync(resolve(__dirname, 'supabase.ts'), 'utf8');
const room = (name: string) => readFileSync(resolve(__dirname, `rooms/${name}`), 'utf8');

describe('account progression XP policy', () => {
  it('awards bounded base XP from authoritative match facts only', () => {
    expect(matchProgressionBaseXp({ won: false, realSeats: 1, totalSeats: 4, game: '51' })).toBe(25);
    expect(matchProgressionBaseXp({ won: false, realSeats: 2, totalSeats: 4, game: 'okey' })).toBe(30);
    expect(matchProgressionBaseXp({ won: true, realSeats: 4, totalSeats: 4, game: '51' })).toBe(70);
    expect(matchProgressionBaseXp({ won: true, realSeats: 4, totalSeats: 4, teamMode: true, game: 'okey' })).toBe(75);
    expect(matchProgressionBaseXp({ won: true, realSeats: 2, totalSeats: 2, game: 'tavla' })).toBe(75);
  });

  it('calls the service-role progression RPC with a match idempotency key', () => {
    expect(supabaseBridge).toContain("rpcService('grant_account_xp'");
    expect(supabaseBridge).toMatch(/p_source:\s*'match'/);
    expect(supabaseBridge).toMatch(/p_event_key:\s*opts\.progressionKey/);
    expect(supabaseBridge).toMatch(/p_base_xp:\s*baseXp/);
    expect(supabaseBridge).toMatch(/result\?\.ok\s*!==\s*true/);
  });

  it('does not gate progression behind paid-bet economy settlement', () => {
    const settleBlock = supabaseBridge.slice(supabaseBridge.indexOf('export async function settleMatch'));
    expect(settleBlock).toMatch(/if \(!supabaseConfigured\(\) \|\| !Number\.isFinite\(winnerSeat\)\) return \[\];/);
    expect(settleBlock).toContain('const economyBet = Math.max(0, Math.floor(bet));');
    expect(settleBlock).toMatch(/if \(economyBet > 0\)[\s\S]*rpc\('add_chips'/);
    expect(settleBlock).toMatch(/grantMatchProgression\(uid, true,[\s\S]*bet: economyBet/);
    expect(settleBlock).not.toMatch(/bet <= 0\) return/);
  });

  it.each(['EllibirRoom.ts', 'OkeyRoom.ts', 'TavlaRoom.ts'])(
    '%s keeps a per-match progression idempotency key',
    (name) => {
      const source = room(name);
      expect(source).toMatch(/private matchProgressionKey\s*=\s*''/);
      expect(source).toMatch(/this\.matchProgressionKey\s*=\s*`[^`]*:\$\{this\.roomId\}:\$\{Date\.now\(\)\}:\$\{/);
      expect(source).toMatch(/progressionKey:\s*this\.matchProgressionKey/);
    },
  );
});

describe('account progression Supabase authority schema', () => {
  it('stores account XP in server-owned profile fields and an idempotent event ledger', () => {
    expect(migration).toMatch(/alter table public\.profiles add column if not exists account_level integer not null default 1/i);
    expect(migration).toMatch(/alter table public\.profiles add column if not exists account_xp_total bigint not null default 0/i);
    expect(migration).toMatch(/create table if not exists public\.account_xp_events/i);
    expect(migration).toMatch(/unique\s*\(user_id,\s*event_key\)/i);
    expect(migration).toMatch(/alter table public\.account_xp_events enable row level security/i);
    expect(migration).toMatch(/create policy account_xp_events_select_own/i);
  });

  it('keeps XP grants service-role only while allowing players to read their own ledger', () => {
    expect(migration).toMatch(/revoke all on public\.account_xp_events from public,\s*anon,\s*authenticated/i);
    expect(migration).toMatch(/grant select on public\.account_xp_events to authenticated/i);
    expect(migration).toMatch(/function public\.grant_account_xp\s*\(/i);
    expect(migration).toMatch(/auth\.role\(\)[\s\S]*service_role/i);
    expect(migration).toMatch(/revoke all on function public\.grant_account_xp\(text,\s*text,\s*text,\s*integer,\s*text,\s*jsonb\) from public,\s*anon,\s*authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.grant_account_xp\(text,\s*text,\s*text,\s*integer,\s*text,\s*jsonb\) to service_role/i);
  });

  it('protects progression fields from every client profile upsert path', () => {
    expect(migration).toMatch(/new\.account_level\s*:=\s*1;\s*new\.account_xp_total\s*:=\s*0/i);
    expect(migration).toMatch(/new\.account_level\s*:=\s*old\.account_level/i);
    expect(migration).toMatch(/new\.account_xp_total\s*:=\s*old\.account_xp_total/i);
    expect(migration).toMatch(/new\.account_xp_updated_at\s*:=\s*old\.account_xp_updated_at/i);
  });

  it('feeds daily reward bonuses from the authoritative account level', () => {
    expect(migration).toMatch(/function public\.account_daily_bonus_pct\(p_level integer\)/i);
    expect(migration).toMatch(/v_progress\s*:=\s*public\.account_xp_progress\(coalesce\(r\.account_xp_total,\s*0\)\)/i);
    expect(migration).toMatch(/v_level_bonus_chips\s*:=\s*floor\(v_chips_delta\s*\*\s*v_bonus_pct\s*\/\s*100\.0\)::bigint/i);
    expect(migration).toMatch(/'level_bonus_pct',\s*v_bonus_pct/i);
    expect(migration).toMatch(/'daily_bonus_pct',\s*public\.account_daily_bonus_pct\(v_level\)/i);
  });

  it('preserves daily level bonus fields after role/vip entitlement migrations', () => {
    expect(dailyProgressionRestoreMigration).toMatch(/v_progress\s*:=\s*public\.account_xp_progress\(coalesce\(r\.account_xp_total,\s*0\)\)/i);
    expect(dailyProgressionRestoreMigration).toMatch(/v_bonus_pct\s*:=\s*public\.account_daily_bonus_pct\(v_level\)/i);
    expect(dailyProgressionRestoreMigration).toMatch(/v_chips_delta\s*:=\s*v_chips_delta\s*\+\s*v_level_bonus_chips/i);
    expect(dailyProgressionRestoreMigration).toMatch(/'daily_bonus_pct',\s*v_bonus_pct/i);
    expect(dailyProgressionRestoreMigration).toMatch(/coalesce\(r\.role,\s*'normal'\)\s+in\s+\('admin',\s*'moderator',\s*'vip'\)/i);
  });
});
