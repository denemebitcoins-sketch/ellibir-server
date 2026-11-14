import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dir = join(__dirname, '..', 'migrations');
const v2 = readFileSync(join(dir, '20261114_daily_rewards_v2.sql'), 'utf8');
const prev = readFileSync(join(dir, '20260825_restore_daily_progression_bonus.sql'), 'utf8');

describe('daily rewards v2 migration', () => {
  it('pays 1000..7000 chips Monday..Sunday', () => {
    expect(v2).toContain('array[1000, 2000, 3000, 4000, 5000, 6000, 7000]');
    expect(v2).not.toContain('array[250, 400, 600');
  });
  it('keeps the previous claim_daily body except the chip table', () => {
    const body = (s: string) => s.slice(s.indexOf('create or replace function public.claim_daily'))
      .replace(/array\[[0-9, ]+\]/, 'ARR').split('\n').filter(l => !l.includes('get_daily_state')).join('\n').trim();
    expect(body(v2)).toBe(body(prev));
  });
  it('keeps VIP bonus, Sunday diamonds and grants', () => {
    expect(v2).toContain('v_chips_delta := 10000;');
    expect(v2).toContain('when v_dow = 7 then 2 else 0');
    expect(v2).toContain('grant execute on function public.claim_daily(int) to authenticated;');
  });
});
