import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const migrations = resolve(__dirname, '../migrations');
const onboarding = readFileSync(resolve(migrations, '20260716_beta_onboarding_device_guard.sql'), 'utf8');
const monetization = readFileSync(resolve(migrations, '20260716_monetization_authority.sql'), 'utf8');
const moderation = readFileSync(resolve(migrations, '20260716_realtime_moderation.sql'), 'utf8');
const hotfix = readFileSync(resolve(migrations, '20260716_profile_id_text_compat_hotfix.sql'), 'utf8');

describe('production profiles.id text compatibility', () => {
  it.each([
    ['beta onboarding', onboarding],
    ['monetization authority', monetization],
    ['realtime moderation', moderation],
  ])('%s casts uuid identities before comparing profiles.id', (_name, sql) => {
    expect(sql).not.toMatch(/public\.profiles[^;]*?where\s+id\s*=\s*(?:v_uid|v_row\.user_id|p_user_id)/is);
    expect(sql).toMatch(/(?:profiles\.)?id::text\s*=\s*(?:v_uid|v_row\.user_id|p_user_id)::text/i);
  });

  it('ships a rerunnable repair for every affected live RPC', () => {
    for (const signature of [
      'public.claim_beta_welcome(text)',
      'public.get_my_moderation_state()',
      'public.begin_rewarded_ad(text)',
      'public.get_rewarded_ad_state(uuid)',
      'public.finalize_rewarded_ad(uuid,text,text,text,numeric)',
      'public.finalize_play_purchase(uuid,text,text,text,text,text,jsonb,jsonb)',
    ]) {
      expect(hotfix).toContain(`'${signature}'`);
    }
    expect(hotfix).toMatch(/notify\s+pgrst,\s*'reload schema'/i);
    expect(hotfix).toMatch(/replace\(v_sql,[\s\S]*?'where id = v_uid'[\s\S]*?'where id::text = v_uid::text'/i);
  });
});
