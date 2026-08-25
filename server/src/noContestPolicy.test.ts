import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasLowestScoreTie, isOneRound, isOneRoundNoContest, shouldDeferEntryHouse } from './noContest';

const repoRoot = path.resolve(process.cwd(), '..');
const room = (name: string) => readFileSync(path.resolve(repoRoot, 'server/src/rooms', name), 'utf8');
const migration = readFileSync(
  path.resolve(repoRoot, 'server/migrations/20260819_one_hand_no_contest_refunds.sql'),
  'utf8',
);

describe('one-hand no-contest economy policy', () => {
  it('detects one-hand no-contest cases without treating normal multi-hand matches as refunds', () => {
    expect(isOneRound(1)).toBe(true);
    expect(isOneRound(3)).toBe(false);
    expect(shouldDeferEntryHouse(1)).toBe(true);
    expect(shouldDeferEntryHouse(5)).toBe(false);

    expect(isOneRoundNoContest({ totalRounds: 1, handWinnerSeat: null, scores: [0, 0, 0, 0] })).toBe(true);
    expect(isOneRoundNoContest({ totalRounds: 1, handWinnerSeat: -1, scores: [10, 20, 30, 40] })).toBe(true);
    expect(isOneRoundNoContest({ totalRounds: 1, handWinnerSeat: 2, scores: [20, 10, 10, 30] })).toBe(true);
    expect(isOneRoundNoContest({ totalRounds: 1, handWinnerSeat: 2, scores: [20, 30, -101, 40] })).toBe(false);
    expect(isOneRoundNoContest({ totalRounds: 3, handWinnerSeat: null, scores: [0, 0, 0, 0] })).toBe(false);
    expect(hasLowestScoreTie([10, 5, 5, 20])).toBe(true);
    expect(hasLowestScoreTie([10, 5, 7, 20])).toBe(false);
  });

  it('51 and Okey defer canak commission on one-hand entry and refund before settlement', () => {
    for (const name of ['EllibirRoom.ts', 'OkeyRoom.ts']) {
      const source = room(name);
      expect(source).toContain('shouldDeferEntryHouse');
      expect(source).toMatch(/deductEntry\(entryUsers,\s*this\.bet,\s*oneHandEntry \? undefined : '(?:51|okey)',\s*entryHouse\)/);
      expect(source).toContain('this.entryCanakCharged = !oneHandEntry;');
      expect(source).toContain('isOneRoundNoContest');
      expect(source).toContain('refundEntryOnce(this.seatUsers, this.bet');

      const noContestIdx = source.indexOf('isOneRoundNoContest');
      const settleIdx = source.indexOf('settleMatch({');
      expect(noContestIdx).toBeGreaterThanOrEqual(0);
      expect(settleIdx).toBeGreaterThan(noContestIdx);
    }
  });

  it('does not let 101 Okey skip XP settlement when scores identify a unique winner', () => {
    const source = room('OkeyRoom.ts');
    expect(source).toContain('hasLowestScoreTie');
    expect(source).toMatch(/const\s+winnerSeat\s*=\s*this\.lowestScoreSeat\(\)/);
    expect(source).toMatch(/this\.isOneHandNoContest\(winnerSeat\)/);
    expect(source).toMatch(/this\.game\.rules\.variant\s*===\s*'yuzbir'[\s\S]*fallbackWinnerSeat[\s\S]*!hasLowestScoreTie\(this\.game\.scores\)/);
  });

  it('stores refund idempotency in Supabase with service-role-only access', () => {
    expect(migration).toMatch(/create table if not exists public\.match_entry_refunds/i);
    expect(migration).toMatch(/refund_key text primary key/i);
    expect(migration).toMatch(/on conflict \(refund_key\) do nothing/i);
    expect(migration).toMatch(/create or replace function public\.refund_match_entry_once/i);
    expect(migration).toMatch(/update public\.profiles[\s\S]*set chips = coalesce\(chips,\s*0\) \+ p_amount/i);
    expect(migration).toMatch(/revoke execute on function public\.refund_match_entry_once\(text,\s*text,\s*text\[\],\s*bigint\) from public,\s*anon,\s*authenticated/i);
    expect(migration).toMatch(/grant execute on function public\.refund_match_entry_once\(text,\s*text,\s*text\[\],\s*bigint\) to service_role/i);
  });
});
