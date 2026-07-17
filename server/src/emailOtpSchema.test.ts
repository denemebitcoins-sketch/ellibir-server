import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../migrations/20260717_email_otp_linking.sql'), 'utf8');

describe('email OTP linking schema', () => {
  it('stores only hashed server OTPs and keeps the table service-role only', () => {
    expect(sql).toMatch(/create table if not exists public\.email_link_codes/i);
    expect(sql).toMatch(/code_hash text not null/i);
    expect(sql).not.toMatch(/\bcode\s+text/i);
    expect(sql).toMatch(/alter table public\.email_link_codes enable row level security/i);
    expect(sql).toMatch(/revoke all on public\.email_link_codes from public, anon, authenticated/i);
    expect(sql).toMatch(/grant select, insert, update, delete on public\.email_link_codes to service_role/i);
  });
});
