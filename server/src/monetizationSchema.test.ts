import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../migrations/20260716_monetization_authority.sql'), 'utf8');

describe('monetization authority schema', () => {
  it('makes reward transactions and Play purchase tokens unique', () => {
    expect(sql).toMatch(/transaction_id text unique/i);
    expect(sql).toMatch(/purchase_token text not null unique/i);
  });
  it('keeps finalizers service-role only', () => {
    expect(sql).toMatch(/current_user not in \('service_role', 'postgres'\)/i);
    expect(sql).toMatch(/grant execute on function public\.finalize_rewarded_ad[\s\S]*to service_role/i);
    expect(sql).toMatch(/grant execute on function public\.finalize_play_purchase[\s\S]*to service_role/i);
  });
  it('enforces five ads and a fifteen-minute cooldown', () => {
    expect(sql).toMatch(/v_used >= 5/i);
    expect(sql).toMatch(/interval '15 minutes'/i);
  });
});
