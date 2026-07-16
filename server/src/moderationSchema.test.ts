import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '../migrations/20260716_realtime_moderation.sql'), 'utf8');

describe('realtime moderation contract', () => {
  it('returns only the authenticated caller state', () => {
    expect(sql).toMatch(/v_uid uuid := auth\.uid\(\)/i);
    expect(sql).toMatch(/where id::text = v_uid::text/i);
    expect(sql).toMatch(/grant execute[\s\S]*to authenticated/i);
  });
  it('does not turn an expired typed game ban into a permanent legacy ban', () => {
    expect(sql).toMatch(/when p\.game_banned_until is not null[\s\S]*p\.game_banned_until > now\(\)/i);
  });
});
