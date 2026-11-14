import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLE_BETS, isTableBet, isPopulationBet } from './tableBets';
import { normalizeRoomBet } from './supabase';

const sql = readFileSync(join(__dirname, '..', 'migrations', '20261114_table_bets_5k_25k.sql'), 'utf8');

describe('table bets 5k-25k', () => {
  it('single source list', () => {
    expect(TABLE_BETS).toEqual([5000, 10000, 15000, 20000, 25000]);
    for (const b of [500, 1000, 2500, 4999, 30000, 7500]) expect(isTableBet(b)).toBe(false);
    for (const b of TABLE_BETS) expect(isTableBet(b)).toBe(true);
  });
  it('rooms keep allowed bets as-is', () => {
    for (const b of TABLE_BETS) expect(normalizeRoomBet(b, TABLE_BETS, 'okey')).toBe(b);
  });
  it('migration widens population bet checks to 500..25000', () => {
    expect(sql).toContain("pg_get_constraintdef(con.oid) ilike '%bet%500%'");
    expect(sql.match(/bet between 500 and 25000 and bet % 500 = 0/g)?.length).toBe(3);
  });
  it('population accepts old and new bets', () => {
    for (const b of [500, 1000, 5000, 25000]) expect(isPopulationBet(b)).toBe(true);
    for (const b of [0, 250, 25500, 30000]) expect(isPopulationBet(b)).toBe(false);
  });
});
