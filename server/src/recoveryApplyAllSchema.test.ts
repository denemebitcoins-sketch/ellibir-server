import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../migrations/20260816_recovery_apply_all.sql'), 'utf8');

describe('recovery apply-all Supabase SQL', () => {
  it('bundles username guard and training rewarded access into one SQL Editor script', () => {
    expect(sql).toMatch(/function public\.guard_profile_name_unique\(\)/i);
    expect(sql).toMatch(/create trigger trg_profiles_name_unique/i);
    expect(sql).toMatch(/create table if not exists public\.training_rewarded_ad_sessions/i);
    expect(sql).toMatch(/function public\.begin_training_rewarded_ad\(p_device_hash text\)/i);
    expect(sql).toMatch(/function public\.finalize_training_rewarded_ad\(/i);
    expect(sql).toMatch(/revoke execute on function public\.grant_training_access\(text, text\) from public, anon, authenticated/i);
  });

  it('returns an explicit post-check result for every live requirement', () => {
    expect(sql).toMatch(/training_access_windows_ok/i);
    expect(sql).toMatch(/training_rewarded_ad_sessions_ok/i);
    expect(sql).toMatch(/begin_training_rewarded_ad_ok/i);
    expect(sql).toMatch(/finalize_training_rewarded_ad_ok/i);
    expect(sql).toMatch(/profile_name_guard_ok/i);
    expect(sql).toMatch(/profile_name_trigger_ok/i);
  });
});
