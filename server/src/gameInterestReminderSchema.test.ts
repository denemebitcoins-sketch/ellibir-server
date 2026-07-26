import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '..', 'migrations', '20260726_game_interest_and_daily_reminders.sql'),
  'utf8',
);

describe('game interest + daily reminder migration', () => {
  it('game_interest tablosu RLS ile kullanıcıya ait', () => {
    expect(sql).toContain('create table if not exists public.game_interest');
    expect(sql).toContain("game in ('bilardo', 'ihale', 'macakizi')");
    expect(sql).toContain('enable row level security');
    expect(sql).toContain('auth.uid() = user_id');
  });

  it('set_game_interest toggle ve my_game_interests liste RPC güvenli', () => {
    expect(sql).toContain('create or replace function public.set_game_interest(p_game text, p_interested boolean)');
    expect(sql).toContain('on conflict (user_id, game) do nothing');
    expect(sql).toContain('create or replace function public.my_game_interests()');
    expect(sql).toContain('grant execute on function public.set_game_interest(text, boolean) to authenticated');
    expect(sql).toContain('grant execute on function public.my_game_interests() to authenticated');
  });

  it('günlük hatırlatma yalnız alınmamış gün + aktif cihaz + günde bir', () => {
    expect(sql).toContain('create or replace function public.enqueue_daily_reminders()');
    expect(sql).toContain('public.push_devices d');
    expect(sql).toContain('d.enabled');
    expect(sql).toContain('daily_claim_week is distinct from v_week');
    expect(sql).toContain("o.data->>'type' = 'daily_reminder'");
    expect(sql).toContain("o.created_at >= date_trunc('day', now())");
    expect(sql).toContain('revoke all on function public.enqueue_daily_reminders() from public');
  });
});
