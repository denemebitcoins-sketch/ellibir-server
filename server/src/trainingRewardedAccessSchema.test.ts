import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const migration = readFileSync(join(root, 'migrations', '20260816_training_rewarded_access.sql'), 'utf8');
const monetization = readFileSync(join(root, 'src', 'monetization.ts'), 'utf8');

describe('training rewarded access authority', () => {
  it('uses a dedicated SSV-backed training session table and RPCs', () => {
    expect(migration).toMatch(/create table if not exists public\.training_rewarded_ad_sessions/i);
    expect(migration).toMatch(/function public\.begin_training_rewarded_ad\(p_device_hash text\)/i);
    expect(migration).toMatch(/function public\.get_training_rewarded_ad_state\(p_session_id uuid\)/i);
    expect(migration).toMatch(/function public\.finalize_training_rewarded_ad\(/i);
    expect(migration).toMatch(/insert into public\.training_access_windows/i);
    expect(migration).toMatch(/source = excluded\.source/i);
  });

  it('does not let authenticated clients directly grant training access', () => {
    expect(migration).toMatch(/revoke execute on function public\.grant_training_access\(text, text\) from public, anon, authenticated/i);
    expect(migration).not.toMatch(/grant execute on function public\.grant_training_access\(text, text\) to authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.begin_training_rewarded_ad\(text\) to authenticated/i);
  });

  it('routes AdMob SSV to training sessions before falling back to chip rewards', () => {
    const trainingIdx = monetization.indexOf("rpcService('finalize_training_rewarded_ad'");
    const chipIdx = monetization.indexOf("rpcService('finalize_rewarded_ad'");
    expect(trainingIdx).toBeGreaterThanOrEqual(0);
    expect(chipIdx).toBeGreaterThan(trainingIdx);
    expect(monetization).toContain("finalize_training_rewarded_ad_http_404");
    expect(monetization).toContain("training && (training.ok || training.error !== 'session_not_found')");
    expect(monetization).toContain("return await rpcService('finalize_rewarded_ad', args)");
  });
});
