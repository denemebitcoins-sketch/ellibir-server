import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const sql = readFileSync(resolve(__dirname, '../migrations/20260716_beta_reset_tool.sql'), 'utf8');
const onboarding = readFileSync(resolve(__dirname, '../migrations/20260716_beta_onboarding_device_guard.sql'), 'utf8');

describe('protected beta reset migration', () => {
  it('is install-only, confirmation-gated and does not cascade into auth', () => {
    expect(sql).toContain("p_confirmation is distinct from 'ONLINE-KAHVEM-BETA-SIFIRLA'");
    expect(sql).toContain("current_user not in ('postgres', 'service_role')");
    expect(sql).not.toMatch(/truncate\s+table[\s\S]*cascade/i);
    expect(sql).not.toMatch(/^\s*delete\s+from\s+auth\.users\s*;/im);
  });

  it('resets beta wallets and seeds every canak with 20,000', () => {
    expect(sql).toMatch(/set\s+chips\s*=\s*50000/i);
    expect(sql).toMatch(/diamonds\s*=\s*500/i);
    expect(sql).toContain("('51', 20000, now())");
    expect(sql).toContain("('okey', 20000, now())");
    expect(sql).toContain("('tavla', 20000, now())");
  });

  it('preserves anti-replay ledgers unless explicitly requested', () => {
    expect(sql).toContain('p_include_financial_ledger boolean default false');
    expect(sql).toContain("array['rewarded_ad_sessions', 'play_purchase_receipts']");
    expect(sql).toContain("'financial_ledger_preserved', not p_include_financial_ledger");
  });

  it('binds one beta account per device and rejects an active device ban', () => {
    expect(onboarding).toMatch(/v_owner\s+is not null\s+and\s+v_owner\s+<>\s+v_uid/i);
    expect(onboarding).toMatch(/v_banned_until\s+is not null\s+and\s+v_banned_until\s+>\s+now\(\)/i);
    expect(onboarding).toContain("'error', 'device_banned'");
  });
});
